'use strict';

/**
 * The messages this product sends, as text.
 *
 * Pure, and apart from mailer.js, which cannot be tested without AWS. What an
 * invitation actually says is the part worth being able to check.
 *
 * There is one rule behind all of it: an invitation goes to somebody who never
 * gave us their address. Someone else typed it in. That makes it the one kind
 * of mail here that a stranger did not ask for, and everything below follows
 * from that — it says who invited them, it says it will not happen again, and
 * it happens once with no follow-up. Not politeness. A domain that sends
 * unwanted mail loses the ability to deliver the password resets and receipts
 * that customers actually need, and SES will suspend an account over a bounce
 * rate before that.
 */

/** Trim, collapse whitespace, and cap — for anything shown to a stranger. */
function clean(value, max = 80) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/**
 * An invitation to sign up.
 *
 * `referrer` is a business name, not an email address. Naming the business is
 * what makes the message make sense to the person reading it; naming the
 * account behind it would hand a stranger somebody's email because a third
 * party typed theirs into a box. When there is no business name yet it falls
 * back to something anonymous rather than reaching for the address.
 *
 * @param {{referrer?: string, url: string}} input
 * @returns {{subject: string, text: string, html: string}}
 */
function inviteEmail({ referrer, url }) {
  const who = clean(referrer) || 'Someone';
  const link = String(url ?? '');

  const subject = `${who} invited you to Reviewslip`;

  const text = [
    `${who} uses Reviewslip to help their customers write reviews, and has invited you to try it.`,
    '',
    'Set up your account here:',
    link,
    '',
    'The link is meant for you and works once.',
    '',
    `If you do not know ${who}, ignore this — it is the only message you will get from us.`,
    '',
    '— Reviewslip',
  ].join('\n');

  // Deliberately plain. A table-based, image-heavy template is more likely to
  // be filtered than read, and this message is four sentences long.
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.6;color:#1b2a23;max-width:34rem">',
    `<p>${escapeHtml(who)} uses Reviewslip to help their customers write reviews, and has invited you to try it.</p>`,
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:0.7rem 1.3rem;border-radius:999px;background:#e9a03b;color:#22190a;text-decoration:none;font-weight:600">Set up your account</a></p>`,
    `<p style="font-size:0.9em;color:#5a6b63">Or paste this into your browser:<br><a href="${escapeHtml(link)}" style="color:#2f5f4c">${escapeHtml(link)}</a></p>`,
    '<p style="font-size:0.9em;color:#5a6b63">The link is meant for you and works once.</p>',
    `<p style="font-size:0.9em;color:#5a6b63">If you do not know ${escapeHtml(who)}, ignore this — it is the only message you will get from us.</p>`,
    '<p style="font-size:0.9em;color:#5a6b63">— Reviewslip</p>',
    '</div>',
  ].join('');

  return { subject, text, html };
}

/* -------------------------------------------------------------- tickets */

/**
 * A reply on a customer's ticket, to the customer.
 *
 * Carries the reply in full rather than "you have a new message". Somebody
 * waiting on support should be able to read the answer without signing in, and
 * a notification that withholds it is a second errand, not a courtesy.
 */
function ticketReplyEmail({ title, body, url }) {
  const subject = `Re: ${clean(title, 100)}`;
  const reply = String(body ?? '').trim();

  const text = [
    reply,
    '',
    '—',
    'Reply to this ticket here:',
    String(url ?? ''),
    '',
    '— Reviewslip support',
  ].join('\n');

  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.6;color:#1b2a23;max-width:34rem">',
    `<p style="white-space:pre-wrap">${escapeHtml(reply)}</p>`,
    '<hr style="border:none;border-top:1px solid #d9d2c2;margin:1.5rem 0">',
    `<p style="font-size:0.9em"><a href="${escapeHtml(String(url ?? ''))}" style="color:#2f5f4c">Reply to this ticket</a></p>`,
    '<p style="font-size:0.9em;color:#5a6b63">— Reviewslip support</p>',
    '</div>',
  ].join('');

  return { subject, text, html };
}

/**
 * Something happened on a ticket, to us.
 *
 * Plain text only. It goes to one mailbox that one person reads, and the point
 * is to know quickly — who, which venue, and what they said.
 */
function ticketAlertEmail({ opened, from, venue, title, body, url }) {
  const who = clean(from, 120) || 'A customer';
  const subject = `${opened ? 'New ticket' : 'Reply'}: ${clean(title, 90)}`;

  const text = [
    `${who}${venue ? ` (${clean(venue)})` : ''} ${opened ? 'opened a ticket' : 'replied'}:`,
    '',
    String(body ?? '').trim(),
    '',
    '—',
    String(url ?? ''),
  ].join('\n');

  return { subject, text, html: '' };
}

module.exports = {
  inviteEmail,
  ticketReplyEmail,
  ticketAlertEmail,
  clean,
  escapeHtml,
};
