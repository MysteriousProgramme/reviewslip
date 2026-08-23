'use strict';

const { query, one, all } = require('./db');

/**
 * Review events: one row per generated review, and the counts the dashboard
 * reads back off them.
 *
 * Stores the review text and, when a guest rates it, their thumb. Nothing about
 * the guest is kept — no address, no identifier, no session — so a row says what
 * the writer produced and whether it was any good, and nothing about who saw it.
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
async function record({
  subscriberId,
  categoryId,
  model,
  usage,
  reviewText,
  language,
  length,
}) {
  try {
    const row = await one(
      `INSERT INTO review_events
         (subscriber_id, category_id, model, prompt_tokens, completion_tokens,
          total_tokens, review_text, language, length)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        subscriberId,
        categoryId || null,
        model || null,
        int(usage?.prompt_tokens),
        int(usage?.completion_tokens),
        int(usage?.total_tokens),
        typeof reviewText === 'string' ? reviewText.slice(0, 2000) : null,
        language || null,
        length || null,
      ]
    );
    return row?.id ?? null;
  } catch (err) {
    console.error('Could not record the review event:', err.message);
    return null;
  }
}

/**
 * A guest's thumb on one review.
 *
 * Scoped to the business as well as the row id, so a guest on one page cannot
 * rate another business's reviews by guessing numbers. Re-rating overwrites:
 * someone who taps the wrong thumb should be able to fix it.
 *
 * @returns {Promise<boolean>} whether a row was actually rated
 */
async function setFeedback({ subscriberId, id, rating }) {
  // null clears the rating, which is how someone undoes a misclick. Anything
  // outside one to five is refused by the caller before it reaches here, and by
  // a check constraint after, so a bad number cannot quietly become a star.
  const stars = rating === null ? null : Number(rating);

  const result = await query(
    `UPDATE review_events
        SET rating = $1, rated_at = CASE WHEN $1::smallint IS NULL THEN NULL ELSE now() END
      WHERE id = $2 AND subscriber_id = $3`,
    [stars, Number(id), subscriberId]
  );
  return result.rowCount > 0;
}

/**
 * Marks one review as taken to a listing.
 *
 * This is what turns a draft into a review. Every generation writes a row,
 * because that is what meters the tokens; only the one the guest actually
 * carried away is something the business wrote. Everything that reads the
 * corpus — the list below, the examples fed back into the prompt, the sample
 * written away from — requires this to be set.
 *
 * Scoped to the business as well as the row, like the rating is, so a guest on
 * one page cannot mark another business's rows by guessing numbers.
 *
 * Set once. A guest who taps Google and then Facebook has published once as far
 * as this is concerned, and the second tap must not move the timestamp — the
 * dashboard orders by it, and a review would climb the list every time somebody
 * pressed a second button.
 *
 * @returns {Promise<boolean>} whether a row was actually marked
 */
async function markProceeded({ subscriberId, id }) {
  const result = await query(
    `UPDATE review_events
        SET proceeded_at = now()
      WHERE id = $1 AND subscriber_id = $2 AND proceeded_at IS NULL`,
    [Number(id), subscriberId]
  );
  return result.rowCount > 0;
}

/**
 * The latest reviews, newest first, rated or not — what the dashboard list
 * shows so the owner can work through them.
 *
 * Rows from before the text column existed come back with review_text null;
 * they are still counted in the stats, so they are excluded here rather than
 * shown as blanks with nothing to judge.
 */
async function recent(subscriberId, limit = 20) {
  return all(
    `SELECT id, review_text, category_id, rating, rated_at, created_at,
              language, length
       FROM review_events
      WHERE subscriber_id = $1 AND review_text IS NOT NULL
        AND proceeded_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [subscriberId, Math.min(Number(limit) || 20, 100)]
  );
}

/** The rated reviews, newest first — for a filtered view of the same list. */
async function rated(subscriberId, limit = 50) {
  return all(
    `SELECT id, review_text, category_id, rating, rated_at, created_at,
              language, length
       FROM review_events
      WHERE subscriber_id = $1 AND rating IS NOT NULL
        AND proceeded_at IS NOT NULL
      ORDER BY rated_at DESC
      LIMIT $2`,
    [subscriberId, Math.min(Number(limit) || 50, 200)]
  );
}

/**
 * Five-star reviews, which the writer is shown on every generation from then on.
 *
 * This is what "AI training" actually means at this scale: a handful of approved
 * samples in the prompt, per business. Fine-tuning needs orders of magnitude
 * more rated data than any one business will produce.
 *
 * Five and only five stars. Four means "nearly", and a business that rates
 * honestly will have far more fours than fives — feeding those back would teach
 * the writer to aim at nearly-right. The bar is deliberately the top of the
 * scale, so marking one is a decision rather than a shrug.
 *
 * Ordered newest-rated first and capped, because every one of these costs
 * prompt tokens on every review. A business with forty five-star reviews gets
 * its most recent handful, not all forty.
 */
async function topRated(subscriberId, limit = 5) {
  const rows = await all(
    `SELECT review_text
       FROM review_events
      WHERE subscriber_id = $1 AND rating = 5 AND review_text IS NOT NULL
        AND proceeded_at IS NOT NULL
      ORDER BY rated_at DESC
      LIMIT $2`,
    [subscriberId, Math.min(Number(limit) || 5, 20)]
  );
  return rows.map((row) => row.review_text);
}

/**
 * One and two star reviews, as things to write away from.
 *
 * A rejected review is at least as informative as an approved one — it says what
 * this business does not want said about it.
 *
 * Worst first, unlike the examples above: if only three fit, they should be the
 * three the owner disliked most rather than the three they happened to rate most
 * recently.
 */
async function poorlyRated(subscriberId, limit = 3) {
  const rows = await all(
    `SELECT review_text
       FROM review_events
      WHERE subscriber_id = $1 AND rating <= 2 AND review_text IS NOT NULL
        AND proceeded_at IS NOT NULL
      ORDER BY rating ASC, rated_at DESC
      LIMIT $2`,
    [subscriberId, Math.min(Number(limit) || 3, 10)]
  );
  return rows.map((row) => row.review_text);
}

/**
 * A spread of what this business has already published, to write away from.
 *
 * Sampled at random across the last hundred rather than taking the newest few.
 * The newest few are the ones most likely to resemble each other already, so
 * avoiding only those leaves the model free to drift back towards a review from
 * last week. Random sampling costs the same tokens and covers far more ground.
 */
async function spread(subscriberId, take = 8, pool = 100) {
  const rows = await all(
    `SELECT review_text
       FROM (
         SELECT review_text
           FROM review_events
          WHERE subscriber_id = $1 AND review_text IS NOT NULL
            AND proceeded_at IS NOT NULL
          ORDER BY created_at DESC
          LIMIT $3
       ) AS recent
      ORDER BY random()
      LIMIT $2`,
    [subscriberId, Math.min(Number(take) || 8, 20), Math.min(Number(pool) || 100, 500)]
  );
  return rows.map((row) => row.review_text);
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
  markProceeded,
  record,
  recent,
  setFeedback,
  rated,
  topRated,
  poorlyRated,
  spread,
  usageThisMonth,
  usageThisMonthFor,
  daily,
  byCategory,
  lifetime,
};
