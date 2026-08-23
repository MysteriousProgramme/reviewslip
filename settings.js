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

const { bannedWord, bullets } = require('./seed');
const themes = require('./theme');
const assets = require('./assets');

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
  'facebookUrl',
  'wongnaiUrl',
  'websiteUrl',
];

const BUILT_IN = {
  apiKey: '',
  model: MODEL,
  // No built-in review links. One venue's listing is the wrong default for
  // every other venue — an unset link is reported as unset, and the guest page
  // drops that button rather than sending someone to a stranger's listing.
  googleUrl: '',
  tripadvisorUrl: '',
  facebookUrl: '',
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
  // null rather than the shipped palette: "this business has no theme" and
  // "this business chose the shipped colours" want to behave differently.
  // The first serves an empty /theme.css and leaves the stylesheet alone.
  merged.theme = ownTheme(own);
  // The grabbed typefaces, whole — file included. Only the route that serves
  // them reads this; `describe` strips the bytes before anything is sent out.
  merged.fontDisplay = ownFont(own?.fontDisplay);
  merged.fontUi = ownFont(own?.fontUi);
  merged.background = ownBackground(own?.background);
  return merged;
}

/** @returns {object|null} a stored font file, if this business grabbed one */
function ownFont(value) {
  return assets.isStoredFont(value) ? value : null;
}

/** @returns {object|null} the stored hero photograph, if there is one */
function ownBackground(value) {
  return value &&
    typeof value === 'object' &&
    assets.isStoredImage(value.dataUri, assets.MAX_BACKGROUND_BYTES)
    ? value
    : null;
}

/** The same, minus the file — safe to put in an API response. */
function describeFont(font) {
  if (!font) return null;
  return {
    family: font.family,
    format: font.format,
    source: typeof font.source === 'string' ? font.source : '',
    kb: Math.round((font.data.length * 3) / 4 / 1024),
  };
}

/** @returns {object|null} the business's own four colours, if it set them */
function ownTheme(own) {
  const verdict = themes.validate(own?.theme ?? null);
  return verdict.ok ? verdict.theme : null;
}

/**
 * Sorts topics by their label, the way a person reading a list expects.
 *
 * Through a collator rather than `<`, because labels are whatever the business
 * writes and that includes Thai and Chinese, where comparing UTF-16 code units
 * gives an order nobody recognises. `numeric` so "Room 2" precedes "Room 10";
 * `base` so case and accents do not split words that belong together — those
 * compare equal, and `Array.sort` is stable, so equal labels keep the order
 * they were stored in.
 */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

/** @param {{label?: string}} a @param {{label?: string}} b */
function byLabel(a, b) {
  return collator.compare(a?.label || '', b?.label || '');
}

/**
 * @returns {object[]|null} the venue's own list, if it set one
 *
 * Sorted here, at the one point both readers pass through: the dashboard's
 * editor and the guest page's picker are then in the same order without either
 * one sorting for itself. A copy rather than a sort in place — this array comes
 * off the subscriber row, and reordering it underneath the caller that stored
 * it would be a surprise.
 */
function ownCategories(own) {
  const list = own?.categories;
  return Array.isArray(list) && list.length ? [...list].sort(byLabel) : null;
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
    facebookUrl: { value: values.facebookUrl, source: source.facebookUrl },
    wongnaiUrl: { value: values.wongnaiUrl, source: source.wongnaiUrl },
    categories: { value: values.categories, source: source.categories },
    // The four chosen colours, plus what they derive to and anything the
    // contrast check had to move. The dashboard needs the derived set to draw a
    // truthful preview — showing the four raw colours would promise a page the
    // guest is not going to get.
    theme: {
      value: palette,
      source: source.theme,
      derived: derived.vars,
      adjusted: derived.adjusted,
      // What was actually taken off the business's own site, described rather
      // than included: the dashboard needs to say "Canela, 84kB, from your
      // stylesheet", not carry the file.
      fonts: {
        display: describeFont(values.fontDisplay),
        ui: describeFont(values.fontUi),
      },
      // Described, not included: a hero photo is up to half a megabyte, and the
      // dashboard only needs to say that there is one and how big it is.
      background: values.background
        ? {
            type: values.background.type,
            source: values.background.source ?? '',
            kb: Math.round((values.background.dataUri.length * 3) / 4 / 1024),
          }
        : null,
    },
    // Sent rather than hardcoded in the page, so the editor and the validator
    // cannot drift apart. `categories` keeps its name here because that is the
    // column and the API field; the dashboard and the guest page both call them
    // topics, which is the word a customer uses.
    limits: {
      categories: MAX_TOPICS,
      description: MAX_DESCRIPTION,
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
    ['facebookUrl', 'Facebook link'],
    ['wongnaiUrl', 'Wongnai link'],
  ]) {
    const bad = checkWebUrl(patch[field], label);
    if (bad) return bad;
  }

  // Handed back normalised, so the caller stores exactly what was checked
  // rather than re-deriving it.
  const out = { ok: true };

  if (Array.isArray(patch.categories)) {
    const verdict = validateCategories(patch.categories);
    if (!verdict.ok) return verdict;
    out.categories = verdict.categories;
  }

  if (patch.theme !== undefined) {
    const verdict = themes.validate(patch.theme);
    if (!verdict.ok) return verdict;
    out.theme = verdict.theme;
  }

  // Fonts arrive whole from the drafting endpoint, which is where the download
  // and its checks happen. Anything else is dropped rather than stored: this
  // must never become a way to put arbitrary bytes behind a font URL on our own
  // domain. `null` clears, falling back to the shortlist.
  for (const field of ['fontDisplay', 'fontUi']) {
    if (patch[field] === undefined) continue;
    out[field] = assets.isStoredFont(patch[field]) ? patch[field] : null;
  }

  // Same contract as the fonts: it arrives whole from the drafting endpoint,
  // which is where the download and its checks happen, and anything else is
  // dropped rather than stored.
  if (patch.background !== undefined) {
    out.background = ownBackground(patch.background);
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
 * Fifty is where the depth stops being free. A business generating topics from
 * its own website runs out of things there is real evidence for somewhere around
 * there and starts padding, and padded topics produce vague reviews. What moved
 * it up from thirty was signature products: a restaurant with a menu, or a shop
 * with a range, has a genuine named thing per line, and those are the topics a
 * customer most wants to talk about.
 */
const MAX_TOPICS = 50;
const MAX_LABEL = 40;

/**
 * How long a topic's description may run.
 *
 * This is now the only thing the writer is told about the business, so it has
 * to hold a paragraph rather than a steer. Every *selected* topic's description
 * goes into the prompt, so three chosen topics cost three of these — which is
 * why it is 600 and not the 2,000 the old About box allowed.
 */
const MAX_DESCRIPTION = 600;
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

    // `bullets`, not `text`: a description is a list, and `text` collapses the
    // line breaks that make it one. Typed by hand here rather than generated,
    // so it also tidies whatever someone pasted in.
    const focus = bullets(item?.focus, MAX_DESCRIPTION + 1);

    if (focus) {
      if (focus.length > MAX_DESCRIPTION) {
        return {
          ok: false,
          error: `The description for "${label}" is ${focus.length} characters, and ${MAX_DESCRIPTION} is the limit. Every topic a guest picks goes into the prompt, so keep it to a paragraph.`,
        };
      }

      // Reported rather than silently dropped. These used to be a short steer a
      // model wrote; they are now prose an owner types, and prose that vanishes
      // on save with no explanation is worse than a refusal that says why.
      //
      // Numbers, because the writer is told to use none and a number sitting in
      // front of it is an invitation. Superlatives, because "our award-winning
      // kitchen" comes back out in the reviews whatever the framing says, and a
      // listing full of that phrase is one of the tells the generic document is
      // about.
      if (/\d/.test(focus)) {
        return {
          ok: false,
          error: `The description for "${label}" has a number in it. Reviews are written without numbers, so take it out.`,
        };
      }

      const hit = bannedWord(focus);
      if (hit) {
        return {
          ok: false,
          error: `Take "${hit}" out of the description for "${label}". Words like that end up in the reviews, and a listing full of them is exactly what looks manufactured.`,
        };
      }
    }

    // Locked topics survive a re-generation, which otherwise replaces the whole
    // set. Stored only when true: a `locked: false` on every one of fifty rows
    // is noise in a column that is read on every guest page load.
    const locked = item?.locked === true;

    // No description of its own: the label alone steers the prompt, which reads
    // fine — "write one review about Rooms" — and is what a topic typed by hand
    // in a hurry will be.
    out.push({ id, label, focus: focus || label, ...(locked && { locked }) });
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
  MAX_DESCRIPTION,
  clean,
  fromEnv,
  resolve,
  sources,
  describe,
  mask,
  validate,
  validateCategories,
  byLabel,
};
