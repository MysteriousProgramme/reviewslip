'use strict';

const fs = require('fs');
const path = require('path');

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

/**
 * The same, for a description — which is a list now, not a sentence.
 *
 * `text` above collapses every run of whitespace into one space. That is right
 * for a label and destroys a description: the line breaks between bullets are
 * the shape of it. Its own function rather than a flag on `text`, because the
 * two want opposite things and a boolean at the call site would say neither.
 *
 * Tidies each line and drops the blank ones, so a model that double-spaces its
 * bullets and a person who pastes out of a document end up with the same thing.
 * Common bullet glyphs become "- ": nobody typing into a textarea should have
 * to know which character this expects.
 */
function bullets(value, max) {
  if (typeof value !== 'string') return '';

  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/[ \t]+/g, ' ')
        .replace(/^[•*–—]\s*/, '- ')
    )
    .filter(Boolean)
    .join('\n')
    .slice(0, max);
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
 * The topic-drafting instructions, in context_topic.md next door.
 *
 * Out of this file for the same reason context.md is out of config.js: it is
 * prose a model reads, it is the thing most worth editing when the topics come
 * back wrong, and a person editing it should not have to open a .js file and
 * work inside a template literal to do it. A diff then shows the argument
 * changing rather than a string literal changing.
 *
 * Read once at require time and cached. It is the same for every business, so
 * re-reading it per draft would put a disk hit in front of a call that already
 * takes twenty seconds, to support an edit nobody makes without deploying.
 *
 * Throws rather than degrades. A topic prompt reduced to "propose some topics"
 * would still return topics — plausible ones, for a business nobody read — and
 * that failure is invisible until a customer notices their menu is fiction.
 * Refusing to start is the louder and cheaper outcome.
 */
const TOPIC_DOC = (() => {
  const file = path.join(__dirname, 'context_topic.md');

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read ${file}: ${err.message}. The topic drafting instructions ` +
        'are required.'
    );
  }

  const body = raw.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
  if (!body) throw new Error(`${file} is empty.`);

  return body;
})();

/**
 * @param {number} max - how many topics may be stored, from settings.js
 */
function topicSystem(max) {
  // One placeholder, filled everywhere it appears. The document says so about
  // itself, so a reader is not left wondering what {max} is.
  return TOPIC_DOC.split('{max}').join(String(max));
}

/**
 * @param {object} args
 * @param {string} args.url - whatever page this business has: its website, or
 *   its Facebook page, or one of its review listings. The instruction below is
 *   deliberately the same for all of them. A social page that answers with a
 *   sign-in wall is not a different kind of source needing different words; it
 *   is a page that came back with nothing on it, and the honest response to
 *   that is the one already asked for — leave it out rather than assume.
 * @param {string[]} [args.listings] - the business's review pages, when it has
 *   set any. Its own site says what it offers; these say which of it customers
 *   actually talk about, and in whose words. The document sets out how far each
 *   source may be trusted, because that is the distinction with consequences:
 *   what reviewers say is evidence of what matters, never of what is true.
 * @param {number} args.max - how many topics may be stored, from settings.js
 */
function buildTopicMessages({ url, listings = [], max = 30 }) {
  // Deduplicated, because the source URL is chosen out of the same set: a
  // business whose only address is its Facebook page would otherwise be asked
  // to read that page twice, once as the site and once as a listing.
  const others = listings.filter(Boolean).filter((link) => link !== url);

  const reviews = others.length
    ? `\n\nThen read the reviews this business already has:\n${others.map((link) => `- ${link}`).join('\n')}\n\nRead the good ones, and take two things from them: which subjects come up again and again, and what words customers use for them. A subject nobody has ever mentioned in a review is one nobody will pick off a button. Remember what the reviews may and may not be used for — they tell you what matters, never what is true, and none of them may be quoted or reworded.`
    : '';

  return [
    { role: 'system', content: topicSystem(max) },
    {
      role: 'user',
      content: `Read ${url} and propose the review topics. Fetch the page before answering — do not guess from the domain name or from the business's name. Follow the site's own links to the menu, the product range, the treatment list, the rooms: that is where most of the topics are, and the front page rarely has them. Work through what you find item by item rather than summarising it.${reviews}

If a page will not load, or shows a sign-in wall, or carries nothing about the business, say so plainly and carry on with whatever did load. If none of them loaded, return only the topics of the third kind — the ones true of any visit. Do not describe a business you could not read.`,
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
    let focus = bullets(item?.description ?? item?.focus, maxChars);
    if (focus && (/\d/.test(focus) || bannedWord(focus))) focus = '';

    out.push({ label, focus });
    if (out.length === max) break;
  }

  return out.length ? out : null;
}

/* ------------------------------------------------- one topic's description */

/**
 * A description for a single topic, written to order.
 *
 * The bulk generator reads a website and proposes fifty topics at once, which
 * is the right shape for setting a business up and the wrong one for changing
 * your mind about one button. This is that: the owner has a topic — often one
 * they typed themselves, so there is no description at all — and wants a
 * paragraph for it without disturbing the other forty-nine.
 *
 * Two ways in, and they are the same call. The name alone is enough ("Sunday
 * Roast" tells the model what it is looking for on the page). A hint is
 * whatever the owner has already typed into the box, which may be a keyword, a
 * half-written sentence, or a note to themselves — and it is the strongest
 * signal there is about what they want said, so it outranks whatever the page
 * suggests would be interesting.
 *
 * The page is still read, and still the only source of specifics. That is what
 * separates this from a machine for inventing plausible business copy: the name
 * says which thing to write about, and the page says what may be said about it.
 */
const DESCRIBE_SYSTEM = `You write one short description of one thing a business offers, for a review-writing assistant to work from.

Return a single JSON object of this shape:
{ "description": "- Every room looks over the garden\n- Your own balcony, which is where most people end up in the evening\n- Walk-in showers rather than a tub you step into" }

What you write is the whole of what a review about this topic will ever be able to claim. There is no other document about this business. A review may say what your description says, and may say how the visit felt, and nothing else — so a sentence you invent here is a sentence published under a real customer's name.

Rules:
- A list of bullet points, not a paragraph. Each bullet is a single line starting with "- ", separated by a newline, and the whole list is never more than 600 characters.
- How many bullets depends on the topic you were given, not on a quota. Take as many as it genuinely has and stop: a named dish the page describes at length might carry five or six; "Parking" might carry two. Never one — a single bullet is a paragraph wearing a dash — and never a line invented to reach a number.
- One bullet per thing. Do not put two ideas in one line joined by "and" — split them.
- Everything specific must come off the page you were given. If the page does not support a sentence, leave the sentence out.
- Every bullet says what a customer gets out of it, not what it is. Restating the name in other words tells the review writer nothing.

  NEVER write a description like this — for the label "Weekend Stay", the description "A short break over the weekend." That is a definition of the label. It adds nothing the label did not already say, and it is one bullet where there should be several.

  Write this instead: "- Two nights is enough to stop rushing about\n- Checkout is late enough on a Sunday for another swim before you go\n- The kitchen is still open if you get back after dark". Ask what is worth having about this one, and answer with a line for each.
- Write what a customer would notice and mention, not what a brochure would lead with. Plainly, in the business's own voice: "the pad thai is made to the owner's mother's recipe", not "our legendary pad thai".
- No superlatives, no awards, no ratings, no rankings.
- No numbers of any kind — no prices, no counts, no years, no distances, no opening hours.
- No staff names, and nobody identifiable.
- If the page says nothing about this topic — which is normal for the ordinary parts of a visit, like the welcome or the wait — describe what that part of a visit is, plainly and briefly, and claim nothing specific about this business. That is a good answer, not a failure.
- If the page will not load, or shows a sign-in wall, do the same: describe the topic in general terms and claim nothing specific. Never describe a business you could not read.

Output only the JSON object. Nothing before it, nothing after it.`;

/**
 * @param {object} args
 * @param {string} args.url - the page to read, if this business has one
 * @param {string} args.label - the topic's name, which is what to write about
 * @param {string} [args.hint] - whatever is already in the box: a keyword, a
 *   fragment, a note. Optional, and load-bearing when it is there.
 */
function buildDescribeMessages({ url, label, hint = '' }) {
  const steer = hint
    ? `\n\nThe owner has already written this much, and it is the best signal you have about what they want said. Build on it rather than replacing it, and keep anything in it that is true:\n\n${hint}`
    : '';

  const source = url
    ? `Read ${url} first, and follow its own links if what you need is on another page — a menu, a treatment list, a room type.`
    : `There is no page to read for this business, so claim nothing specific about it. Describe what this part of a visit is, plainly, and stop.`;

  return [
    { role: 'system', content: DESCRIBE_SYSTEM },
    {
      role: 'user',
      content: `Write the description for one topic: "${label}".\n\n${source}${steer}`,
    },
  ];
}

/**
 * @returns {string|null} the description, screened, or null when nothing usable
 *   came back. Screened rather than trusted for the same reason parseTopics
 *   screens: the prompt is a request, and this text is repeated in every review
 *   written under that button.
 */
function parseDescription(raw, { maxChars = 600 } = {}) {
  const data = extractJson(raw);
  if (!data) return null;

  const description = bullets(data.description ?? data.focus, maxChars);
  if (!description) return null;
  if (/[0-9]/.test(description) || bannedWord(description)) return null;

  return description;
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
  bullets,
  buildDescribeMessages,
  parseDescription,
  buildThemeMessages,
  parseTheme,
  themeSystem,
  buildTopicMessages,
  parseTopics,
};
