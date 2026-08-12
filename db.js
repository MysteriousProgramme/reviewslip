'use strict';

const { Pool } = require('pg');

/**
 * The Postgres pool, plus the schema migrations.
 *
 * One pool for the process, opened at require time. It holds every subscriber's
 * OpenRouter key in plain text — so the database belongs on the machine that
 * runs the app, listening on loopback and nowhere else.
 */

const CONNECTION = process.env.DATABASE_URL;

if (!CONNECTION) {
  throw new Error(
    'DATABASE_URL is not set. Point it at Postgres, for example:\n' +
      '  DATABASE_URL=postgres://reviewslip:password@127.0.0.1:5432/reviewslip'
  );
}

// Small on purpose. One Node process, against a server tuned for twenty
// backends — a pool bigger than the work queue only costs memory.
const pool = new Pool({
  connectionString: CONNECTION,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// An idle client dropped by the server — a restart, a network blip — surfaces
// here rather than at the next query, and an unhandled 'error' event on the
// pool would take the process down with it.
pool.on('error', (err) => {
  console.error('Idle Postgres client error:', err.message);
});

/* ------------------------------------------------------------------ queries */

function query(text, params) {
  return pool.query(text, params);
}

/** @returns {Promise<object|null>} the first row, or null for none */
async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

/** @returns {Promise<object[]>} */
async function all(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

/* -------------------------------------------------------------- migrations */

/**
 * Append-only. Each entry moves the schema forward by one, and `schema_version`
 * records how far we have gone — so a fresh database and an existing one take
 * the same path.
 *
 * SQLite kept that counter in `user_version`. Postgres has no per-database slot
 * like it, so it lives in a one-row table instead.
 */
const MIGRATIONS = [
  async (c) => {
    await c.query(`
      CREATE TABLE subscribers (
        id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        slug        text NOT NULL UNIQUE,
        name        text NOT NULL,
        status      text NOT NULL DEFAULT 'active',
        api_key     text,
        model       text,
        google_url  text,
        website_url text,
        token_hash  text NOT NULL,
        created_at  text NOT NULL,
        updated_at  text NOT NULL
      )
    `);
  },

  async (c) => {
    await c.query('ALTER TABLE subscribers ADD COLUMN tripadvisor_url text');
    // A JSON array of {id, label, focus}. NULL means "use the built-in set",
    // which is what every existing row wants.
    await c.query('ALTER TABLE subscribers ADD COLUMN categories text');
  },

  async (c) => {
    // Who the venue is, in the writer's words. Until now these lived in
    // config.js, installation-wide, so every venue's reviews described the
    // first one. NULL still falls back to config.js, which is what a venue
    // that has not filled them in wants.
    await c.query('ALTER TABLE subscribers ADD COLUMN kind text');
    await c.query('ALTER TABLE subscribers ADD COLUMN place text');
    // A JSON array of strings — the details a review may draw on.
    await c.query('ALTER TABLE subscribers ADD COLUMN safe_details text');
  },

  async (c) => {
    // Customers. A venue used to be configured through a token handed to its
    // staff; now it belongs to an account, and the account signs in.
    await c.query(`
      CREATE TABLE accounts (
        id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email         text NOT NULL,
        username      text NOT NULL,
        password_hash text NOT NULL,
        plan          text NOT NULL DEFAULT 'starter',
        status        text NOT NULL DEFAULT 'active',
        created_at    text NOT NULL,
        updated_at    text NOT NULL
      )
    `);
    // Case-insensitive: nobody should be able to register Zac@x.com twice by
    // changing the capitals, and nobody should fail to sign in over it either.
    await c.query(
      'CREATE UNIQUE INDEX accounts_email ON accounts (lower(email))'
    );
    await c.query(
      'CREATE UNIQUE INDEX accounts_username ON accounts (lower(username))'
    );

    // Opaque session tokens, hashed the way subscriber tokens are: the cookie
    // in the browser is the only copy of the real thing.
    await c.query(`
      CREATE TABLE sessions (
        token_hash text PRIMARY KEY,
        account_id integer NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )
    `);
    await c.query(
      'CREATE INDEX sessions_account ON sessions (account_id)'
    );

    // A venue with no account is one created straight from the admin API, which
    // is still allowed — hence nullable rather than NOT NULL.
    await c.query(`
      ALTER TABLE subscribers
        ADD COLUMN account_id integer REFERENCES accounts (id) ON DELETE SET NULL
    `);
    await c.query(
      'CREATE INDEX subscribers_account ON subscribers (account_id)'
    );

    // One row per generated review. This is where the dashboard's counts and
    // the token meter come from, so it is written on the guest path — kept
    // narrow deliberately: no review text, nothing about the guest.
    await c.query(`
      CREATE TABLE review_events (
        id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        subscriber_id     integer NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
        created_at        timestamptz NOT NULL DEFAULT now(),
        category_id       text,
        model             text,
        prompt_tokens     integer,
        completion_tokens integer,
        total_tokens      integer
      )
    `);
    // Every dashboard query is "this venue, this month", so index that pair.
    await c.query(`
      CREATE INDEX review_events_subscriber_created
        ON review_events (subscriber_id, created_at DESC)
    `);
  },

  async (c) => {
    // Staff. One flag rather than a roles table: there are two kinds of person
    // here, us and customers, and inventing a permission system for that would
    // be building for a problem nobody has yet.
    await c.query(
      'ALTER TABLE accounts ADD COLUMN is_admin boolean NOT NULL DEFAULT false'
    );

    // subscriber_id is nullable and SET NULL on delete: a ticket about a venue
    // that has since been deleted is still a ticket, and often the interesting
    // kind.
    await c.query(`
      CREATE TABLE support_tickets (
        id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        account_id    integer NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        subscriber_id integer REFERENCES subscribers (id) ON DELETE SET NULL,
        title         text NOT NULL,
        body          text NOT NULL,
        status        text NOT NULL DEFAULT 'open',
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await c.query(`
      CREATE INDEX support_tickets_account
        ON support_tickets (account_id, created_at DESC)
    `);
    // The admin queue reads by status, oldest first within it.
    await c.query(`
      CREATE INDEX support_tickets_queue
        ON support_tickets (status, created_at)
    `);

    // Referrals move through three states, and each needs its own timestamp
    // because the discount depends on the last one: invited, signed up, and
    // paying. Only the third counts.
    await c.query(`
      CREATE TABLE referrals (
        id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        referrer_id  integer NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        email        text NOT NULL,
        code         text NOT NULL UNIQUE,
        invited_at   timestamptz NOT NULL DEFAULT now(),
        account_id   integer REFERENCES accounts (id) ON DELETE SET NULL,
        signed_up_at timestamptz,
        qualified_at timestamptz
      )
    `);
    // One invite per address per referrer — re-inviting someone should resend,
    // not quietly count twice towards the discount.
    await c.query(`
      CREATE UNIQUE INDEX referrals_referrer_email
        ON referrals (referrer_id, lower(email))
    `);
  },

  async (c) => {
    // Agency is gone. planFor() falls back to Starter for an id it does not
    // recognise, so leaving these rows alone would silently drop an unlimited
    // account to one venue — the kind of change nobody notices until a venue
    // stops working. Enterprise is the nearest tier that still exists.
    await c.query(
      "UPDATE accounts SET plan = 'enterprise', updated_at = $1 WHERE plan = 'agency'",
      [new Date().toISOString()]
    );
  },

  async (c) => {
    // review_events was deliberately narrow — counts and tokens, no text. This
    // reverses that, because a rated list of what the writer produced is the
    // only way to tell good output from bad, and "read them yourself" does not
    // scale past one business.
    //
    // What is stored is a review the guest was about to post publicly anyway.
    // Nothing about the guest is kept: no address, no identifier, no session.
    await c.query('ALTER TABLE review_events ADD COLUMN review_text text');

    // NULL means nobody rated it, which is most of them. Only true and false
    // carry information, so a three-state column beats a boolean defaulting to
    // false — that would read as "everyone disliked it".
    await c.query('ALTER TABLE review_events ADD COLUMN liked boolean');
    await c.query('ALTER TABLE review_events ADD COLUMN rated_at timestamptz');

    // The dashboard's rated list reads "this business, rated, newest first".
    await c.query(`
      CREATE INDEX review_events_rated
        ON review_events (subscriber_id, rated_at DESC)
        WHERE liked IS NOT NULL
    `);
  },
];

// Any constant will do; it only has to be the same in every process.
const MIGRATION_LOCK = 8_274_123;

async function migrate() {
  const client = await pool.connect();

  try {
    // Two processes starting at once — a restart overlapping the old one —
    // would otherwise race to create the same table. The lock is tied to the
    // session, so a crash mid-migration cannot wedge the next boot.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);

    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_version (version integer NOT NULL)'
    );

    const { rows } = await client.query('SELECT version FROM schema_version');
    if (!rows.length) {
      await client.query('INSERT INTO schema_version (version) VALUES (0)');
    }
    const from = rows[0]?.version ?? 0;

    for (let version = from; version < MIGRATIONS.length; version++) {
      // Per step rather than around the whole run: a failure half way leaves
      // the completed steps in place, and the next boot resumes from there.
      await client.query('BEGIN');
      try {
        await MIGRATIONS[version](client);
        await client.query('UPDATE schema_version SET version = $1', [
          version + 1,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    } catch {
      // Releasing the connection drops the lock anyway. Failing here would
      // only mask whatever real error sent us into this block.
    }
    client.release();
  }
}

/**
 * Migrations run once, at require time. Callers that must not query before the
 * schema exists — the server on boot — await this; everything else is reached
 * through a request, by which point it has long since settled.
 */
const ready = migrate();

module.exports = { pool, query, one, all, ready };
