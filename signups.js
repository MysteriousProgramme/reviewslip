'use strict';

const { all, one, query } = require('./db');

/**
 * Guests who signed up on a venue's welcome page.
 *
 * The rules — what a valid sign-up is, what the mailing list holds — are in
 * welcome.js. This file is only where they are kept.
 */

function toRecord(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    consent: row.marketing_consent,
    consentedAt: row.consented_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A guest signs up, or signs up again.
 *
 * One row per email per venue, so a guest scanning the code on two visits is
 * one entry on the list, not two. A later visit updates the name.
 *
 * Consent only ever moves forward here. The box is unticked by default, so a
 * returning guest who does not tick it again has not withdrawn anything — they
 * have simply not been asked twice. Withdrawing is done the way every mailing
 * list does it, from the email itself, or by asking the venue, which can
 * delete the row.
 *
 * @returns {Promise<object>} the stored sign-up
 */
async function upsert({ subscriberId, name, email, consent }) {
  const row = await one(
    `INSERT INTO guest_signups (subscriber_id, name, email, marketing_consent, consented_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN now() END)
     ON CONFLICT (subscriber_id, lower(email)) DO UPDATE SET
       name = EXCLUDED.name,
       marketing_consent = guest_signups.marketing_consent OR EXCLUDED.marketing_consent,
       consented_at = COALESCE(guest_signups.consented_at, EXCLUDED.consented_at),
       updated_at = now()
     RETURNING *`,
    [subscriberId, name, email, consent]
  );
  return toRecord(row);
}

/**
 * A sign-up, or null once it has been deleted — which ends the guest's pass.
 * The name comes back with it so the app can greet the guest by it.
 */
async function find({ subscriberId, id }) {
  const row = await one(
    'SELECT * FROM guest_signups WHERE subscriber_id = $1 AND id = $2',
    [subscriberId, id]
  );
  return row ? toRecord(row) : null;
}

/** Every sign-up for a venue, newest first. Small lists: one venue's guests. */
async function list(subscriberId) {
  const rows = await all(
    `SELECT * FROM guest_signups WHERE subscriber_id = $1
     ORDER BY created_at DESC, id DESC`,
    [subscriberId]
  );
  return rows.map(toRecord);
}

/**
 * A guest's details, gone — what a guest is entitled to ask a venue for.
 * Scoped by venue, so an id from another venue deletes nothing.
 *
 * @returns {Promise<boolean>} whether anything was deleted
 */
async function remove({ subscriberId, id }) {
  const result = await query(
    'DELETE FROM guest_signups WHERE subscriber_id = $1 AND id = $2',
    [subscriberId, id]
  );
  return result.rowCount > 0;
}

module.exports = { upsert, find, list, remove };
