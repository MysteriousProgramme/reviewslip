'use strict';

const inbound = require('./inbound');
const sitefacts = require('./sitefacts');
const { PLATFORMS } = require('./platforms');

/**
 * Reading reviews off a listing page, with the model that already reads
 * websites for the theme and the topics.
 *
 * This exists because the APIs do not. Google's Business Profile API is
 * allow-listed per project and then needs an owner to grant access;
 * Tripadvisor's review endpoints are a partner agreement. Both are worth
 * having and neither arrives this quarter, and the features on the other side
 * of them are waiting.
 *
 * Two things are true about it and both should be said plainly, because
 * whoever maintains this next will want to know why it is shaped this way.
 *
 * Automated reading of a listing page is against Google's terms of service.
 * It runs only when somebody presses a button for their own listing, and it
 * fetches that one page once. That is a description of the scale, not an
 * exemption.
 *
 * And a listing page is a worse source than an API in ways that are not about
 * volume. It prints "3 weeks ago" instead of a date, it truncates long reviews
 * behind a "more" link, and its markup is rewritten without notice. The first
 * of those is the dangerous one: a date that moves every week means a review
 * that arrives new every week. inbound.js handles it by leaving a guessed date
 * out of the identity altogether, which is why every review from here is
 * marked approximate rather than being given a date that looks precise.
 *
 * When an API does arrive, its reviews carry real ids and real timestamps, and
 * they will land in the same table beside these — which is what the two-layer
 * identity in inbound.js was built for.
 *
 * One thing this cannot do, and it is worth writing down because it looks
 * like a bug and is not. Google Maps renders its reviews with JavaScript
 * after the page loads. Fetch that page over HTTP — by any means, ours or a
 * model's web tool — and you get two hundred kilobytes of HTML with the
 * business name in it and not one review. Tested on every surface Google
 * offers for it: /maps/place, ?cid=, output=embed and a plain search page.
 * All 200, all empty. So a Google Maps link cannot be read this way at all,
 * and the honest thing is to say so before spending anybody's tokens on a
 * call that cannot succeed. A page whose reviews *are* in its HTML reads
 * fine, which is most listing sites that are not Google.
 */

const LABELS = new Map(PLATFORMS.map((p) => [p.id, p.label]));

/** Enough to be worth the tokens, few enough to come back in one answer. */
const MAX_REVIEWS = 40;

/**
 * What the model is asked for.
 *
 * Days-ago rather than a date, because the page does not have a date and a
 * model asked for one will produce a plausible one. Asking for the number it
 * can actually see keeps the invention out, and the arithmetic happens in
 * inbound.js where it is tested.
 *
 * The source per review matters more than it looks: a Google listing shows
 * Tripadvisor reviews alongside its own, labelled. Filing those under Google
 * would put a review on a listing it is not on, and an owner going to answer
 * it would not find it.
 */
function system() {
  return `You are reading the public reviews on a business's own listing page and returning them as data. You are not summarising, judging or improving them. Copy what is there.

Return only a JSON object:

{
  "reviews": [
    {
      "author": "Anna L",
      "rating": 5,
      "ago": "3 weeks",
      "source": "google",
      "body": "Lovely garden, and the breakfast fruit is all local.",
      "truncated": false,
      "reply": "Thank you — glad you enjoyed it."
    }
  ]
}

Rules:
- "body" is the review's own words, exactly as they appear, in the language they are written in. Do not translate, tidy, shorten or complete them.
- "truncated" is true when the page cut the text off behind a "more" link. Give what is visible and say so; do not guess the rest.
- "ago" is how long ago the page says it was posted — "3 weeks", "a year", "2 days". Copy the page's own words. Do not convert it to a date: the page does not show one, and a date you work out will be wrong.
- "rating" is the number of stars, 1 to 5, or null where the page shows none.
- "source" is which site the review is on, lowercase, one of: ${PLATFORMS.map((p) => p.id).join(', ')}. A listing page often shows reviews from other sites alongside its own and labels them; use the label. If there is no label, it is the site whose page this is.
- "reply" is the owner's reply if one is shown, or null. Not another guest's comment.
- Return at most ${MAX_REVIEWS} reviews, newest first as the page orders them.
- If the page shows no reviews at all — a sign-in wall, a consent page, an empty listing — return {"reviews": []}. An empty answer is correct and useful. Inventing reviews is not.

Output only the JSON object. Nothing before it, nothing after it.`;
}

/**
 * @param {object} args
 * @param {string} args.url - the listing page, for context only
 * @param {string} args.platform - whose page it is, for reviews with no label
 * @param {string} args.text - the page, already fetched
 */
function messages({ url, platform, text }) {
  const label = LABELS.get(platform) ?? platform;
  return [
    { role: 'system', content: system() },
    {
      role: 'user',
      content:
        `Below is the text of ${url}, the business's ${label} listing. Return the reviews in it. ` +
        `A review with no other site named on it is a ${platform} review. ` +
        `Everything you return must be in the text below — do not add anything you know about this business from elsewhere, and if there are no reviews in it say so with an empty list.\n\n` +
        `--- page ---\n${text}`,
    },
  ];
}

/** Tags out, entities in, whitespace collapsed. */
function visibleText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does this text plausibly contain reviews at all?
 *
 * Asked before the model is, because the answer is usually no for a reason no
 * model can fix, and finding that out costs a fetch instead of a completion.
 *
 * The test is deliberately loose. It is not trying to count reviews — it is
 * separating "a page with reviews on it" from "a shell that will fill itself
 * in once a browser runs its JavaScript", and those two are not close. A
 * Google Maps page has the business name, a hundred script tags and nothing
 * a person would read.
 */
const REVIEW_WORDS =
  /\b(review|reviews|rated|rating|stars?|guest|stayed|verified)\b|รีวิว|ความเห็น|评论|レビュー|리뷰/i;

/** How few words means the page never really arrived. */
const MIN_WORDS = 120;

/**
 * @returns {{ok: true}|{ok: false, error: string}} and the two failures are
 *   worth telling apart, because one is the site's design and the other is
 *   just an empty listing. "Could not be read" covered both and helped with
 *   neither.
 */
function looksLikeReviews(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;

  if (words < MIN_WORDS) {
    return {
      ok: false,
      error:
        'that page builds itself in the browser, so almost nothing is in the page that was sent and there is nothing to read',
    };
  }

  if (!REVIEW_WORDS.test(text)) {
    return { ok: false, error: 'there are no reviews on that page' };
  }

  return { ok: true };
}

/**
 * The page, as text, fetched by us rather than by the model.
 *
 * Ours for three reasons. It works with any model, including one whose
 * provider has no web tool or will not use it. It costs one request instead
 * of a completion when the page turns out to be unreadable. And it goes
 * through the same refusals as every other fetch in the app — https only, the
 * host resolved and private addresses refused, redirects followed by hand,
 * bytes capped.
 *
 * @returns {Promise<{ok: true, text: string}|{ok: false, error: string}>}
 */
async function readPage(url) {
  const page = await sitefacts.fetchText(url, { maxBytes: 1_500_000 });
  if (!page.ok) return page;

  const text = visibleText(page.text);

  const usable = looksLikeReviews(text);
  if (!usable.ok) return { ok: false, error: usable.error, empty: true };

  // Trimmed, because a listing page is mostly navigation and the reviews are
  // in it once. Generous enough to hold a first page of them.
  return { ok: true, text: text.slice(0, 60_000) };
}

/** The first JSON object in whatever came back. */
function extractJson(raw) {
  const text = String(raw ?? '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * What came back, split by the listing each review is actually on.
 *
 * Grouped rather than flat because store() writes one platform at a time —
 * the platform is half of a review's identity, and a Tripadvisor review filed
 * under Google would be a second copy of itself the day Tripadvisor is read
 * properly.
 *
 * @returns {{groups: Array<{platform: string, rows: object[]}>, read: number,
 *   truncated: number}|null} null when nothing usable came back at all, which
 *   is different from a page that honestly had no reviews on it.
 */
function parse(raw, { platform }) {
  const data = extractJson(raw);
  if (!data || !Array.isArray(data.reviews)) return null;

  const ids = new Set(PLATFORMS.map((p) => p.id));
  const byPlatform = new Map();
  let truncated = 0;

  for (const row of data.reviews.slice(0, MAX_REVIEWS)) {
    if (!row || typeof row !== 'object') continue;

    // An unrecognised label is this page's platform rather than a dropped
    // review: the label is the model's reading of a word on a page, and being
    // wrong about which site is better than losing the review.
    const said = String(row.source ?? '').toLowerCase().trim();
    const where = ids.has(said) ? said : platform;

    if (row.truncated) truncated += 1;

    if (!byPlatform.has(where)) byPlatform.set(where, []);
    byPlatform.get(where).push({
      author: row.author ?? null,
      rating: row.rating,
      body: row.body ?? '',
      // Handed on as words. inbound.js turns it into a day and marks it as the
      // estimate it is; nothing here should be inventing dates.
      ago: row.ago ?? null,
      replyBody: row.reply ?? null,
      url: null,
    });
  }

  const groups = [...byPlatform.entries()].map(([id, rows]) => ({ platform: id, rows }));
  return {
    groups,
    read: groups.reduce((n, g) => n + g.rows.length, 0),
    truncated,
  };
}

/** Which of a venue's listings can be read: the ones it has linked. */
function pages(settings = {}) {
  return PLATFORMS.map((p) => ({ platform: p.id, url: settings[`${p.id}Url`] }))
    .filter((p) => typeof p.url === 'string' && p.url.trim())
    .map((p) => ({ ...p, url: p.url.trim() }));
}

module.exports = {
  MAX_REVIEWS,
  messages,
  parse,
  pages,
  extractJson,
  readPage,
  visibleText,
  looksLikeReviews,
};
