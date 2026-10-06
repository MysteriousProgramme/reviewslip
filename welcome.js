'use strict';

const crypto = require('crypto');
const csv = require('./csv');

/**
 * The welcome page: the rules, with no database and no Express.
 *
 * A guest scans a QR code in the room or on the table, gives their name and
 * email, and gets the venue's links — the Wi-Fi, the menu, the website — and a
 * way to keep the page on their phone. The venue chooses the links in the
 * dashboard and downloads the email addresses as a mailing list.
 *
 * Name and email are required before the links show; that was the venue's
 * call, made knowing it costs some guests. Marketing is a separate, unticked
 * box: an email given to see the Wi-Fi is not permission to send newsletters,
 * and the mailing list holds only the people who said yes (Thailand's PDPA).
 */

/* ------------------------------------------------------------------- links */

const MAX_LINKS = 20;
const MAX_LABEL = 40;
const MAX_URL = 500;

/**
 * What a link may point at.
 *
 * Web pages, a phone number and an email address. Not `javascript:` or `data:`,
 * which on a page every guest opens would be a way for whoever has the
 * dashboard login to run script in a stranger's browser.
 */
const SCHEMES = new Set(['https:', 'http:', 'tel:', 'mailto:']);

/**
 * The venue's links as it saved them, checked.
 *
 * A row with neither a label nor an address is one somebody added and left
 * empty, and is dropped rather than refused. Order is kept: it is the order the
 * guest sees them in.
 *
 * @param {unknown} value
 * @returns {{ok: true, links: {label: string, url: string}[]}|{ok: false, error: string}}
 */
function validateLinks(value) {
  if (!Array.isArray(value)) return { ok: false, error: 'Links must be a list.' };

  const links = [];
  for (const item of value) {
    const label = String(item?.label ?? '').trim().replace(/\s+/g, ' ');
    const raw = String(item?.url ?? '').trim();
    if (!label && !raw) continue;

    if (!label) return { ok: false, error: `Give the link to ${raw.slice(0, 40)} a name.` };
    if (label.length > MAX_LABEL) {
      return { ok: false, error: `"${label.slice(0, 20)}…" is too long for a button. Keep it under ${MAX_LABEL} characters.` };
    }
    if (!raw) return { ok: false, error: `"${label}" needs an address.` };
    if (raw.length > MAX_URL) return { ok: false, error: `The address for "${label}" is too long.` };

    const url = normaliseUrl(raw);
    if (!url) {
      return { ok: false, error: `"${raw.slice(0, 40)}" is not an address a phone can open. Start it with https://` };
    }
    links.push({ label, url });
  }

  if (links.length > MAX_LINKS) {
    return { ok: false, error: `That is more than ${MAX_LINKS} links. A guest scrolls past the rest.` };
  }
  return { ok: true, links };
}

/**
 * An address a guest's phone can open, or null.
 *
 * A bare domain gets https:// — "baanponglodge.com" is what people type, and
 * refusing it would be pedantry. Anything with a scheme must use one of the
 * allowed ones.
 */
function normaliseUrl(raw) {
  const text = String(raw ?? '').trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (!SCHEMES.has(url.protocol)) return null;
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.hostname.includes('.')) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/** The stored links, or none. Stored as JSON text on the subscriber row. */
function parseLinks(text) {
  try {
    const value = JSON.parse(text || '[]');
    const checked = validateLinks(value);
    return checked.ok ? checked.links : [];
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------------- sign-up */

const MAX_NAME = 80;
const MAX_EMAIL = 254;

/**
 * Deliberately loose: something@something.something. Real validation of an
 * address is sending it a message, and a stricter pattern refuses real
 * addresses (plus signs, long TLDs, Thai domains) before it catches a typo.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A guest's sign-up, checked.
 *
 * The error is a strings.js key rather than a sentence: the guest page shows it
 * in their language.
 *
 * @returns {{ok: true, name: string, email: string, consent: boolean}|{ok: false, error: string}}
 */
function validateSignup(body) {
  const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
  const email = String(body?.email ?? '').trim().toLowerCase();

  if (!name) return { ok: false, error: 'welcomeNeedName' };
  if (name.length > MAX_NAME) return { ok: false, error: 'welcomeNameLong' };
  if (!email || email.length > MAX_EMAIL || !EMAIL.test(email)) {
    return { ok: false, error: 'welcomeNeedEmail' };
  }

  // Only a real `true`: an absent field, "false" or "on" from a form that was
  // not ours is not somebody ticking a box.
  return { ok: true, name, email, consent: body?.consent === true };
}

/* ------------------------------------------------------------ mailing list */

const COLUMNS = ['Name', 'Email', 'Signed up', 'Agreed to emails'];

/**
 * The mailing list a venue downloads: only the guests who said yes.
 *
 * Everyone else gave an address to see the Wi-Fi, and putting them in a file
 * labelled "mailing list" is how they end up on one.
 *
 * Dates are the venue's own calendar day, not UTC: a guest signing up at nine
 * in the morning in Bangkok did it on that day, and UTC would file it under
 * the one before — the dashboard and the file would disagree.
 *
 * @param {{name: string, email: string, consentedAt: string|Date|null, createdAt: string|Date, consent: boolean}[]} rows
 * @param {{timeZone?: string}} [options]
 */
function mailingList(rows = [], { timeZone = 'Asia/Bangkok' } = {}) {
  // en-CA writes YYYY-MM-DD, which every spreadsheet reads as a date.
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = (value) => (value ? format.format(new Date(value)) : '');
  return csv.file(
    COLUMNS.map(csv.cell),
    rows
      .filter((r) => r.consent)
      .map((r) => [r.name, r.email, day(r.createdAt), day(r.consentedAt)].map(csv.untrusted))
  );
}

/* -------------------------------------------------------------------- pass */

/**
 * A guest's pass back to the links, so a returning guest — one who saved the
 * page to their phone — is not asked for their email every time they open it.
 *
 * Signed and stateless, like a housekeeping shift, but it names the sign-up it
 * came from. The server checks that sign-up still exists, so a venue deleting
 * a guest's details (which the guest is entitled to ask for) also ends the
 * pass, and the guest sees the form again.
 */
const PASS_DAYS = 365;

function passKey() {
  const raw = String(process.env.SECRET_KEY || '').trim();
  if (raw.length !== 64) return null;
  // Its own key, derived for this purpose, so a pass and a housekeeping shift
  // can never be mistaken for each other however their bodies line up.
  return crypto.createHmac('sha256', Buffer.from(raw, 'hex')).update('welcome-pass').digest();
}

/** @returns {string|null} a pass, or null when SECRET_KEY is not usable */
function issuePass({ subscriberId, signupId, now = Date.now() }) {
  const key = passKey();
  if (!key) return null;
  const body = Buffer.from(
    JSON.stringify({ v: 1, s: Number(subscriberId), g: Number(signupId), x: now + PASS_DAYS * 86_400_000 })
  ).toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/**
 * @returns {{ok: true, signupId: number}|{ok: false}}
 *   No reason given: every failure sends the guest to the same form.
 */
function openPass(pass, { subscriberId, now = Date.now() } = {}) {
  const key = passKey();
  const [body, mac] = String(pass ?? '').split('.');
  if (!key || !body || !mac) return { ok: false };

  const expected = Buffer.from(crypto.createHmac('sha256', key).update(body).digest('base64url'));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false };
  }

  try {
    const claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (claim.v !== 1 || claim.s !== Number(subscriberId) || !(claim.x > now)) return { ok: false };
    return Number.isInteger(claim.g) ? { ok: true, signupId: claim.g } : { ok: false };
  } catch {
    return { ok: false };
  }
}

module.exports = {
  MAX_LINKS,
  MAX_LABEL,
  validateLinks,
  normaliseUrl,
  parseLinks,
  validateSignup,
  mailingList,
  issuePass,
  openPass,
};
