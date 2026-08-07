'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const { VENUE, CATEGORIES, buildMessages } = require('./config');
const settings = require('./settings');

const PORT = Number(process.env.PORT) || 3000;

const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_KEY_INFO = 'https://openrouter.ai/api/v1/key';

const app = express();
app.use(express.json({ limit: '16kb' }));
// No max-age: the files are small and served off the same box, and a stale
// index.html on a guest's phone is far more annoying than a revalidation.
app.use(express.static(path.join(__dirname, 'public'), { etag: true }));

/* ---------------------------------------------------------------- throttle */
// One tab on a lobby QR code is the normal case; this only exists so an open
// endpoint can't burn the API budget. In-memory, per-IP, resets every minute.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map();

function throttled(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

/* ------------------------------------------------------------------ routes */

app.get('/api/config', (req, res) => {
  const { googleUrl } = settings.current();
  res.json({
    venue: VENUE.name,
    place: VENUE.place,
    categories: CATEGORIES.map(({ id, label }) => ({ id, label })),
    googleUrl,
  });
});

/* Settings panel. The key is never sent back to the browser — only whether one
   is set, and a masked hint so staff can tell which key is in place. */

app.get('/api/settings', (req, res) => {
  res.json(settings.describe());
});

app.post('/api/settings', async (req, res) => {
  const patch = req.body || {};

  const check = settings.validate(patch);
  if (!check.ok) return res.status(400).json({ error: check.error });

  // A key that OpenRouter rejects would only surface later as a failed
  // generation, so try it here while the panel is still open.
  let warning;
  const key = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
  if (key) {
    const verdict = await verifyKey(key);
    if (verdict === 'rejected') {
      return res
        .status(400)
        .json({ error: 'OpenRouter rejected that key. Check it and try again.' });
    }
    if (verdict === 'unreachable') {
      warning = 'Saved, but OpenRouter could not be reached to check the key.';
    }
  }

  const model = typeof patch.model === 'string' ? patch.model.trim() : '';
  if (model && (await modelMissing(model))) {
    warning = `Saved, but "${model}" is not in OpenRouter's catalogue.`;
  }

  try {
    settings.save(patch);
  } catch (err) {
    console.error('Could not write settings.json:', err);
    return res
      .status(500)
      .json({ error: 'Could not write settings.json. Check file permissions.' });
  }

  res.json({ settings: settings.describe(), warning });
});

/** Model slugs for the picker, so staff do not have to type one from memory. */
app.get('/api/models', async (req, res) => {
  const models = await catalogue();
  res.json({ models: models.map(({ id, name }) => ({ id, name })) });
});

app.post('/api/review', async (req, res) => {
  const { apiKey, model } = settings.current();

  if (!apiKey) {
    return res.status(500).json({
      error: 'No OpenRouter key yet. Add one in Settings.',
    });
  }

  if (throttled(req.ip)) {
    return res
      .status(429)
      .json({ error: 'That is a lot of reviews. Wait a moment and try again.' });
  }

  const body = req.body || {};
  // config.js falls back to the first category for anything unknown; resolve it
  // here too so the response says which category was actually written.
  const categoryId = CATEGORIES.some((c) => c.id === body.categoryId)
    ? body.categoryId
    : CATEGORIES[0].id;
  const recent = Array.isArray(body.recent)
    ? body.recent
        .filter((r) => typeof r === 'string')
        .slice(-3)
        .map((r) => r.slice(0, 400))
    : [];

  const messages = buildMessages({ categoryId, recent });

  try {
    const upstream = await fetch(OPENROUTER_CHAT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': `${VENUE.name} review helper`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 1,
        top_p: 0.95,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error(`OpenRouter ${upstream.status}: ${detail.slice(0, 500)}`);
      return res
        .status(502)
        .json({ error: 'The writer is unavailable right now. Try again.' });
    }

    const data = await upstream.json();
    const review = clean(data?.choices?.[0]?.message?.content);

    if (!review) {
      console.error('Empty completion:', JSON.stringify(data).slice(0, 500));
      return res
        .status(502)
        .json({ error: 'The writer came back empty. Try again.' });
    }

    res.json({ review, categoryId });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    console.error('Review request failed:', err);
    res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? 'The writer took too long. Try again.'
        : 'Could not reach the writer. Check the connection and try again.',
    });
  }
});

/* ------------------------------------------------------------------ helpers */

const QUOTE_PAIRS = [
  ['"', '"'],
  ['“', '”'],
  ["'", "'"],
  ['‘', '’'],
];

/**
 * Models sometimes wrap the review in quotes, label it, or do both in either
 * order — so unwrap and unlabel repeatedly until nothing more comes off.
 */
function clean(raw) {
  let t = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();

  for (let pass = 0; pass < 4; pass++) {
    const before = t;

    for (const [open, close] of QUOTE_PAIRS) {
      if (t.length > 2 && t.startsWith(open) && t.endsWith(close)) {
        t = t.slice(1, -1).trim();
        break;
      }
    }
    t = t
      .replace(/^(?:review|here'?s (?:a|the|your) review)\s*[:–-]\s*/i, '')
      .trim();

    if (t === before) break;
  }
  return t;
}

/* ---------------------------------------------------------- OpenRouter meta */

let catalogueCache = { at: 0, models: [] };
const CATALOGUE_TTL = 10 * 60_000;

/** The model list, cached — used by the picker and the slug check. */
async function catalogue() {
  if (Date.now() - catalogueCache.at < CATALOGUE_TTL) {
    return catalogueCache.models;
  }
  try {
    const res = await fetch(OPENROUTER_MODELS, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return catalogueCache.models;
    const { data } = await res.json();
    if (!Array.isArray(data)) return catalogueCache.models;

    const models = data
      .map((m) => ({ id: m.id, name: m.name || m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    catalogueCache = { at: Date.now(), models };
    return models;
  } catch {
    // Offline, or OpenRouter is down. Fall back to whatever we last saw.
    return catalogueCache.models;
  }
}

/** True only when the catalogue loaded and the slug is definitely absent. */
async function modelMissing(slug) {
  const models = await catalogue();
  return models.length > 0 && !models.some((m) => m.id === slug);
}

/** 'ok' | 'rejected' | 'unreachable' — never throws. */
async function verifyKey(key) {
  try {
    const res = await fetch(OPENROUTER_KEY_INFO, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'ok';
    if (res.status === 401 || res.status === 403) return 'rejected';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/* ------------------------------------------------------------------- start */

app.listen(PORT, async () => {
  const { apiKey, model } = settings.current();
  const source = settings.sources();

  console.log(`\n  ${VENUE.name} review helper`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  model: ${model} (${source.model})`);

  if (!apiKey) {
    console.warn('  ! No OpenRouter key yet. Add one in Settings on the page.');
  } else if (await modelMissing(model)) {
    console.warn(`  ! "${model}" is not in OpenRouter's catalogue.`);
  }
});
