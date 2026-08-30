'use strict';

/**
 * Identifiers that arrive from the database as strings.
 *
 * Its own module for one reason: everything that touches the database is behind
 * db.js, which refuses to load without a connection string — so a check living
 * in events.js cannot be tested without a Postgres. That is how the bug this
 * exists to prevent survived: nothing could exercise it.
 *
 * The same reasoning as quota.js. Logic worth getting right has to be reachable
 * by a test, and "it needs the database" is usually a sign it is in the wrong
 * file rather than a fact about the logic.
 */

/**
 * A review id from anywhere, as a number, or null.
 *
 * `review_events.id` is a bigint, and node-postgres hands bigints back as
 * strings — deliberately, because one can exceed what a JavaScript number
 * represents exactly. So the id reached the guest page as "47", every
 * `Number.isInteger` guard between here and there said no, and the request
 * marking a review as taken to a listing was never sent. No error on either
 * side: the button simply did nothing, for as long as it had existed.
 *
 * Safe integers only. Past 2^53 a number stops holding a bigint exactly, and an
 * id that is quietly the wrong row is worse than no id — that ceiling is what
 * the driver is protecting by using strings, and this respects it rather than
 * assuming the table stays small.
 */
function reviewId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

module.exports = { reviewId };
