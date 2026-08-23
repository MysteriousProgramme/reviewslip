'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

const {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  LENGTH_CHOICES,
  languageFor,
  lengthFor,
  buildMessages,
} = require('./config');
const {
  buildTopicMessages,
  parseTopics,
} = require('./seed');
const settingsRules = require('./settings');
const strings = require('./strings');
const translate = require('./translate');
const { createQuota, MAX_REGENERATIONS } = require('./quota');
const theme = require('./theme');
const { ready } = require('./db');
const subscribers = require('./subscribers');
const events = require('./events');
const openrouter = require('./openrouter');
const { readWebsite, openrouterHeaders } = require('./reader');
const { PLATFORMS } = require('./platforms');
const adminRouter = require('./admin');
const customerRouter = require('./customer');
const { requireSubscriber, ADMIN_TOKEN } = require('./auth');

// One counter for the process, keyed by business and address inside.
const quota = createQuota();
const {
  resolveTenant,
  requireTenant,
  publicUrl,
  BASE_DOMAIN,
  DEFAULT_SLUG,
} = require('./tenant');

const PORT = Number(process.env.PORT) || 3000;

/** What a single-tenant install's imported settings.json becomes, once. */
const LEGACY_NAME = 'Imported venue';

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
/**
 * Every guest-facing string, in every language, as one script.
 *
 * Before express.static and outside tenant resolution: it is the same table for
 * every business, and the page needs it to render its own furniture — including
 * the error it shows when the address belongs to no business at all.
 *
 * Cached hard. The body is built once at boot and cannot change without a
 * deploy, and the URL is versioned by that build, so a long max-age costs a
 * guest nothing and saves the second page load a round trip.
 */
app.get('/i18n.js', (req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(strings.SCRIPT);
});

app.use(express.static(path.join(__dirname, 'public'), { etag: true }));

// Admin first, and outside tenant resolution: creating the first subscriber
// cannot require already being on a subscriber's hostname.
app.use('/api/admin', adminRouter);

// Customers sign in on the marketing site's hostname, not on a venue's, so
// this sits outside tenant resolution too.
app.use('/api/customer', customerRouter);

/**
 * The venue's palette, as a stylesheet.
 *
 * Served rather than applied from JavaScript after /api/config lands: the guest
 * would otherwise watch the shipped colours for as long as that request takes,
 * outdoors, on a phone. A <link> blocks the first paint instead, which is the
 * one thing that should block it.
 *
 * Outside the /api tenant middleware because it is not an API route, so it
 * resolves the tenant itself. A venue with no theme gets an empty file — the
 * stylesheet's own defaults then stand, untouched and byte-identical to what
 * shipped, rather than being reconstructed by arithmetic that would land close
 * but not exact.
 */
app.get('/theme.css', resolveTenant, (req, res) => {
  res.type('css');
  // Private: this is per-hostname, and a shared cache keyed on the path alone
  // would hand one venue's colours to another. Short, so a save shows up on a
  // refresh rather than at some unpredictable later point.
  res.set('Cache-Control', 'private, max-age=60');

  if (!req.subscriber) return res.send('');

  const resolved = subscribers.settingsFor(req.subscriber);
  res.send(
    theme.css(
      resolved.theme,
      { display: resolved.fontDisplay, ui: resolved.fontUi },
      { background: Boolean(resolved.background) }
    )
  );
});

/**
 * The venue's typefaces.
 *
 * A redirect rather than a stylesheet of our own. The page needs one <link> in
 * static HTML that resolves to a different Google Fonts URL per venue, and a
 * 302 with no body is the cheapest way to do that — a CSS file containing an
 * @import would serialise an extra download in front of the font files
 * themselves. The preconnects in index.html mean the connection to Google is
 * already warm by the time this answers.
 *
 * The URL is built only from the `spec` strings in theme.js. Nothing that
 * arrived over the wire reaches it — a font is chosen by id from a fixed list,
 * precisely so that this cannot become a redirect to somewhere else.
 */
app.get('/fonts.css', resolveTenant, (req, res) => {
  const resolved = req.subscriber
    ? subscribers.settingsFor(req.subscriber)
    : {};

  const answer = theme.fontsCss(resolved.theme, {
    display: resolved.fontDisplay,
    ui: resolved.fontUi,
  });

  res.set('Cache-Control', 'private, max-age=300');
  if (answer.redirect) return res.redirect(302, answer.redirect);

  res.type('css');
  res.send(answer.css);
});

/**
 * One of the two typefaces taken off the business's own site.
 *
 * Served from here rather than inlined into /fonts.css as a data URI: a woff2 is
 * a couple of hundred kilobytes, and as base64 inside a stylesheet it would be
 * re-downloaded with every change to a colour. As its own URL the browser caches
 * the file and re-fetches only the rules.
 */
app.get('/font/:slot', resolveTenant, (req, res) => {
  const slot = req.params.slot === 'display' ? 'fontDisplay' : req.params.slot === 'ui' ? 'fontUi' : null;
  if (!slot || !req.subscriber) return res.status(404).end();

  const font = subscribers.settingsFor(req.subscriber)[slot];
  if (!font) return res.status(404).end();

  const TYPES = {
    woff2: 'font/woff2',
    woff: 'font/woff',
    truetype: 'font/ttf',
    opentype: 'font/otf',
    'embedded-opentype': 'application/vnd.ms-fontobject',
  };

  res.type(TYPES[font.format] || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=3600');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(font.data, 'base64'));
});

/**
 * The venue's logo.
 *
 * Its own route rather than a field on /api/config: a logo is up to 120kB, and
 * as base64 inside a JSON body it would be re-sent on every generation and
 * cached by nothing. Here it is bytes with an ETag, fetched once by the phone
 * and then not again.
 */
app.get('/logo', resolveTenant, (req, res) => {
  const stored = req.subscriber
    ? subscribers.settingsFor(req.subscriber).theme?.logo
    : null;

  if (!stored) return res.status(404).end();

  const [, type, base64] = /^data:([^;]+);base64,(.+)$/.exec(stored) || [];
  if (!type || !base64) return res.status(404).end();

  const body = Buffer.from(base64, 'base64');

  res.type(type);
  // Immutable it is not — a venue can change its logo — but a minute is enough
  // to stop a reload re-fetching it, and short enough that a change shows up
  // while someone is still looking at the page they changed it on.
  res.set('Cache-Control', 'private, max-age=60');
  // Belt and braces around the SVG case: served as an image, never as a
  // document, and with nothing else allowed to load from inside it.
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(body);
});

/**
 * The venue's hero photograph, taken off its own site.
 *
 * Its own route for the same reason the logo and the fonts have one: half a
 * megabyte inlined into a stylesheet would be re-downloaded every time a colour
 * changed. Cached for an hour, since a photo changes far less often than a
 * palette being adjusted in the dashboard.
 */
app.get('/background', resolveTenant, (req, res) => {
  const stored = req.subscriber
    ? subscribers.settingsFor(req.subscriber).background
    : null;

  if (!stored) return res.status(404).end();

  const [, type, base64] = /^data:([^;]+);base64,(.+)$/.exec(stored.dataUri) || [];
  if (!type || !base64) return res.status(404).end();

  res.type(type);
  res.set('Cache-Control', 'private, max-age=3600');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(base64, 'base64'));
});

// Everything below knows which venue it is serving.
app.use('/api', resolveTenant);

/* ---------------------------------------------------------------- throttle */
// One tab on a lobby QR code is the normal case; this only exists so an open
// endpoint can't burn the API budget. Keyed per subscriber as well as per IP,
// so one busy venue cannot throttle another. In-memory, resets every minute.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map();

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
    // Whether to draw the mark, not the mark itself — it is served from /logo,
    // where it can be cached instead of riding along with every config load.
    hasLogo: Boolean(resolved.theme?.logo),
    // Every topic, not the ten the guest first sees. The page samples ten and
    // keeps the rest behind its browse button, so sampling server-side would
    // cost a second request to show what is already in hand — and the sample
    // has to be redrawn on the page anyway when the guest browses.
    //
    // `focus` is prompt input, not guest-facing — the buttons only need a label.
    categories: categories.map(({ id, label }) => ({ id, label })),
    googleUrl,
    tripadvisorUrl,
    destinations,
    // Sent rather than hardcoded in the page, so neither list can drift from the
    // one the prompt knows about.
    languages: LANGUAGES.map(({ code, label }) => ({ code, label })),
    lengths: LENGTH_CHOICES,
    // Which account is being served. The panel shows it so staff can tell at a
    // glance that they are editing the right venue.
    subscriber: { slug: req.subscriber.slug, name: req.subscriber.name },
  });
});

/* --------------------------------------------------- translated topic names */

// One translation in flight per business and language, however many guests ask
// at once. Ten people picking Thai in the same minute is one model call, not
// ten — and the nine who arrived second wait on the same promise rather than
// each starting their own.
const translating = new Map();

/**
 * The topic names, in the language the guest picked.
 *
 * Its own route rather than a parameter on /api/config, because the page needs
 * it at a different moment: config is fetched once on load, and this is asked
 * for again every time the selector moves.
 *
 * Never fails in a way the page has to handle. A model that is unreachable, a
 * language nobody has words for, a business with no key — all of them answer
 * with the topics as they were written. Untranslated buttons are a poor
 * outcome; no buttons is a broken page.
 */
app.get('/api/topics', requireTenant, async (req, res) => {
  const resolved = subscribers.settingsFor(req.subscriber);
  const topics = resolved.categories.map(({ id, label }) => ({ id, label }));

  const language = languageFor(String(req.query.lang || '')).code;
  const plain = () => res.json({ language, categories: topics });

  // English is what these were written in often enough that it is worth not
  // asking, and a business with no topics has nothing to translate.
  if (language === DEFAULT_LANGUAGE || !topics.length) return plain();

  const stored = subscribers.topicLabels(req.subscriber);
  const table = stored[language] || {};
  const gaps = translate.missing(table, topics);

  if (!gaps.length) {
    return res.json({ language, categories: translate.apply(table, topics) });
  }

  const { apiKey, model } = resolved;
  if (!apiKey) return plain();

  const key = `${req.subscriber.slug}:${language}`;
  let job = translating.get(key);

  if (!job) {
    job = (async () => {
      const upstream = await fetch(openrouter.CHAT, {
        method: 'POST',
        headers: openrouterHeaders(apiKey, req.subscriber),
        body: JSON.stringify({
          model,
          messages: translate.buildLabelMessages({ language, topics: gaps }),
          // Short answers by construction: fifty ids and fifty short names.
          max_tokens: 2000,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!upstream.ok) {
        throw new Error(`OpenRouter ${upstream.status}`);
      }

      const data = await upstream.json();
      const fresh = translate.parseLabels(data?.choices?.[0]?.message?.content);
      const merged = translate.merge(table, fresh, topics);

      await subscribers.saveTopicLabels(req.subscriber.slug, language, merged);
      return merged;
    })().finally(() => translating.delete(key));

    translating.set(key, job);
  }

  try {
    const merged = await job;
    res.json({ language, categories: translate.apply(merged, topics) });
  } catch (err) {
    console.error(`Topic translation failed for ${key}:`, err.message);
    plain();
  }
});

app.post('/api/review', requireTenant, async (req, res) => {
  const resolved = subscribers.settingsFor(req.subscriber);
  const { apiKey, model, categories } = resolved;

  // Which language to fail in. The page sends what the guest picked; the header
  // covers a request that arrives before it has picked anything. Read up here
  // rather than beside the first error, because every error below wants it and
  // one of them fires before the body is otherwise touched.
  const lang = languageFor(
    req.body?.language || strings.fromHeader(req.get('accept-language'))
  ).code;

  if (!apiKey) {
    return res.status(500).json({ error: strings.t(lang, 'noKey') });
  }

  if (throttled(`${req.subscriber.slug}:${req.ip}`)) {
    return res.status(429).json({ error: strings.t(lang, 'tooFast') });
  }

  // Counted before the model is called, not after: a cap enforced on the way
  // out has already spent the tokens it exists to protect.
  const spend = quota.count(`${req.subscriber.slug}:${req.ip}`);
  if (!spend.allowed) {
    return res.status(429).json({
      error: strings.t(lang, 'outOfTries'),
      left: 0,
      max: MAX_REGENERATIONS,
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
  // Sampled across the last hundred rather than taking the newest twelve: the
  // newest twelve are the ones already most alike, and steering around only
  // those leaves the model free to drift back onto last week's review.
  const published = await events
    .spread(req.subscriber.id, 12, 100)
    .catch(() => []);

  // Both thumbs. The likes say what this business wants; the dislikes say what it
  // does not, which the likes cannot express. Caught rather than awaited into the
  // happy path only: a review must still be written if either lookup fails.
  const [examples, rejected] = await Promise.all([
    events.topRated(req.subscriber.id, 5).catch(() => []),
    events.poorlyRated(req.subscriber.id, 3).catch(() => []),
  ]);

  // The one sample is split rather than drawn twice, because the two halves are
  // asked contradictory-looking things — match how these read, and be clearly
  // different from these — and the same review appearing in both would be an
  // instruction to differ from itself. A slice of one random sample is disjoint
  // by construction; two random samples would overlap.
  //
  // The realism half exists because a listing's own reviews are the only honest
  // answer to "what does a real review of this place look like". It is skipped
  // once the owner has approved anything: an approved review is a better example
  // than an unrated one, and `examples` below already carries those.
  const realism = examples.length ? [] : published.slice(0, 4);
  const avoid = examples.length ? published : published.slice(4);

  // An unknown code falls back to English rather than refusing: a guest with a
  // stale page should still get a review.
  const language = languageFor(body.language).code;
  const length = lengthFor(body.length);

  const messages = buildMessages({
    categoryIds,
    // This tab's last, then the business's recent ones. Ordered so the guest's
    // own are nearest the instruction that matters most.
    recent: [...avoid, ...recent],
    categories,
    language,
    length,
    venue: subscribers.venueFor(req.subscriber),
    examples,
    realism,
    rejected,
    // Which listing the review is bound for, when the business has only one and
    // so there is no doubt. A Google review and a Xiaohongshu post are different
    // genres; see context.js.
    platformIds: PLATFORMS.map((p) => p.id).filter((id) => resolved[`${id}Url`]),
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
      return res.status(502).json({ error: strings.t(lang, 'writerDown') });
    }

    const data = await upstream.json();
    const review = clean(data?.choices?.[0]?.message?.content);

    if (!review) {
      console.error('Empty completion:', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: strings.t(lang, 'writerEmpty') });
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
      // Kept so the dashboard can say what the writer was working from when it
      // produced this one, which is most of what makes a rating actionable.
      language,
      length,
    });

    // `left` alone cannot be shown as a fraction, and "3 left" reads as a
    // warning where "7/10" reads as information.
    res.json({
      review,
      categoryId,
      reviewId,
      left: spend.left,
      max: MAX_REGENERATIONS,
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
  const { reviewId, rating } = req.body || {};
  const stars = rating === null ? null : Number(rating);

  if (
    !Number.isInteger(reviewId) ||
    (stars !== null && !(Number.isInteger(stars) && stars >= 1 && stars <= 5))
  ) {
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
      rating: stars,
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
 * The topic set, drafted from the venue's website. Same contract as seeding:
 * this proposes, the caller fills its editor with it, and a human decides.
 * Nothing is saved here.
 *
 * The path still says `categories` because that is what the field and the column
 * are called; the dashboard and the guest page say topics, which is the word a
 * customer uses for them.
 */
app.post(
  '/api/categories/suggest',
  requireTenant,
  requireSubscriber,
  async (req, res) => {
    const resolved = websiteSettings(req, res);
    if (!resolved) return;

    const answer = await readWebsite(req.subscriber, resolved, {
      messages: buildTopicMessages({
        url: resolved.websiteUrl,
        max: settingsRules.MAX_TOPICS,
      }),
      // Fifty topics with a focus line each is a long answer; 3000 truncated
      // it and the JSON came back unparseable.
      maxTokens: 6000,
    });
    if (!answer.ok) {
      return res.status(answer.status).json({ error: answer.error });
    }

    const categories = parseTopics(answer.content, {
      max: settingsRules.MAX_TOPICS,
    });

    if (!categories) {
      console.error(
        'Topic drafting produced nothing usable:',
        String(answer.content).slice(0, 500)
      );
      return res.status(502).json({
        error:
          'No usable topics came back from that page. Try a different page on the site — one that says what the business offers works best.',
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
    // The name used to come from the built-in venue in config.js, which was the
    // first customer. That is now a blank shape rather than a place, so there is
    // nothing there to name a subscriber after — and settings.json never carried
    // a name either. An operator renames it in the dashboard; the slug is what
    // has to be stable, and this only ever runs once.
    return await subscribers.importLegacyFile(slugify(LEGACY_NAME), LEGACY_NAME);
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
