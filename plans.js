'use strict';

/**
 * Plan limits, as enforced.
 *
 * The website repo has its own copy in `lib/plans.ts` — that one is what
 * customers are *shown*, this one is what actually stops a request. Neither can
 * import from the other, so a limit changed in one has to be changed in both.
 * If they ever disagree, this file is the one that decides.
 */

/** Per venue, per calendar month. Same on every tier. */
const TOKENS_PER_MONTH_PER_VENUE = 1_000_000;

/** Reviews a month, per business. The same on every tier. */
const REVIEWS_PER_BUSINESS = 1_500;

/**
 * What a tier covers. `reviewsPerMonth` is deliberately absent: the limit is
 * per business, so a plan's headline figure is REVIEWS_PER_BUSINESS times the
 * businesses it allows — 10 x 1,500 reads as 15,000 on Enterprise — while the
 * number actually enforced is 1,500 against each one.
 *
 * Conflating the two is how a customer on Enterprise with two businesses ends up
 * believing they have 15,000 reviews to spend on them.
 */
const PLANS = {
  starter: { name: 'Starter', venues: 1 },
  pro: { name: 'Pro', venues: 3 },
  enterprise: { name: 'Enterprise', venues: 10 },
};

const DEFAULT_PLAN = 'starter';

function isPlan(id) {
  return Object.prototype.hasOwnProperty.call(PLANS, id);
}

/** Unknown ids resolve to Starter rather than throwing — a row is never unusable. */
function planFor(id) {
  return PLANS[id] || PLANS[DEFAULT_PLAN];
}

/** @returns {boolean} whether this account may add one more venue */
function canAddVenue(planId, currentCount) {
  const { venues } = planFor(planId);
  return venues === null || currentCount < venues;
}

/** The figure a plan advertises: the per-business limit times its businesses. */
function advertisedReviews(planId) {
  return planFor(planId).venues * REVIEWS_PER_BUSINESS;
}

module.exports = {
  PLANS,
  DEFAULT_PLAN,
  TOKENS_PER_MONTH_PER_VENUE,
  REVIEWS_PER_BUSINESS,
  isPlan,
  planFor,
  canAddVenue,
  advertisedReviews,
};
