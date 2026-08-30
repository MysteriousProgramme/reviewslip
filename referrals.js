'use strict';

const { query, one, all } = require('./db');
const rewards = require('./rewards');

/**
 * Referrals: who invited whom, and how far along each invitation is.
 *
 * The table was created some migrations ago and has sat unused since. Its three
 * timestamps were written for a world with payment in it — invited, signed up,
 * paying — and there is still no payment, so the third is being used for the
 * bar we actually have: the invited person signed up and signed in.
 *
 * That is a deliberately low bar, and it is worth being clear about why it is
 * acceptable. Nothing is charged, discounted or paid out by this file. A
 * qualified referral changes a line on a dashboard. When Stripe arrives the
 * honest move is a fourth timestamp for paid_at and a rule that reads it — not
 * quietly re-pointing qualified_at, which would leave no way to tell an account
 * that referred five payers from one that referred five signups.
 */

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

// The same expression accounts.js validates signups with. Copied rather than
// exported across, because an address here is a label on an invitation and not
// a credential — if the two ever need to differ, they should be free to.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ------------------------------------------------------------------- shape */

/**
 * A referral as the dashboard sees it.
 *
 * `state` is derived rather than stored. Three nullable timestamps have eight
 * possible combinations and only three of them are real, so the page should be
 * reading one word, not deciding which of three dates to trust.
 */
function toRecord(row) {
  return {
    id: row.id,
    email: row.email,
    code: row.code,
    state: row.qualified_at ? 'joined' : row.signed_up_at ? 'signed up' : 'invited',
    invitedAt: row.invited_at,
    signedUpAt: row.signed_up_at,
    qualifiedAt: row.qualified_at,
  };
}

/* ---------------------------------------------------------------- inviting */

/**
 * Invite an address, and get back the referral to share.
 *
 * The code is per invitation, not per account. That is what the unique index on
 * (referrer_id, lower(email)) is for: one link cannot be posted publicly and
 * claimed by fifty people, because each one is bound to a person the referrer
 * named first. With no payment step to lean on, that is the only thing keeping
 * the count meaning anything at all.
 *
 * @param {{referrerId: number, referrerEmail: string, email: string}} input
 */
async function invite({ referrerId, referrerEmail, email }) {
  const address = String(email ?? '').trim();

  if (!EMAIL_RE.test(address) || address.length > 254) {
    throw fail(400, 'That does not look like an email address.');
  }

  // Inviting yourself is the first thing anyone tries, and it is the one case
  // worth naming out loud rather than silently dropping later.
  if (address.toLowerCase() === String(referrerEmail ?? '').toLowerCase()) {
    throw fail(400, 'That is your own address.');
  }

  // Retried because the code is random and the column is unique. Three attempts
  // against 850 billion possibilities is not a real loop — it is there so a
  // collision is a retry rather than a 500.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const row = await one(
        `INSERT INTO referrals (referrer_id, email, code)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [referrerId, address, rewards.newCode()]
      );
      return toRecord(row);
    } catch (err) {
      if (err?.code !== '23505') throw err;

      // Which unique index tripped changes what the person has to do about it.
      if (String(err.constraint).includes('email')) {
        throw fail(409, 'You have already invited that address.');
      }
    }
  }

  throw fail(500, 'Could not create an invitation. Try again.');
}

/** Withdraw an invitation that has not been taken up. */
async function revoke({ referrerId, id }) {
  const row = await one(
    `DELETE FROM referrals
      WHERE id = $1 AND referrer_id = $2 AND account_id IS NULL
      RETURNING id`,
    [id, referrerId]
  );

  // Scoped by referrer_id, so a missing row is either someone else's invitation
  // or one already claimed. Neither can be withdrawn and neither is worth
  // telling a caller apart — the second would confirm that a code was used.
  if (!row) throw fail(404, 'No such invitation.');
  return true;
}

/* ---------------------------------------------------------------- claiming */

/**
 * Attach a new account to the invitation whose code it arrived with.
 *
 * Called from signup, and deliberately forgiving: a code that is unknown, spent
 * or the caller's own does nothing at all rather than failing the signup. The
 * person typing their password did not choose the code and cannot fix it, and
 * refusing them an account over it would cost a customer to protect a
 * percentage.
 *
 * The invited address is a label, not a check. Someone invited at a work
 * address who signs up with a personal one was still referred, and failing them
 * for it would be the same mistake in a smaller place.
 *
 * @returns {Promise<boolean>} whether a referral was attached
 */
async function claim({ code, accountId }) {
  const clean = rewards.normaliseCode(code);
  if (!clean) return false;

  try {
    const row = await one(
      `UPDATE referrals
          SET account_id = $1, signed_up_at = now()
        WHERE code = $2
          AND account_id IS NULL
          AND referrer_id <> $1
        RETURNING id`,
      [accountId, clean]
    );
    return Boolean(row);
  } catch (err) {
    // The partial unique index on account_id. This account was already the
    // subject of another referral, so the first one keeps it — two referrers
    // cannot both count the same person.
    if (err?.code === '23505') return false;
    throw err;
  }
}

/**
 * Mark an account's referral as having come good, on sign-in.
 *
 * Signing up signs you straight in, so in practice this fires moments after
 * claim() for almost everyone. It is a separate step anyway because the two
 * facts are separate — and because when there is something better to qualify
 * on, this is the one line that has to change.
 *
 * Silent and idempotent: nothing about a sign-in should fail because of a
 * referral, and every subsequent sign-in must leave the first date alone.
 */
async function qualify(accountId) {
  await query(
    `UPDATE referrals
        SET qualified_at = now()
      WHERE account_id = $1 AND qualified_at IS NULL`,
    [accountId]
  );
}

/* ---------------------------------------------------------------- reading */

/**
 * Everything the referrals page shows: the invitations, and where they add up
 * to.
 */
async function listFor(referrerId) {
  const rows = await all(
    `SELECT * FROM referrals
      WHERE referrer_id = $1
      ORDER BY invited_at DESC`,
    [referrerId]
  );

  const referrals = rows.map(toRecord);

  return {
    referrals,
    progress: rewards.progress(
      referrals.filter((r) => r.state === 'joined').length
    ),
  };
}

module.exports = {
  toRecord,
  invite,
  revoke,
  claim,
  qualify,
  listFor,
};
