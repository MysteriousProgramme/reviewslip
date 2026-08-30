'use strict';

const crypto = require('crypto');

/**
 * What a referral is worth, and when it has been earned.
 *
 * Deliberately apart from referrals.js, which cannot be loaded without a
 * database. Everything with a rule in it lives here so it can be tested on its
 * own — the same reason ids.js and quota.js exist.
 *
 * IMPORTANT, and the thing most likely to be misread later: earning the
 * discount does not apply it. There is no payment step in this product yet
 * (see the note above POST /plan in customer.js), so nothing here touches
 * money. `progress()` decides what the dashboard *says*. Honouring it is a
 * manual act until Stripe exists, and the rule below is what it will be
 * honoured against.
 */

/** Qualified referrals needed before the discount is earned. */
const REFERRALS_NEEDED = 5;

/** What it is worth, as a percentage off the plan. */
const DISCOUNT_PERCENT = 20;

/* --------------------------------------------------------------- the codes */

// No I, L, O, 0 or 1. A referral code gets read off one screen and typed into
// another, sometimes out loud, and those five are the characters that turn a
// working code into a support email.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/**
 * A referral code.
 *
 * 31^8 is about 850 billion, which is not a secret but is far past guessing one
 * at the rate a signup endpoint will answer. Nothing worse than an unearned
 * referral is behind it, so that is the right amount of effort.
 *
 * Rejection sampling rather than `% ALPHABET.length`: 256 is not a multiple of
 * 31, so plain modulo makes the first eight letters likelier than the rest. It
 * would not matter much here, but a biased generator is the kind of thing that
 * gets copied into somewhere it does matter.
 */
function newCode() {
  const ceiling = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = '';

  while (out.length < CODE_LENGTH) {
    for (const byte of crypto.randomBytes(CODE_LENGTH)) {
      if (byte >= ceiling) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }

  return out;
}

/**
 * Codes as typed, made comparable.
 *
 * Someone pasting a code from an email brings whitespace with it, and someone
 * typing one brings whatever case they felt like. Neither should be the reason
 * a referral does not count.
 */
function normaliseCode(value) {
  const code = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');

  return code.length === CODE_LENGTH && !/[^A-Z0-9]/.test(code) ? code : null;
}

/* ------------------------------------------------------------- the progress */

/**
 * Where an account stands, from a count of its qualified referrals.
 *
 * @param {number} qualified how many referrals have signed up and signed in
 * @returns {{qualified: number, needed: number, remaining: number,
 *            earned: boolean, percent: number}}
 *
 * Two percentages, and they are not the same question. `worth` is what the
 * offer is — the number the page advertises before anyone has referred anybody.
 * `percent` is what this account currently has, which is nothing until the
 * fifth referral lands.
 *
 * `percent` does not scale with progress on purpose. Four referrals is not
 * worth 16% off; it is worth nothing, which is the whole shape of the offer,
 * and a number creeping upwards would read as a promise that four had already
 * bought something.
 */
function progress(qualified) {
  // Coerced, not type-checked. A count from Postgres arrives as a string —
  // COUNT(*) is a bigint and the driver hands bigints back as text — and this
  // codebase has already lost a feature to a guard that rejected one instead of
  // converting it. Someone who earned the discount must not be shown "0 of 5"
  // because the number came back from a different query.
  const parsed = Number(qualified);
  const count = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  const earned = count >= REFERRALS_NEEDED;

  return {
    qualified: count,
    needed: REFERRALS_NEEDED,
    remaining: Math.max(REFERRALS_NEEDED - count, 0),
    earned,
    percent: earned ? DISCOUNT_PERCENT : 0,
    // So the offer can be advertised without either end hard-coding "20".
    worth: DISCOUNT_PERCENT,
  };
}

module.exports = {
  REFERRALS_NEEDED,
  DISCOUNT_PERCENT,
  CODE_LENGTH,
  newCode,
  normaliseCode,
  progress,
};
