'use strict';

const nights = require('./nights');

/**
 * The TM30 notification, as data.
 *
 * Thailand's Immigration Act section 38 makes the keeper of any accommodation
 * responsible for reporting a foreign national's stay to Immigration within 24
 * hours of their arrival. There are fines for not doing it. Every hotel system
 * sold here automates it, and it is the single most useful thing this module
 * can do for a Thai property.
 *
 * What this produces is a file to upload, not a submission. The portal at
 * tm30.immigration.go.th takes a spreadsheet of guests, and there is no
 * published API — so the property uploads what this builds, signed in as
 * themselves. Doing it for them would mean holding their Immigration
 * credentials, which is not a thing to take on lightly and is certainly not a
 * thing to take on quietly.
 *
 * IMPORTANT, and worth a person checking once: the exact column order the
 * portal expects could not be verified from the published documentation. The
 * fields below are the documented ones, named plainly. Compare the first export
 * against the portal's own template before relying on it, and if the order
 * differs, it differs here in one place.
 */

/** What the notification asks for, in the order this file writes them. */
const COLUMNS = [
  'Family name',
  'First name',
  'Middle name',
  'Nationality',
  'Passport number',
  'Date of birth',
  'Phone',
  'Arrived in Thailand',
  'Check-in',
  'Check-out',
  'Room',
];

/**
 * Who has to be reported.
 *
 * Thai nationals are not notifiable under section 38 — it is a foreigner
 * notification — so a guest recorded as Thai is left out rather than sent and
 * rejected. Anybody with no nationality recorded is *included*, because the
 * failure of omitting somebody who should have been reported is a fine, and the
 * failure of including somebody who should not is a line the portal ignores.
 */
function reportable(guest) {
  const nationality = String(guest?.nationality ?? '').trim().toUpperCase();
  return nationality !== 'TH' && nationality !== 'THAI' && nationality !== 'THAILAND';
}

/**
 * Whether a guest record can be reported, and what is missing if not.
 *
 * Returns every problem rather than the first. Somebody fixing a guest record
 * at a front desk should be told all of it at once, not made to save four
 * times.
 *
 * @param {object} guest
 * @returns {{ok: boolean, missing: string[]}}
 */
function checkGuest(guest = {}) {
  const missing = [];

  if (!String(guest.familyName ?? '').trim()) missing.push('family name');
  if (!String(guest.firstName ?? '').trim()) missing.push('first name');
  if (!String(guest.nationality ?? '').trim()) missing.push('nationality');
  if (!String(guest.passportNumber ?? '').trim()) missing.push('passport number');

  // The arrival stamp date. Immigration asks for when they entered Thailand,
  // which is not when they reached this property — somebody on a three-week
  // trip checks in here on day twelve.
  if (guest.arrivedInThailand && !nights.parse(guest.arrivedInThailand)) {
    missing.push('a readable arrival date');
  }
  if (guest.dateOfBirth && !nights.parse(guest.dateOfBirth)) {
    missing.push('a readable date of birth');
  }

  return { ok: missing.length === 0, missing };
}

/**
 * A passport number, tidied.
 *
 * Upper-cased and stripped of spaces and dashes, because the same passport gets
 * typed four ways across four stays and a report that disagrees with itself is
 * worse than one that is merely ugly. Nothing is validated beyond that: formats
 * differ by every issuing country, and a rule tight enough to be useful would
 * reject somebody's real passport at a front desk.
 */
function normalisePassport(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .slice(0, 40);
}

/**
 * One guest as a row, in COLUMNS order.
 *
 * @param {object} guest — with the passport already decrypted by the caller
 * @param {{roomName?: string, arrival?: string, departure?: string}} stay
 */
function toRow(guest, stay = {}) {
  return [
    guest.familyName ?? '',
    guest.firstName ?? '',
    guest.middleName ?? '',
    guest.nationality ?? '',
    guest.passportNumber ?? '',
    guest.dateOfBirth ?? '',
    guest.phone ?? '',
    guest.arrivedInThailand ?? '',
    stay.arrival ?? '',
    stay.departure ?? '',
    stay.roomName ?? '',
  ];
}

/** One CSV field: quoted when it has to be, doubled quotes inside. */
function cell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The whole export.
 *
 * CSV with a UTF-8 byte-order mark, and CRLF line endings. Both are for Excel,
 * which is what opens this: without the BOM it renders Thai names and accented
 * European ones as mojibake, and without CRLF some versions put the lot on one
 * line. This file is going to be opened by a person before it is uploaded, so
 * it has to survive that.
 *
 * @param {{guest: object, stay: object}[]} entries
 * @returns {string}
 */
function toCsv(entries = []) {
  const lines = [COLUMNS.map(cell).join(',')];

  for (const entry of entries) {
    lines.push(toRow(entry.guest, entry.stay).map(cell).join(','));
  }

  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = {
  COLUMNS,
  reportable,
  checkGuest,
  normalisePassport,
  toRow,
  toCsv,
};
