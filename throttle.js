'use strict';

/**
 * The open endpoints' throttle.
 *
 * One tab on a lobby QR code is the normal case; this only exists so an open
 * endpoint can't burn the API budget or fill a table with junk. Callers key it
 * per venue as well as per IP, so one busy venue cannot throttle another.
 * In-memory, resets every minute — a restart forgets it, which is fine for a
 * speed bump.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map();

/** @returns {boolean} whether this key has gone over `max` this minute */
function throttled(key, { max = MAX_PER_WINDOW } = {}) {
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

module.exports = { throttled };
