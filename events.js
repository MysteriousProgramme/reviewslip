'use strict';

const { query, one, all } = require('./db');

/**
 * Review events: one row per generated review, and the counts the dashboard
 * reads back off them.
 *
 * Deliberately narrow. No review text, nothing identifying the guest — the
 * point is to answer "how much did this venue use this month", not to keep a
 * record of what anybody wrote.
 */

/** Postgres integer columns; a bad number is better stored as NULL than as 0. */
function int(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * Never throws. A review the guest already has in their hands must not fail
 * because the meter could not be written — the count being one short is the
 * lesser problem, and it is logged.
 */
async function record({ subscriberId, categoryId, model, usage }) {
  try {
    await query(
      `INSERT INTO review_events
         (subscriber_id, category_id, model, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        subscriberId,
        categoryId || null,
        model || null,
        int(usage?.prompt_tokens),
        int(usage?.completion_tokens),
        int(usage?.total_tokens),
      ]
    );
  } catch (err) {
    console.error('Could not record the review event:', err.message);
  }
}

/**
 * This calendar month, in UTC. Billing periods are a later problem; a month
 * boundary everyone can agree on is enough for a usage meter.
 */
const THIS_MONTH = "created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')";

/** @returns {Promise<{reviews: number, tokens: number}>} */
async function usageThisMonth(subscriberId) {
  return one(
    `SELECT COUNT(*)::int AS reviews,
            COALESCE(SUM(total_tokens), 0)::int AS tokens
       FROM review_events
      WHERE subscriber_id = $1 AND ${THIS_MONTH}`,
    [subscriberId]
  );
}

/** The same, for every venue on an account, keyed by subscriber id. */
async function usageThisMonthFor(subscriberIds) {
  if (!subscriberIds.length) return new Map();

  const rows = await all(
    `SELECT subscriber_id,
            COUNT(*)::int AS reviews,
            COALESCE(SUM(total_tokens), 0)::int AS tokens
       FROM review_events
      WHERE subscriber_id = ANY($1::int[]) AND ${THIS_MONTH}
      GROUP BY subscriber_id`,
    [subscriberIds]
  );

  return new Map(
    rows.map((row) => [
      row.subscriber_id,
      { reviews: row.reviews, tokens: row.tokens },
    ])
  );
}

/**
 * Daily counts for a chart. Generated from a date series rather than the rows,
 * so a day with no reviews is a zero instead of a gap.
 */
async function daily(subscriberId, days = 30) {
  return all(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COALESCE(COUNT(e.id), 0)::int AS reviews,
            COALESCE(SUM(e.total_tokens), 0)::int AS tokens
       FROM generate_series(
              date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $2 - 1),
              date_trunc('day', now() AT TIME ZONE 'UTC'),
              interval '1 day'
            ) AS d(day)
       LEFT JOIN review_events e
              ON e.subscriber_id = $1
             AND e.created_at >= d.day
             AND e.created_at <  d.day + interval '1 day'
      GROUP BY d.day
      ORDER BY d.day`,
    [subscriberId, days]
  );
}

/** Which buttons guests actually press, this month. */
async function byCategory(subscriberId) {
  return all(
    `SELECT COALESCE(category_id, 'unknown') AS category,
            COUNT(*)::int AS reviews
       FROM review_events
      WHERE subscriber_id = $1 AND ${THIS_MONTH}
      GROUP BY category
      ORDER BY reviews DESC`,
    [subscriberId]
  );
}

async function lifetime(subscriberId) {
  return one(
    `SELECT COUNT(*)::int AS reviews,
            COALESCE(SUM(total_tokens), 0)::int AS tokens,
            MAX(created_at) AS last_at
       FROM review_events
      WHERE subscriber_id = $1`,
    [subscriberId]
  );
}

module.exports = {
  record,
  usageThisMonth,
  usageThisMonthFor,
  daily,
  byCategory,
  lifetime,
};
