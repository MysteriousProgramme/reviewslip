'use strict';

const express = require('express');

const accounts = require('./accounts');
const subscribers = require('./subscribers');
const events = require('./events');
const plans = require('./plans');
const openrouter = require('./openrouter');
const { publicUrl } = require('./tenant');
const { readWebsite } = require('./reader');
const {
  buildSeedMessages,
  parseProposal,
  buildTopicMessages,
  parseTopics,
  buildContextMessages,
  parseContextDoc,
  buildThemeMessages,
  parseTheme,
} = require('./seed');
const theme = require('./theme');
const settingsRules = require('./settings');
const { PLATFORMS } = require('./platforms');

/**
 * The customer API: sign up, sign in, and manage your own businesses.
 *
 * Mounted outside tenant resolution, like the admin API — a customer signs in
 * on the marketing site's hostname, not on any one venue's subdomain.
 *
 * The website calls this server-to-server over loopback and forwards the
 * session token it holds in the browser's cookie. It never tells us who the
 * caller is; the token does, and `requireAccount` checks it here.
 */

const router = express.Router();

/* -------------------------------------------------------------- middleware */

function bearer(req) {
  const header = String(req.get('authorization') || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

async function requireAccount(req, res, next) {
  try {
    const row = await accounts.fromSession(bearer(req));
    if (!row) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Sign in first.' });
    }
    req.account = row;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Loads the venue named in the path *and* checks it belongs to the caller.
 *
 * A venue that exists but belongs to someone else answers 404, not 403 — a 403
 * would confirm the slug is taken, which is not this customer's business.
 */
async function requireOwnVenue(req, res, next) {
  try {
    const row = await subscribers.get(req.params.slug);
    if (!row || row.account_id !== req.account.id) {
      return res.status(404).json({ error: 'No business at that address.' });
    }
    req.venue = row;
    next();
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ shapes */

/** A venue as the venue list wants it: identity, address, and this month. */
function venueSummary(row, usage, plan) {
  return {
    slug: row.slug,
    name: row.name,
    status: row.status,
    url: publicUrl(row.slug),
    createdAt: row.created_at,
    usage: {
      reviews: usage?.reviews ?? 0,
      tokens: usage?.tokens ?? 0,
      tokenLimit: plans.TOKENS_PER_MONTH_PER_VENUE,
    },
    ready: Boolean(row.google_url) || Boolean(process.env.GOOGLE_REVIEW_URL),
    plan,
  };
}

/* ------------------------------------------------------------------- auth */

router.post('/signup', async (req, res, next) => {
  try {
    const body = req.body || {};
    const account = await accounts.create(body);

    // Straight in. Making someone sign in again immediately after proving they
    // know the password is friction with nothing behind it.
    const session = await accounts.login(account.email, body.password);
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { identifier, email, username, password } = req.body || {};
    const session = await accounts.login(
      identifier || email || username,
      password
    );
    res.json(session);
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await accounts.endSession(bearer(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- the account */

/** Everything the dashboard's landing page needs, in one call. */
router.get('/me', requireAccount, async (req, res, next) => {
  try {
    const rows = await subscribers.listForAccount(req.account.id);
    const usage = await events.usageThisMonthFor(rows.map((r) => r.id));
    const plan = plans.planFor(req.account.plan);

    const reviewsThisMonth = rows.reduce(
      (total, row) => total + (usage.get(row.id)?.reviews ?? 0),
      0
    );

    const list = rows.map((row) =>
      venueSummary(row, usage.get(row.id), req.account.plan)
    );

    res.json({
      account: accounts.toRecord(req.account),
      plan: {
        id: req.account.plan,
        name: plan.name,
        businesses: plan.venues,
        // The advertised total, for the header, and the limit each business is
        // actually held to. They are different numbers and the dashboard needs
        // both.
        reviewAllowance: plans.advertisedReviews(req.account.plan),
        reviewsPerBusiness: plans.REVIEWS_PER_BUSINESS,
        tokensPerMonthPerBusiness: plans.TOKENS_PER_MONTH_PER_VENUE,
      },
      usage: { reviewsThisMonth, businesses: rows.length },
      canAddBusiness: plans.canAddVenue(req.account.plan, rows.length),
      businesses: list,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/password', requireAccount, async (req, res, next) => {
  try {
    const { currentPassword, password } = req.body || {};

    const ok = await accounts.verifyPassword(
      currentPassword,
      req.account.password_hash
    );
    if (!ok) return res.status(403).json({ error: 'That is not your current password.' });

    await accounts.setPassword(req.account.id, password);
    // setPassword drops every session, this one included, so the caller has to
    // sign in again — which is the point.
    res.json({ ok: true, signedOut: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Choosing a plan. There is no payment step yet, so this is exactly what it
 * looks like: the account says which tier it is on and the limits follow.
 * Stripe slots in ahead of this call, not inside it.
 */
router.post('/plan', requireAccount, async (req, res, next) => {
  try {
    const account = await accounts.setPlan(req.account.id, req.body?.plan);
    res.json({ account });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------- businesses */

/**
 * Is this address free?
 *
 * Behind sign-in on purpose. Availability is exactly the kind of thing a
 * scraper would walk to enumerate every venue on the platform, and a customer
 * choosing an address is the only person who needs to ask.
 */
router.get('/slug/:slug', requireAccount, async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();

    const check = subscribers.checkSlug(slug);
    if (!check.ok) {
      return res.json({
        slug,
        valid: false,
        available: false,
        reason: check.error,
      });
    }

    const taken = await subscribers.get(slug);

    res.json({
      slug,
      valid: true,
      available: !taken,
      url: publicUrl(slug),
      reason: taken ? 'That address is already taken.' : undefined,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/businesses', requireAccount, async (req, res, next) => {
  try {
    const owned = await subscribers.countForAccount(req.account.id);
    if (!plans.canAddVenue(req.account.plan, owned)) {
      const plan = plans.planFor(req.account.plan);
      return res.status(403).json({
        error: `${plan.name} covers ${plan.venues} business${plan.venues === 1 ? '' : 'es'}. Change plan to add another.`,
      });
    }

    const verdict = await openrouter.vet(req.body || {});
    if (verdict.error) return res.status(400).json({ error: verdict.error });

    const { record } = await subscribers.create({
      ...(req.body || {}),
      accountId: req.account.id,
    });

    res.status(201).json({
      business: { ...record, url: publicUrl(record.slug) },
      warning: verdict.warning,
    });
  } catch (err) {
    next(err);
  }
});

/** One business: its settings, and the numbers behind the dashboard. */
router.get(
  '/businesses/:slug',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      const [month, all, daily, byCategory] = await Promise.all([
        events.usageThisMonth(req.venue.id),
        events.lifetime(req.venue.id),
        events.daily(req.venue.id, 30),
        events.byCategory(req.venue.id),
      ]);

      const identity = {
        slug: req.venue.slug,
        name: req.venue.name,
        status: req.venue.status,
        url: publicUrl(req.venue.slug),
        createdAt: req.venue.created_at,
      };

      res.json({
        business: identity,
        settings: subscribers.describe(req.venue),
        stats: {
          month: {
            reviews: month.reviews,
            tokens: month.tokens,
            tokenLimit: plans.TOKENS_PER_MONTH_PER_VENUE,
          },
          lifetime: {
            reviews: all.reviews,
            tokens: all.tokens,
            lastAt: all.last_at,
          },
          daily,
          byCategory,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Venue settings. The same fields the gear icon used to edit, minus the parts
 * that were never the venue's to change — its address and its plan.
 */
router.patch(
  '/businesses/:slug',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      const patch = req.body || {};

      const verdict = await openrouter.vet(patch);
      if (verdict.error) return res.status(400).json({ error: verdict.error });

      // apiKey and model are deliberately not here. The platform key and the
      // fixed model are ours; a customer changing either is not a setting, it
      // is a support ticket. Sending them is ignored rather than rejected —
      // there is nothing for the customer to correct.
      const record = await subscribers.update(req.venue.slug, {
        name: patch.name,
        status: patch.status,
        googleUrl: patch.googleUrl,
        tripadvisorUrl: patch.tripadvisorUrl,
        lineUrl: patch.lineUrl,
        facebookUrl: patch.facebookUrl,
        xiaohongshuUrl: patch.xiaohongshuUrl,
        wongnaiUrl: patch.wongnaiUrl,
        websiteUrl: patch.websiteUrl,
        categories: patch.categories,
        kind: patch.kind,
        place: patch.place,
        safeDetails: patch.safeDetails,
        contextDoc: patch.contextDoc,
        theme: patch.theme,
      });

      res.json({ business: record, warning: verdict.warning });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Deleting a venue.
 *
 * review_events cascades with the row, so this destroys that venue's entire
 * history along with it — and the address becomes free for someone else to
 * claim, which means any QR code already printed for it could later point at a
 * different business. The website asks for the slug to be typed before calling
 * this; nothing here can undo it.
 */
router.delete(
  '/businesses/:slug',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      await subscribers.remove(req.venue.slug);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

/** The latest reviews, for the list beside the stats. */
router.get(
  '/businesses/:slug/reviews',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      res.json({ reviews: await events.recent(req.venue.id, 20) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Rating one.
 *
 * This is the owner's judgement rather than a guest's, and it is what decides
 * which reviews come back as approved samples in the prompt. Re-rating
 * overwrites, and the row has to belong to this business.
 */
router.post(
  '/businesses/:slug/reviews/:id/feedback',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      const { liked } = req.body || {};
      const id = Number(req.params.id);

      if (typeof liked !== 'boolean' || !Number.isInteger(id)) {
        return res.status(400).json({ error: 'Bad request.' });
      }

      const saved = await events.setFeedback({
        subscriberId: req.venue.id,
        id,
        liked,
      });
      if (!saved) return res.status(404).json({ error: 'No such review.' });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Reading a business's own website and proposing what a review may draw on.
 *
 * These two moved here from the guest page's settings panel, which no longer
 * exists. Both return a draft and write nothing: the whole no-fabrication
 * guarantee rests on a human reading the details before they reach a prompt.
 */
function readable(venue, res) {
  const resolved = subscribers.settingsFor(venue);

  if (!resolved.apiKey) {
    res.status(500).json({ error: 'No OpenRouter key is configured.' });
    return null;
  }
  if (!resolved.websiteUrl) {
    res
      .status(400)
      .json({ error: 'Add the business website address first, then save.' });
    return null;
  }
  return resolved;
}

router.post(
  '/businesses/:slug/seed',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      const resolved = readable(req.venue, res);
      if (!resolved) return;

      const answer = await readWebsite(req.venue, resolved, {
        messages: buildSeedMessages({ url: resolved.websiteUrl }),
        maxTokens: 2000,
      });
      if (!answer.ok) {
        return res.status(answer.status).json({ error: answer.error });
      }

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

      res.json({ ...parsed, url: resolved.websiteUrl });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * The topic set, drafted from the website.
 *
 * A draft, like the others: it fills the editor and Save stores it. Thirty
 * {label, focus} pairs need considerably more room than the five this replaced,
 * hence the token ceiling.
 */
router.post(
  '/businesses/:slug/topics/suggest',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      const resolved = readable(req.venue, res);
      if (!resolved) return;

      const answer = await readWebsite(req.venue, resolved, {
        messages: buildTopicMessages({
          url: resolved.websiteUrl,
          max: settingsRules.MAX_TOPICS,
        }),
        maxTokens: 3000,
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
            'No usable topics came back from that page. Try one that says what the business offers.',
        });
      }

      res.json({ categories, url: resolved.websiteUrl });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * The business's own AI context document, drafted from what it publishes.
 *
 * Reads the review listings alongside the website, because how this business's
 * real customers already write is the single most useful thing on the subject —
 * and it is the one input the website cannot give. Whether any of those pages
 * actually yields reviews to a server-side fetch varies by platform; the prompt
 * is told that seeing none is a normal outcome and to say nothing rather than
 * describe reviews it has not read.
 *
 * A draft, again. The customer reads it in a textarea and Save stores it — which
 * matters more here than anywhere else in this file, because this is free prose
 * with no source quote behind any sentence.
 */
router.post(
  '/businesses/:slug/context/draft',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      const resolved = readable(req.venue, res);
      if (!resolved) return;

      const listings = PLATFORMS.map((p) => resolved[`${p.id}Url`]).filter(
        Boolean
      );

      const answer = await readWebsite(req.venue, resolved, {
        messages: buildContextMessages({
          url: resolved.websiteUrl,
          listings,
        }),
        maxTokens: 1500,
      });
      if (!answer.ok) {
        return res.status(answer.status).json({ error: answer.error });
      }

      const parsed = parseContextDoc(answer.content, {
        maxChars: settingsRules.MAX_CONTEXT_DOC,
      });
      if (!parsed) {
        console.error(
          'Context drafting produced nothing usable:',
          String(answer.content).slice(0, 500)
        );
        return res.status(502).json({
          error:
            'Nothing usable came back from that page. An About page usually works best.',
        });
      }

      res.json({ ...parsed, url: resolved.websiteUrl, read: listings.length + 1 });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * The theme, drafted from the business's own website.
 *
 * A draft like the rest: it fills the swatches and Save stores it. What comes
 * back is the four colours the model read, what they derive to once the contrast
 * checks have run, and which of them the checks had to move — so the customer is
 * looking at the palette the guest will actually see rather than the one their
 * brand guide specifies.
 */
router.post(
  '/businesses/:slug/theme/draft',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      const resolved = readable(req.venue, res);
      if (!resolved) return;

      const answer = await readWebsite(req.venue, resolved, {
        messages: buildThemeMessages({ url: resolved.websiteUrl }),
        maxTokens: 800,
      });
      if (!answer.ok) {
        return res.status(answer.status).json({ error: answer.error });
      }

      const parsed = parseTheme(answer.content);
      if (!parsed) {
        console.error(
          'Theme drafting produced nothing usable:',
          String(answer.content).slice(0, 500)
        );
        return res.status(502).json({
          error:
            'No usable colours came back from that page. Try the site\'s front page.',
        });
      }

      // Checked here rather than left to Save. A palette that cannot be stored
      // should not be put in front of someone as though it can.
      const verdict = theme.validate(parsed.theme);
      if (!verdict.ok) {
        return res.status(502).json({
          error: `The colours that came back are not usable: ${verdict.error}`,
        });
      }

      const derived = theme.derive(verdict.theme);

      res.json({
        theme: verdict.theme,
        sources: parsed.sources,
        derived: derived.vars,
        adjusted: derived.adjusted,
        url: resolved.websiteUrl,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * What a set of colours would actually look like, without storing them.
 *
 * The dashboard needs this because the four colours a customer types are not the
 * palette they get — the contrast checks may move some of them. Deriving in the
 * browser to draw the preview would mean a second copy of theme.js in TypeScript,
 * and two implementations of a rule about readability is how a page ends up
 * promising one thing and serving another. No model call, so it is cheap enough
 * to ask on every change.
 */
router.post(
  '/businesses/:slug/theme/preview',
  requireAccount,
  requireOwnVenue,
  (req, res) => {
    const verdict = theme.validate(req.body?.theme);
    if (!verdict.ok) return res.status(400).json({ error: verdict.error });

    // A cleared theme previews as the shipped palette, which is what clearing it
    // gets you.
    const palette = verdict.theme || theme.DEFAULT_THEME;
    const derived = theme.derive(palette);

    res.json({ theme: palette, derived: derived.vars, adjusted: derived.adjusted });
  }
);

/* --------------------------------------------------- website drafting tools */

router.get(
  '/businesses/:slug/models',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      const models = await openrouter.catalogue();
      res.json({ models: models.map(({ id, name }) => ({ id, name })) });
    } catch (err) {
      next(err);
    }
  }
);

/* ------------------------------------------------------------------ errors */

router.use((err, req, res, _next) => {
  if (err?.expose && err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('Customer API error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

module.exports = router;
