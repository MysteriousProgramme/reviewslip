'use strict';

/**
 * Money, and the rules that decide whether a stay may be sold.
 *
 * Pure, and apart from rates.js which cannot be loaded without a database. The
 * same reason nights.js exists: a price that is wrong looks exactly like a
 * price that is right, and the only symptom is an invoice somebody argues with.
 */

/* ------------------------------------------------------------------- money */

/**
 * Money is an integer count of the currency's smallest unit. Satang for baht,
 * cents for dollars.
 *
 * Never a float. 0.1 + 0.2 is 0.30000000000000004, and a rate of 1,150.00 baht
 * multiplied over a fourteen-night stay in floating point lands somewhere near
 * 16,100.000000000002 — which prints as expected right up until it does not,
 * and then it is a disagreement with a guest over their bill.
 *
 * Two decimal places covers every currency this is likely to meet. Currencies
 * with none (yen) and three (dinar) exist; when one turns up, this constant
 * becomes a property of the currency rather than of the module.
 */
const MINOR_PER_UNIT = 100;

/**
 * A ceiling, in minor units — a million baht a night.
 *
 * Far above any real room and low enough to catch the mistake it is for: an
 * extra zero. A stay priced ten times over is not obviously wrong on a form,
 * and is very obviously wrong on a card statement.
 */
const MAX_AMOUNT = 100_000_000;

const AMOUNT_RE = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * An amount as minor units, or null.
 *
 * Accepts what somebody types: '1200', '1,200', '1200.50', '1200.5', and the
 * same as a number. Rejects a third decimal place rather than rounding it,
 * because rounding somebody's money without telling them is how a price ends up
 * one satang out on every line of a fourteen-night invoice.
 *
 * @param {unknown} value
 * @returns {number|null} whole minor units
 */
function parseAmount(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    // Through the string form, so 12.1 * 100 = 1210.0000000000002 never
    // reaches Math.round with the rounding already done for it.
    return parseAmount(value.toFixed(2));
  }

  if (typeof value !== 'string') return null;

  const clean = value.trim().replace(/,/g, '');
  if (!clean) return null;

  const match = AMOUNT_RE.exec(clean);
  if (!match) return null;

  const units = Number(match[1]);
  // '5' means five satang out of ten, not five out of a hundred.
  const minor = Number((match[2] ?? '0').padEnd(2, '0'));

  const total = units * MINOR_PER_UNIT + minor;
  if (!Number.isSafeInteger(total) || total > MAX_AMOUNT) return null;

  return total;
}

/**
 * Minor units as a string somebody would recognise.
 *
 * Grouped, with the decimals only when they are not zero — hotel rates in Thai
 * baht are whole numbers almost always, and '1,200' reads better than
 * '1,200.00' on a calendar cell with three centimetres to work in.
 */
function formatAmount(minor, { always = false } = {}) {
  const n = Number(minor);
  if (!Number.isSafeInteger(n) || n < 0) return '';

  const units = Math.floor(n / MINOR_PER_UNIT);
  const rest = n % MINOR_PER_UNIT;

  const grouped = units.toLocaleString('en-US');
  if (rest === 0 && !always) return grouped;
  return `${grouped}.${String(rest).padStart(2, '0')}`;
}

/**
 * What a stay costs, given what each of its nights is priced at.
 *
 * Summed in minor units, so it is integer arithmetic from end to end. A night
 * with no price at all makes the whole total null rather than zero: a stay we
 * cannot price is not a stay that is free, and quietly charging nothing is the
 * worse of the two failures.
 *
 * @param {(number|null|undefined)[]} perNight
 * @returns {{total: number, nights: number}|null}
 */
function total(perNight) {
  if (!Array.isArray(perNight) || perNight.length === 0) return null;

  let sum = 0;
  for (const amount of perNight) {
    // null and undefined are rejected before coercion, deliberately.
    // Number(null) is 0, which is a perfectly good safe integer — so a missing
    // rate would pass this check as a free night and the total would come out
    // short rather than absent. That is the exact failure this function exists
    // to prevent, and it is invisible: a stay quoted at two nights' money looks
    // like a stay of two nights.
    if (amount === null || amount === undefined) return null;

    const n = Number(amount);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    sum += n;
  }

  return Number.isSafeInteger(sum) ? { total: sum, nights: perNight.length } : null;
}

/* ------------------------------------------------------------ restrictions */

/**
 * Whether a stay may be sold, given the restrictions on its nights.
 *
 * Three rules, in the order somebody would want to be told about them:
 *
 *   closed          the property is not selling that night at all
 *   closedToArrival somebody may stay through it but not start on it
 *   minNights       read from the arrival night, which is the convention every
 *                   channel uses — a two-night minimum on a Friday means a stay
 *                   *beginning* Friday must be two nights, not that every stay
 *                   touching Friday must be
 *
 * @param {{nights: string[], byNight: Record<string, object>}} input
 * @returns {{ok: boolean, error?: string}}
 */
function checkRestrictions({ nights = [], byNight = {} } = {}) {
  if (!Array.isArray(nights) || nights.length === 0) {
    return { ok: false, error: 'That is not a stay.' };
  }

  const shut = nights.find((night) => byNight[night]?.closed === true);
  if (shut) {
    return { ok: false, error: `Not selling ${shut}.` };
  }

  const first = byNight[nights[0]] ?? {};
  if (first.closedToArrival === true) {
    return { ok: false, error: `Not taking arrivals on ${nights[0]}.` };
  }

  const min = Number(first.minNights);
  if (Number.isSafeInteger(min) && min > 1 && nights.length < min) {
    return {
      ok: false,
      error: `Arrivals on ${nights[0]} are ${min} nights or more.`,
    };
  }

  return { ok: true };
}

module.exports = {
  MINOR_PER_UNIT,
  MAX_AMOUNT,
  parseAmount,
  formatAmount,
  total,
  checkRestrictions,
};
