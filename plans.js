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

/** `venues: null` means unlimited. */
const PLANS = {
  starter: {
    name: 'Starter',
    venues: 1,
    reviewsPerMonth: 1_500,
    reviewsArePerVenue: false,
  },
  pro: {
    name: 'Pro',
    venues: 3,
    reviewsPerMonth: 4_500,
    reviewsArePerVenue: false,
  },
  enterprise: {
    name: 'Enterprise',
    venues: 10,
    reviewsPerMonth: 15_000,
    reviewsArePerVenue: false,
  },
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

/** Reviews a month across the account, which depends on venue count on Agency. */
function reviewAllowance(planId, venueCount) {
  const plan = planFor(planId);
  return plan.reviewsArePerVenue
    ? plan.reviewsPerMonth * Math.max(venueCount, 1)
    : plan.reviewsPerMonth;
}

module.exports = {
  PLANS,
  DEFAULT_PLAN,
  TOKENS_PER_MONTH_PER_VENUE,
  isPlan,
  planFor,
  canAddVenue,
  reviewAllowance,
};
