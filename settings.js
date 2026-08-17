'use strict';

/**
 * Settings resolution and validation.
 *
 * Each subscriber's values resolve in this order, per field:
 *
 *   the subscriber's own row  ->  .env  ->  built-in
 *
 * The .env layer is deliberate rather than leftover: it lets an operator put
 * one platform-wide OpenRouter key in place and have every venue work off it,
 * while a venue that brings its own key simply overrides it. Clearing a field
 * on a subscriber drops back through the same chain.
 *
 * Nothing here touches the database. subscribers.js owns the rows and calls in
 * for the merge, so this file stays testable with a plain object.
 */

const { bannedWord } = require('./seed');
const themes = require('./theme');

/**
 * The model every venue writes with, fixed.
 *
 * Not part of the resolution chain below: neither a venue nor .env can change
 * it. Model choice is a platform decision — the prompt, the screens and the
 * token budget are all tuned around one model, and a venue quietly running a
 * different one is a support problem nobody would see coming.
 */
const MODEL = 'x-ai/grok-4.3';

const FIELDS = [
  'apiKey',
  'googleUrl',
  'tripadvisorUrl',
  'lineUrl',
  'facebookUrl',
  'xiaohongshuUrl',
  'wongnaiUrl',
  'websiteUrl',
  'kind',
  'place',
  'contextDoc',
];

const BUILT_IN = {
  apiKey: '',
  model: MODEL,
  // Who the business is, in the writer's words. No .env layer and no built-in
  // value: one business's description is meaningless for another, and until this
  // was emptied every business that had not described itself inherited the first
  // customer's — so a dental clinic's reviews described a lodge in Chiang Mai.
  // Blank is the honest default, and `buildSystemPrompt` handles it by writing
  // about the customer's impression and nothing else.
  kind: '',
  place: '',
  // The business's own AI context document: free text its owner wrote or had
  // drafted from their website, steering what a review talks about and how it
  // sounds. Same reasoning as kind and place — nobody else's is any use here.
  contextDoc: '',
  // No built-in review links. One venue's listing is the wrong default for
  // every other venue — an unset link is reported as unset, and the guest page
  // drops that button rather than sending someone to a stranger's listing.
  googleUrl: '',
  tripadvisorUrl: '',
  lineUrl: '',
  facebookUrl: '',
  xiaohongshuUrl: '',
  wongnaiUrl: '',
  // The venue's own site. Read during seeding to draft the venue details;
  // nothing else uses it, and it is never shown to guests.
  websiteUrl: '',
};

/* -------------------------------------------------------------- resolution */

/** Drops blanks and non-strings, so an empty field falls through the chain. */
function clean(values) {
  const out = {};
  for (const field of FIELDS) {
    const value = values?.[field];
    if (typeof value === 'string' && value.trim()) out[field] = value.trim();
  }
  return out;
}

function fromEnv() {
  return clean({
    apiKey: process.env.OPENROUTER_API_KEY,
    googleUrl: process.env.GOOGLE_REVIEW_URL,
    tripadvisorUrl: process.env.TRIPADVISOR_REVIEW_URL,
    websiteUrl: process.env.VENUE_WEBSITE_URL,
  });
}

/**
 * The values the app should actually use for a subscriber.
 * @param {object} own - that subscriber's stored fields
 */
function resolve(own) {
  const merged = { ...BUILT_IN, ...fromEnv(), ...clean(own) };
  // Last, so nothing above can have replaced it.
  merged.model = MODEL;
  // Topics skip the .env layer — a list of buttons is not something you usefully
  // set installation-wide, so it is the business's own or nothing. No fallback:
  // a business with no topics has none, and silently handing a dentist a lodge's
  // buttons was worse than showing none at all. Callers must cope with an empty
  // list. Details are the same, for the same reason.
  merged.categories = ownCategories(own) || [];
  merged.safeDetails = ownSafeDetails(own) || [];
  // null rather than the shipped palette: "this business has no theme" and
  // "this business chose the shipped colours" want to behave differently.
  // The first serves an empty /theme.css and leaves the stylesheet alone.
  merged.theme = ownTheme(own);
  return merged;
}

/** @returns {object|null} the business's own four colours, if it set them */
function ownTheme(own) {
  const verdict = themes.validate(own?.theme ?? null);
  return verdict.ok ? verdict.theme : null;
}

/** @returns {object[]|null} the venue's own list, if it set one */
function ownCategories(own) {
  const list = own?.categories;
  return Array.isArray(list) && list.length ? list : null;
}

/** @returns {string[]|null} the venue's own details, if it set any */
function ownSafeDetails(own) {
  const list = own?.safeDetails;
  return Array.isArray(list) && list.length ? list : null;
}

/** Where each value came from — shown next to the fields in the panel. */
function sources(own) {
  const mine = clean(own);
  const env = fromEnv();
  const out = {};
  for (const field of FIELDS) {
    out[field] = mine[field] ? 'subscriber' : env[field] ? 'env' : 'default';
  }
  // Not in FIELDS, so the loop above never sets it — and it is always ours.
  out.model = 'default';
  out.categories = ownCategories(own) ? 'subscriber' : 'default';
  out.safeDetails = ownSafeDetails(own) ? 'subscriber' : 'default';
  out.theme = ownTheme(own) ? 'subscriber' : 'default';
  return out;
}

/** Safe to hand to the browser: describes the key without revealing it. */
function describe(own) {
  const values = resolve(own);
  const source = sources(own);
  const palette = values.theme || themes.DEFAULT_THEME;
  const derived = themes.derive(palette);
  return {
    apiKey: {
      set: Boolean(values.apiKey),
      hint: mask(values.apiKey),
      source: source.apiKey,
    },
    model: { value: values.model, source: source.model },
    googleUrl: { value: values.googleUrl, source: source.googleUrl },
    tripadvisorUrl: {
      value: values.tripadvisorUrl,
      source: source.tripadvisorUrl,
    },
    websiteUrl: { value: values.websiteUrl, source: source.websiteUrl },
    lineUrl: { value: values.lineUrl, source: source.lineUrl },
    facebookUrl: { value: values.facebookUrl, source: source.facebookUrl },
    xiaohongshuUrl: { value: values.xiaohongshuUrl, source: source.xiaohongshuUrl },
    wongnaiUrl: { value: values.wongnaiUrl, source: source.wongnaiUrl },
    categories: { value: values.categories, source: source.categories },
    kind: { value: values.kind, source: source.kind },
    place: { value: values.place, source: source.place },
    safeDetails: { value: values.safeDetails, source: source.safeDetails },
    contextDoc: { value: values.contextDoc, source: source.contextDoc },
    // The four chosen colours, plus what they derive to and anything the
    // contrast check had to move. The dashboard needs the derived set to draw a
    // truthful preview — showing the four raw colours would promise a page the
    // guest is not going to get.
    theme: {
      value: palette,
      source: source.theme,
      derived: derived.vars,
      adjusted: derived.adjusted,
    },
    // Sent rather than hardcoded in the page, so the editor and the validator
    // cannot drift apart. `categories` keeps its name here because that is the
    // column and the API field; the dashboard and the guest page both call them
    // topics, which is the word a customer uses.
    limits: {
      categories: MAX_TOPICS,
      safeDetails: MAX_SAFE_DETAILS,
      contextDoc: MAX_CONTEXT_DOC,
    },
  };
}

function mask(key) {
  if (!key) return '';
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 8)}••••${key.slice(-4)}`;
}

/* ------------------------------------------------------------- validation */

const MODEL_RE = /^[\w.-]+\/[\w.:-]+$/;

/**
 * @param {object} patch - fields to change. A field left out is untouched; a
 *   field set to '' is cleared, falling back to .env or the built-in.
 * @returns {{ok: boolean, error?: string}}
 */
function validate(patch) {
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    const key = patch.apiKey.trim();
    if (key.length > 300) return { ok: false, error: 'That key is too long.' };
    if (/\s/.test(key)) {
      return { ok: false, error: 'The key has a space in it. Check the paste.' };
    }
  }

  if (typeof patch.model === 'string' && patch.model.trim()) {
    if (!MODEL_RE.test(patch.model.trim())) {
      return {
        ok: false,
        error:
          'A model slug looks like author/model — for example anthropic/claude-haiku-4.5.',
      };
    }
  }

  const googleUrl = checkWebUrl(patch.googleUrl, 'Google review link');
  if (googleUrl) return googleUrl;

  const tripadvisorUrl = checkWebUrl(patch.tripadvisorUrl, 'Tripadvisor link');
  if (tripadvisorUrl) return tripadvisorUrl;

  const websiteUrl = checkWebUrl(patch.websiteUrl, 'website address');
  if (websiteUrl) return websiteUrl;

  for (const [field, label] of [
    ['lineUrl', 'LINE link'],
    ['facebookUrl', 'Facebook link'],
    ['xiaohongshuUrl', 'Xiaohongshu link'],
    ['wongnaiUrl', 'Wongnai link'],
  ]) {
    const bad = checkWebUrl(patch[field], label);
    if (bad) return bad;
  }

  const kind = checkLength(patch.kind, MAX_KIND, 'description');
  if (kind) return kind;

  const place = checkLength(patch.place, MAX_PLACE, 'location');
  if (place) return place;

  const contextDoc = checkContextDoc(patch.contextDoc);
  if (contextDoc) return contextDoc;

  // Handed back normalised, so the caller stores exactly what was checked
  // rather than re-deriving it.
  const out = { ok: true };

  if (Array.isArray(patch.categories)) {
    const verdict = validateCategories(patch.categories);
    if (!verdict.ok) return verdict;
    out.categories = verdict.categories;
  }

  if (Array.isArray(patch.safeDetails)) {
    const verdict = validateSafeDetails(patch.safeDetails);
    if (!verdict.ok) return verdict;
    out.safeDetails = verdict.safeDetails;
  }

  if (patch.theme !== undefined) {
    const verdict = themes.validate(patch.theme);
    if (!verdict.ok) return verdict;
    out.theme = verdict.theme;
  }

  return out;
}

/** @returns {{ok: false, error: string}|null} null when the value is fine */
function checkLength(value, max, label) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().length > max
    ? { ok: false, error: `That ${label} is too long.` }
    : null;
}

/* --------------------------------------------------------- the context doc */

// Long enough for a couple of paragraphs about who comes here and what they
// mention; short enough that it is not most of the prompt. It is sent on every
// generation, and the business pays for it by the token.
const MAX_CONTEXT_DOC = 2000;

/**
 * The business's own AI context document.
 *
 * Free text, unlike the details list — it steers tone and subject matter rather
 * than supplying facts a review may assert, and the prompt says so explicitly.
 * That is why numbers are allowed here and banned there: a number in a detail
 * gets stated as fact in every review, while a number in the background material
 * is something the writer is told not to repeat.
 *
 * Superlatives are still refused. "Our award-winning kitchen" in here comes back
 * out in the reviews whatever the framing says, and a listing full of the word
 * "award-winning" is one of the tells the generic context document is about.
 *
 * @returns {{ok: false, error: string}|null} null when the value is fine
 */
function checkContextDoc(value) {
  if (typeof value !== 'string' || !value.trim()) return null;

  const doc = value.trim();

  if (doc.length > MAX_CONTEXT_DOC) {
    return {
      ok: false,
      error: `That context is ${doc.length} characters, and ${MAX_CONTEXT_DOC} is the limit. It goes into every review, so keep it to the essentials.`,
    };
  }

  const hit = bannedWord(doc);
  if (hit) {
    return {
      ok: false,
      error: `Take "${hit}" out of the context. Words like that end up in the reviews, and a listing full of them is exactly what looks manufactured.`,
    };
  }

  return null;
}

/* ----------------------------------------------------------- safe details */

// The prompt asks for six to ten; ten is where a list stops steering the writer
// and starts being a menu it picks from at random.
const MAX_SAFE_DETAILS = 10;
const MAX_DETAIL = 180;
const MAX_KIND = 120;
const MAX_PLACE = 160;

/**
 * The details a review may draw on — the load-bearing part of the
 * no-fabrication guarantee. A wrong one here is repeated in *every* review from
 * then on, not just one, so the same screens seeding applies to a model's
 * output apply to a human's typing: no numbers, no unverifiable claims.
 *
 * Unlike seeding, which silently drops what fails, this reports the problem —
 * someone editing the list by hand should be told why their line vanished.
 *
 * @returns {{ok: true, safeDetails: string[]}|{ok: false, error: string}}
 */
function validateSafeDetails(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Details must be a list.' };
  }
  if (value.length > MAX_SAFE_DETAILS) {
    return {
      ok: false,
      error: `That is more than ${MAX_SAFE_DETAILS} details. Trim the list.`,
    };
  }

  const out = [];

  for (const item of value) {
    const detail = text(item, MAX_DETAIL + 1);
    if (!detail) continue; // a blank row is a row the user deleted

    if (detail.length > MAX_DETAIL) {
      return {
        ok: false,
        error: `"${detail.slice(0, 30)}…" is too long for a detail.`,
      };
    }
    if (/\d/.test(detail)) {
      return {
        ok: false,
        error: `"${detail.slice(0, 30)}…" has a number in it. Numbers get repeated in every review — take it out.`,
      };
    }
    const hit = bannedWord(detail);
    if (hit) {
      return {
        ok: false,
        error: `"${detail.slice(0, 30)}…" claims something a guest cannot check ("${hit}"). Rephrase it.`,
      };
    }

    out.push(detail);
  }

  return { ok: true, safeDetails: out };
}

/* ------------------------------------------------- topics (aka categories) */

/**
 * How many topics a business may keep.
 *
 * This was five, on the argument that five is the whole picker and a departing
 * guest past that is reading a menu instead of tapping what stood out. That
 * argument was about the *picker*, not about the *set*, and it stopped applying
 * the moment the guest page started sampling: it now shows ten drawn at random
 * with the rest behind a browse button, so the guest sees a short list either
 * way while the set behind it is deep enough that two guests an hour apart are
 * unlikely to be offered the same ten.
 *
 * Thirty is where the depth stops being free. A business generating topics from
 * its own website runs out of things there is real evidence for somewhere around
 * there and starts padding, and padded topics produce vague reviews.
 */
const MAX_TOPICS = 30;
const MAX_LABEL = 40;
const MAX_FOCUS = 200;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Topics are guest-facing buttons *and* prompt input, so they get the same
 * treatment as any other stored setting: normalised once, here, and never
 * trusted in the shape they arrived.
 *
 * An empty list is a business with no topics, not a business falling back to
 * someone else's. The guest page then offers no buttons and writes about the
 * visit overall, which is the honest thing to do before anyone has said what
 * this business is.
 *
 * @returns {{ok: true, categories: object[]}|{ok: false, error: string}}
 */
function validateCategories(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Categories must be a list.' };
  }
  if (value.length > MAX_TOPICS) {
    return {
      ok: false,
      error: `That is more than ${MAX_TOPICS} topics. Trim the list.`,
    };
  }

  const taken = new Set();
  const out = [];

  for (const item of value) {
    const label = text(item?.label, MAX_LABEL + 1);
    if (!label) continue; // a blank row is a row the user deleted

    if (label.length > MAX_LABEL) {
      return {
        ok: false,
        error: `"${label.slice(0, 20)}…" is too long for a button.`,
      };
    }

    // An id sent back unchanged keeps a guest's current selection working
    // across a label edit; anything else gets a fresh one from the label.
    const given = text(item?.id, 32).toLowerCase();
    const id =
      ID_RE.test(given) && !taken.has(given) ? given : idFrom(label, taken);
    taken.add(id);

    // No focus of their own: the label alone steers the prompt, which reads
    // fine — "write one review about Rooms".
    out.push({ id, label, focus: text(item?.focus, MAX_FOCUS) || label });
  }

  return { ok: true, categories: out };
}

function text(value, max) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, max)
    : '';
}

function idFrom(label, taken) {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/, '') || 'category';

  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** @returns {{ok: false, error: string}|null} null when the value is fine */
function checkWebUrl(value, label) {
  if (typeof value !== 'string' || !value.trim()) return null;

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: `That ${label} is not a valid URL.` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: `The ${label} must start with https://.` };
  }
  return null;
}

module.exports = {
  FIELDS,
  BUILT_IN,
  MODEL,
  MAX_TOPICS,
  MAX_SAFE_DETAILS,
  MAX_CONTEXT_DOC,
  validateSafeDetails,
  clean,
  fromEnv,
  resolve,
  sources,
  describe,
  mask,
  validate,
  validateCategories,
};
