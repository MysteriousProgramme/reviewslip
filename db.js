'use strict';

const { Pool, types } = require('pg');

/**
 * `date` columns come back as strings, not Date objects.
 *
 * OID 1082 is `date`. Left alone, node-postgres parses it into a JavaScript
 * Date at **local midnight** — so '2026-10-03' read on a machine in Bangkok
 * becomes 2026-10-02T17:00:00Z, and formatting it back through anything
 * UTC-based gives the 2nd. That is the same off-by-one nights.js exists to
 * avoid, arriving through the driver instead of the arithmetic.
 *
 * A calendar date has no time and no zone, so the honest representation is the
 * string Postgres already sent. Set once here, at load, because a parser
 * registered later would apply only to queries made after it.
 */
types.setTypeParser(1082, (value) => value);

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

/**
 * Run `fn` inside a transaction, on one client.
 *
 * The first thing in this codebase to need it. A booking and the room nights it
 * occupies have to land together: half of that is either a stay holding no
 * inventory, or inventory held by no stay, and the second is worse — a room
 * that cannot be sold and has nothing to explain why.
 *
 * `fn` is handed a client with the same `query` shape as the pool, so callers
 * read the same either way. It rolls back on any throw and always releases.
 *
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Best effort: if the connection is what failed, the rollback fails too,
    // and the original error is the one worth reporting.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
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

  async (c) => {
    // Four more places a guest can post. Separate columns rather than one JSON
    // blob, to match google_url and tripadvisor_url: a links column would be
    // tidier but would mean rewriting every reader of those two, and this ships
    // without touching them.
    await c.query('ALTER TABLE subscribers ADD COLUMN line_url text');
    await c.query('ALTER TABLE subscribers ADD COLUMN facebook_url text');
    await c.query('ALTER TABLE subscribers ADD COLUMN xiaohongshu_url text');
    await c.query('ALTER TABLE subscribers ADD COLUMN wongnai_url text');
  },

  async (c) => {
    // The business's own AI context document: free prose about who comes here
    // and what they tend to mention, drafted from the website and then edited by
    // the owner. Distinct from safe_details, which is a list of facts a review
    // may assert; this steers tone and subject matter and asserts nothing.
    //
    // NULL means the business has not written one, which is most of them, and
    // the prompt simply leaves the section out.
    await c.query('ALTER TABLE subscribers ADD COLUMN context_doc text');
  },

  async (c) => {
    // Four colours as JSON — ground, paper, accent, highlight — drafted from the
    // business's own website and then edited. Everything else in the palette is
    // derived from these at request time by theme.js, so a change to the
    // derivation reaches every business without a migration.
    //
    // NULL is a business using the shipped palette, which is most of them, and
    // makes /theme.css an empty file rather than a reconstruction of it.
    await c.query('ALTER TABLE subscribers ADD COLUMN theme text');
  },

  async (c) => {
    // The business's actual typefaces, taken off its own site: JSON holding the
    // family name, the format, where it came from and the file itself in base64.
    //
    // Their own columns rather than fields inside `theme`, because the theme is
    // read whole and handed to the dashboard on every settings load, and a pair
    // of woff2 files is most of a megabyte of base64. These are only ever read
    // by the route that serves them.
    //
    // NULL is a business using a face from the shortlist, which is the fallback
    // whenever a grab was not possible or not permitted.
    await c.query('ALTER TABLE subscribers ADD COLUMN font_display text');
    await c.query('ALTER TABLE subscribers ADD COLUMN font_ui text');
  },

  async (c) => {
    // Stars instead of thumbs. A thumb answers "was this any good" with one bit,
    // which is enough to sort by and not enough to learn from: the four-star
    // review that only needed a word changing was indistinguishable from the
    // one that was simply fine, and both were fed back as equally good.
    await c.query('ALTER TABLE review_events ADD COLUMN rating smallint');
    await c.query(`
      ALTER TABLE review_events
        ADD CONSTRAINT review_events_rating_range
        CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5))
    `);

    // Thumbs up becomes five, since that is what an owner meant by it: use this
    // one. Thumbs down becomes two rather than one — it was "not this", not "the
    // worst thing I have seen", and one should stay available for the reviews an
    // owner actively wants recorded as bad.
    await c.query('UPDATE review_events SET rating = 5 WHERE liked = true');
    await c.query('UPDATE review_events SET rating = 2 WHERE liked = false');

    // `liked` is deliberately left in place. Nothing reads it after this, but a
    // rollback to the previous release needs it to still hold the old answers,
    // and a column of stale booleans costs nothing. Drop it once this has been
    // out long enough that going back is not a plan.

    await c.query(`
      CREATE INDEX review_events_rating
        ON review_events (subscriber_id, rated_at DESC)
        WHERE rating IS NOT NULL
    `);

    // What the writer was working from, per review, so the dashboard can say why
    // a review came out the way it did. The topics were already stored as
    // category_id; these are the other two knobs the guest actually turns.
    await c.query('ALTER TABLE review_events ADD COLUMN language text');
    await c.query('ALTER TABLE review_events ADD COLUMN length text');
  },

  async (c) => {
    // The hero photograph off the business's own site, as JSON holding the mime
    // type, the file in base64, and where it came from.
    //
    // Its own column rather than a field inside `theme` for the same reason the
    // fonts have one: the theme is read whole and handed to the dashboard on
    // every settings load, and half a megabyte of base64 does not belong in it.
    await c.query('ALTER TABLE subscribers ADD COLUMN background text');
  },

  async (c) => {
    // What the owner pasted about their business, when there is no page we can
    // read. A great many small businesses are a Facebook page and nothing else,
    // and Facebook serves a sign-in wall to anything without a session — so the
    // fallback to their listing URL, while correct, usually comes back empty.
    //
    // Pasted text always works. It feeds the same drafting prompts a fetched
    // page would, in place of the fetch.
    await c.query('ALTER TABLE subscribers ADD COLUMN source_text text');
  },

  async (c) => {
    // Topic names in every language the page offers, as JSON:
    //
    //   { "th": { "<topic id>": { "label": "ห้องพัก", "of": "Rooms" } } }
    //
    // A cache, not a setting. A guest picking Thai on a business whose topics
    // are English is the case this exists for, and translating fifty short
    // labels in front of that guest is a model call they would wait for. So the
    // first guest to pick a language pays for it and everyone after them reads
    // this column.
    //
    // `of` is the English label the translation was made from. A label the
    // owner has since edited no longer matches, and a mismatch counts as
    // missing — which is the whole invalidation story, and needs no timestamps.
    await c.query('ALTER TABLE subscribers ADD COLUMN topic_labels text');
  },

  async (c) => {
    // When the guest took this one to a listing.
    //
    // A row is written for every generation, because that is what meters the
    // tokens the business is billed for. But most of those are drafts nobody
    // used: a guest regenerates until they like one, and the nine they passed
    // over are not reviews. Only the one they carried to Google is.
    //
    // So the corpus — the dashboard's list, the five-star examples fed back
    // into the prompt, the sample written away from — reads only rows with
    // this set, while the usage meter keeps reading all of them.
    await c.query('ALTER TABLE review_events ADD COLUMN proceeded_at timestamptz');

    // Everything already stored predates the distinction, and was shown as a
    // review for months. Backfilled rather than orphaned: a dashboard that
    // empties itself on deploy is a bug report, not a migration.
    await c.query('UPDATE review_events SET proceeded_at = created_at');

    await c.query(
      `CREATE INDEX IF NOT EXISTS review_events_proceeded_idx
         ON review_events (subscriber_id, proceeded_at DESC)
         WHERE proceeded_at IS NOT NULL`
    );
  },

  async (c) => {
    // Which listing the review was taken to. A business with four links has
    // four answers, and where a review ended up is the owner's first question
    // about it.
    //
    // Its own step, and not folded into the one above, because that one had
    // already run. Migrations are recorded by index: editing an applied one
    // changes what a fresh database gets and nothing at all on a live box —
    // which is how this column came to be missing on the server while the code
    // that selects it shipped. Append only. There is no exception to this.
    // IF NOT EXISTS because the history is genuinely ambiguous: a database
    // created while the column was still inside the step above already has it,
    // and one created before that does not. Both must survive this.
    await c.query(
      'ALTER TABLE review_events ADD COLUMN IF NOT EXISTS proceeded_to text'
    );
  },

  async (c) => {
    // One account can be the subject of at most one referral. Without this,
    // signing up twice through two different codes — or a retried request —
    // would let two referrers both count the same person towards a discount,
    // and referrals.claim() leans on the constraint rather than on a check it
    // would have to do in a separate statement and hope nothing raced.
    //
    // Partial, because account_id is null for every invitation not yet taken
    // up, and a plain unique index would allow exactly one of those to exist.
    await c.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS referrals_account
        ON referrals (account_id)
        WHERE account_id IS NOT NULL
    `);

    // claim() and qualify() both find rows by these, on every signup and every
    // sign-in. code is already unique and so already indexed; this is the one
    // lookup that would otherwise be a sequential scan.
    await c.query(
      'CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals (referrer_id)'
    );
  },

  async (c) => {
    // A ticket becomes a conversation.
    //
    // support_tickets has held one title and one body since it was created,
    // which is a suggestion box rather than support: nobody could answer. The
    // header stays as it is — append-only, and its two indexes are already the
    // right ones — and the messages hang off it.
    await c.query(`
      CREATE TABLE ticket_messages (
        id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        ticket_id  integer NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
        -- SET NULL rather than cascade: a deleted account must not take the
        -- staff side of the conversation with it, and a thread missing every
        -- other message is not a record of anything.
        author_id  integer REFERENCES accounts (id) ON DELETE SET NULL,
        -- Stored, not derived from the author's is_admin. Derived, every old
        -- reply would change sides the day somebody stops being staff.
        from_staff boolean NOT NULL,
        body       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Every read is one thread in order.
    await c.query(`
      CREATE INDEX ticket_messages_thread
        ON ticket_messages (ticket_id, created_at)
    `);

    // One active ticket per account, enforced here rather than only in code.
    // The check in tickets.js is a read followed by a write, and two requests
    // that interleave between the two would both pass it.
    await c.query(`
      CREATE UNIQUE INDEX support_tickets_one_active
        ON support_tickets (account_id)
        WHERE status <> 'closed'
    `);
  },

  async (c) => {
    // Reservations, slice one.
    //
    // Read nights.js before changing anything here: every date in this step is
    // a `date` and not a `timestamptz`, which disagrees with the rest of this
    // schema deliberately. A night is a calendar date at the property, not an
    // instant. `date_trunc('day', now() AT TIME ZONE 'UTC')` rolls over at
    // 07:00 in Bangkok, so a UTC-derived night is the previous one for seven
    // hours every morning.
    //
    // Which is also why a venue needs to say where it is. Nullable, and the
    // code falls back to Asia/Bangkok — the market this is built for — so no
    // existing row needs touching.
    await c.query("ALTER TABLE subscribers ADD COLUMN timezone text");

    // A room type: what is actually sold, and what an OTA lists. Guests book a
    // Deluxe Double; which one they sleep in is decided later.
    await c.query(`
      CREATE TABLE room_groups (
        id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        subscriber_id integer NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
        name          text NOT NULL,
        capacity      integer NOT NULL DEFAULT 2,
        sort          integer NOT NULL DEFAULT 0,
        -- The channel manager's own id for this type. One column rather than a
        -- mapping table because a channel manager is a single upstream that
        -- fans out to the OTAs itself, so there is one id to hold, not one per
        -- OTA. Nullable until that slice exists; here now so connecting later
        -- is a write and not a migration.
        external_ref  text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )
    `);

    await c.query(`
      CREATE UNIQUE INDEX room_groups_name
        ON room_groups (subscriber_id, lower(name))
    `);

    // Lets `rooms` carry subscriber_id and still be provably consistent with
    // its group's — see the composite foreign key below.
    await c.query(`
      CREATE UNIQUE INDEX room_groups_id_subscriber
        ON room_groups (id, subscriber_id)
    `);

    // A physical room. What housekeeping cleans and what a booking is finally
    // assigned to.
    await c.query(`
      CREATE TABLE rooms (
        id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        subscriber_id integer NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
        group_id      integer NOT NULL,
        name          text NOT NULL,
        -- 'active' or 'out_of_service'. A room being refurbished should stop
        -- taking bookings without being deleted and losing its history.
        status        text NOT NULL DEFAULT 'active',
        sort          integer NOT NULL DEFAULT 0,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        -- subscriber_id is repeated here rather than reached through the group,
        -- because every availability query scopes by venue and the extra join
        -- would be on the hottest path in the module. The composite key is what
        -- makes the duplication safe: a room cannot name a group belonging to
        -- another venue, so the two columns cannot disagree. Without this it
        -- would be a denormalisation held together by hope.
        FOREIGN KEY (group_id, subscriber_id)
          REFERENCES room_groups (id, subscriber_id) ON DELETE CASCADE
      )
    `);

    await c.query(`
      CREATE UNIQUE INDEX rooms_name
        ON rooms (subscriber_id, lower(name))
    `);
    await c.query('CREATE INDEX rooms_group ON rooms (group_id)');

    // A stay. Held against a group from the moment it arrives; room_id is
    // filled in when somebody assigns it, which is what the calendar's drag
    // and drop will do.
    await c.query(`
      CREATE TABLE bookings (
        id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        subscriber_id integer NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
        -- RESTRICT, not CASCADE: a room type with bookings against it must not
        -- be deletable, because that would delete the bookings with it.
        group_id      integer NOT NULL REFERENCES room_groups (id) ON DELETE RESTRICT,
        -- SET NULL: deleting a room unassigns its stays rather than destroying
        -- them. They fall back to the unassigned row on the calendar, which is
        -- recoverable; a lost booking is not.
        room_id       integer REFERENCES rooms (id) ON DELETE SET NULL,
        guest_name    text NOT NULL,
        guest_email   text,
        guest_phone   text,
        adults        integer NOT NULL DEFAULT 1,
        children      integer NOT NULL DEFAULT 0,
        arrival       date NOT NULL,
        departure     date NOT NULL,
        -- confirmed | in_house | checked_out | cancelled | no_show
        status        text NOT NULL DEFAULT 'confirmed',
        -- 'direct' now; the channel the stay came from once there are others.
        source        text NOT NULL DEFAULT 'direct',
        notes         text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        -- One night minimum, in the database. Departure day is not a night, so
        -- departure = arrival is a stay of nothing. See nights.js.
        CONSTRAINT bookings_at_least_one_night CHECK (departure > arrival)
      )
    `);

    // The two questions asked of this table: this venue's arrivals around a
    // date, and one booking by id.
    await c.query(`
      CREATE INDEX bookings_venue_arrival
        ON bookings (subscriber_id, arrival)
    `);

    // The room nights master: one row per room per night.
    //
    // Rows exist only for an assigned booking. An unassigned one holds no
    // room, so it holds no nights — it is counted against its group instead,
    // and shows on the calendar as unassigned.
    await c.query(`
      CREATE TABLE room_nights (
        id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        subscriber_id integer NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
        room_id       integer NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
        night         date NOT NULL,
        booking_id    integer NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);

    // The constraint the whole module rests on: a room can be sold once per
    // night. Overbooking is not something application code has to remember to
    // check — it is refused here, so every path that could cause it fails
    // loudly, including two requests racing.
    //
    // No WHERE clause, because cancelling a booking deletes its nights rather
    // than leaving them behind with a status. The booking row keeps
    // status = 'cancelled' as the record; the inventory goes back immediately.
    await c.query(`
      CREATE UNIQUE INDEX room_nights_room_night
        ON room_nights (room_id, night)
    `);

    // The calendar reads a venue's window of nights in one go.
    await c.query(`
      CREATE INDEX room_nights_venue_night
        ON room_nights (subscriber_id, night)
    `);
    await c.query('CREATE INDEX room_nights_booking ON room_nights (booking_id)');
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

module.exports = { pool, query, one, all, tx, ready };
