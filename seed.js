'use strict';

/**
 * Drafting: read a business's own website and propose what a review may be
 * written from.
 *
 * That used to be three separate things — a list of verified details, a prose
 * background document, and a set of topic buttons. It is one thing now. A topic
 * carries its own description, and that description is the entire boundary of
 * what a review about it may claim, so this file's job is to fill those
 * descriptions from evidence and to refuse to fill them from anything else.
 *
 * The no-fabrication guarantee rests on them being true: a bad description is
 * repeated in every review written under that button, not once. So the prompt is
 * constrained harder than the writing prompt, and `parseTopics` independently
 * drops a description carrying a number or a superlative rather than trusting
 * the prompt to have been obeyed. What comes out is a draft for a human to
 * approve, never something applied unseen.
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
 * How a drafting request opens, given whatever source we actually have.
 *
 * There are two: a page to fetch, or text the owner pasted. The second exists
 * because a great many small businesses are a Facebook page and nothing else,
 * and Facebook serves a sign-in wall to anything without a session — so
 * "fall back to their Facebook URL" reads well and returns nothing. Pasted text
 * always works.
 *
 * The instruction differs in more than the noun. A fetched page can be followed
 * to a menu or an About page; pasted text is all there is, so the model is told
 * so plainly — otherwise it goes looking, finds nothing, and reports failure
 * rather than working with what it was given.
 *
 * @param {object} source - one of `{ url }` or `{ text }`
 * @param {string} fetching - what to do with a page, appended after the URL
 * @param {string} pasted - what to do with the text, before it
 */
function opening({ url, text }, fetching, pasted) {
  if (text) {
    return `${pasted}

There is no page to fetch — this is everything you have, and it is enough. Work only from what is between the markers. Do not go looking for a website, and do not fill gaps with what a business of this kind usually has.

----- what the owner pasted -----
${text}
----- end -----`;
  }
  return `Read ${url} and ${fetching}`;
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

/* ---------------------------------------------------------- the topic set */

/**
 * Topics, drafted from the website — the deep version of the category
 * suggestion above.
 *
 * The old suggestion proposed five buttons, all of which the guest saw. The page
 * now samples ten from a set of up to fifty, so the job changed: the model is
 * being asked for *breadth*, and breadth is exactly where a model pads.
 *
 * It is asked to aim for close to the cap, which is the instruction models
 * answer with filler — so the prompt spends most of its length on *how* to get
 * there honestly rather than on the number. Three kinds, worked in order:
 *
 *   1. Named things the business is known for. A menu or a product range is
 *      worth twenty on its own, and these are what customers want to talk
 *      about. Every one has to be printed on the page.
 *   2. Specific but unnamed — a room type, a space, a facility.
 *   3. Common to any visit. This is the deep well and the reason the number is
 *      reachable at all: two dozen of them are true of every business by
 *      definition, so none can be an invention. The prompt lists them.
 *
 * Then the escape hatch, stated plainly, because it is the only thing standing
 * between a target and a fabricated bar: a genuinely small business lands well
 * short and that is the correct answer for it. Falling short is fine. Inventing
 * is not.
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
    {
      "label": "Rooms",
      "description": "The rooms look out over the garden and the hills behind it. Each one has its own balcony, and the bathrooms were rebuilt with walk-in showers. Mornings are quiet enough to hear the birds, and the beds are made up with cotton rather than polyester."
    }
  ]
}

There are three kinds of topic, and a full set uses all three:

1. Named things this business is known for — a signature dish, a house speciality, a flagship product, a treatment or service it is identified with. Take the actual name off the page: "The Pad Thai", "The Sunday Roast", "The Oat Flat White", "The Handmade Frames". These are the topics customers most want to talk about. Take every one the page gives you: a menu or a product range is worth twenty or more on its own.
2. Specific to this business but not named — a room type, a space, a facility, an area, somewhere nearby. A business with no bar does not get a bar topic.
3. Common to any visit — true of every business by definition, so always safe and never invented. There are far more of these than people first think: the welcome, being greeted, how you were treated, booking, arriving, finding the place, parking, how long you waited, being looked after without being hovered over, how it felt to be there, how it looked, how clean it was, the quiet or the buzz, being remembered, being helped with something awkward, how easy it was to pay, leaving, whether you would come back, whether you would send a friend, the first visit, coming back again, going as a couple, going with family, going alone.

Aim for close to ${max} topics, and reach it in that order: exhaust the named things first, then the specific ones, then work down the third kind until you are near the number. The third kind is what gets you there — it is a deep well and every one of it is true.

What you must not do to reach the number: invent a dish, a product, a treatment, a room or a facility the page does not show; split one thing into three; or list the same thing twice in different words. If a business is genuinely small — a clinic with four treatments and one room — you will land well short of ${max}, and that is the correct answer for that business. Falling short is fine. Inventing is not.

Only take a name that is actually printed on the page. Never guess at one a business of this kind usually has.

Rules:
- At most ${max} topics.
- Order them the way a customer would scan them: the most obvious and most specific first, the general ones last.
- "label" is what a customer taps: one to three words, title case, no punctuation, no emoji.
- "description" is a short paragraph about that one thing, two to four sentences, and never more than 600 characters.
- A named thing from the first kind may of course appear in its own label and description — that is the whole point of it. Describe it plainly, the way the business would explain it to someone who asked ("the pad thai is made to the owner's mother's recipe", not "our legendary pad thai").
- No two topics may be the same thing worded differently. Two dishes are two topics; "The Staff" and "The Service" are one.

The description matters more than it looks. It is the *only* thing the review writer will ever be told about this business — there is no other document, no list of facts, nothing else. A review about this topic can say what its description says and nothing more, so:

- Everything in it must come off the page you read. If the page does not support a sentence, leave the sentence out. An empty-handed description is recoverable; an invented one is published under a real customer's name.
- Write what a customer would actually notice and mention, not what a brochure would lead with.
- No superlatives, no awards, no ratings, no rankings.
- No numbers of any kind — no prices, no counts, no years, no distances, no opening hours.
- No staff names, and nobody identifiable.
- A topic of the third kind — the welcome, the wait, being looked after — often has nothing on the page behind it. Describe what that part of a visit is, plainly and briefly, and say nothing specific about this business that you cannot support.

Output only the JSON object. Nothing before it, nothing after it.`;
}

/**
 * @param {object} args
 * @param {string} args.url - the business's website
 * @param {number} args.max - how many topics may be stored, from settings.js
 */
function buildTopicMessages({ url, text, max = 30 }) {
  return [
    { role: 'system', content: topicSystem(max) },
    {
      role: 'user',
      content: opening(
        { url, text },
        `propose the review topics. Fetch the page before answering — do not guess from the domain name. Follow the site's own links to the menu, the product range, the treatment list, the rooms: that is where most of the topics are, and the front page rarely has them. Work through what you find item by item rather than summarising it. If the page shows no evidence for something, leave it out rather than assuming a business of this kind usually has one.`,
        `Propose the review topics from what the owner of this business has pasted below. Every dish, product, treatment or room it names is a topic — work through them item by item. Then the third kind, which needs no evidence at all, until you are near the number.`
      ),
    },
  ];
}

/**
 * @param {object} args
 * @param {number} args.max - the stored cap, so the draft cannot exceed it
 * @returns {object[]|null} up to `max` {label, focus}, or null when nothing usable
 */
function parseTopics(raw, { max = 30, maxChars = 600 } = {}) {
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

    // The description is now the whole of what a review may claim about this
    // topic, so a bad one is worse than none: it is repeated in every review
    // written under that button. Dropped rather than reported, unlike the same
    // check on the settings form — this is a model's output and the owner has
    // not seen it yet, so the button survives with its label alone and they can
    // write the paragraph themselves.
    //
    // Either key. The prompt asks for "description"; models that have seen the
    // older prompt still answer with "focus", and accepting both costs a line
    // and saves a wasted page read.
    let focus = text(item?.description ?? item?.focus, maxChars);
    if (focus && (/\d/.test(focus) || bannedWord(focus))) focus = '';

    out.push({ label, focus });
    if (out.length === max) break;
  }

  return out.length ? out : null;
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
  buildThemeMessages,
  parseTheme,
  themeSystem,
  buildTopicMessages,
  parseTopics,
};
