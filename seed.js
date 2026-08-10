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

const CATEGORY_IDS = ['restaurant', 'bar', 'rooms', 'common'];

const SEED_SYSTEM = `You read a hospitality business's own website and extract only facts a guest could verify with their own eyes.

Return a single JSON object of this shape:
{
  "name": "the business name",
  "kind": "a short description, e.g. a small lodge",
  "place": "town, region, country",
  "safeDetails": [
    { "detail": "phrased plainly, as a guest would say it", "source": "the sentence on the page this came from" }
  ],
  "categories": ["restaurant", "bar", "rooms", "common"]
}

Rules for safeDetails. Every detail you list may be repeated in a public review of this business, so a detail that is not true becomes a fabricated review:
- Physical, checkable, sensory facts only: the setting, the grounds, the rooms, what food is served, what is nearby.
- No awards, ratings, rankings, or prizes of any kind.
- No superlatives the business uses about itself.
- No numbers: no prices, no room counts, no star ratings, no years, no distances.
- No staff names, no dish names, no brand names.
- Phrase each one the way a guest would say it, not the way the website says it.
- Between 6 and 10 items. Fewer is fine if the page is thin. Do not pad.
- Every item must quote the page text it came from in "source". If you cannot quote it, leave the item out.

Rules for categories. Include an id only if the page gives real evidence the venue has it:
- "restaurant" food served on site, "bar" drinks or a bar, "rooms" guest rooms, "common" garden, terrace, lounge, or other shared space.

Output only the JSON object. Nothing before it, nothing after it.`;

/**
 * @param {object} args
 * @param {string} args.url - the venue's website
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

  const categories = (
    Array.isArray(data.categories) ? data.categories : []
  ).filter((c) => CATEGORY_IDS.includes(c));

  return {
    proposal: {
      name: str(data.name, 120),
      kind: str(data.kind, 120),
      place: str(data.place, 160),
      safeDetails: kept,
      categories,
    },
    dropped,
  };
}

/* ------------------------------------------------------ category suggestions */

/**
 * The other half of seeding: which buttons this venue's picker should have.
 *
 * Categories are lighter than safeDetails — a wrong button is a button nobody
 * taps, not a fabricated claim — so this does not demand a source quote. The
 * `focus` text does reach the writing prompt though, so it gets screened for
 * the same unverifiable claims below.
 */
const MAX_SUGGESTED = 5;

const CATEGORY_SYSTEM = `You read a hospitality business's own website and propose the buttons a departing guest picks from before writing a review.

Return a single JSON object of this shape:
{
  "categories": [
    { "label": "Rooms", "focus": "the room itself — comfort, bed, bathroom, the view or outlook" }
  ]
}

Rules:
- At most ${MAX_SUGGESTED} categories, and the first must always be the catch-all: label "Any", focus "the stay overall — pick whichever single aspect feels most natural to lead with".
- That leaves ${MAX_SUGGESTED - 1} for the venue itself. Fewer is fine if the page is thin. Do not pad.
- Propose a category only where the page gives real evidence for it. A place with no bar does not get a bar button.
- "label" is what a guest taps: one to three words, title case, no punctuation, no emoji.
- "focus" tells the review writer what that review should be about, as a sentence fragment it can follow. No superlatives, no awards, no ratings, no numbers, no staff or dish names.
- Order them the way a guest would scan them, most obvious first.

Output only the JSON object. Nothing before it, nothing after it.`;

/**
 * @param {object} args
 * @param {string} args.url - the venue's website
 */
function buildCategoryMessages({ url }) {
  return [
    { role: 'system', content: CATEGORY_SYSTEM },
    {
      role: 'user',
      content: `Read ${url} and propose the review categories. Fetch the page before answering — do not guess from the domain name. If the page shows no evidence for a category, leave it out rather than assuming a place of this kind usually has one.`,
    },
  ];
}

/**
 * @returns {object[]|null} up to five {label, focus}, or null when nothing
 *   usable came back
 */
function parseCategorySuggestions(raw) {
  const data = extractJson(raw);
  if (!data) return null;

  const out = [];
  const seen = new Set();

  for (const item of Array.isArray(data.categories) ? data.categories : []) {
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
    if (out.length === MAX_SUGGESTED) break;
  }

  return out.length ? out : null;
}

module.exports = {
  buildSeedMessages,
  parseProposal,
  buildCategoryMessages,
  parseCategorySuggestions,
  SEED_SYSTEM,
  CATEGORY_SYSTEM,
  MAX_SUGGESTED,
};
