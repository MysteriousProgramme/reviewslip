'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * The SQLite handle, plus the schema migrations.
 *
 * One file on disk, opened once at require time. It holds every subscriber's
 * OpenRouter key in plain text — the same exposure `settings.json` had, only
 * now it is one file for many venues, so it belongs on the machine that runs
 * the app and nowhere else.
 */

const FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, 'data', 'app.db');

fs.mkdirSync(path.dirname(FILE), { recursive: true });

const db = new Database(FILE);

// WAL so a slow read (the admin listing) never blocks a guest's write.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

try {
  fs.chmodSync(FILE, 0o600);
} catch {
  // Windows maps modes onto ACLs only loosely, and a failure here is not worth
  // refusing to boot over. The file still sits wherever the operator put it.
}

/* -------------------------------------------------------------- migrations */

/**
 * Append-only. Each entry moves the schema forward by one, and `user_version`
 * records how far we have gone — so a fresh file and an existing one take the
 * same path.
 */
const MIGRATIONS = [
  (d) => {
    d.exec(`
      CREATE TABLE subscribers (
        id          INTEGER PRIMARY KEY,
        slug        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'active',
        api_key     TEXT,
        model       TEXT,
        google_url  TEXT,
        website_url TEXT,
        token_hash  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE UNIQUE INDEX subscribers_slug ON subscribers (slug);
    `);
  },

  (d) => {
    d.exec(`
      ALTER TABLE subscribers ADD COLUMN tripadvisor_url TEXT;
      -- A JSON array of {id, label, focus}. NULL means "use the built-in set",
      -- which is what every existing row wants.
      ALTER TABLE subscribers ADD COLUMN categories TEXT;
    `);
  },
];

function migrate() {
  const from = db.pragma('user_version', { simple: true });

  for (let version = from; version < MIGRATIONS.length; version++) {
    const step = db.transaction(() => {
      MIGRATIONS[version](db);
      db.pragma(`user_version = ${version + 1}`);
    });
    step();
  }
}

migrate();

module.exports = db;
module.exports.FILE = FILE;
