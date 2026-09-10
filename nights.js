'use strict';

/**
 * Night arithmetic, for the reservations module.
 *
 * Pure, and the first thing written for it, because every date bug in a booking
 * system looks like the system working: the calendar renders, the booking
 * saves, and the only symptom is a guest who could not book a room that was
 * free. Nothing here touches a database, so all of it can be checked.
 *
 * Two rules the whole module rests on:
 *
 *   A night belongs to the day it starts. A stay from the 3rd to the 5th
 *   occupies the 3rd and the 4th; the guest is gone on the 5th. Get this wrong
 *   and a two-night stay holds three nights of inventory, availability
 *   under-reports by a third, and nobody notices until somebody complains.
 *
 *   A date here is a calendar date, not an instant. It is written as
 *   'YYYY-MM-DD' and stays a string from end to end — Postgres `date` columns,
 *   this module, and the JSON that reaches the browser. The rest of this
 *   codebase is timestamptz in UTC, which is right for "when did this happen"
 *   and wrong for a night: date_trunc('day', now() AT TIME ZONE 'UTC') rolls
 *   over at 07:00 in Bangkok, so a UTC-derived "today" is yesterday's night for
 *   seven hours every morning.
 *
 * Where arithmetic is unavoidable it goes through Date.UTC, which is a fixed
 * 86,400,000ms per day with no zone and no daylight saving to step on. The
 * result is converted straight back to a string; no Date object escapes this
 * file.
 */

/** Milliseconds in a day. Safe here because UTC has no daylight saving. */
const DAY = 86_400_000;

/**
 * The longest stay, and the widest calendar window, in nights.
 *
 * Two years. Far past any real booking, and far short of the mistake it exists
 * to catch: an arrival in 2026 with the departure year fat-fingered as 2036.
 * Every night is a row, so that one keystroke would otherwise write three and a
 * half thousand of them and hold a room for a decade.
 *
 * One constant for both because a calendar asked for a window it cannot draw
 * and a stay nobody will take are the same kind of wrong, and a second number
 * would only be a second thing to keep in step.
 */
const MAX_NIGHTS = 730;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A date string, or null.
 *
 * Strict on purpose. `new Date('2026-02-30')` does not fail — it quietly
 * becomes the 2nd of March, which in a booking system means somebody's arrival
 * has been moved without anybody being told. So the parts are read out,
 * rebuilt, and compared: if the calendar disagrees with what was typed, it was
 * not a date.
 *
 * Only 'YYYY-MM-DD' is accepted. Not a Date, not a timestamp, not '3/10/2026' —
 * which is the 3rd of October to half the world and the 10th of March to the
 * other half, and guessing between them is how a booking lands in the wrong
 * month.
 *
 * @param {unknown} value
 * @returns {string|null} the same date, normalised, or null
 */
function parse(value) {
  if (typeof value !== 'string') return null;

  const match = DATE_RE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const stamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(stamp)) return null;

  // The round trip. Date.UTC(2026, 1, 30) is the 2nd of March, and this is
  // where that gets caught.
  const back = new Date(stamp);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }

  return value;
}

/** @returns {number|null} UTC milliseconds at midnight on that date */
function stampOf(value) {
  const date = parse(value);
  if (!date) return null;
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10))
  );
}

/** @returns {string} 'YYYY-MM-DD' for a UTC millisecond stamp */
function format(stamp) {
  return new Date(stamp).toISOString().slice(0, 10);
}

/**
 * The date `count` days away, or null if the input was not a date.
 *
 * Negative counts go backwards. Month, year and leap-day boundaries are
 * handled by the arithmetic rather than by cases.
 *
 * @param {string} value
 * @param {number} count
 * @returns {string|null}
 */
function addDays(value, count) {
  const stamp = stampOf(value);
  if (stamp === null || !Number.isSafeInteger(count)) return null;
  return format(stamp + count * DAY);
}

/**
 * The nights a stay occupies: arrival included, departure excluded.
 *
 * A stay that is not a stay — same day, backwards, or either date unreadable —
 * occupies nothing, so no caller has to defend against a negative length.
 *
 * Capped at MAX_NIGHTS as a backstop against building an enormous array from
 * bad input. Anything that reaches here should already have passed checkStay,
 * which refuses the same length with an explanation; this exists so that a
 * caller which skipped it fails on memory rather than consuming it. The
 * booking layer compares what it is about to write against nightCount before
 * committing, so a truncated set cannot become a quietly under-held room.
 *
 * @returns {string[]} each night, ascending
 */
function nightsBetween(arrival, departure) {
  const from = stampOf(arrival);
  const to = stampOf(departure);
  if (from === null || to === null || to <= from) return [];

  const total = Math.round((to - from) / DAY);
  if (total > MAX_NIGHTS) return [];

  const out = [];
  for (let i = 0; i < total; i += 1) out.push(format(from + i * DAY));
  return out;
}

/**
 * How many nights a stay occupies. Zero for anything that is not a stay.
 *
 * Counted rather than derived from nightsBetween, so asking how long something
 * is does not build an array of every night in it.
 */
function nightCount(arrival, departure) {
  const from = stampOf(arrival);
  const to = stampOf(departure);
  if (from === null || to === null || to <= from) return 0;
  return Math.round((to - from) / DAY);
}

/**
 * Whether two stays want the same room on the same night.
 *
 * Half-open intervals, which is what makes a changeover day work: one guest
 * leaves on the 5th and the next arrives on the 5th. They share a date and not
 * a night, and treating that as a conflict would refuse a booking on every
 * changeover the property ever has — the single busiest thing a hotel does.
 *
 * A convenience, not the enforcement. The unique index on (room_id, night) is
 * what actually prevents a double booking, including two requests racing, which
 * no amount of checking in front of the write can catch. So this answers false
 * for a stay it cannot read rather than throwing: it is used to explain a
 * conflict to somebody, and the database is what refuses it.
 */
function overlaps(arrivalA, departureA, arrivalB, departureB) {
  const aFrom = stampOf(arrivalA);
  const aTo = stampOf(departureA);
  const bFrom = stampOf(arrivalB);
  const bTo = stampOf(departureB);

  if (aFrom === null || aTo === null || bFrom === null || bTo === null) {
    return false;
  }
  // A zero-length or backwards stay holds no nights, so it clashes with none.
  if (aTo <= aFrom || bTo <= bFrom) return false;

  return aFrom < bTo && bFrom < aTo;
}

/**
 * Whether a stay makes sense, and a sentence saying why not.
 *
 * The two ways to get the dates wrong are told apart deliberately. Somebody who
 * picked the same day for both meant one night and does not know departure is
 * exclusive; somebody who picked them backwards has them the wrong way round.
 * One message for both would be wrong for whichever of them is reading it.
 *
 * @param {{arrival: string, departure: string}} stay
 * @returns {{ok: boolean, error?: string, nights?: number}}
 */
function checkStay({ arrival, departure } = {}) {
  if (!parse(arrival)) {
    return { ok: false, error: 'Arrival needs to be a date, as YYYY-MM-DD.' };
  }
  if (!parse(departure)) {
    return { ok: false, error: 'Departure needs to be a date, as YYYY-MM-DD.' };
  }

  const from = stampOf(arrival);
  const to = stampOf(departure);

  if (to === from) {
    return {
      ok: false,
      error:
        'A stay is at least one night. For one night, departure is the day after arrival.',
    };
  }
  if (to < from) {
    return { ok: false, error: 'Departure has to be after arrival.' };
  }

  const count = Math.round((to - from) / DAY);
  if (count > MAX_NIGHTS) {
    return {
      ok: false,
      error: `That is ${count.toLocaleString()} nights. Check the year on the departure date.`,
    };
  }

  return { ok: true, nights: count };
}

/**
 * The nights a calendar view covers, starting at `start`.
 *
 * Capped, so a hand-edited URL asking for a hundred thousand nights returns a
 * screen's worth instead of trying to render a column per day for three
 * centuries. Anything unreadable, zero, or negative is an empty window rather
 * than an error: the calendar draws nothing and the page still loads.
 *
 * @returns {string[]}
 */
function window(start, count) {
  const from = stampOf(start);
  if (from === null || !Number.isSafeInteger(count) || count <= 0) return [];

  const total = Math.min(count, MAX_NIGHTS);
  const out = [];
  for (let i = 0; i < total; i += 1) out.push(format(from + i * DAY));
  return out;
}

module.exports = {
  MAX_NIGHTS,
  parse,
  addDays,
  nightsBetween,
  nightCount,
  overlaps,
  checkStay,
  window,
};
