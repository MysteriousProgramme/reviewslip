'use strict';

const express = require('express');

const accounts = require('./accounts');
const plans = require('./plans');
const rewards = require('./rewards');
const { publicUrl } = require('./tenant');
const { one, all } = require('./db');
const tickets = require('./tickets');
const mailer = require('./mailer');
const emails = require('./emails');

/**
 * The staff view: every account, every venue, and what each one is doing.
 *
 * Distinct from admin.js, which is the same idea with a different key. That one
 * is gated by ADMIN_TOKEN, is about provisioning venues, and is meant for a
 * terminal. This is gated by a signed-in account carrying is_admin, is read-only,
 * and is what admin.reviewslip.com renders. Two different doors because they
 * answer to two different things — a shared secret in an env file, and a person.
 *
 * Read-only about customers: nothing here can change an account, a plan or a
 * venue. The only writes are on tickets — replying and closing — which is a
 * conversation the customer is already part of and can read either way.
 *
 * That distinction is worth keeping. Everything else this exposes is either
 * already public to the customer or a count, so a leaked staff session can tell
 * somebody what they could have asked us for; it cannot change what they are
 * paying or take a venue away. A write that alters a customer's own data would
 * end that property, and should be argued for on its own rather than added
 * because there was already a router here.
 */

const router = express.Router();

/**
 * Anything that is not a signed-in admin gets 404.
 *
 * Not 401 or 403, which is the point: those confirm the route exists. A
 * customer who guesses admin.reviewslip.com, and anybody who finds it in a
 * bundle, should get exactly what they would get for any address that is not a
 * page. The website renders its own not-found for the same reason.
 *
 * It also means a signed-in non-admin and a stranger cannot tell each other's
 * situation apart, which is the property that makes the hiding worth anything.
 */
function requireStaff(req, res, next) {
  if (!req.account?.is_admin) {
    return res.status(404).json({ error: 'Not found.' });
  }
  next();
}

router.use(requireStaff);

/**
 * Postgres counts are bigints, and the driver returns bigints as strings.
 *
 * Every count below goes through here. This codebase has already lost a feature
 * to a string that was assumed to be a number, and a dashboard rendering "12"
 * as a string mostly works until something sorts or sums it.
 */
function count(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/* ------------------------------------------------------------------ overview */

/**
 * The headline numbers, as one query.
 *
 * Scalar subqueries rather than joins: these count five unrelated things, and
 * joining them would multiply rows against each other for no reason. Postgres
 * runs each once.
 *
 * The month boundary is copied from events.js verbatim. Not shared through an
 * import because that module is about a venue's own usage and this is a
 * platform total — but they have to agree, or a customer reading 40 on their
 * dashboard and staff reading 38 here starts a conversation about which is
 * lying. If one moves, move both.
 */
router.get('/overview', async (req, res, next) => {
  try {
    const month = "created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')";

    const row = await one(`
      SELECT
        (SELECT count(*) FROM accounts) AS accounts,
        (SELECT count(*) FROM subscribers) AS venues,
        (SELECT count(*) FROM subscribers WHERE account_id IS NULL) AS orphans,
        (SELECT count(*) FROM review_events WHERE ${month}) AS reviews_month,
        (SELECT count(*) FROM review_events
          WHERE ${month} AND proceeded_at IS NOT NULL) AS taken_month,
        (SELECT count(*) FROM support_tickets WHERE status = 'open') AS tickets_open,
        (SELECT count(*) FROM referrals WHERE qualified_at IS NOT NULL) AS referrals_joined
    `);

    res.json({
      accounts: count(row.accounts),
      venues: count(row.venues),
      orphans: count(row.orphans),
      reviewsThisMonth: count(row.reviews_month),
      takenThisMonth: count(row.taken_month),
      openTickets: count(row.tickets_open),
      referralsJoined: count(row.referrals_joined),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ accounts */

/**
 * Every account, with enough on each row to know which one to open.
 *
 * The three counts are done as one grouped query rather than per row. It is a
 * small table today and would be fine either way; it is written this way
 * because the per-row version is the kind of thing that is fine until it very
 * suddenly is not, and the fix afterwards is this query anyway.
 *
 * DISTINCT on each count because joining venues and referrals in the same
 * statement multiplies the rows: an account with 3 venues and 4 referrals
 * produces 12, and a plain count(*) would report both numbers as 12.
 */
router.get('/accounts', async (req, res, next) => {
  try {
    const rows = await all(`
      SELECT a.id, a.email, a.username, a.plan, a.status, a.is_admin, a.created_at,
             count(DISTINCT s.id) AS venues,
             count(DISTINCT r.id) AS referrals,
             count(DISTINCT r.id) FILTER (WHERE r.qualified_at IS NOT NULL) AS qualified
        FROM accounts a
        LEFT JOIN subscribers s ON s.account_id = a.id
        LEFT JOIN referrals r ON r.referrer_id = a.id
       GROUP BY a.id
       ORDER BY a.created_at DESC
    `);

    res.json({
      accounts: rows.map((row) => ({
        ...accounts.toRecord(row),
        venues: count(row.venues),
        referrals: {
          total: count(row.referrals),
          qualified: count(row.qualified),
        },
        progress: rewards.progress(count(row.qualified)),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * One account in full: what they are on, what they own, who they brought.
 *
 * Three queries rather than one join, because they answer three questions and a
 * single statement would have to be un-multiplied afterwards anyway.
 */
router.get('/accounts/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(404).json({ error: 'Not found.' });
    }

    const row = await accounts.byId(id);
    if (!row) return res.status(404).json({ error: 'Not found.' });

    const venues = await all(
      `SELECT s.id, s.slug, s.name, s.status, s.created_at,
              s.google_url IS NOT NULL AND s.google_url <> '' AS has_google,
              count(e.id) AS reviews,
              count(e.id) FILTER (WHERE e.proceeded_at IS NOT NULL) AS taken,
              max(e.created_at) AS last_review
         FROM subscribers s
         LEFT JOIN review_events e ON e.subscriber_id = s.id
        WHERE s.account_id = $1
        GROUP BY s.id
        ORDER BY s.created_at DESC`,
      [id]
    );

    // The referred account's email as well as the invited address. They are
    // often different — the invited one is a label and signing up with another
    // still counts — and when they differ that is the thing worth seeing.
    const invited = await all(
      `SELECT r.id, r.email, r.code, r.invited_at, r.signed_up_at, r.qualified_at,
              b.email AS joined_as
         FROM referrals r
         LEFT JOIN accounts b ON b.id = r.account_id
        WHERE r.referrer_id = $1
        ORDER BY r.invited_at DESC`,
      [id]
    );

    // Who brought them, if anybody. The other direction of the same table, and
    // the question you actually have when looking at a new account.
    const referredBy = await one(
      `SELECT a.id, a.email, r.qualified_at
         FROM referrals r
         JOIN accounts a ON a.id = r.referrer_id
        WHERE r.account_id = $1`,
      [id]
    );

    const plan = plans.planFor(row.plan);
    const qualified = invited.filter((r) => r.qualified_at).length;

    res.json({
      account: accounts.toRecord(row),
      plan: {
        id: row.plan,
        name: plan.name,
        venues: plan.venues,
        reviewsPerBusiness: plans.REVIEWS_PER_BUSINESS,
        tokensPerMonthPerBusiness: plans.TOKENS_PER_MONTH_PER_VENUE,
      },
      venues: venues.map((v) => ({
        slug: v.slug,
        name: v.name,
        status: v.status,
        url: publicUrl(v.slug),
        createdAt: v.created_at,
        // "Ready" on the customer's own dashboard means the same thing: a venue
        // with no review link generates drafts nobody can post.
        ready: v.has_google === true,
        reviews: count(v.reviews),
        taken: count(v.taken),
        lastReview: v.last_review,
      })),
      referrals: {
        invited: invited.map((r) => ({
          id: r.id,
          email: r.email,
          code: r.code,
          state: r.qualified_at ? 'joined' : r.signed_up_at ? 'signed up' : 'invited',
          joinedAs: r.joined_as,
          invitedAt: r.invited_at,
          signedUpAt: r.signed_up_at,
          qualifiedAt: r.qualified_at,
        })),
        progress: rewards.progress(qualified),
      },
      referredBy: referredBy
        ? {
            id: referredBy.id,
            email: referredBy.email,
            qualified: Boolean(referredBy.qualified_at),
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------- venues */

/**
 * Every venue on the platform, newest first, with its owner.
 *
 * A venue whose account was deleted keeps serving — subscribers.account_id is
 * ON DELETE SET NULL — so `owner` can be null, and those are exactly the rows
 * worth being able to see. Nothing else in the product surfaces them.
 */
router.get('/venues', async (req, res, next) => {
  try {
    const rows = await all(`
      SELECT s.slug, s.name, s.status, s.created_at, s.account_id,
             a.email AS owner_email,
             count(e.id) AS reviews,
             max(e.created_at) AS last_review
        FROM subscribers s
        LEFT JOIN accounts a ON a.id = s.account_id
        LEFT JOIN review_events e ON e.subscriber_id = s.id
       GROUP BY s.id, a.email
       ORDER BY s.created_at DESC
    `);

    res.json({
      venues: rows.map((row) => ({
        slug: row.slug,
        name: row.name,
        status: row.status,
        url: publicUrl(row.slug),
        createdAt: row.created_at,
        owner: row.account_id
          ? { id: row.account_id, email: row.owner_email }
          : null,
        reviews: count(row.reviews),
        lastReview: row.last_review,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ support */

/** The queue: everything open, oldest first, then answered, then closed. */
router.get('/tickets', async (req, res, next) => {
  try {
    res.json({ tickets: await tickets.queue() });
  } catch (err) {
    next(err);
  }
});

/** One ticket, its thread, and who it is from. Unscoped — this is the queue. */
router.get('/tickets/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(404).json({ error: 'Not found.' });
    }
    res.json(await tickets.get({ id }));
  } catch (err) {
    next(err);
  }
});

/**
 * Answer.
 *
 * `scopeToAccount: false` because the ticket belongs to a customer, not to the
 * person replying. `accountId` is still the staff account — it is who wrote the
 * message, which is what ticket_messages.author_id records.
 */
router.post('/tickets/:id/reply', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(404).json({ error: 'Not found.' });
    }

    const ticket = await tickets.reply({
      id,
      accountId: req.account.id,
      fromStaff: true,
      body: req.body?.body,
      scopeToAccount: false,
    });

    // The customer gets the reply itself, not a note saying there is one.
    // Never allowed to fail the reply: it is saved, and a bounced notification
    // must not read as a failure to answer.
    try {
      const { account } = await tickets.get({ id });
      await mailer.send({
        to: account.email,
        ...emails.ticketReplyEmail({
          title: ticket.title,
          body: req.body?.body,
          url: customerTicketUrl(),
        }),
      });
    } catch (err) {
      console.error('Reply notification failed for ticket %d:', id, err);
    }

    res.json({ ticket });
  } catch (err) {
    next(err);
  }
});

router.post('/tickets/:id/close', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(404).json({ error: 'Not found.' });
    }
    res.json({
      ticket: await tickets.close({ id, accountId: null, scopeToAccount: false }),
    });
  } catch (err) {
    next(err);
  }
});

/** Where a customer reads their own tickets. Empty off a real host. */
function customerTicketUrl() {
  const domain = String(process.env.BASE_DOMAIN || '').trim();
  if (!domain || domain === 'localhost' || domain.endsWith('.localhost')) {
    return '';
  }
  return `https://${domain}/dashboard/support`;
}

module.exports = { router, requireStaff };
