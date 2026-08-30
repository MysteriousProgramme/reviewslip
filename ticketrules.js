'use strict';

/**
 * What a ticket may say, and how it moves.
 *
 * Apart from tickets.js, which cannot be loaded without a database. Everything
 * with a rule in it lives here so it can be tested on its own — the same reason
 * ids.js, quota.js and rewards.js exist.
 */

/* ------------------------------------------------------------------ states */

const OPEN = 'open';
const ANSWERED = 'answered';
const CLOSED = 'closed';

const STATUSES = [OPEN, ANSWERED, CLOSED];

/**
 * The two states that mean somebody is still waiting.
 *
 * `answered` counts as active even though the ball is with the customer. It is
 * their ticket and it is not finished; treating it as done would let them open
 * a second one to say the thing they were about to say in this one, which is
 * how a one-ticket limit turns into two threads about the same problem.
 */
const ACTIVE = [OPEN, ANSWERED];

/**
 * How many tickets one account may have going at once.
 *
 * One. It keeps the queue honest — a queue where a single person can open
 * fifty is not a queue — and for a product this size it is also just true that
 * a customer with two problems is better served by one thread about both.
 *
 * Closed tickets do not count. The limit is on what is outstanding, not on how
 * many times somebody may ever ask for help.
 */
const MAX_ACTIVE = 1;

function isActive(status) {
  return ACTIVE.includes(status);
}

/* -------------------------------------------------------------- what it says */

const TITLE_MAX = 120;
const BODY_MAX = 4000;

/** @returns {{ok: boolean, error?: string}} */
function checkTitle(value) {
  const title = String(value ?? '').trim();
  if (!title) return { ok: false, error: 'Give it a subject.' };
  if (title.length > TITLE_MAX) {
    return { ok: false, error: `A subject is at most ${TITLE_MAX} characters.` };
  }
  return { ok: true };
}

/** @returns {{ok: boolean, error?: string}} */
function checkBody(value) {
  const body = String(value ?? '').trim();
  if (!body) return { ok: false, error: 'Say what is wrong.' };
  if (body.length > BODY_MAX) {
    return {
      ok: false,
      error: `That is longer than ${BODY_MAX.toLocaleString()} characters. Send the important part and we will ask for the rest.`,
    };
  }
  return { ok: true };
}

/* ----------------------------------------------------------- how it moves */

/**
 * The status a ticket lands in after somebody adds to it.
 *
 * Two rules, and the second is the one that makes the queue worth reading:
 *
 *   staff replied     -> answered, so it leaves the open queue
 *   customer replied  -> open, so it comes back
 *
 * The second applies to a closed ticket too, which is what reopening is. A
 * customer replying to something we closed has not been helped, and making them
 * start again would throw away the history at the moment it is most useful.
 *
 * Closing is not here. It is a decision somebody makes, not a consequence of
 * writing a message, so it is its own call.
 */
function nextStatus(fromStaff) {
  return fromStaff ? ANSWERED : OPEN;
}

/**
 * Whether an account may start a new ticket.
 *
 * @param {number} activeCount how many of their tickets are open or answered
 */
function canOpen(activeCount) {
  // Coerced. This arrives from a COUNT(*), which the driver returns as a
  // string, and a comparison against a string here would let somebody past the
  // limit or lock them out of their first ticket depending on which way it went.
  const n = Number(activeCount);
  return (Number.isSafeInteger(n) && n >= 0 ? n : 0) < MAX_ACTIVE;
}

module.exports = {
  OPEN,
  ANSWERED,
  CLOSED,
  STATUSES,
  ACTIVE,
  MAX_ACTIVE,
  TITLE_MAX,
  BODY_MAX,
  isActive,
  checkTitle,
  checkBody,
  nextStatus,
  canOpen,
};
