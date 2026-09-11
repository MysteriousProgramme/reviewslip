'use strict';

const { one, all, query } = require('./db');
const nights = require('./nights');
const secrets = require('./secrets');
const tm30 = require('./tm30');

/**
 * The people on a booking, and the notification Thailand requires about them.
 *
 * The passport number never leaves this module in the clear except through
 * `forExport`, which exists to build the file somebody uploads to Immigration.
 * Every other read returns the last four characters, which is enough for a
 * person at a desk to confirm they have the right document and enough for
 * nobody else to do anything with.
 */

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

const NAME_MAX = 80;

/** What a caller sees: everything except the number itself. */
function toRecord(row) {
  const guest = {
    id: row.id,
    bookingId: row.booking_id,
    familyName: row.family_name,
    firstName: row.first_name,
    middleName: row.middle_name,
    nationality: row.nationality,
    dateOfBirth: row.date_of_birth,
    phone: row.phone,
    arrivedInThailand: row.arrived_in_thailand,
    // Never row.passport_enc. The tail is the whole of what a list needs.
    passportTail: row.passport_tail,
    hasPassport: Boolean(row.passport_enc),
    notifiedAt: row.notified_at,
  };

  // Said here rather than by every page that lists guests, so one answer to
  // "is this ready to report" exists in one place.
  const check = tm30.checkGuest({
    ...guest,
    passportNumber: row.passport_enc ? 'held' : '',
  });

  return {
    ...guest,
    reportable: tm30.reportable(guest),
    ready: check.ok,
    missing: check.missing,
  };
}

/* ------------------------------------------------------------------ writes */

/**
 * Add somebody to a booking.
 *
 * Refuses to store a passport number at all when there is no encryption key
 * configured. Not a warning and not a plaintext fallback: the whole reason this
 * table is acceptable is that the number is unreadable in a backup, and a
 * fallback that quietly drops that guarantee is worse than the feature being
 * unavailable — because nobody would know.
 */
async function add({ subscriberId, bookingId, ...input }) {
  const booking = await one(
    'SELECT id FROM bookings WHERE id = $1 AND subscriber_id = $2',
    [bookingId, subscriberId]
  );
  if (!booking) throw fail(404, 'No such booking.');

  const familyName = String(input.familyName ?? '').trim().slice(0, NAME_MAX);
  const firstName = String(input.firstName ?? '').trim().slice(0, NAME_MAX);
  if (!familyName || !firstName) {
    throw fail(400, 'A guest needs a family name and a first name.');
  }

  for (const [key, label] of [
    ['dateOfBirth', 'date of birth'],
    ['arrivedInThailand', 'arrival date'],
  ]) {
    if (input[key] && !nights.parse(input[key])) {
      throw fail(400, `That ${label} is not a date.`);
    }
  }

  const passport = tm30.normalisePassport(input.passportNumber);
  if (passport && !secrets.configured) {
    throw fail(
      503,
      'Passport numbers cannot be stored until SECRET_KEY is set on the server. Everything else about the guest will save.'
    );
  }

  const row = await one(
    `INSERT INTO booking_guests
       (subscriber_id, booking_id, family_name, first_name, middle_name,
        nationality, date_of_birth, phone, arrived_in_thailand,
        passport_enc, passport_tail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      subscriberId,
      bookingId,
      familyName,
      firstName,
      String(input.middleName ?? '').trim().slice(0, NAME_MAX) || null,
      String(input.nationality ?? '').trim().slice(0, 40) || null,
      input.dateOfBirth || null,
      String(input.phone ?? '').trim().slice(0, 40) || null,
      input.arrivedInThailand || null,
      passport ? secrets.encrypt(passport) : null,
      passport ? secrets.tail(passport) : null,
    ]
  );

  return toRecord(row);
}

async function remove({ subscriberId, id }) {
  const row = await one(
    'DELETE FROM booking_guests WHERE id = $1 AND subscriber_id = $2 RETURNING id',
    [id, subscriberId]
  );
  if (!row) throw fail(404, 'No such guest.');
  return true;
}

/* ------------------------------------------------------------------- reads */

async function listFor({ subscriberId, bookingId }) {
  const rows = await all(
    `SELECT * FROM booking_guests
      WHERE subscriber_id = $1 AND booking_id = $2
      ORDER BY id`,
    [subscriberId, bookingId]
  );
  return rows.map(toRecord);
}

/**
 * Who still needs notifying, for a window of arrivals.
 *
 * Counted rather than listed when all somebody wants is the badge on a page.
 * Cancelled stays are excluded: nobody arrived, so there is nothing to report.
 */
async function pending({ subscriberId, from, to }) {
  const start = nights.parse(from);
  const end = nights.parse(to);
  if (!start || !end) throw fail(400, 'Those are not dates.');

  const rows = await all(
    `SELECT g.*, b.arrival, b.departure, r.name AS room_name
       FROM booking_guests g
       JOIN bookings b ON b.id = g.booking_id
       LEFT JOIN rooms r ON r.id = b.room_id
      WHERE g.subscriber_id = $1
        AND g.notified_at IS NULL
        AND b.status <> 'cancelled'
        AND b.arrival BETWEEN $2 AND $3
      ORDER BY b.arrival, g.family_name`,
    [subscriberId, start, end]
  );

  return rows
    .map((row) => ({
      ...toRecord(row),
      arrival: row.arrival,
      departure: row.departure,
      roomName: row.room_name,
    }))
    .filter((g) => g.reportable);
}

/**
 * The export, with the numbers decrypted.
 *
 * The only path in the product that returns a passport number, and the only
 * reason it exists is that Immigration asks for it. Kept as its own function so
 * that fact is greppable: anything that calls this is handling passports.
 */
async function forExport({ subscriberId, from, to }) {
  const start = nights.parse(from);
  const end = nights.parse(to);
  if (!start || !end) throw fail(400, 'Those are not dates.');

  const rows = await all(
    `SELECT g.*, b.arrival, b.departure, r.name AS room_name
       FROM booking_guests g
       JOIN bookings b ON b.id = g.booking_id
       LEFT JOIN rooms r ON r.id = b.room_id
      WHERE g.subscriber_id = $1
        AND b.status <> 'cancelled'
        AND b.arrival BETWEEN $2 AND $3
      ORDER BY b.arrival, g.family_name`,
    [subscriberId, start, end]
  );

  const entries = rows
    .filter((row) => tm30.reportable({ nationality: row.nationality }))
    .map((row) => ({
      id: row.id,
      guest: {
        familyName: row.family_name,
        firstName: row.first_name,
        middleName: row.middle_name,
        nationality: row.nationality,
        // Decrypted here and nowhere else. Null when the key has changed or
        // gone — which shows as a blank column rather than a wrong number.
        passportNumber: secrets.decrypt(row.passport_enc) ?? '',
        dateOfBirth: row.date_of_birth,
        phone: row.phone,
        arrivedInThailand: row.arrived_in_thailand,
      },
      stay: {
        arrival: row.arrival,
        departure: row.departure,
        roomName: row.room_name,
      },
    }));

  return { entries, csv: tm30.toCsv(entries) };
}

/**
 * Mark people as notified.
 *
 * Set by the property after they have uploaded the file, not by the export
 * itself. Downloading is not notifying — somebody can download a file and never
 * upload it, and a system that marked them done at download would hide exactly
 * the stays that were missed.
 */
async function markNotified({ subscriberId, ids }) {
  const list = (Array.isArray(ids) ? ids : [])
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0);

  if (!list.length) throw fail(400, 'Nothing to mark.');

  const result = await query(
    `UPDATE booking_guests SET notified_at = now(), updated_at = now()
      WHERE subscriber_id = $1 AND id = ANY($2::int[]) AND notified_at IS NULL`,
    [subscriberId, list]
  );

  return { marked: result.rowCount ?? 0 };
}

/**
 * Forget passport numbers for stays that ended more than `days` ago.
 *
 * The record of who stayed is kept — the name, the nationality, the dates. The
 * document number is dropped, because there is no reason to hold somebody's
 * passport number two years after they left, and every reason not to.
 *
 * `days` is the caller's decision, not a legal opinion: Thailand's own
 * record-keeping requirement is a question for a Thai lawyer, and this is the
 * mechanism rather than the policy.
 */
async function forgetPassports({ subscriberId, days = 365 }) {
  const window = Number(days);
  if (!Number.isSafeInteger(window) || window < 1) {
    throw fail(400, 'That is not a number of days.');
  }

  const result = await query(
    `UPDATE booking_guests g
        SET passport_enc = NULL, updated_at = now()
       FROM bookings b
      WHERE b.id = g.booking_id
        AND g.subscriber_id = $1
        AND g.passport_enc IS NOT NULL
        AND b.departure < (now() AT TIME ZONE 'UTC')::date - $2::int`,
    [subscriberId, window]
  );

  return { forgotten: result.rowCount ?? 0 };
}

module.exports = {
  add,
  remove,
  listFor,
  pending,
  forExport,
  markNotified,
  forgetPassports,
};
