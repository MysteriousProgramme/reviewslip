'use strict';

const crypto = require('crypto');

/**
 * A housekeeper's shift: signed, stateless, and short.
 *
 * Not an account, on purpose. Housekeeping is done by whoever is on today,
 * often on a shared phone or a tablet kept on the trolley, and giving each of
 * them a username and a password would mean the venue managing a staff list
 * whose whole purpose is to open one screen. A link and a PIN that the shift
 * shares is what the work actually looks like.
 *
 * Which is also why the token is deliberately weak medicine: it says "somebody
 * who knew today's PIN opened this, for this venue, and it expires tonight".
 * That is the right size of claim. Nothing behind it can read a guest's name,
 * an email or a passport — see housekeeping.js — because a PIN written on a
 * whiteboard is not a secret and the screen is built as though it is known.
 *
 * Stateless, so there is no session table to grow and no cleanup to forget.
 * The cost is that a token cannot be revoked one at a time — but it is bound
 * to the PIN, so changing the PIN ends every shift at once, which is the only
 * revocation anybody would actually reach for.
 */

/** A shift, not a login. Long enough to cover a day, short enough to lapse. */
const HOURS = 14;

function secret() {
  const raw = String(process.env.SECRET_KEY || '').trim();
  // Falls back to nothing usable rather than to a constant. A signing key that
  // is the same on every deployment is worse than no signing at all, because
  // it looks like it works.
  return raw.length === 64 ? Buffer.from(raw, 'hex') : null;
}

function b64(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

/**
 * The key a token is signed with.
 *
 * The venue's stored PIN hash is mixed in, so changing the PIN changes every
 * signature and ends every shift that was opened with the old one. That is the
 * revocation a manager means when they change it after somebody leaves.
 */
function signingKey(pinHash) {
  const base = secret();
  if (!base) return null;
  return crypto.createHmac('sha256', base).update(String(pinHash ?? '')).digest();
}

/** @returns {string|null} a token, or null when SECRET_KEY is not usable */
function issue({ subscriberId, pinHash, now = Date.now() }) {
  const key = signingKey(pinHash);
  if (!key) return null;

  const body = b64(
    JSON.stringify({ v: 1, s: Number(subscriberId), x: now + HOURS * 3_600_000 })
  );
  const mac = b64(crypto.createHmac('sha256', key).update(body).digest());
  return `${body}.${mac}`;
}

/**
 * @returns {{ok: true, subscriberId: number}|{ok: false, error: string}}
 *   A reason rather than a boolean, because "your shift has ended" and "that
 *   link is not for this venue" send somebody to different places.
 */
function open(token, { pinHash, subscriberId, now = Date.now() } = {}) {
  const key = signingKey(pinHash);
  if (!key) return { ok: false, error: 'not configured' };

  const [body, mac] = String(token ?? '').split('.');
  if (!body || !mac) return { ok: false, error: 'signed out' };

  const expected = Buffer.from(
    crypto.createHmac('sha256', key).update(body).digest('base64url'),
    'base64url'
  );
  const given = Buffer.from(mac, 'base64url');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, error: 'signed out' };
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'signed out' };
  }

  if (claims?.v !== 1) return { ok: false, error: 'signed out' };
  if (!(Number(claims.x) > now)) return { ok: false, error: 'shift ended' };
  if (Number(claims.s) !== Number(subscriberId)) {
    return { ok: false, error: 'wrong venue' };
  }

  return { ok: true, subscriberId: Number(claims.s) };
}

/* -------------------------------------------------------------------- PINs */

/**
 * Six digits. Not four to eight.
 *
 * A range meant the field had to explain itself — "4 to 8 digits" as
 * placeholder text, which at the letter-spacing a PIN field wants read as a
 * row of spread-out letters and left people thinking letters were allowed.
 * One fixed length needs no explaining: the field can show six slots and be
 * understood without a word.
 *
 * Six rather than four is also worth an order of magnitude against guessing.
 * Four digits is ten thousand possibilities, which the eight-tries-per-ten-
 * minutes throttle holds off for about a fortnight of continuous attempts; six
 * is a million, which is years. This PIN is shared and rarely changed, so it
 * has to survive being left alone.
 */
const PIN_LENGTH = 6;

/**
 * @returns {string|null} the reason it will not do, or null if it will
 */
function checkPin(value) {
  const pin = String(value ?? '').trim();
  if (!/^\d*$/.test(pin)) return 'A PIN is digits only.';
  if (pin.length !== PIN_LENGTH) return `A PIN is ${PIN_LENGTH} digits.`;

  // The ones somebody picks when they are not thinking, and the ones an
  // attacker tries first. Refused rather than warned about, because this PIN
  // is shared and nobody is going to come back and change it.
  if (/^(\d)\1+$/.test(pin)) return 'That PIN is one repeated digit.';
  if ('01234567890'.includes(pin) || '09876543210'.includes(pin)) {
    return 'That PIN is a run of digits in order.';
  }
  // 123123, 121212, 454545 — a short pattern repeated. It looks random at a
  // glance and is not, and a six-digit box invites exactly this.
  if (/^(\d{1,3})\1+$/.test(pin)) return 'That PIN repeats a short pattern.';
  return null;
}

module.exports = { issue, open, checkPin, HOURS, PIN_LENGTH };
