'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { query, one, all } = require('./db');
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
//
// The second row is different: those are path segments under /dashboard on the
// website. A static route outranks a dynamic one, so a venue called `billing`
// would exist and serve guests perfectly well while being permanently
// unreachable from its owner's dashboard — the worst kind of bug, because
// nothing anywhere would report it.
const RESERVED = new Set([
  'www', 'admin', 'api', 'app', 'apps', 'dashboard', 'static', 'assets', 'cdn',
  'mail', 'smtp', 'imap', 'ftp', 'ns', 'ns1', 'ns2', 'support', 'help',
  'status', 'blog', 'docs', 'test', 'staging', 'dev', 'localhost',

  'billing', 'venues', 'businesses', 'account', 'plans', 'pricing', 'login', 'signup',
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
  lineUrl: 'line_url',
  facebookUrl: 'facebook_url',
  xiaohongshuUrl: 'xiaohongshu_url',
  wongnaiUrl: 'wongnai_url',
  kind: 'kind',
  place: 'place',
  contextDoc: 'context_doc',
};

// The columns holding a JSON list rather than a scalar, by settings field.
const LISTS = {
  categories: 'categories',
  safeDetails: 'safe_details',
};

// JSON too, but an object rather than a list, so it needs its own parse: an
// empty object is meaningful where an empty list is not.
const OBJECTS = {
  theme: 'theme',
  fontDisplay: 'font_display',
  fontUi: 'font_ui',
};

/** A row's own stored settings, in the shape settings.js works with. */
function own(row) {
  const out = {};
  for (const [field, column] of Object.entries(COLUMNS)) {
    if (row?.[column]) out[field] = row[column];
  }
  for (const [field, column] of Object.entries(LISTS)) {
    const list = parseList(row?.[column], field);
    if (list) out[field] = list;
  }
  for (const [field, column] of Object.entries(OBJECTS)) {
    const object = parseObject(row?.[column], field);
    if (object) out[field] = object;
  }

  return out;
}

/** @returns {object|null} null for unset or unparseable — both mean "not set". */
function parseObject(json, what) {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  } catch {
    console.error(`Ignoring unreadable ${what} JSON in the store.`);
    return null;
  }
}

/**
 * Lists live in one JSON column rather than tables of their own: they are read
 * whole, written whole, and never queried across venues.
 *
 * @returns {any[]|null} null for unset, empty, or unparseable — all three mean
 *   "fall back to the built-in" rather than "show nothing".
 */
function parseList(json, what) {
  if (!json) return null;
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) && list.length ? list : null;
  } catch {
    console.error(`Ignoring unreadable ${what} JSON in the store.`);
    return null;
  }
}

/** @returns {string|null} the column value for a validated list */
function packList(list) {
  return list?.length ? JSON.stringify(list) : null;
}

/** The values to actually use for this subscriber, real API key included. */
function settingsFor(row) {
  return settings.resolve(own(row));
}

/**
 * Who the writer is writing about. `name` comes off the row rather than the
 * settings chain — every subscriber has one, so there is nothing to fall back
 * to — while the rest resolve down to config.js for a venue that has not
 * described itself yet.
 */
function venueFor(row) {
  const resolved = settings.resolve(own(row));
  return {
    name: row.name,
    kind: resolved.kind,
    place: resolved.place,
    safeDetails: resolved.safeDetails,
    contextDoc: resolved.contextDoc,
  };
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
    accountId: row.account_id ?? null,
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
  all: 'SELECT * FROM subscribers ORDER BY slug',
  bySlug: 'SELECT * FROM subscribers WHERE slug = $1',
  // Cast, or the driver hands back COUNT's bigint as a string.
  count: 'SELECT COUNT(*)::int AS n FROM subscribers',
  byAccount: 'SELECT * FROM subscribers WHERE account_id = $1 ORDER BY slug',
  countForAccount:
    'SELECT COUNT(*)::int AS n FROM subscribers WHERE account_id = $1',
  insert: `
    INSERT INTO subscribers
      (slug, name, status, account_id, api_key, model, google_url,
       tripadvisor_url, website_url, categories, kind, place, safe_details,
       context_doc, token_hash, created_at, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
  `,
  remove: 'DELETE FROM subscribers WHERE slug = $1',
  setToken:
    'UPDATE subscribers SET token_hash = $1, updated_at = $2 WHERE slug = $3',
};

function now() {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------- read */

async function get(slug) {
  if (typeof slug !== 'string' || !slug) return null;
  return one(Q.bySlug, [slug.trim().toLowerCase()]);
}

async function list() {
  return (await all(Q.all)).map(toRecord);
}

async function count() {
  return (await one(Q.count)).n;
}

/** The rows themselves, not records — the dashboard needs ids for the meter. */
async function listForAccount(accountId) {
  return all(Q.byAccount, [accountId]);
}

async function countForAccount(accountId) {
  return (await one(Q.countForAccount, [accountId])).n;
}

/* ------------------------------------------------------------------- write */

/**
 * @param {object} input - slug, name, status, and any of the settings fields
 * @returns {{record: object, token: string}} the token is shown once, here
 */
async function create(input = {}) {
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
    await query(Q.insert, [
      slug,
      name,
      status,
      Number.isInteger(input.accountId) ? input.accountId : null,
      values.apiKey || null,
      values.model || null,
      values.googleUrl || null,
      values.tripadvisorUrl || null,
      values.websiteUrl || null,
      packList(check.categories),
      values.kind || null,
      values.place || null,
      packList(check.safeDetails),
      values.contextDoc || null,
      hashToken(token),
      now(),
    ]);
  } catch (err) {
    // 23505 is unique_violation, and `slug` carries the only unique constraint
    // on the table.
    if (err?.code === '23505') {
      throw fail(409, `"${slug}" is taken. Pick another address.`);
    }
    throw err;
  }

  return { record: toRecord(await get(slug)), token };
}

/**
 * Applies a validated patch. A field left out is untouched; a field set to ''
 * is cleared, falling back to .env and then the built-in.
 *
 * @returns {object} the updated record
 */
async function update(slug, patch = {}) {
  const row = await get(slug);
  if (!row) throw fail(404, 'No subscriber at that address.');

  const check = settings.validate(patch);
  if (!check.ok) throw fail(400, check.error);

  const sets = [];
  const args = [];

  // Placeholders are numbered rather than positional, so each one is written
  // from how many arguments have been collected so far.
  const next = (value) => {
    args.push(value);
    return `$${args.length}`;
  };

  for (const [field, column] of Object.entries(COLUMNS)) {
    if (typeof patch[field] !== 'string') continue;
    const value = patch[field].trim();
    sets.push(`${column} = ${next(value || null)}`);
  }

  // An explicit null, or a list that emptied out, resets to the built-in set.
  for (const [field, column] of Object.entries(LISTS)) {
    if (patch[field] === undefined) continue;
    sets.push(`${column} = ${next(packList(check[field]))}`);
  }

  // Same contract for the theme: sending null clears it, and clearing it puts
  // the business back on the shipped palette.
  for (const [field, column] of Object.entries(OBJECTS)) {
    if (patch[field] === undefined) continue;
    sets.push(`${column} = ${next(check[field] ? JSON.stringify(check[field]) : null)}`);
  }

  if (typeof patch.name === 'string') {
    const name = patch.name.trim();
    if (!name) throw fail(400, 'A subscriber needs a name.');
    if (name.length > 120) throw fail(400, 'That name is too long.');
    sets.push(`name = ${next(name)}`);
  }

  if (patch.status !== undefined) {
    sets.push(`status = ${next(readStatus(patch.status))}`);
  }

  if (!sets.length) return toRecord(row);

  sets.push(`updated_at = ${next(now())}`);

  await query(
    `UPDATE subscribers SET ${sets.join(', ')} WHERE slug = ${next(row.slug)}`,
    args
  );

  return toRecord(await get(row.slug));
}

async function remove(slug) {
  const result = await query(Q.remove, [
    String(slug || '').trim().toLowerCase(),
  ]);
  return result.rowCount > 0;
}

/** Invalidates the old token immediately. @returns {string} the new one */
async function rotateToken(slug) {
  const row = await get(slug);
  if (!row) throw fail(404, 'No subscriber at that address.');

  const token = newToken();
  await query(Q.setToken, [hashToken(token), now(), row.slug]);
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
async function importLegacyFile(slug = 'venue', name = 'Venue') {
  if ((await count()) > 0) return null;

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
  venueFor,
  describe,
  toRecord,
  get,
  list,
  count,
  listForAccount,
  countForAccount,
  create,
  update,
  remove,
  rotateToken,
  importLegacyFile,
};
