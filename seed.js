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

There are three kinds of topic, and a good set mixes them:

1. Named things this business is known for — a signature dish, a house speciality, a flagship product, a treatment or service it is identified with. Take the actual name off the page: "The Pad Thai", "The Sunday Roast", "The Oat Flat White", "The Handmade Frames". These are the topics customers most want to talk about, and they are the reason the list can be long: a menu or a product range gives you a real one per line.
2. Specific to this business but not named — a room type, a space, a facility, somewhere nearby. A business with no bar does not get a bar topic.
3. Common to any visit — how you were treated, the welcome, booking or arriving, how the place felt, whether you would come back, recommending it to someone. These need no evidence and are safe for any business.

Lead with the first kind where the business has any. A restaurant with a menu should produce a dozen or more named dishes before it reaches "The Service"; a clinic with four treatments produces four and then moves on. Only take a name that is actually printed on the page — never invent a dish, a product or a treatment, and never guess at one a business of this kind usually has.

Rules:
- At most ${max} topics. A short honest list is a correct answer. Do not pad, do not split one thing into three, and do not invent a second kind of room to make up the number. The ceiling is high because a menu or a product range genuinely fills it — not as a target to reach by other means.
- Order them the way a customer would scan them: the most obvious and most specific first, the general ones last.
- "label" is what a customer taps: one to three words, title case, no punctuation, no emoji.
- "focus" tells the review writer what that review should be about, as a sentence fragment it can follow. No superlatives, no awards, no ratings, no numbers, no staff names.
- A named thing from the first kind may of course appear in its own label and focus — that is the whole point of it. Describe it plainly, the way a customer would ("the pad thai", not "our legendary pad thai").
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
const CONTEXT_SYSTEM = `You read what a business publishes about itself and write a detailed background note for a review-writing assistant.

The note is not shown to customers and is not a fact sheet. It exists so the assistant writes in the right register about the right things. Someone who has never heard of this business should be able to read it and know exactly how its customers talk.

Return a single JSON object of this shape:
{ "contextDoc": "four to six paragraphs" }

Cover, in plain prose and in this order:
- What kind of business it is and who its customers are — who actually walks in, on what sort of occasion, and what they came for. Distinguish the regulars from the one-off visitors if the page gives you anything to go on.
- Where it sits, and what is around it. Name the neighbourhood or district, the nearest recognisable landmarks, what a customer would have walked or driven past to get there, and what else people are in the area to do. This is the part customers reach for when they explain why they went, so be specific: a street, a park, a station, a beach, a market, a well known building nearby.
- What those customers are most likely to notice and mention afterwards. Be concrete about subjects, not about claims. Cover the ordinary things as well as the obvious ones — waiting, parking, being greeted, how long it took.
- What they would never bother saying, and what would sound wrong coming from them.
- How a real review of a place like this reads: how long, how warm, how much detail, what a customer opens with.
- If, and only if, you can actually see real customer reviews on one of the pages: a sentence or two on how they read. If you cannot see any, say nothing about them at all. Do not describe reviews you have not read.

Rules:
- Aim for 1,700 to 1,900 characters. There is a hard ceiling of 2,000 and anything past it is cut off mid-sentence, so stay under it — but a short note wastes the room. Use what you have. Specific and long beats general and short.
- Detail means detail about *this* business. Do not pad with generalities to reach the length: if you genuinely run out of things the pages support, stop rather than invent.
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

  // Cut at a sentence rather than mid-word. The prompt now asks for a note close
  // to the ceiling, so a draft that overruns is the normal case rather than a
  // strange one — and a note ending "the nearest station is abo" reads as a bug.
  let contextDoc = kept.join('\n\n').trim();

  if (contextDoc.length > maxChars) {
    const clipped = contextDoc.slice(0, maxChars);
    const lastStop = Math.max(
      clipped.lastIndexOf('. '),
      clipped.lastIndexOf('.\n'),
      clipped.lastIndexOf('! '),
      clipped.lastIndexOf('? ')
    );
    // Only when a sentence ends somewhere near the cut. A single enormous
    // paragraph would otherwise lose most of itself to this.
    contextDoc = (
      lastStop > maxChars * 0.6 ? clipped.slice(0, lastStop + 1) : clipped.replace(/\s+\S*$/, '')
    ).trim();
  }
  return contextDoc ? { contextDoc, dropped } : null;
}

/* ------------------------------------------------------------- the theme */

/**
 * Four colours, read off the business's own site.
 *
 * Four rather than a full palette because four is what a model can genuinely
 * take from a page — the header, the body, a button — while the tints, shades
 * and text colours are arithmetic, and theme.js does that better than a prompt
 * can. It is also what makes the result checkable: four hex values either parse
 * or they do not.
 *
 * The prompt asks for a `source` per colour for the same reason the details
 * prompt does. A model that cannot say where a colour came from has invented it,
 * and a business seeing "the primary button" beside a hex can tell at a glance
 * whether it really read the site or guessed from the name.
 *
 * Contrast is deliberately not the model's problem. It is asked for a *dark*
 * ground and a *light* paper and nothing more; theme.js then nudges anything
 * that cannot carry text until it can, and reports what moved. Asking a model to
 * do WCAG arithmetic produces confident wrong numbers.
 */
function themeSystem({ displayFonts, uiFonts }) {
  const list = (fonts) =>
    fonts.map((f) => `  "${f.id}" — ${f.name}: ${f.note}`).join('\n');

  return `You read a business's own website and choose how its review page should look: four colours, two typefaces, and its logo.

Return a single JSON object of this shape:
{
  "ground": { "hex": "#0c1f19", "source": "the site header background" },
  "paper":  { "hex": "#f3ecdc", "source": "the page background behind body text" },
  "accent": { "hex": "#82b49b", "source": "the link colour" },
  "highlight": { "hex": "#e9a03b", "source": "the Book Now button" },
  "display": { "id": "lora", "family": "Canela", "url": "https://example.com/fonts/canela.woff2", "source": "headings are set in Canela" },
  "ui": { "id": "inter", "family": "Founders Grotesk", "url": "https://example.com/fonts/founders.woff2", "source": "body text is set in Founders Grotesk" },
  "logo": { "url": "https://example.com/logo.svg", "source": "the mark in the header, linking home" },
  "background": { "url": "https://example.com/hero.jpg", "source": "the full-width photo behind the front-page headline" }
}

What each one is for:
- "ground" is the deep background of the whole page. It must be DARK. Take the site's darkest brand colour — a header, a footer, a hero overlay. If the site is entirely pale, deepen its main brand colour until it is dark rather than returning a light one.
- "paper" is the light card the review is written on, and the printed table card. It must be LIGHT and close to neutral: an off-white, a cream, a very pale tint of the brand. Never a saturated colour — text has to sit on it.
- "accent" is the quiet furniture: labels, borders, the topic buttons. A mid-tone brand colour.
- "highlight" is spent once, on the button that opens the review listing. The site's most attention-seeking colour — the one on its main call to action.

Rules:
- Every value must be a full six-digit hex like #1b2a23. No colour names, no rgb(), no shorthand.
- "ground" and "paper" must be clearly different in lightness. A dark ground and a light paper.
- Take colours the site actually uses. Say where each came from in "source", naming the element you saw it on.
- If the site gives you nothing for a slot, choose one that sits with the others rather than leaving it out. All four are required.
- Do not return four near-identical colours. This is a palette, not a monochrome study.

Typefaces. Two things for each of the two slots: the site's real font file if you can find it, and a fallback id from the list below in case it cannot be used.

"display" sets the review text itself. "ui" sets everything else — labels, buttons, the topic names.

The real font, in "family" and "url":
- Read the @font-face rules in the site's own stylesheets. "family" is the font-family name as declared there; "url" is the absolute address of the file in its src, preferring woff2, then woff, then ttf or otf.
- Follow the stylesheet links to find them. The @font-face rules are almost never in the HTML.
- Give a full absolute URL including scheme and host. A path like /fonts/x.woff2 is not usable.
- If the site loads its fonts from Google Fonts, give the fonts.gstatic.com file URL from the stylesheet it imports.
- If there are several weights, give the regular upright one — not bold, not italic.
- If you cannot find a real file, set "family" and "url" to null. Do not guess a URL, and do not construct one from a font's name.

The fallback, in "id" — always required, whether or not you found a file. It must be one of these exactly:

"display" choose from:
${list(displayFonts)}

"ui" choose from:
${list(uiFonts)}

- Match the character of what the site uses, not the name. A site set in Canela or Tiempos wants a warm contemporary serif; one set in Helvetica or Circular wants a neutral or geometric sans.
- If the site's own type is unremarkable or you cannot tell, say so in "source" and pick the closest neutral rather than guessing at something distinctive.

Logo. Give the absolute https URL of the business's own mark:
- The one in the site header or footer, the one that links to the home page. Not a photograph, not a partner or payment badge, not a social icon, not an award seal.
- Prefer an SVG, then a PNG. Prefer the version on a transparent or light background.
- Resolve it to a full URL including the scheme and host. A path like /img/logo.svg is not usable.
- If you cannot find a real logo, set "logo" to null. Do not offer a photo of the building instead.

Background. Give the absolute https URL of one photograph from the site, to sit behind the review page:
- The hero or banner image — the big one at the top of the front page. Failing that, the most representative photograph of the place itself.
- The place, not the people: a room, the frontage, the grounds, the counter. Not a portrait of staff or customers, not a stock photo of something generic, not a screenshot, not a diagram, not a logo again.
- Prefer a wide one over a tall one, and a large one over a thumbnail — it is displayed full-bleed. It will be heavily dimmed and read as texture rather than as a picture, so a busy image is fine but a dark or simple one works best.
- Resolve it to a full URL including scheme and host, and give the actual image file, not the page it appears on.
- If the site has no real photograph of itself, set "background" to null. A page with no photo is better than a page behind a stock image of somebody else's building.

Output only the JSON object. Nothing before it, nothing after it.`;
}

/**
 * @param {object} args
 * @param {string} args.url - the business's website
 * @param {object[]} args.displayFonts - the allowlist, from theme.js
 * @param {object[]} args.uiFonts - likewise
 */
function buildThemeMessages({ url, displayFonts, uiFonts }) {
  return [
    { role: 'system', content: themeSystem({ displayFonts, uiFonts }) },
    {
      role: 'user',
      content: `Read ${url} and choose the look. Fetch the page before answering — do not guess from the business name or the domain. Read the stylesheet and the inline styles as well as the visible text: that is where the colours, the font-family stacks and the logo's real address are. Prefer something you can point at over something that merely feels right.`,
    },
  ];
}

/**
 * @returns {{theme: object, sources: object, logoUrl: string}|null} null when
 *   nothing usable came back. The colours are validated in theme.js and the
 *   logo is downloaded and checked in assets.js — this only reshapes.
 */
function parseTheme(raw) {
  const data = extractJson(raw);
  if (!data) return null;

  const theme = {};
  const sources = {};

  // Accept the bare value too, throughout. A model told to return objects still
  // occasionally returns `"ground": "#0c1f19"`, and refusing that would cost the
  // customer another minute of page reading for nothing.
  const unwrap = (entry, key) =>
    typeof entry === 'string' ? entry : entry?.[key];

  for (const slot of ['ground', 'paper', 'accent', 'highlight']) {
    const value = unwrap(data[slot], 'hex');
    if (typeof value !== 'string') return null;

    theme[slot] = value.trim();
    sources[slot] = text(typeof data[slot] === 'string' ? '' : data[slot]?.source, 120);
  }

  // Fonts are optional in the answer and resolved rather than refused: an id
  // outside the list lands on the shipped face, which is a working page. Losing
  // a whole website read because a model invented a font name would not be.
  const files = {};

  for (const slot of ['display', 'ui']) {
    const entry = data[slot];
    const id = unwrap(entry, 'id');
    if (typeof id === 'string') theme[slot] = id.trim().toLowerCase();
    sources[slot] = text(typeof entry === 'string' ? '' : entry?.source, 120);

    // The real file, when one was found. Downloaded and checked by the caller —
    // nothing here touches the network, and the family name is still untrusted
    // text at this point.
    const family = text(typeof entry === 'string' ? '' : entry?.family, 80);
    const url = text(typeof entry === 'string' ? '' : entry?.url, 2000);
    if (family && url) files[slot] = { family, url };
  }

  const logoUrl = text(unwrap(data.logo, 'url'), 2000);
  sources.logo = text(typeof data.logo === 'string' ? '' : data.logo?.source, 120);

  const backgroundUrl = text(unwrap(data.background, 'url'), 2000);
  sources.background = text(
    typeof data.background === 'string' ? '' : data.background?.source,
    120
  );

  return { theme, sources, logoUrl, backgroundUrl, files };
}

module.exports = {
  bannedWord,
  buildSeedMessages,
  buildThemeMessages,
  parseTheme,
  themeSystem,
  parseProposal,
  buildTopicMessages,
  parseTopics,
  buildContextMessages,
  parseContextDoc,
  SEED_SYSTEM,
  CONTEXT_SYSTEM,
};
