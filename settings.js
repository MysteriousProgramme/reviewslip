'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Runtime settings, resolved in this order per field:
 *
 *   settings.json (saved from the Settings panel)  ->  .env  ->  built-in
 *
 * settings.json is gitignored — it holds the API key in plain text, so it
 * belongs on the machine that runs the app and nowhere else.
 */

const FILE = path.join(__dirname, 'settings.json');
const FIELDS = ['apiKey', 'model', 'googleUrl'];

const BUILT_IN = {
  apiKey: '',
  model: 'anthropic/claude-haiku-4.5',
  googleUrl: 'https://www.google.com/maps?cid=4269216131106280644',
};

let saved = readFile();

/* ------------------------------------------------------------------- read */

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const out = {};
    for (const field of FIELDS) {
      if (typeof raw[field] === 'string' && raw[field].trim()) {
        out[field] = raw[field].trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

function fromEnv() {
  const env = {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL,
    googleUrl: process.env.GOOGLE_REVIEW_URL,
  };
  const out = {};
  for (const field of FIELDS) {
    if (typeof env[field] === 'string' && env[field].trim()) {
      out[field] = env[field].trim();
    }
  }
  return out;
}

/** The values the app should actually use. */
function current() {
  return { ...BUILT_IN, ...fromEnv(), ...saved };
}

/** Where each value came from — shown next to the fields in the panel. */
function sources() {
  const env = fromEnv();
  const out = {};
  for (const field of FIELDS) {
    out[field] = saved[field] ? 'saved' : env[field] ? 'env' : 'default';
  }
  return out;
}

/** Safe to hand to the browser: describes the key without revealing it. */
function describe() {
  const values = current();
  const source = sources();
  return {
    apiKey: {
      set: Boolean(values.apiKey),
      hint: mask(values.apiKey),
      source: source.apiKey,
    },
    model: { value: values.model, source: source.model },
    googleUrl: { value: values.googleUrl, source: source.googleUrl },
  };
}

function mask(key) {
  if (!key) return '';
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 8)}••••${key.slice(-4)}`;
}

/* ------------------------------------------------------------ validation */

const MODEL_RE = /^[\w.-]+\/[\w.:-]+$/;

/**
 * @param {object} patch - fields to change. A field left out is untouched; a
 *   field set to '' is cleared, falling back to .env or the built-in.
 * @returns {{ok: boolean, error?: string, warning?: string}}
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
        error: 'A model slug looks like author/model — for example anthropic/claude-haiku-4.5.',
      };
    }
  }

  if (typeof patch.googleUrl === 'string' && patch.googleUrl.trim()) {
    let url;
    try {
      url = new URL(patch.googleUrl.trim());
    } catch {
      return { ok: false, error: 'That review link is not a valid URL.' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, error: 'The review link must start with https://.' };
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ write */

/** Applies a validated patch and writes settings.json. */
function save(patch) {
  const next = { ...saved };

  for (const field of FIELDS) {
    if (typeof patch[field] !== 'string') continue;
    const value = patch[field].trim();
    if (value) next[field] = value;
    else delete next[field]; // cleared — fall back to .env / built-in
  }

  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  saved = next;
}

module.exports = { current, describe, sources, validate, save, BUILT_IN };
