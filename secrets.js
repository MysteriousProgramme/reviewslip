'use strict';

const crypto = require('crypto');

/**
 * Encrypting the few things that must not be readable in a database dump.
 *
 * There is exactly one of those today: a guest's passport number, which
 * Thailand requires a property to collect and report. Everything else in this
 * database is either the customer's own data or a count.
 *
 * The threat this addresses is specific and real. `scripts/backup-to-s3.sh`
 * writes a full dump to S3 every night. If that bucket is ever read by somebody
 * who should not have it, plaintext passport numbers for every foreign guest
 * who has ever stayed at a customer's property go with it — and unlike a
 * password, a passport number cannot be rotated.
 *
 * The key lives in the environment, not in the database. So the dump on its own
 * decrypts to nothing: an attacker needs the bucket *and* the box. That is a
 * meaningful difference and it is the whole point — it does not protect against
 * somebody who has already got onto the server, and it is not meant to.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than returning plausible rubbish. Stored as iv:tag:ciphertext in hex, which
 * is a text column and needs no driver support.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, what GCM is specified for
const KEY_BYTES = 32;

/**
 * The key, from SECRET_KEY, as 64 hex characters.
 *
 * Read once at load. Absent is a legitimate state — an installation with no
 * reservations module has nothing to encrypt — and `configured` is how callers
 * find out, so the feature can refuse to collect passports rather than
 * collecting them in the clear.
 *
 * Generate one with:  openssl rand -hex 32
 */
function readKey() {
  const raw = String(process.env.SECRET_KEY || '').trim();
  if (!raw) return null;

  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    // Loud, because the alternative is a key that is silently the wrong length
    // and a feature that silently refuses to work.
    console.error(
      'SECRET_KEY is set but is not 64 hex characters. Generate one with: openssl rand -hex 32'
    );
    return null;
  }

  return Buffer.from(raw, 'hex');
}

const KEY = readKey();
const configured = KEY !== null && KEY.length === KEY_BYTES;

/**
 * Encrypt a string.
 *
 * @param {string} value
 * @returns {string|null} iv:tag:ciphertext in hex, or null if there is no key
 */
function encrypt(value) {
  if (!configured) return null;

  const text = String(value ?? '');
  if (!text) return null;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${body.toString('hex')}`;
}

/**
 * Decrypt what encrypt() produced.
 *
 * Returns null rather than throwing for anything it cannot read — a missing
 * key, a malformed value, a tampered one. The callers are all "show this to
 * somebody who is allowed to see it", and a blank field is a better failure
 * there than a five-hundred on a page that is mostly about something else.
 *
 * @param {string} stored
 * @returns {string|null}
 */
function decrypt(stored) {
  if (!configured || typeof stored !== 'string') return null;

  const parts = stored.split(':');
  if (parts.length !== 3) return null;

  try {
    const [ivHex, tagHex, bodyHex] = parts;
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      KEY,
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

    return (
      decipher.update(Buffer.from(bodyHex, 'hex'), undefined, 'utf8') +
      decipher.final('utf8')
    );
  } catch {
    // Wrong key, or somebody edited the row. Either way this is not readable
    // and saying so is the whole value of an authenticated cipher.
    return null;
  }
}

/**
 * The last few characters, kept in the clear.
 *
 * So a person at the desk can confirm they are looking at the right passport
 * without anything decrypting it, and so a list can show something. Four
 * characters of a passport number identifies nobody on its own.
 */
function tail(value, keep = 4) {
  const text = String(value ?? '').trim();
  if (text.length <= keep) return text;
  return text.slice(-keep);
}

module.exports = { configured, encrypt, decrypt, tail };
