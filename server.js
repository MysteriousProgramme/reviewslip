'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

const {
  VENUE,
  LANGUAGES,
  DEFAULT_LANGUAGE,
  languageFor,
  buildMessages,
} = require('./config');
const {
  buildSeedMessages,
  parseProposal,
  buildCategoryMessages,
  parseCategorySuggestions,
} = require('./seed');
const { ready } = require('./db');
const subscribers = require('./subscribers');
const events = require('./events');
const openrouter = require('./openrouter');
const { readWebsite, openrouterHeaders } = require('./reader');
const { PLATFORMS } = require('./platforms');
const adminRouter = require('./admin');
const customerRouter = require('./customer');
const { requireSubscriber, ADMIN_TOKEN } = require('./auth');
const {
  resolveTenant,
  requireTenant,
  publicUrl,
  BASE_DOMAIN,
  DEFAULT_SLUG,
} = require('./tenant');

const PORT = Number(process.env.PORT) || 3000;

const app = express();

// Behind a reverse proxy, the name the guest actually typed arrives as
// X-Forwarded-Host and their address as X-Forwarded-For. Both matter here:
// one picks the subscriber, the other keys the throttle. Off unless asked for,
// since trusting those headers from an untrusted client is a way to spoof both.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));
}

app.use(express.json({ limit: '16kb' }));
// No max-age: the files are small and served off the same box, and a stale
// index.html on a guest's phone is far more annoying than a revalidation.
app.use(express.static(path.join(__dirname, 'public'), { etag: true }));

// Admin first, and outside tenant resolution: creating the first subscriber
// cannot require already being on a subscriber's hostname.
app.use('/api/admin', adminRouter);

// Customers sign in on the marketing site's hostname, not on a venue's, so
// this sits outside tenant resolution too.
app.use('/api/customer', customerRouter);

// Everything below knows which venue it is serving.
app.use('/api', resolveTenant);

/* ---------------------------------------------------------------- throttle */
// One tab on a lobby QR code is the normal case; this only exists so an open
// endpoint can't burn the API budget. Keyed per subscriber as well as per IP,
// so one busy venue cannot throttle another. In-memory, resets every minute.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map();

/**
 * The generation cap.
 *
 * The per-minute throttle above stops a script; this stops an honest guest
 * regenerating forty times looking for a sentence they like. Each attempt is a
 * model call the business pays for, and a guest who has not settled by the tenth
 * is not going to.
 *
 * An hour, keyed the same way as the throttle. In memory, like the throttle:
 * a restart forgives everyone, which is the right way to fail for a limit whose
 * only job is to bound spending.
 */
const MAX_GENERATIONS = 10;
const GENERATION_WINDOW_MS = 60 * 60_000;
const generations = new Map();

/** @returns {{allowed: boolean, used: number, left: number}} */
function countGeneration(key) {
  const now = Date.now();
  const entry = generations.get(key);

  if (!entry || now > entry.resetAt) {
    generations.set(key, { count: 1, resetAt: now + GENERATION_WINDOW_MS });
    if (generations.size > 5000) generations.clear();
    return { allowed: true, used: 1, left: MAX_GENERATIONS - 1 };
  }

  if (entry.count >= MAX_GENERATIONS) {
    return { allowed: false, used: entry.count, left: 0 };
  }

  entry.count += 1;
  return {
    allowed: true,
    used: entry.count,
    left: MAX_GENERATIONS - entry.count,
  };
}

function throttled(key) {
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

/* ------------------------------------------------------------ guest routes */

app.get('/api/config', requireTenant, (req, res) => {
  const resolved = subscribers.settingsFor(req.subscriber);
  const { googleUrl, tripadvisorUrl, categories, place } = resolved;

  // Only the links that are set, in platform order, each carrying its own mark.
  // Sending the marks here rather than serving platforms.js keeps one copy of
  // them, and an unset platform costs nothing — a Xiaohongshu path is 3.5kB.
  const destinations = PLATFORMS.map((p) => ({
    ...p,
    url: resolved[`${p.id}Url`] || '',
  })).filter((p) => p.url);

  res.json({
    venue: req.subscriber.name,
    place,
    // `focus` is prompt input, not guest-facing — the buttons only need a label.
    categories: categories.map(({ id, label }) => ({ id, label })),
    googleUrl,
    tripadvisorUrl,
    destinations,
    // Sent rather than hardcoded in the page, so the list cannot drift from the
    // one the prompt knows about.
    languages: LANGUAGES.map(({ code, label }) => ({ code, label })),
    // Which account is being served. The panel shows it so staff can tell at a
    // glance that they are editing the right venue.
    subscriber: { slug: req.subscriber.slug, name: req.subscriber.name },
  });
});

app.post('/api/review', requireTenant, async (req, res) => {
  const { apiKey, model, categories } = subscribers.settingsFor(req.subscriber);

  if (!apiKey) {
    return res.status(500).json({
      error: 'No OpenRouter key yet. Add one in Settings.',
    });
  }

  if (throttled(`${req.subscriber.slug}:${req.ip}`)) {
    return res
      .status(429)
      .json({ error: 'That is a lot of reviews. Wait a moment and try again.' });
  }

  // Counted before the model is called, not after: a cap enforced on the way
  // out has already spent the tokens it exists to protect.
  const quota = countGeneration(`${req.subscriber.slug}:${req.ip}`);
  if (!quota.allowed) {
    return res.status(429).json({
      error:
        'You have used the reviews available for now. Edit the one you have — it is yours to change.',
      left: 0,
    });
  }

  const body = req.body || {};
  // A set now, and possibly empty — a business may have no categories, and
  // `categories[0].id` on an empty list threw. Unknown ids are dropped rather
  // than rejected, so a guest whose page predates a category edit still works.
  const asked = Array.isArray(body.categoryIds)
    ? body.categoryIds
    : [body.categoryId];
  const categoryIds = categories
    .filter((c) => asked.includes(c.id))
    .map((c) => c.id);

  // One string for the meter, so the breakdown still groups: a multi-topic
  // review is its own combination rather than a vote for each part.
  const categoryId = categoryIds.join('+') || null;
  const recent = Array.isArray(body.recent)
    ? body.recent
        .filter((r) => typeof r === 'string')
        .slice(-3)
        .map((r) => r.slice(0, 400))
    : [];

  // What this business has actually published lately — not just what this tab
  // generated. Two guests an hour apart otherwise get near-identical reviews
  // from the same six details and the same prompt, and a wall of near-duplicates
  // is exactly the pattern review platforms filter.
  //
  // Sampled across the last hundred rather than taking the newest eight: the
  // newest eight are the ones already most alike, and steering around only those
  // leaves the model free to drift back onto last week's review.
  const published = await events.spread(req.subscriber.id, 8, 100).catch(() => []);

  // Both thumbs. The likes say what this business wants; the dislikes say what it
  // does not, which the likes cannot express. Caught rather than awaited into the
  // happy path only: a review must still be written if either lookup fails.
  const [examples, rejected] = await Promise.all([
    events.liked(req.subscriber.id, 3).catch(() => []),
    events.disliked(req.subscriber.id, 3).catch(() => []),
  ]);

  // An unknown code falls back to English rather than refusing: a guest with a
  // stale page should still get a review.
  const language = languageFor(body.language).code;

  const messages = buildMessages({
    categoryIds,
    // This tab's last, then the business's recent ones. Ordered so the guest's
    // own are nearest the instruction that matters most.
    recent: [...published, ...recent],
    categories,
    language,
    venue: subscribers.venueFor(req.subscriber),
    examples,
    rejected,
  });

  try {
    const upstream = await fetch(openrouter.CHAT, {
      method: 'POST',
      headers: openrouterHeaders(apiKey, req.subscriber),
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
      console.error(
        `OpenRouter ${upstream.status} for ${req.subscriber.slug}: ${detail.slice(0, 500)}`
      );
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

    // Awaited now, unlike before, because the guest needs the row id to rate
    // the review. record() swallows its own failures and returns null, so a
    // meter problem costs the thumbs and not the review — and the write is a
    // single insert over loopback.
    const reviewId = await events.record({
      subscriberId: req.subscriber.id,
      categoryId,
      model,
      usage: data?.usage,
      reviewText: review,
    });

    // `left` alone cannot be shown as a fraction, and "3 left" reads as a
    // warning where "7/10" reads as information.
    res.json({
      review,
      categoryId,
      reviewId,
      left: quota.left,
      max: MAX_GENERATIONS,
    });
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

/**
 * A guest's thumb on the review they were just handed.
 *
 * Open, like the rest of the guest path — a guest has no token to present. The
 * row has to belong to this business, so the worst anyone can do by guessing
 * ids is rate reviews on a page they could already open: noise, not damage. The
 * throttle above covers volume.
 */
app.post('/api/feedback', requireTenant, async (req, res) => {
  const { reviewId, liked } = req.body || {};

  if (!Number.isInteger(reviewId) || typeof liked !== 'boolean') {
    return res.status(400).json({ error: 'Bad request.' });
  }

  if (throttled(`${req.subscriber.slug}:${req.ip}`)) {
    return res
      .status(429)
      .json({ error: 'That is a lot of ratings. Wait a moment.' });
  }

  try {
    const saved = await events.setFeedback({
      subscriberId: req.subscriber.id,
      id: reviewId,
      liked,
    });
    if (!saved) return res.status(404).json({ error: 'No such review.' });
    res.status(204).end();
  } catch (err) {
    console.error('Could not save the rating:', err);
    res.status(500).json({ error: 'Could not save that.' });
  }
});

/* ------------------------------------------------------- subscriber routes */

/* The settings panel. It edits one subscriber's own row, so it needs that
   subscriber's token — the admin token works too. The key is never sent back
   to the browser, only whether one is set and a masked hint. */

app.get('/api/settings', requireTenant, requireSubscriber, (req, res) => {
  res.json(subscribers.describe(req.subscriber));
});

app.post('/api/settings', requireTenant, requireSubscriber, async (req, res) => {
  const patch = req.body || {};

  const verdict = await openrouter.vet(patch);
  if (verdict.error) return res.status(400).json({ error: verdict.error });

  let record;
  try {
    // Only the settings fields — the panel has no business renaming the
    // account or changing its status.
    record = await subscribers.update(req.subscriber.slug, {
      apiKey: patch.apiKey,
      model: patch.model,
      googleUrl: patch.googleUrl,
      tripadvisorUrl: patch.tripadvisorUrl,
      websiteUrl: patch.websiteUrl,
      categories: patch.categories,
      kind: patch.kind,
      place: patch.place,
      safeDetails: patch.safeDetails,
    });
  } catch (err) {
    if (err?.expose && err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Could not save settings:', err);
    return res.status(500).json({ error: 'Could not save the settings.' });
  }

  res.json({ settings: record.settings, warning: verdict.warning });
});

/** Model slugs for the picker, so staff do not have to type one from memory. */
app.get('/api/models', requireTenant, requireSubscriber, async (req, res) => {
  const models = await openrouter.catalogue();
  res.json({ models: models.map(({ id, name }) => ({ id, name })) });
});

/**
 * Seeding. Reads the venue's website via OpenRouter's web_fetch server tool and
 * proposes venue details. Returns a draft only — nothing here writes to config.
 */
app.post('/api/seed', requireTenant, requireSubscriber, async (req, res) => {
  const resolved = websiteSettings(req, res);
  if (!resolved) return;

  const answer = await readWebsite(req.subscriber, resolved, {
    messages: buildSeedMessages({ url: resolved.websiteUrl }),
    maxTokens: 2000,
  });
  if (!answer.ok) return res.status(answer.status).json({ error: answer.error });

  const parsed = parseProposal(answer.content);

  if (!parsed || !parsed.proposal.safeDetails.length) {
    console.error(
      'Seed produced nothing usable:',
      String(answer.content).slice(0, 500)
    );
    return res.status(502).json({
      error:
        'Nothing checkable came back from that page. It may be image-only, or blocked. Try a different page on the site — an About page usually works best.',
    });
  }

  res.json({ ...parsed, url: resolved.websiteUrl, model: resolved.model });
});

/**
 * The category picker, drafted from the venue's website. Same contract as
 * seeding: this proposes, the panel fills the editor with it, and a human
 * decides. Nothing is saved here.
 */
app.post(
  '/api/categories/suggest',
  requireTenant,
  requireSubscriber,
  async (req, res) => {
    const resolved = websiteSettings(req, res);
    if (!resolved) return;

    const answer = await readWebsite(req.subscriber, resolved, {
      messages: buildCategoryMessages({ url: resolved.websiteUrl }),
      maxTokens: 800,
    });
    if (!answer.ok) {
      return res.status(answer.status).json({ error: answer.error });
    }

    const categories = parseCategorySuggestions(answer.content);

    if (!categories) {
      console.error(
        'Category suggestion produced nothing usable:',
        String(answer.content).slice(0, 500)
      );
      return res.status(502).json({
        error:
          'No usable categories came back from that page. Try a different page on the site — one that lists rooms, dining or facilities works best.',
      });
    }

    res.json({ categories, url: resolved.websiteUrl });
  }
);

/* ------------------------------------------------------------------ helpers */

/**
 * Both website readers need the same two things in place first.
 *
 * @returns {object|null} the resolved settings, or null once it has answered
 */
function websiteSettings(req, res) {
  const resolved = subscribers.settingsFor(req.subscriber);

  if (!resolved.apiKey) {
    res.status(500).json({ error: 'No OpenRouter key yet. Add one above.' });
    return null;
  }
  if (!resolved.websiteUrl) {
    res
      .status(400)
      .json({ error: 'Add the venue website address first, then save.' });
    return null;
  }
  return resolved;
}



/** Accepts `true`, a hop count, or an address list — see express's docs. */
function trustProxySetting(raw) {
  const value = String(raw).trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/** A DNS-legal address derived from a venue name, for the legacy import. */
function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'venue'
  );
}

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

/* ------------------------------------------------------------------ errors */

// Reached by anything a route did not answer itself — in practice the store
// being unreachable, since tenant resolution now touches it on every request.
// Without this, express 4 would answer an HTML error page to an API client.
app.use((err, req, res, _next) => {
  if (err?.expose && err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('Request failed:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

/* ------------------------------------------------------------------- start */

/**
 * Carries a single-tenant install forward: if settings.json is still sitting
 * there and the store is empty, it becomes the first subscriber. The token is
 * printed once, because there is no other way to get it afterwards.
 */
async function importLegacy() {
  try {
    return await subscribers.importLegacyFile(slugify(VENUE.name), VENUE.name);
  } catch (err) {
    console.error('  ! Could not import settings.json:', err.message);
    return null;
  }
}

async function start() {
  // Nothing may query before the schema exists, and the first request can
  // arrive the moment we listen.
  await ready;

  app.listen(PORT, async () => {
    const imported = await importLegacy();
    const count = await subscribers.count();

    console.log(
      `\n  Review helper — ${count} subscriber${count === 1 ? '' : 's'}`
    );
    console.log(`  http://localhost:${PORT}  (base domain: ${BASE_DOMAIN})`);

    if (imported) {
      console.log(`\n  Imported settings.json as "${imported.record.slug}".`);
      console.log(`  Settings token (shown once): ${imported.token}`);
      console.log(`  Guest page: ${publicUrl(imported.record.slug)}`);
    }

    if (!count) {
      console.warn('\n  ! No subscribers yet. Create one:');
      console.warn(
        `      curl -X POST http://localhost:${PORT}/api/admin/subscribers \\\n` +
          '        -H "Authorization: Bearer $ADMIN_TOKEN" \\\n' +
          '        -H "Content-Type: application/json" \\\n' +
          '        -d \'{"slug":"my-venue","name":"My Venue"}\''
      );
    } else if (DEFAULT_SLUG) {
      console.log(`  Unmatched hosts fall back to "${DEFAULT_SLUG}".`);
    }

    if (!ADMIN_TOKEN) {
      console.warn('\n  ! ADMIN_TOKEN is not set, so the admin API is off.');
    }

    // One live check, so a stale model slug warns on boot instead of failing
    // in front of a guest.
    for (const record of await subscribers.list()) {
      const row = await subscribers.get(record.slug);
      const { model } = subscribers.settingsFor(row);
      if (await openrouter.modelMissing(model)) {
        console.warn(
          `  ! ${record.slug}: "${model}" is not in OpenRouter's catalogue.`
        );
      }
    }
  });
}

// A store that will not answer is not something to serve around: without it
// every request would 500 anyway, and failing here makes systemd retry.
start().catch((err) => {
  console.error('\n  ! Could not start:', err.message);
  process.exit(1);
});
