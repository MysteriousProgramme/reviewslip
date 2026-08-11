'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const { query, one } = require('./db');
const plans = require('./plans');

/**
 * Customer accounts and their sessions.
 *
 * An account owns venues. Signing in gets a session token, which the website
 * keeps in an httpOnly cookie and presents on every call — so the website never
 * asserts who someone is, it forwards a token this file checks.
 */

const scrypt = promisify(crypto.scrypt);

/* -------------------------------------------------------------- credentials */

// 3–20 characters, and at least one of each: lowercase, uppercase, digit,
// symbol. A username is public-ish, so this is really a "pick something
// deliberate" rule rather than a security control.
const USERNAME_LENGTH = { min: 3, max: 20 };
const USERNAME_CLASSES = [
  [/[a-z]/, 'a lowercase letter'],
  [/[A-Z]/, 'an uppercase letter'],
  [/\d/, 'a number'],
  [/[^A-Za-z0-9]/, 'a symbol'],
];

// Passwords are checked by length alone, on purpose. Composition rules push
// people towards P@ssw0rd1; length is what actually costs an attacker.
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;

// Deliberately loose. The only email check that means anything is sending one.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @returns {{ok: boolean, error?: string}} */
function checkUsername(value) {
  const username = String(value ?? '').trim();

  if (username.length < USERNAME_LENGTH.min || username.length > USERNAME_LENGTH.max) {
    return {
      ok: false,
      error: `A username is ${USERNAME_LENGTH.min}–${USERNAME_LENGTH.max} characters.`,
    };
  }
  if (/\s/.test(username)) {
    return { ok: false, error: 'A username cannot contain spaces.' };
  }

  const missing = USERNAME_CLASSES.filter(([re]) => !re.test(username)).map(
    ([, label]) => label
  );
  if (missing.length) {
    return { ok: false, error: `A username needs ${listOf(missing)}.` };
  }
  return { ok: true };
}

/** @returns {{ok: boolean, error?: string}} */
function checkPassword(value) {
  const password = String(value ?? '');
  if (password.length < PASSWORD_MIN) {
    return {
      ok: false,
      error: `A password is at least ${PASSWORD_MIN} characters.`,
    };
  }
  if (password.length > PASSWORD_MAX) {
    return { ok: false, error: 'That password is too long.' };
  }
  return { ok: true };
}

/** @returns {{ok: boolean, error?: string}} */
function checkEmail(value) {
  const email = String(value ?? '').trim();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { ok: false, error: 'That does not look like an email address.' };
  }
  return { ok: true };
}

function listOf(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/* ---------------------------------------------------------------- passwords */

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * scrypt rather than a bcrypt dependency: it is in node's standard library,
 * memory-hard, and the async form keeps the event loop free while it runs.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Constant-time, and false rather than throwing on a malformed stored value. */
async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(
    String(password ?? ''),
    Buffer.from(saltHex, 'hex'),
    expected.length
  );
  return crypto.timingSafeEqual(expected, actual);
}

/* ----------------------------------------------------------------- sessions */

const SESSION_PREFIX = 'rvs_';
const SESSION_DAYS = 30;

function newSessionToken() {
  return SESSION_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/* ------------------------------------------------------------------ errors */

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

/* ------------------------------------------------------------------- shape */

/** What the website may see. Never the hash. */
function toRecord(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    plan: row.plan,
    status: row.status,
    createdAt: row.created_at,
  };
}

function now() {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------- read */

async function byId(id) {
  return one('SELECT * FROM accounts WHERE id = $1', [id]);
}

/** Either identifier signs you in — people remember one or the other. */
async function byLogin(identifier) {
  const value = String(identifier || '').trim().toLowerCase();
  if (!value) return null;
  return one(
    'SELECT * FROM accounts WHERE lower(email) = $1 OR lower(username) = $1',
    [value]
  );
}

/* ------------------------------------------------------------------ create */

/**
 * @param {object} input - email, username, password, and optionally plan
 * @returns {Promise<object>} the account record
 */
async function create(input = {}) {
  const email = String(input.email || '').trim();
  const username = String(input.username || '').trim();

  for (const check of [
    checkEmail(email),
    checkUsername(username),
    checkPassword(input.password),
  ]) {
    if (!check.ok) throw fail(400, check.error);
  }

  const plan = plans.isPlan(input.plan) ? input.plan : plans.DEFAULT_PLAN;
  const stamp = now();

  let row;
  try {
    row = await one(
      `INSERT INTO accounts (email, username, password_hash, plan, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [email, username, await hashPassword(input.password), plan, stamp]
    );
  } catch (err) {
    if (err?.code === '23505') {
      // Two unique indexes, and which one it was changes what the person has to
      // fix — so say, rather than a generic "already taken".
      throw fail(
        409,
        String(err.constraint).includes('username')
          ? 'That username is taken.'
          : 'There is already an account with that email.'
      );
    }
    throw err;
  }

  return toRecord(row);
}

/* ------------------------------------------------------------------- login */

/**
 * @returns {Promise<{account: object, token: string, expiresAt: string}>}
 * @throws 401 for both a missing account and a wrong password, deliberately —
 *   distinguishing them tells an attacker which emails are registered.
 */
async function login(identifier, password) {
  const row = await byLogin(identifier);

  // Hash anyway when the account does not exist, so the failure takes about as
  // long either way and cannot be timed to enumerate accounts.
  const ok = row
    ? await verifyPassword(password, row.password_hash)
    : await verifyPassword(password, `scrypt$${'00'.repeat(SALT_BYTES)}$${'00'.repeat(SCRYPT_KEYLEN)}`);

  if (!row || !ok) throw fail(401, 'Wrong email, username, or password.');
  if (row.status !== 'active') throw fail(403, 'This account is not active.');

  return { account: toRecord(row), ...(await startSession(row.id)) };
}

async function startSession(accountId) {
  const token = newSessionToken();
  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  await query(
    'INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), accountId, expiresAt]
  );

  return { token, expiresAt };
}

/** @returns {Promise<object|null>} the account behind a session token */
async function fromSession(token) {
  if (typeof token !== 'string' || !token) return null;

  const row = await one(
    `SELECT a.*
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );

  return row && row.status === 'active' ? row : null;
}

async function endSession(token) {
  if (typeof token !== 'string' || !token) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/** Housekeeping. Expired rows are harmless but they accumulate. */
async function pruneSessions() {
  const result = await query('DELETE FROM sessions WHERE expires_at <= now()');
  return result.rowCount;
}

/* ------------------------------------------------------------------ update */

async function setPassword(accountId, password) {
  const check = checkPassword(password);
  if (!check.ok) throw fail(400, check.error);

  await query(
    'UPDATE accounts SET password_hash = $1, updated_at = $2 WHERE id = $3',
    [await hashPassword(password), now(), accountId]
  );
  // Every other browser is signed out. Changing a password is usually a
  // response to losing control of it, so leaving the old sessions alive would
  // defeat the point.
  await query('DELETE FROM sessions WHERE account_id = $1', [accountId]);
}

async function setPlan(accountId, planId) {
  if (!plans.isPlan(planId)) throw fail(400, 'No such plan.');

  const row = await one(
    'UPDATE accounts SET plan = $1, updated_at = $2 WHERE id = $3 RETURNING *',
    [planId, now(), accountId]
  );
  if (!row) throw fail(404, 'No such account.');
  return toRecord(row);
}

module.exports = {
  USERNAME_LENGTH,
  PASSWORD_MIN,
  checkUsername,
  checkPassword,
  checkEmail,
  hashPassword,
  verifyPassword,
  toRecord,
  byId,
  byLogin,
  create,
  login,
  startSession,
  fromSession,
  endSession,
  pruneSessions,
  setPassword,
  setPlan,
};
