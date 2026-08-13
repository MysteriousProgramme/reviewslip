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

const { CATEGORIES, VENUE } = require('./config');
const { bannedWord } = require('./seed');

/**
 * The model every venue writes with, fixed.
 *
 * Not part of the resolution chain below: neither a venue nor .env can change
 * it. Model choice is a platform decision — the prompt, the screens and the
 * token budget are all tuned around one model, and a venue quietly running a
 * different one is a support problem nobody would see coming.
 */
const MODEL = 'google/gemma-4-26b-a4b-it:free';

const FIELDS = [
  'apiKey',
  'googleUrl',
  'tripadvisorUrl',
  'websiteUrl',
  'kind',
  'place',
];

const BUILT_IN = {
  apiKey: '',
  model: MODEL,
  // Who the venue is, in the writer's words. No .env layer: one venue's
  // description is meaningless for another, so these are the venue's own or the
  // built-in, and `fromEnv` simply does not read them.
  kind: VENUE.kind,
  place: VENUE.place,
  // No built-in review links. One venue's listing is the wrong default for
  // every other venue — an unset link is reported as unset, and the guest page
  // drops that button rather than sending someone to a stranger's listing.
  googleUrl: '',
  tripadvisorUrl: '',
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
  // Categories skip the .env layer — a list of buttons is not something you
  // usefully set installation-wide, so it is the venue's own or the built-in.
  // No fallback. A business with no categories has none: the built-in five
  // describe a lodge, and silently handing them to a dentist was worse than
  // showing no buttons at all. Callers must cope with an empty list.
  merged.categories = ownCategories(own) || [];
  merged.safeDetails = ownSafeDetails(own) || VENUE.safeDetails;
  return merged;
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
  return out;
}

/** Safe to hand to the browser: describes the key without revealing it. */
function describe(own) {
  const values = resolve(own);
  const source = sources(own);
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
    categories: { value: values.categories, source: source.categories },
    kind: { value: values.kind, source: source.kind },
    place: { value: values.place, source: source.place },
    safeDetails: { value: values.safeDetails, source: source.safeDetails },
    // Sent rather than hardcoded in the page, so the editor and the validator
    // cannot drift apart.
    limits: { categories: MAX_CATEGORIES, safeDetails: MAX_SAFE_DETAILS },
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

  const kind = checkLength(patch.kind, MAX_KIND, 'description');
  if (kind) return kind;

  const place = checkLength(patch.place, MAX_PLACE, 'location');
  if (place) return place;

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

  return out;
}

/** @returns {{ok: false, error: string}|null} null when the value is fine */
function checkLength(value, max, label) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().length > max
    ? { ok: false, error: `That ${label} is too long.` }
    : null;
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

/* ------------------------------------------------------------- categories */

// Five buttons is the whole picker. Past that a departing guest is reading a
// menu instead of tapping the thing that stood out, and the built-in set is
// exactly five, so this is the shape the page was designed around.
const MAX_CATEGORIES = 5;
const MAX_LABEL = 40;
const MAX_FOCUS = 200;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Categories are guest-facing buttons *and* prompt input, so they get the same
 * treatment as any other stored setting: normalised once, here, and never
 * trusted in the shape they arrived.
 *
 * An empty list is a cleared list — it falls back to the built-in set, the way
 * clearing a text field falls back down the chain.
 *
 * @returns {{ok: true, categories: object[]}|{ok: false, error: string}}
 */
function validateCategories(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Categories must be a list.' };
  }
  if (value.length > MAX_CATEGORIES) {
    return {
      ok: false,
      error: `That is more than ${MAX_CATEGORIES} categories. Trim the list.`,
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
  MAX_CATEGORIES,
  MAX_SAFE_DETAILS,
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
