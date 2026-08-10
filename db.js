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
