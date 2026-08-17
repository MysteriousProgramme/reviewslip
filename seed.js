'use strict';

/**
 * Seeding: read a venue's own website and propose the venue details the review
 * writer is allowed to draw on.
 *
 * The whole no-fabrication guarantee rests on those details being true — a bad
 * one is repeated in every review from then on, not just once. So the prompt is
 * constrained harder than the writing prompt, every proposed detail has to
 * quote the page text it came from, and `screen()` below independently drops
 * anything that slips through. The output is a draft for a human to approve,
 * never something to apply unseen.
 */

const BANNED_WORDS = [
  'award',
  'best',
  'finest',
  'stunning',
  'world-class',
  'world class',
  'unforgettable',
  'luxurious',
  'luxury',
  'premier',
  'unrivalled',
  'unrivaled',
  'exceptional',
  'renowned',
  'acclaimed',
  'voted',
  'rated',
  'star',
];

/**
 * Not "a hospitality business" any more, and no category list.
 *
 * The prompt used to say hospitality and to close with a fixed set of ids —
 * restaurant, bar, rooms, common — which is a lodge's floor plan. Asked to
 * describe a dental practice it either forced the practice into those four or
 * had every id dropped by the filter. Topics are drafted by their own prompt
 * now, from evidence, with no fixed vocabulary; this one extracts facts and
 * nothing else.
 */
const SEED_SYSTEM = `You read a business's own website and extract only facts a customer could verify with their own eyes.

Return a single JSON object of this shape:
{
  "name": "the business name",
  "kind": "a short description, e.g. a small lodge, a dental clinic, a bike shop",
  "place": "town, region, country",
  "safeDetails": [
    { "detail": "phrased plainly, as a customer would say it", "source": "the sentence on the page this came from" }
  ]
}

Rules for safeDetails. Every detail you list may be repeated in a public review of this business, so a detail that is not true becomes a fabricated review:
- Physical, checkable, sensory facts only: the setting, the premises, what is offered, what it is like to be there, what is nearby.
- No awards, ratings, rankings, or prizes of any kind.
- No superlatives the business uses about itself.
- No numbers: no prices, no counts, no star ratings, no years, no distances.
- No staff names, no product or dish names, no brand names.
- Phrase each one the way a customer would say it, not the way the website says it.
- Between 6 and 10 items. Fewer is fine if the page is thin. Do not pad.
- Every item must quote the page text it came from in "source". If you cannot quote it, leave the item out.

Output only the JSON object. Nothing before it, nothing after it.`;

/**
 * @param {object} args
 * @param {string} args.url - the business's website
 */
function buildSeedMessages({ url }) {
  return [
    { role: 'system', content: SEED_SYSTEM },
    {
      role: 'user',
      content: `Read ${url} and extract the details. Fetch the page before answering — do not infer anything from the domain name alone. If a page section is marketing copy with no checkable facts in it, skip that section rather than rephrasing it.`,
    },
  ];
}

/** @returns {string|undefined} the first banned word found, if any */
function bannedWord(value) {
  return BANNED_WORDS.find((w) =>
    new RegExp(`\\b${w.replace(/[-\s]/g, '[-\\s]')}\\b`, 'i').test(value)
  );
}

function text(value, max) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, max)
    : '';
}

/** Pull the JSON object out of a completion that may be fenced or padded. */
function extractJson(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
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
 * Independent check on the model's output. The prompt already forbids these,
 * but the prompt is a request and this is a filter — a detail that reaches
 * `safeDetails` gets repeated indefinitely, so it is worth checking twice.
 *
 * @returns {{kept: object[], dropped: {detail: string, reason: string}[]}}
 */
function screen(items) {
  const kept = [];
  const dropped = [];

  for (const item of Array.isArray(items) ? items : []) {
    const detail =
      typeof item?.detail === 'string' ? item.detail.trim() : '';
    const source = typeof item?.source === 'string' ? item.source.trim() : '';

    if (!detail) continue;

    if (!source) {
      dropped.push({ detail, reason: 'no source quote from the page' });
      continue;
    }
    if (/\d/.test(detail)) {
      dropped.push({ detail, reason: 'contains a number' });
      continue;
    }
    const hit = bannedWord(detail);
    if (hit) {
      dropped.push({ detail, reason: `unverifiable claim ("${hit}")` });
      continue;
    }
    if (detail.length > 180) {
      dropped.push({ detail, reason: 'too long to read as a guest detail' });
      continue;
    }

    kept.push({ detail, source: source.slice(0, 300) });
    if (kept.length === 10) break;
  }

  return { kept, dropped };
}

/**
 * @returns {{proposal: object, dropped: object[]}|null} null when unparseable
 */
function parseProposal(raw) {
  const data = extractJson(raw);
  if (!data) return null;

  const str = (v, max) =>
    typeof v === 'string' ? v.trim().slice(0, max) : '';

  const { kept, dropped } = screen(data.safeDetails);

  return {
    proposal: {
      name: str(data.name, 120),
      kind: str(data.kind, 120),
      place: str(data.place, 160),
      safeDetails: kept,
    },
    dropped,
  };
}

/* ---------------------------------------------------------- the topic set */

/**
 * Topics, drafted from the website — the deep version of the category
 * suggestion above.
 *
 * The old suggestion proposed five buttons, all of which the guest saw. The page
 * now samples ten from a set of up to thirty, so the job changed: the model is
 * being asked for *breadth*, and breadth is exactly where a model pads. Two
 * things hold it back. It is told plainly that a short honest list is a correct
 * answer, and the subjects are split in two — things this business demonstrably
 * has, which need evidence on the page, and things every customer of any
 * business experiences, which do not.
 *
 * That split is what makes thirty reachable without inventing a bar. "The
 * welcome" is safe for a clinic and a campsite alike; "The rooftop terrace" has
 * to be on the page.
 *
 * There is no "Any" catch-all any more. It was pinned first out of five, which
 * does not survive sampling — it would show up in two guests out of three — and
 * it was never needed: a guest who taps nothing already gets a review about the
 * visit overall, which is what "Any" meant.
 */
function topicSystem(max) {
  return `You read a business's own website and propose the topics a departing customer picks from before writing a review.

Return a single JSON object of this shape:
{
  "topics": [
    { "label": "Rooms", "focus": "the room itself — comfort, bed, bathroom, the view or outlook" }
  ]
}

There are two kinds of topic, and a good set mixes them:

1. Specific to this business — a room type, a service, a space, something on the menu category level, somewhere nearby. Propose one of these ONLY where the page gives real evidence for it. A business with no bar does not get a bar topic.
2. Common to any visit — how you were treated, the welcome, booking or arriving, how the place felt, whether you would come back, recommending it to someone. These need no evidence and are safe for any business.

Rules:
- At most ${max} topics. A short honest list is a correct answer. Do not pad, do not split one thing into three, and do not invent a second kind of room to make up the number.
- Order them the way a customer would scan them: the most obvious and most specific first, the general ones last.
- "label" is what a customer taps: one to three words, title case, no punctuation, no emoji.
- "focus" tells the review writer what that review should be about, as a sentence fragment it can follow. No superlatives, no awards, no ratings, no numbers, no staff or dish names.
- No two topics may be the same thing worded differently.

Output only the JSON object. Nothing before it, nothing after it.`;
}

/**
 * @param {object} args
 * @param {string} args.url - the business's website
 * @param {number} args.max - how many topics may be stored, from settings.js
 */
function buildTopicMessages({ url, max = 30 }) {
  return [
    { role: 'system', content: topicSystem(max) },
    {
      role: 'user',
      content: `Read ${url} and propose the review topics. Fetch the page before answering — do not guess from the domain name. Follow the site's own links to what it offers if the front page is thin. If the page shows no evidence for something, leave it out rather than assuming a business of this kind usually has one.`,
    },
  ];
}

/**
 * @param {object} args
 * @param {number} args.max - the stored cap, so the draft cannot exceed it
 * @returns {object[]|null} up to `max` {label, focus}, or null when nothing usable
 */
function parseTopics(raw, { max = 30 } = {}) {
  const data = extractJson(raw);
  if (!data) return null;

  // `topics` is what the prompt asks for; `categories` is what the older prompt
  // asked for, and a model that has seen both keys sometimes reaches for the
  // wrong one. Accepting either costs one line and saves a wasted page read.
  const items = Array.isArray(data.topics)
    ? data.topics
    : Array.isArray(data.categories)
      ? data.categories
      : [];

  const out = [];
  const seen = new Set();

  for (const item of items) {
    const label = text(item?.label, 40);
    if (!label) continue;

    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // A focus goes into every review written under that button, so an
    // unverifiable steer there is worth more than one bad review. Drop the
    // steer and keep the button — the label alone still works.
    let focus = text(item?.focus, 200);
    if (focus && (/\d/.test(focus) || bannedWord(focus))) focus = '';

    out.push({ label, focus });
    if (out.length === max) break;
  }

  return out.length ? out : null;
}

/* -------------------------------------------------- the context document */

/**
 * A business's own AI context document, drafted from what it publishes.
 *
 * Different in kind from everything else in this file. safeDetails and topics are
 * structured and load-bearing — a wrong entry becomes a false claim in every
 * review — so both are screened hard and quote their source. This is background
 * prose: who comes here, what they notice, how their reviews would sound. It
 * asserts nothing, and the prompt tells the writer it asserts nothing.
 *
 * It reads the review listings as well as the website when there are any, because
 * the most useful thing on this subject is how that business's real customers
 * already write. Often the listing will not be readable — Google renders its
 * reviews in the browser, so a fetch gets a shell — and the prompt is explicit
 * that saying nothing is correct when there is nothing to see. An invented
 * description of reviews nobody read is worse than no description.
 */
const CONTEXT_SYSTEM = `You read what a business publishes about itself and write a short background note for a review-writing assistant.

The note is not shown to customers and is not a fact sheet. It exists so the assistant writes in the right register about the right things. Someone who has never heard of this business should be able to read it and know how its customers talk.

Return a single JSON object of this shape:
{ "contextDoc": "two or three short paragraphs" }

Cover, in plain prose and in this order:
- What kind of business it is and who its customers are — who actually walks in, and what they came for.
- What those customers are most likely to notice and mention afterwards. Be concrete about subjects, not about claims.
- How a real review of a place like this reads: how long, how warm, how much detail, what a customer would say and what they would never bother saying.
- If, and only if, you can actually see real customer reviews on one of the pages: one sentence on how they read. If you cannot see any, say nothing about them at all. Do not describe reviews you have not read.

Rules:
- Under 250 words. It is sent to the model on every single review, so every sentence has to earn its place.
- No superlatives, no awards, no ratings, no rankings, no marketing language of any kind. Describe the business the way a researcher would, not the way it describes itself.
- No staff names, no dish names, no prices, no figures.
- Do not list facilities. A separate list already records what a review may claim; this is about register and subject matter.
- Write about this business specifically. A paragraph that would fit any business of the kind is worth nothing here.

Output only the JSON object. Nothing before it, nothing after it.`;

/**
 * @param {object} args
 * @param {string} args.url - the business's website
 * @param {string[]} [args.listings] - its review-platform links, if it set any
 */
function buildContextMessages({ url, listings = [] }) {
  const also = listings.length
    ? ` Then look at ${listings.join(' and ')} — if you can see real customer reviews there, note how they read; if the page comes back without any, ignore it and say nothing about reviews.`
    : '';

  return [
    { role: 'system', content: CONTEXT_SYSTEM },
    {
      role: 'user',
      content: `Read ${url} and write the background note.${also} Fetch the pages before answering — do not infer anything from a domain name.`,
    },
  ];
}

/**
 * Independent screen, as everywhere else here: the prompt forbids superlatives
 * and this drops them anyway.
 *
 * Dropped by the sentence rather than by the whole draft. One "award-winning" in
 * the second paragraph should not cost the customer another page read and
 * another minute of waiting — and if it dropped nothing the customer would only
 * meet the same refusal from the validator on Save, with no idea which word did
 * it.
 *
 * @param {object} [options]
 * @param {number} [options.maxChars] - the stored cap, from settings.js
 * @returns {{contextDoc: string, dropped: string[]}|null} null when unparseable
 */
function parseContextDoc(raw, { maxChars = 2000 } = {}) {
  const data = extractJson(raw);
  if (!data) return null;

  const doc = typeof data.contextDoc === 'string' ? data.contextDoc.trim() : '';
  if (!doc) return null;

  const dropped = [];
  const kept = [];

  // Blank lines are paragraph breaks and worth keeping, so each paragraph is
  // screened on its own and rejoined.
  for (const paragraph of doc.split(/\n\s*\n/)) {
    // Split after a full stop, question or exclamation mark followed by a space.
    // Crude, and fine here: a misplaced break costs a sentence fragment on its
    // own line in a draft a human is about to edit.
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    const good = [];

    for (const sentence of sentences) {
      const hit = bannedWord(sentence);
      if (hit) dropped.push(sentence.trim());
      else if (sentence.trim()) good.push(sentence.trim());
    }

    if (good.length) kept.push(good.join(' '));
  }

  const contextDoc = kept.join('\n\n').slice(0, maxChars).trim();
  return contextDoc ? { contextDoc, dropped } : null;
}

module.exports = {
  bannedWord,
  buildSeedMessages,
  parseProposal,
  buildTopicMessages,
  parseTopics,
  buildContextMessages,
  parseContextDoc,
  SEED_SYSTEM,
  CONTEXT_SYSTEM,
};
