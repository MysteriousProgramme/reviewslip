'use strict';

/**
 * What state a room is in, and what that stops.
 *
 * There were two states — active, and out_of_service — and nothing in the
 * product ever set the second one. A real property has more than one reason to
 * take a room off the board, and they are not the same reason: a bathroom
 * being retiled and a room the owner's family is using both stop it being
 * sold, and only one of them should stop somebody cleaning it.
 *
 * So a status is three answers rather than a label:
 *
 *   sells    — counts as inventory. Occupancy is measured against it, and one
 *              day a channel manager will offer it.
 *   takes    — a booking can be put in it by hand. Not the same as selling: a
 *              room held back for staff still has staff in it, and the desk
 *              still has to record that somebody is there.
 *   cleaned  — appears on the housekeeping board. Nobody cleans a building
 *              site, and a room on that list is a room somebody is expected to
 *              walk into.
 *
 * Pure, so the answers can be tested without a database — and so the three
 * screens that ask them cannot drift into disagreeing.
 */

const STATUSES = [
  {
    id: 'active',
    label: 'Open',
    note: 'Sold, booked and cleaned as normal.',
    sells: true,
    takes: true,
    cleaned: true,
  },
  {
    id: 'not_selling',
    label: 'Not selling',
    note: 'Held back from sale. Still cleaned, and can still be given to somebody by hand.',
    sells: false,
    takes: true,
    cleaned: true,
  },
  {
    id: 'renovating',
    label: 'Renovating',
    note: 'Out of use entirely. No bookings, and it does not appear for housekeeping.',
    sells: false,
    takes: false,
    cleaned: false,
  },
];

const BY_ID = new Map(STATUSES.map((s) => [s.id, s]));

/**
 * The state this room is in.
 *
 * `out_of_service` was the old second state and may still be in a row
 * somewhere, so it reads as renovating rather than as nonsense. Anything
 * unrecognised reads as open, which is the safe direction: a room that cannot
 * be sold because of a typo is a room losing money silently, while one that
 * can be is visible the moment anybody looks at the calendar.
 */
function of(status) {
  const id = String(status ?? '').trim().toLowerCase();
  if (id === 'out_of_service') return BY_ID.get('renovating');
  return BY_ID.get(id) ?? BY_ID.get('active');
}

/** Whether a state somebody sent is one a room can be put into. */
function usable(status) {
  const id = String(status ?? '').trim().toLowerCase();
  if (id === 'out_of_service') return 'renovating';
  return BY_ID.has(id) ? id : null;
}

/** Counts as inventory: occupancy is measured against it. */
function sells(status) {
  return of(status).sells;
}

/** A booking can be put in it by hand. */
function takes(status) {
  return of(status).takes;
}

/** It appears on the housekeeping board. */
function cleaned(status) {
  return of(status).cleaned;
}

/** For a picker, and for a line of explanation under it. */
function list() {
  return STATUSES.map(({ id, label, note }) => ({ id, label, note }));
}

module.exports = { STATUSES, of, usable, sells, takes, cleaned, list };
