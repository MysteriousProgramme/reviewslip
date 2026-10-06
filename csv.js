'use strict';

/**
 * CSV for files a person opens in Excel.
 *
 * Shared by the TM30 export and the guest mailing list, which both end up in a
 * spreadsheet before they go anywhere else.
 */

/** One field: quoted when it has to be, doubled quotes inside. */
function cell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One field that a stranger typed.
 *
 * A spreadsheet treats a cell starting with = + - or @ as a formula, so a name
 * typed into a public form as `=HYPERLINK(...)` would run when the venue opens
 * its mailing list. A leading apostrophe makes Excel and Sheets show the text
 * as text and is dropped from the displayed value.
 *
 * Not used for the TM30 file, whose phone numbers start with + on purpose and
 * go on to a government upload that would reject the apostrophe.
 */
function untrusted(value) {
  const text = String(value ?? '');
  return cell(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
}

/**
 * A whole file: a UTF-8 byte-order mark and CRLF line endings, both for Excel.
 * Without the mark it reads Thai and accented names as its local codepage;
 * without CRLF some versions put everything on one line.
 *
 * @param {string[]} header - already-escaped header cells
 * @param {string[][]} rows - already-escaped cells
 */
function file(header, rows) {
  return '﻿' + [header, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
}

module.exports = { cell, untrusted, file };
