'use strict';

const { one, all } = require('./db');
const rules = require('./ticketrules');

/**
 * Support tickets, and the conversations on them.
 *
 * The header table has existed since its migration and has never been written
 * to. It holds one title and one body, which is a suggestion box — the replies
 * are in ticket_messages, added alongside it.
 *
 * The opening message is stored twice on purpose: once as support_tickets.body,
 * which is the column that already exists and is what a list needs to show a
 * preview, and once as the first row in ticket_messages, so a thread is one
 * ordered read rather than "this column, then those rows". The duplication is
 * a few hundred bytes and it buys every reader a simpler query.
 */

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

/* ------------------------------------------------------------------- shape */

function toRecord(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    active: rules.isActive(row.status),
    venue: row.slug ? { slug: row.slug, name: row.venue_name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row) {
  return {
    id: row.id,
    body: row.body,
    fromStaff: row.from_staff === true,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ reading */

/** One account's tickets, newest first, without their messages. */
async function listFor(accountId) {
  const rows = await all(
    `SELECT t.*, s.slug, s.name AS venue_name
       FROM support_tickets t
       LEFT JOIN subscribers s ON s.id = t.subscriber_id
      WHERE t.account_id = $1
      ORDER BY t.created_at DESC`,
    [accountId]
  );

  const tickets = rows.map(toRecord);

  return {
    tickets,
    // What the page needs to decide between a compose form and a thread.
    active: tickets.find((t) => t.active) ?? null,
    canOpen: rules.canOpen(tickets.filter((t) => t.active).length),
  };
}

/**
 * One ticket with its thread.
 *
 * `accountId` scopes it. Passing null reads any ticket, which only staff.js
 * does — and a customer asking for somebody else's id gets the same "no such
 * ticket" as one asking for an id that does not exist.
 */
async function get({ id, accountId = null }) {
  const row = await one(
    `SELECT t.*, s.slug, s.name AS venue_name, a.email AS account_email
       FROM support_tickets t
       LEFT JOIN subscribers s ON s.id = t.subscriber_id
       LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.id = $1 AND ($2::int IS NULL OR t.account_id = $2)`,
    [id, accountId]
  );
  if (!row) throw fail(404, 'No such ticket.');

  const messages = await all(
    `SELECT * FROM ticket_messages
      WHERE ticket_id = $1
      ORDER BY created_at, id`,
    [id]
  );

  return {
    ticket: toRecord(row),
    account: { id: row.account_id, email: row.account_email },
    messages: messages.map(toMessage),
  };
}

/* ------------------------------------------------------------------ writing */

/**
 * Open a ticket.
 *
 * The limit is checked here and enforced by a partial unique index in the
 * database. Both, deliberately: the check produces a sentence a person can act
 * on, and the index is what actually holds when two requests arrive together
 * and both pass the check before either writes.
 *
 * @param {{accountId: number, title: string, body: string, venueId?: number|null}} input
 */
async function open({ accountId, title, body, venueId = null }) {
  for (const check of [rules.checkTitle(title), rules.checkBody(body)]) {
    if (!check.ok) throw fail(400, check.error);
  }

  try {
    const row = await one(
      `INSERT INTO support_tickets (account_id, subscriber_id, title, body, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [accountId, venueId, String(title).trim(), String(body).trim(), rules.OPEN]
    );

    await one(
      `INSERT INTO ticket_messages (ticket_id, author_id, from_staff, body)
       VALUES ($1, $2, false, $3)
       RETURNING id`,
      [row.id, accountId, String(body).trim()]
    );

    return toRecord(row);
  } catch (err) {
    if (err?.code === '23505') {
      throw fail(
        409,
        'You already have a ticket open. Reply to it rather than starting another.'
      );
    }
    // A venue id that is not theirs, or no longer exists.
    if (err?.code === '23503') throw fail(400, 'No such business.');
    throw err;
  }
}

/**
 * Add a message, and move the ticket.
 *
 * Reopening a closed ticket is the same call: the customer replying to
 * something we closed has not been helped, and a new thread would throw away
 * the history exactly when it is most useful. It is refused only when they
 * already have another ticket going, because that would put them over the
 * limit by the back door — and the unique index would refuse it anyway, less
 * legibly.
 *
 * @param {{id: number, accountId: number, fromStaff: boolean, body: string,
 *          scopeToAccount?: boolean}} input
 */
async function reply({ id, accountId, fromStaff, body, scopeToAccount = true }) {
  const check = rules.checkBody(body);
  if (!check.ok) throw fail(400, check.error);

  const ticket = await one(
    `SELECT * FROM support_tickets
      WHERE id = $1 AND ($2::int IS NULL OR account_id = $2)`,
    [id, scopeToAccount ? accountId : null]
  );
  if (!ticket) throw fail(404, 'No such ticket.');

  const status = rules.nextStatus(fromStaff);

  try {
    await one(
      `INSERT INTO ticket_messages (ticket_id, author_id, from_staff, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [id, accountId, Boolean(fromStaff), String(body).trim()]
    );

    const row = await one(
      `UPDATE support_tickets
          SET status = $2, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, status]
    );

    return toRecord(row);
  } catch (err) {
    if (err?.code === '23505') {
      throw fail(
        409,
        'You have another ticket open. Close it before reopening this one.'
      );
    }
    throw err;
  }
}

/**
 * Close a ticket. Either side may — a customer saying it is sorted should not
 * have to wait for us to agree, and it frees the one slot they have.
 */
async function close({ id, accountId, scopeToAccount = true }) {
  const row = await one(
    `UPDATE support_tickets
        SET status = $3, updated_at = now()
      WHERE id = $1 AND ($2::int IS NULL OR account_id = $2)
      RETURNING *`,
    [id, scopeToAccount ? accountId : null, rules.CLOSED]
  );
  if (!row) throw fail(404, 'No such ticket.');
  return toRecord(row);
}

/* -------------------------------------------------------------------- staff */

/**
 * The queue: everything not closed, oldest first, then the closed ones.
 *
 * Oldest first within a status, which is what support_tickets_queue indexes and
 * what a queue means — the person who has waited longest is the one to answer.
 * Newest-first would quietly bury exactly the tickets that have gone wrong.
 */
async function queue() {
  const rows = await all(
    `SELECT t.*, s.slug, s.name AS venue_name, a.email AS account_email,
            (SELECT count(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS messages,
            (SELECT max(created_at) FROM ticket_messages m WHERE m.ticket_id = t.id) AS last_message
       FROM support_tickets t
       LEFT JOIN subscribers s ON s.id = t.subscriber_id
       LEFT JOIN accounts a ON a.id = t.account_id
      ORDER BY (t.status = 'closed'), t.created_at`
  );

  return rows.map((row) => ({
    ...toRecord(row),
    account: { id: row.account_id, email: row.account_email },
    // A bigint from count(*), which the driver hands back as a string.
    messages: Number(row.messages) || 0,
    lastMessage: row.last_message,
  }));
}

module.exports = { listFor, get, open, reply, close, queue, toRecord };
