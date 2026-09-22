'use strict';

const { one, all, query } = require('./db');
const inbound = require('./inbound');
const { PLATFORMS } = require('./platforms');

/**
 * Reviews on the venue's own listings: storing them, and reading them back.
 *
 * The rules for what counts as the same review live in inbound.js, which is
 * pure and tested. This is the half that touches the database.
 */

const LABELS = new Map(PLATFORMS.map((p) => [p.id, p.label]));

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

/** Postgres counts arrive as strings. */
function count(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function toRecord(row) {
  return {
    id: row.id,
    platform: row.platform,
    platformLabel: LABELS.get(row.platform) ?? row.platform,
    author: row.author,
    rating: row.rating,
    body: row.body,
    postedAt: row.posted_at,
    /** Whether that date is a real one or worked out from "3 weeks ago". */
    approximate: row.approximate ?? false,
    repliedAt: row.replied_at,
    replyBody: row.reply_body,
    url: row.url,
  };
}

/**
 * Store a batch, updating what is already there.
 *
 * ON CONFLICT DO UPDATE rather than DO NOTHING, and this is the difference
 * between a list that goes stale and one that does not: an owner who answers a
 * review in Google's own console has changed something we hold, and a fetch
 * that skipped rows it had seen would keep showing it as unanswered for ever.
 *
 * What it will not do is un-answer one. A source that has lost the reply — a
 * paste that omitted it, a platform that stopped returning it — must not wipe
 * a reply we already knew about, because the reply is the thing somebody
 * actually did. So the update takes the new value only when there is one.
 *
 * `from` drops anything older than the window that was asked for — but only
 * if it is new. A listing page hands back its whole first page, which on an
 * established venue is mostly years old, and recent() cannot reach past a
 * year however it is asked, so storing all of that would grow a table nothing
 * can ever display. Whoever wants an old one adds it by hand, which is a
 * deliberate act rather than a side effect.
 *
 * A review already held is updated whatever its age, and that is the whole
 * point of fetching reply status rather than only asking people to tick a
 * box. Somebody answers a review three weeks after it was written, the next
 * fetch sees the reply on the page — and a window applied blindly would have
 * dropped that review on the way past for being a day too old, so the reply
 * it came to collect would never land.
 *
 * @returns {Promise<{read: number, stored: number, added: number}>}
 */
async function store({ subscriberId, platform, rows, from = null }) {
  const found = inbound.batch(platform, rows);
  if (!found.length) return { read: 0, stored: 0, added: 0 };

  let reviews = found;
  if (from) {
    const known = new Set(
      (
        await all(
          `SELECT external_id FROM external_reviews
            WHERE subscriber_id = $1 AND platform = $2 AND external_id = ANY($3)`,
          [subscriberId, platform, found.map((r) => r.externalId)]
        )
      ).map((row) => row.external_id)
    );
    reviews = found.filter(
      (r) => inbound.within(r, from) || known.has(r.externalId)
    );
  }
  if (!reviews.length) return { read: found.length, stored: 0, added: 0 };

  const before = await one(
    'SELECT count(*) AS n FROM external_reviews WHERE subscriber_id = $1',
    [subscriberId]
  );

  for (const r of reviews) {
    await query(
      `INSERT INTO external_reviews
         (subscriber_id, platform, external_id, author, rating, body,
          posted_at, approximate, replied_at, reply_body, url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (subscriber_id, platform, external_id) DO UPDATE SET
         author     = COALESCE(EXCLUDED.author, external_reviews.author),
         rating     = COALESCE(EXCLUDED.rating, external_reviews.rating),
         body       = COALESCE(EXCLUDED.body, external_reviews.body),
         /*
          * The first guess, or any real date.
          *
          * A page that says "3 weeks ago" today says "4 weeks ago" next week
          * about the same review, so a stored date that follows the page
          * slides backwards on every fetch until the review ages out of the
          * window and vanishes from the screen on its own. The earliest
          * estimate is also the closest one, so it is the one that is kept.
          * A real date beats a guess whenever one turns up, which is what
          * happens when an API finally answers for a review a page supplied
          * first.
          */
         posted_at   = CASE
                         WHEN external_reviews.approximate AND EXCLUDED.approximate
                           THEN external_reviews.posted_at
                         ELSE EXCLUDED.posted_at
                       END,
         approximate = external_reviews.approximate AND EXCLUDED.approximate,
         replied_at = COALESCE(EXCLUDED.replied_at, external_reviews.replied_at),
         reply_body = COALESCE(EXCLUDED.reply_body, external_reviews.reply_body),
         url        = COALESCE(EXCLUDED.url, external_reviews.url),
         fetched_at = now()`,
      [
        subscriberId,
        r.platform,
        r.externalId,
        r.author,
        r.rating,
        r.body,
        r.postedAt,
        r.approximate ?? false,
        r.repliedAt,
        r.replyBody,
        r.url,
      ]
    );
  }

  const after = await one(
    'SELECT count(*) AS n FROM external_reviews WHERE subscriber_id = $1',
    [subscriberId]
  );

  return {
    read: found.length,
    stored: reviews.length,
    added: count(after?.n) - count(before?.n),
  };
}

/**
 * The last month, grouped by the listing it came from.
 *
 * Grouped here rather than on the screen because the counts belong with the
 * groups — "Google, 14, four unanswered" is one fact, and a page that gets a
 * flat list has to derive it and can derive it differently from the next page
 * that tries.
 */
async function recent({ subscriberId, days = inbound.WINDOW_DAYS }) {
  const from = inbound.since(days);

  const rows = await all(
    `SELECT * FROM external_reviews
      WHERE subscriber_id = $1 AND posted_at >= $2
      ORDER BY posted_at DESC`,
    [subscriberId, from]
  );

  const groups = new Map();
  for (const p of PLATFORMS) {
    groups.set(p.id, { platform: p.id, label: p.label, reviews: [], unanswered: 0 });
  }

  for (const row of rows) {
    let group = groups.get(row.platform);
    if (!group) {
      // A platform we no longer list still has its history, and dropping it
      // here would make those reviews vanish rather than read as old.
      group = { platform: row.platform, label: row.platform, reviews: [], unanswered: 0 };
      groups.set(row.platform, group);
    }
    group.reviews.push(toRecord(row));
    if (!row.replied_at) group.unanswered += 1;
  }

  const listed = [...groups.values()].filter((g) => g.reviews.length > 0);

  return {
    from,
    days,
    total: rows.length,
    unanswered: listed.reduce((n, g) => n + g.unanswered, 0),
    groups: listed,
  };
}

/**
 * Record that somebody answered one — or that they have not after all.
 *
 * By hand, for a reply left somewhere this cannot see. A fetch that later
 * brings the real reply back overwrites the text; see the COALESCE above for
 * why it cannot overwrite it with nothing.
 */
async function setReplied({ subscriberId, id, replied, body }) {
  const row = await one(
    `UPDATE external_reviews
        SET replied_at = CASE WHEN $3 THEN COALESCE(replied_at, now()) ELSE NULL END,
            reply_body = CASE WHEN $3 THEN COALESCE($4, reply_body) ELSE NULL END
      WHERE id = $1 AND subscriber_id = $2
      RETURNING *`,
    [id, subscriberId, Boolean(replied), body ? String(body).slice(0, 4000) : null]
  );
  if (!row) throw fail(404, 'No such review.');
  return toRecord(row);
}

module.exports = { store, recent, setReplied, toRecord };
