'use strict';

const nights = require('./nights');

/**
 * Reading a booking list's filters off a query string.
 *
 * Pure, and separate from bookings.js, for the same reason nights.js is: this
 * is where the mistakes live. A filter that silently drops itself shows a list
 * that looks complete and is not, and the only symptom is somebody insisting a
 * booking has vanished. Nothing here touches a database, so every edge of it
 * can be checked.
 *
 * The shape this returns is also what the API echoes back, so the screen draws
 * its filter chips from what the server actually applied rather than from what
 * the browser believes it asked for. Those two disagreeing is how a page ends
 * up claiming a filter is on while showing unfiltered rows.
 */

/** Every status a booking can hold. Anything else is not a filter, it is noise. */
const STATUSES = ['confirmed', 'in_house', 'checked_out', 'cancelled', 'no_show'];

/**
 * Which date a range is about.
 *
 * Three, because "bookings in October" is genuinely ambiguous and choosing one
 * silently is how an arrivals report comes out wrong. A stay from the 28th of
 * September to the 2nd of October is in October by one reading and not by
 * another, and both readings are somebody's real question.
 */
const DATE_MODES = ['stay', 'arrival', 'departure'];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SEARCH_MAX = 120;

/** The sentinel for "no room yet", which is a thing people search for. */
const NO_ROOM = 0;

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

/** A query value that may arrive as a string, an array, or not at all. */
function first(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]) : '';
  if (value === undefined || value === null) return '';
  return String(value);
}

/** A positive id, or null. Zero survives only where it means something. */
function id(value, { zeroMeans = null } = {}) {
  const text = first(value).trim();
  if (text === '') return null;

  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  if (n === 0) return zeroMeans;
  return n;
}

/**
 * The cursor, as one opaque string.
 *
 * Keyset rather than an offset, because a list ordered by arrival is a list
 * people page through while bookings are being taken underneath them. An
 * offset shifts every time a row is inserted above it, which shows somebody the
 * same booking twice and hides another entirely — and a booking that appears to
 * have vanished is the one thing a reservations list must never do.
 */
function formatCursor({ arrival, id: rowId }) {
  return `${arrival}:${rowId}`;
}

/**
 * Back from that string, or null.
 *
 * Unreadable is treated as absent — page one — rather than an error. A stale
 * link somebody bookmarked should still show a list; refusing it teaches people
 * the page is broken when all that has happened is that a cursor went out of
 * date.
 */
function parseCursor(value) {
  const text = first(value).trim();
  if (!text) return null;

  const at = text.lastIndexOf(':');
  if (at === -1) return null;

  const arrival = nights.parse(text.slice(0, at));
  const rowId = Number(text.slice(at + 1));
  if (!arrival || !Number.isSafeInteger(rowId) || rowId <= 0) return null;

  return { arrival, id: rowId };
}

/**
 * The filters, validated.
 *
 * Unknown statuses are dropped rather than refused: a link written before a
 * status existed should still show a list. But if *every* status given was
 * unknown the answer is null — all of them — and not an empty set, because an
 * empty set silently matches nothing and looks exactly like a property with no
 * bookings.
 *
 * @returns {{statuses: string[]|null, groupId: number|null, roomId: number|null,
 *   from: string|null, to: string|null, on: string, q: string,
 *   limit: number, cursor: {arrival: string, id: number}|null}}
 */
function parse(query = {}) {
  const wanted = first(query.status)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => STATUSES.includes(s));

  const from = first(query.from).trim() === '' ? null : nights.parse(first(query.from));
  const to = first(query.to).trim() === '' ? null : nights.parse(first(query.to));

  if (first(query.from).trim() !== '' && !from) throw fail(400, 'That is not a date to start from.');
  if (first(query.to).trim() !== '' && !to) throw fail(400, 'That is not a date to end at.');
  // Refused rather than swapped. Somebody who typed the dates backwards wants
  // to know; quietly reversing them means the next wrong date goes unnoticed
  // too, and the list they are reading is not the one they asked for.
  if (from && to && to < from) throw fail(400, 'The end of the range is before the start.');

  const askedMode = first(query.on).trim().toLowerCase();
  const on = DATE_MODES.includes(askedMode) ? askedMode : DATE_MODES[0];

  // Clamped, not refused. A hand-edited limit is somebody exploring, not an
  // attack, and the honest answer to "give me ten thousand" is two hundred.
  const askedLimit = Number(first(query.limit));
  const limit = Number.isSafeInteger(askedLimit) && askedLimit > 0
    ? Math.min(askedLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;

  return {
    statuses: wanted.length ? [...new Set(wanted)] : null,
    groupId: id(query.groupId),
    // Zero is meaningful here and nowhere else: it is how the screen asks for
    // stays with no room yet, which is most of what this list is opened for.
    roomId: id(query.roomId, { zeroMeans: NO_ROOM }),
    from,
    to,
    on,
    q: first(query.q).trim().slice(0, SEARCH_MAX),
    limit,
    cursor: parseCursor(query.cursor),
  };
}

module.exports = {
  STATUSES,
  DATE_MODES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  NO_ROOM,
  parse,
  formatCursor,
  parseCursor,
};
