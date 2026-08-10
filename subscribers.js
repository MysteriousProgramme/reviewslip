'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const settings = require('./settings');

/**
 * The subscriber store: one row per venue, holding that venue's OpenRouter
 * settings and the token that lets it edit them.
 *
 * Settings are stored sparsely — a column left NULL means "not set for this
 * subscriber", which falls through to .env and then the built-in. That is why
 * clearing a field deletes it rather than writing an empty string.
 */

/* ------------------------------------------------------------------- slugs */

// A slug is a DNS label: it becomes the subdomain a guest's QR code points at,
// so it has to be legal in a hostname, not merely legal in a URL path.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// Names that belong to the platform rather than to any venue. Handing one out
// would shadow the apex site or the admin host.
const RESERVED = new Set([
  'www', 'admin', 'api', 'app', 'apps', 'dashboard', 'static', 'assets', 'cdn',
  'mail', 'smtp', 'imap', 'ftp', 'ns', 'ns1', 'ns2', 'support', 'help',
  'status', 'blog', 'docs', 'test', 'staging', 'dev', 'localhost',
]);

/** @returns {{ok: boolean, error?: string}} */
function checkSlug(slug) {
  if (typeof slug !== 'string' || !slug.trim()) {
    return { ok: false, error: 'A subscriber needs an address (slug).' };
  }
  const value = slug.trim().toLowerCase();

  if (!SLUG_RE.test(value)) {
    return {
      ok: false,
      error:
        'An address is 1–32 characters, lowercase letters, digits and hyphens, not starting or ending with a hyphen.',
    };
  }
  if (RESERVED.has(value)) {
    return { ok: false, error: `"${value}" is reserved. Pick another address.` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ tokens */

const TOKEN_PREFIX = 'rvw_';

/**
 * Tokens are shown once, at create and at rotate, and only the hash is kept.
 * A leaked database therefore hands over the OpenRouter keys but not the
 * ability to keep editing settings — those are separate losses.
 */
function newToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Constant-time; false for a missing row or a missing token. */
function verifyToken(row, token) {
  if (!row?.token_hash || typeof token !== 'string' || !token) return false;

  const presented = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(row.token_hash, 'hex');
  if (presented.length !== stored.length) return false;

  return crypto.timingSafeEqual(presented, stored);
}

/* --------------------------------------------------------------- row shape */

const COLUMNS = {
  apiKey: 'api_key',
  model: 'model',
  googleUrl: 'google_url',
  tripadvisorUrl: 'tripadvisor_url',
  websiteUrl: 'website_url',
};

/** A row's own stored settings, in the shape settings.js works with. */
function own(row) {
  const out = {};
  for (const [field, column] of Object.entries(COLUMNS)) {
    if (row?.[column]) out[field] = row[column];
  }

  const categories = parseCategories(row?.categories);
  if (categories) out.categories = categories;

  return out;
}

/**
 * Categories live in one JSON column rather than a table of their own: they
 * are read whole, written whole, and never queried across venues.
 *
 * @returns {object[]|null} null for unset, empty, or unparseable — all three
 *   mean "fall back to the built-in set" rather than "show no buttons".
 */
function parseCategories(json) {
  if (!json) return null;
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) && list.length ? list : null;
  } catch {
    console.error('Ignoring unreadable categories JSON in the store.');
    return null;
  }
}

/** @returns {string|null} the column value for a validated list */
function packCategories(list) {
  return list?.length ? JSON.stringify(list) : null;
}

/** The values to actually use for this subscriber, real API key included. */
function settingsFor(row) {
  return settings.resolve(own(row));
}

/** Panel-safe: masked key, plus where each value came from. */
function describe(row) {
  return settings.describe(own(row));
}

/** What the admin API returns. Never includes the key or the token. */
function toRecord(row) {
  return {
    slug: row.slug,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settings: describe(row),
  };
}

/* ------------------------------------------------------------------ errors */

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

/* ------------------------------------------------------------------ queries */

const Q = {
  all: db.prepare('SELECT * FROM subscribers ORDER BY slug'),
  bySlug: db.prepare('SELECT * FROM subscribers WHERE slug = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM subscribers'),
  insert: db.prepare(`
    INSERT INTO subscribers
      (slug, name, status, api_key, model, google_url, tripadvisor_url,
       website_url, categories, token_hash, created_at, updated_at)
    VALUES
      (@slug, @name, @status, @api_key, @model, @google_url, @tripadvisor_url,
       @website_url, @categories, @token_hash, @now, @now)
  `),
  remove: db.prepare('DELETE FROM subscribers WHERE slug = ?'),
  setToken: db.prepare(
    'UPDATE subscribers SET token_hash = ?, updated_at = ? WHERE slug = ?'
  ),
};

function now() {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------- read */

function get(slug) {
  if (typeof slug !== 'string' || !slug) return null;
  return Q.bySlug.get(slug.trim().toLowerCase()) || null;
}

function list() {
  return Q.all.all().map(toRecord);
}

function count() {
  return Q.count.get().n;
}

/* ------------------------------------------------------------------- write */

/**
 * @param {object} input - slug, name, status, and any of the settings fields
 * @returns {{record: object, token: string}} the token is shown once, here
 */
function create(input = {}) {
  const slug = String(input.slug || '').trim().toLowerCase();
  const slugCheck = checkSlug(slug);
  if (!slugCheck.ok) throw fail(400, slugCheck.error);

  const name = String(input.name || '').trim();
  if (!name) throw fail(400, 'A subscriber needs a name.');
  if (name.length > 120) throw fail(400, 'That name is too long.');

  const status = readStatus(input.status);
  const check = settings.validate(input);
  if (!check.ok) throw fail(400, check.error);

  const values = settings.clean(input);
  const token = newToken();

  try {
    Q.insert.run({
      slug,
      name,
      status,
      api_key: values.apiKey || null,
      model: values.model || null,
      google_url: values.googleUrl || null,
      tripadvisor_url: values.tripadvisorUrl || null,
      website_url: values.websiteUrl || null,
      categories: packCategories(check.categories),
      token_hash: hashToken(token),
      now: now(),
    });
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      throw fail(409, `"${slug}" is taken. Pick another address.`);
    }
    throw err;
  }

  return { record: toRecord(get(slug)), token };
}

/**
 * Applies a validated patch. A field left out is untouched; a field set to ''
 * is cleared, falling back to .env and then the built-in.
 *
 * @returns {object} the updated record
 */
function update(slug, patch = {}) {
  const row = get(slug);
  if (!row) throw fail(404, 'No subscriber at that address.');

  const check = settings.validate(patch);
  if (!check.ok) throw fail(400, check.error);

  const sets = [];
  const args = [];

  for (const [field, column] of Object.entries(COLUMNS)) {
    if (typeof patch[field] !== 'string') continue;
    const value = patch[field].trim();
    sets.push(`${column} = ?`);
    args.push(value || null);
  }

  // An explicit null, or a list that emptied out, resets to the built-in set.
  if (patch.categories !== undefined) {
    sets.push('categories = ?');
    args.push(packCategories(check.categories));
  }

  if (typeof patch.name === 'string') {
    const name = patch.name.trim();
    if (!name) throw fail(400, 'A subscriber needs a name.');
    if (name.length > 120) throw fail(400, 'That name is too long.');
    sets.push('name = ?');
    args.push(name);
  }

  if (patch.status !== undefined) {
    sets.push('status = ?');
    args.push(readStatus(patch.status));
  }

  if (!sets.length) return toRecord(row);

  sets.push('updated_at = ?');
  args.push(now(), row.slug);

  db.prepare(
    `UPDATE subscribers SET ${sets.join(', ')} WHERE slug = ?`
  ).run(...args);

  return toRecord(get(row.slug));
}

function remove(slug) {
  return Q.remove.run(String(slug || '').trim().toLowerCase()).changes > 0;
}

/** Invalidates the old token immediately. @returns {string} the new one */
function rotateToken(slug) {
  const row = get(slug);
  if (!row) throw fail(404, 'No subscriber at that address.');

  const token = newToken();
  Q.setToken.run(hashToken(token), now(), row.slug);
  return token;
}

function readStatus(value) {
  if (value === undefined || value === null || value === '') return 'active';
  const status = String(value).trim().toLowerCase();
  if (status !== 'active' && status !== 'suspended') {
    throw fail(400, 'Status is either "active" or "suspended".');
  }
  return status;
}

/* ------------------------------------------------- one-time legacy import */

/**
 * Carries a single-tenant install forward. The old app kept one venue's
 * settings in settings.json; if that file is still around and no subscribers
 * exist yet, it becomes the first one so the install keeps working.
 *
 * @returns {{record: object, token: string}|null} null when there is nothing
 *   to import, so the caller can stay quiet on every boot after the first.
 */
function importLegacyFile(slug = 'venue', name = 'Venue') {
  if (count() > 0) return null;

  const file = path.join(__dirname, 'settings.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }

  const values = settings.clean(raw);
  if (!Object.keys(values).length) return null;

  return create({ slug, name, ...values });
}

module.exports = {
  SLUG_RE,
  RESERVED,
  checkSlug,
  verifyToken,
  own,
  settingsFor,
  describe,
  toRecord,
  get,
  list,
  count,
  create,
  update,
  remove,
  rotateToken,
  importLegacyFile,
};
