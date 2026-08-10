'use strict';

require('dotenv').config();

const path = require('path');
const Database = require('better-sqlite3');

const { query, pool, ready } = require('../db');

/**
 * One-off: copy subscribers out of the old SQLite file into Postgres.
 *
 * Run it once, after DATABASE_URL is set and before the app is restarted on the
 * new store. Safe to run twice — a slug that already exists in Postgres is left
 * exactly as it is, so a half-finished run can simply be repeated.
 *
 *   node scripts/import-sqlite.js [path/to/app.db]
 *
 * better-sqlite3 is a devDependency now, so on a server installed with
 * `--omit=dev` this needs a plain `npm install` first.
 */

const FILE =
  process.argv[2] ||
  process.env.DB_FILE ||
  path.join(__dirname, '..', 'data', 'app.db');

// The columns as they stood at the last SQLite migration. Named explicitly
// rather than `SELECT *` so a stray column in an older file cannot silently
// shift the values.
const COLUMNS = [
  'slug',
  'name',
  'status',
  'api_key',
  'model',
  'google_url',
  'tripadvisor_url',
  'website_url',
  'categories',
  'token_hash',
  'created_at',
  'updated_at',
];

const INSERT = `
  INSERT INTO subscribers (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
  ON CONFLICT (slug) DO NOTHING
`;

async function main() {
  await ready;

  let sqlite;
  try {
    sqlite = new Database(FILE, { readonly: true, fileMustExist: true });
  } catch {
    console.error(`No readable SQLite file at ${FILE}. Nothing to import.`);
    process.exitCode = 1;
    return;
  }

  const rows = sqlite
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM subscribers ORDER BY id`)
    .all();
  sqlite.close();

  if (!rows.length) {
    console.log(`${FILE} holds no subscribers. Nothing to import.`);
    return;
  }

  let copied = 0;
  let skipped = 0;

  for (const row of rows) {
    const result = await query(
      INSERT,
      COLUMNS.map((column) => row[column] ?? null)
    );

    if (result.rowCount) {
      copied += 1;
      console.log(`  copied  ${row.slug}`);
    } else {
      skipped += 1;
      console.log(`  exists  ${row.slug}  (left alone)`);
    }
  }

  console.log(
    `\n${copied} copied, ${skipped} already present, from ${rows.length} in ${FILE}.`
  );
  console.log(
    'Settings tokens carry over unchanged — the hash moves with the row.'
  );
}

main()
  .catch((err) => {
    console.error('Import failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
