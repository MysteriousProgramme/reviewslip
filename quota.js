'use strict';

/**
 * How many reviews one guest may ask for.
 *
 * Two limits, and they answer different questions. The throttle in server.js
 * asks "is this a script?" and is measured in seconds. This asks "how much is
 * one person allowed to spend?" and is measured in an hour — a guest tapping
 * Regenerate forty times is not attacking anything, they are just not going to
 * be satisfied, and every tap is a model call the business pays for.
 *
 * Lifted out of server.js so it can be tested. It lived in there while it was
 * four lines and stayed when it stopped being four lines, which is how a cap
 * that did not actually stop anybody survived a release: nothing could exercise
 * it without a database and a live model behind it.
 *
 * In memory on purpose. A restart forgives everyone, which is the right way for
 * a spending bound to fail — the alternative is a guest locked out by a deploy,
 * and an hour of it is worth pennies.
 */

/**
 * Ten regenerations, plus the first draft the page writes on its own.
 *
 * Eleven generations, because the opening draft is not a regeneration: nobody
 * asked for it, it arrives before the guest has touched anything, and charging
 * it against the button would leave nine taps behind a label promising ten.
 * What is reported outward is regenerations, which is what the button counts.
 */
const MAX_REGENERATIONS = 10;
const MAX_GENERATIONS = MAX_REGENERATIONS + 1;

const WINDOW_MS = 60 * 60_000;

/** Past this the map is cleared rather than grown. */
const MAX_KEYS = 5000;

/**
 * @param {object} [options]
 * @param {() => number} [options.now] - injectable clock, for the tests
 */
function createQuota({ now = Date.now } = {}) {
  const seen = new Map();

  /**
   * Counts one generation against `key` and says whether it was allowed.
   *
   * Counted on the way in, not on the way out: a cap enforced after the model
   * has answered has already spent the tokens it exists to protect.
   *
   * @param {string} key - business and address, so one venue cannot exhaust
   *   another and one guest cannot exhaust a venue
   * @returns {{allowed: boolean, used: number, left: number}} `used` and `left`
   *   are regenerations, which is the unit the guest page shows
   */
  function count(key) {
    const at = now();
    const entry = seen.get(key);

    if (!entry || at > entry.resetAt) {
      if (seen.size >= MAX_KEYS) seen.clear();
      seen.set(key, { count: 1, resetAt: at + WINDOW_MS });
      return { allowed: true, used: 0, left: MAX_REGENERATIONS };
    }

    if (entry.count >= MAX_GENERATIONS) {
      return { allowed: false, used: MAX_REGENERATIONS, left: 0 };
    }

    entry.count += 1;
    return {
      allowed: true,
      // The first draft is free, so nothing is used until the second call.
      used: entry.count - 1,
      left: MAX_GENERATIONS - entry.count,
    };
  }

  return { count };
}

module.exports = { createQuota, MAX_REGENERATIONS, MAX_GENERATIONS, WINDOW_MS };
