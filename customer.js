'use strict';

const express = require('express');

const accounts = require('./accounts');
const subscribers = require('./subscribers');
const events = require('./events');
const referrals = require('./referrals');
const mailer = require('./mailer');
const plans = require('./plans');
const openrouter = require('./openrouter');
const { publicUrl } = require('./tenant');
const { readWebsite } = require('./reader');
const {
  buildTopicMessages,
  buildDescribeMessages,
  parseDescription,
  parseTopics,
  buildThemeMessages,
  parseTheme,
} = require('./seed');
const theme = require('./theme');
const context = require('./context');
const { buildSystemPrompt } = require('./config');
const assets = require('./assets');
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

/* -------------------------------------------------------------- referrals */

/**
 * The sign-up page on the marketing site.
 *
 * Built from BASE_DOMAIN, which is the only thing this app is told about where
 * it lives. Empty on localhost, where BASE_DOMAIN is not a real host and a link
 * to it would be a link to nowhere — and an invitation carrying a dead link is
 * worse than one that was never emailed, so invite() sends nothing at all
 * rather than send that.
 */
function signupUrl() {
  const domain = String(process.env.BASE_DOMAIN || '').trim();
  if (!domain || domain === 'localhost' || domain.endsWith('.localhost')) {
    return '';
  }
  return `https://${domain}/signup`;
}

/**
 * The account's invitations, and how close they are to the discount.
 *
 * `mail.enabled` is here so the page can describe what pressing the button will
 * actually do. Whether this deployment can send is a fact only this side knows,
 * and a page that says "we will email them" on a box with no SES configured is
 * lying to a customer about something they cannot check.
 */
router.get('/referrals', requireAccount, async (req, res, next) => {
  try {
    const data = await referrals.listFor(req.account.id);
    res.json({ ...data, mail: { enabled: mailer.configured && Boolean(signupUrl()) } });
  } catch (err) {
    next(err);
  }
});

/**
 * Invite an address.
 *
 * Sends the invitation when mail is configured, and says in the response
 * whether it went. Unconfigured, this is what it has always been: an invitation
 * and a link for the referrer to pass on by hand. Both are real outcomes and
 * the page shows a different thing for each, because "created" and "delivered"
 * are not the same promise.
 *
 * The recipient is told the business's name, never the account's email. They
 * are a stranger to us — somebody else typed their address in — and handing
 * them a customer's address because of that is not ours to do. An account with
 * no business yet is introduced anonymously instead.
 */
router.post('/referrals', requireAccount, async (req, res, next) => {
  try {
    const owned = await subscribers.listForAccount(req.account.id);

    const referral = await referrals.invite({
      referrerId: req.account.id,
      referrerEmail: req.account.email,
      email: req.body?.email,
      referrer: owned[0]?.name,
      signupUrl: signupUrl(),
    });

    res.status(201).json({ referral, sent: referral.sent });
  } catch (err) {
    next(err);
  }
});

/** Withdraw an invitation nobody has taken up. */
router.delete('/referrals/:id', requireAccount, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Bad request.' });
    }

    await referrals.revoke({ referrerId: req.account.id, id });
    res.status(204).end();
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
        facebookUrl: patch.facebookUrl,
        wongnaiUrl: patch.wongnaiUrl,
        websiteUrl: patch.websiteUrl,
        categories: patch.categories,
        kind: patch.kind,
        place: patch.place,
        theme: patch.theme,
        fontDisplay: patch.fontDisplay,
        fontUi: patch.fontUi,
        background: patch.background,
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

/**
 * The latest reviews, for the list beside the stats.
 *
 * Fifty rather than the twenty it was. Twenty is about a fortnight for a busy
 * venue, and the list is where an owner works through what has been written and
 * rates it — a cap that quietly hides half of what they have is a cap that
 * makes the page look broken rather than paginated, because nothing on it says
 * there is more.
 *
 * `events.recent` holds its own ceiling of a hundred, so this cannot be talked
 * into fetching the whole table by a query string.
 */
const LATEST_REVIEWS = 50;

router.get(
  '/businesses/:slug/reviews',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      // Together, because they answer one question between them: what is on
      // the listing, and what was written and went nowhere.
      const [reviews, notTaken] = await Promise.all([
        events.recent(req.venue.id, LATEST_REVIEWS),
        events.notTaken(req.venue.id),
      ]);

      res.json({ reviews, notTaken });
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
      const { rating } = req.body || {};
      const id = Number(req.params.id);

      // null clears it — the way someone undoes a misclick. Everything else has
      // to be a whole number of stars; a check constraint says the same thing in
      // the database, because this is the value the prompt reads back.
      const stars = rating === null ? null : Number(rating);
      const usable =
        stars === null || (Number.isInteger(stars) && stars >= 1 && stars <= 5);

      if (!usable || !Number.isInteger(id)) {
        return res.status(400).json({ error: 'A rating is one to five stars.' });
      }

      const saved = await events.setFeedback({
        subscriberId: req.venue.id,
        id,
        rating: stars,
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
/**
 * Where the drafting reads from, in order of how much it will get.
 *
 * A great many small businesses have no website at all — they have a Facebook
 * page, and that is their entire public presence. Requiring a website meant the
 * whole dashboard did nothing for them: no description, no topics, no details,
 * no colours, no logo. Falling back to whichever listing they *have* set costs
 * one line and is the difference between the product working for them and not.
 *
 * A real website first, because it is far and away the richest source and the
 * only one guaranteed to be readable. Then Facebook, which is the usual answer
 * to "no website". Then anything else set, in platform order.
 *
 * A social page will often read poorly or not at all — see `sourceHint` — so
 * this returns which one it picked, and the callers say so when nothing usable
 * comes back.
 */
const SOURCE_ORDER = ['websiteUrl', 'facebookUrl', ...PLATFORMS.map((p) => `${p.id}Url`)];

const SOURCE_LABELS = {
  websiteUrl: 'website',
  facebookUrl: 'Facebook page',
  googleUrl: 'Google listing',
  tripadvisorUrl: 'Tripadvisor listing',
  wongnaiUrl: 'Wongnai listing',
};

/**
 * What to tell someone whose read came back empty.
 *
 * Only worth saying for a social page. Facebook serves a login wall to anything
 * that is not a browser with a session, and a fetcher gets that wall rather than
 * the page — so "nothing usable came back" is the expected outcome there, not a
 * surprise, and the customer should hear which of the two it was.
 */
function sourceHint(field) {
  if (field === 'websiteUrl') {
    return 'Try a different page on the site — an About page usually works best.';
  }
  return `That is your ${SOURCE_LABELS[field] ?? 'listing'}, and those often refuse to be read by anything that is not a signed-in browser — Facebook most of all, which shows a sign-in wall rather than the page. If it keeps coming back empty, the topics and their descriptions can be written by hand below, which is the only route that always works.`;
}

function readable(venue, res, { requireSource = true } = {}) {
  const resolved = subscribers.settingsFor(venue);

  if (!resolved.apiKey) {
    res.status(500).json({ error: 'No OpenRouter key is configured.' });
    return null;
  }

  // First address that is set, in the order above. A website is richer than a
  // listing and a listing is better than nothing — but every one of them is a
  // URL handed to the same fetch, so there is no second code path here and no
  // special case for Facebook. A page that answers with a sign-in wall is a
  // page that came back with nothing on it, and the prompt is what handles
  // that.
  const field = SOURCE_ORDER.find((name) => resolved[name]);
  if (!field) {
    // Most readers have nothing to do without a page and say so. The one that
    // writes a single description does have something to do — the ordinary
    // parts of a visit need no website behind them — so it opts out of this.
    if (requireSource) {
      res.status(400).json({
        error:
          'Nothing to read yet. Add a website address — or your Facebook page as the Facebook link — then save.',
      });
      return null;
    }
    return { ...resolved, sourceUrl: '', sourceField: '' };
  }

  // `sourceUrl` is what the readers actually fetch. `websiteUrl` stays what it
  // always was, so nothing else in the app changes meaning.
  return { ...resolved, sourceUrl: resolved[field], sourceField: field };
}

/**
 * One topic's description, written to order.
 *
 * The bulk generator is the right shape for setting a business up and the wrong
 * one for changing your mind about a single button: it replaces all fifty. This
 * writes one, and the dashboard drops it into that row alone.
 *
 * Unlike every other reader here, this one works without a page. A description
 * for "The Welcome" needs no website — the prompt is told to describe what that
 * part of a visit is and claim nothing specific — so refusing for want of an
 * address would block the one case that needs no address at all.
 */
router.post(
  '/businesses/:slug/topics/describe',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      const resolved = readable(req.venue, res, { requireSource: false });
      if (!resolved) return;

      const label = String(req.body?.label ?? '').trim().slice(0, 40);
      if (!label) {
        return res.status(400).json({ error: 'Name the topic first.' });
      }

      // Whatever is already in the box. Capped at the stored limit because it
      // is going into a prompt, not because anything stores it.
      const hint = String(req.body?.hint ?? '')
        .trim()
        .slice(0, settingsRules.MAX_DESCRIPTION);

      const answer = await readWebsite(req.venue, resolved, {
        messages: buildDescribeMessages({
          url: resolved.sourceUrl,
          label,
          hint,
        }),
        maxTokens: 800,
      });
      if (!answer.ok) {
        return res.status(answer.status).json({ error: answer.error });
      }

      const description = parseDescription(answer.content, {
        maxChars: settingsRules.MAX_DESCRIPTION,
      });
      if (!description) {
        console.error(
          'Topic description produced nothing usable:',
          String(answer.content).slice(0, 500)
        );
        return res.status(502).json({
          error: `Nothing usable came back for "${label}". Try again, or put a word or two in the box first to steer it.`,
        });
      }

      res.json({ description });
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

      // Every listing this business has set, whichever one was chosen as the
      // page to read. What its own site says it offers and what its customers
      // actually talk about are different lists, and the second is the one the
      // buttons want to be.
      const listings = PLATFORMS.map((p) => resolved[`${p.id}Url`]).filter(Boolean);

      const answer = await readWebsite(req.venue, resolved, {
        messages: buildTopicMessages({
          url: resolved.sourceUrl,
          listings,
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
        maxChars: settingsRules.MAX_DESCRIPTION,
      });
      if (!categories) {
        console.error(
          'Topic drafting produced nothing usable:',
          String(answer.content).slice(0, 500)
        );
        return res.status(502).json({
          error: `No usable topics came back from that page. ${sourceHint(resolved.sourceField)}`,
        });
      }

      // Sorted before it reaches the editor, so the list the customer is
      // about to save already reads in the order it will be shown in. The cap
      // is applied first, by parseTopics: the model's own ordering decides
      // which fifty survive, and alphabetical decides only how they are shown.
      res.json({
        categories: [...categories].sort(settingsRules.byLabel),
        url: resolved.sourceUrl,
      });
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
        messages: buildThemeMessages({
          url: resolved.sourceUrl,
          displayFonts: theme.DISPLAY_FONTS,
          uiFonts: theme.UI_FONTS,
        }),
        maxTokens: 1200,
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
          error: `No usable colours came back from that page. ${sourceHint(resolved.sourceField)}`,
        });
      }

      // The logo is downloaded here rather than at Save, so that what is put in
      // front of the customer is the image itself and not a promise of one. A
      // failure is reported and the rest of the draft still stands: a palette
      // and a pair of typefaces are worth having without a mark.
      let logoNote = '';
      if (parsed.logoUrl) {
        const image = await assets.fetchImage(parsed.logoUrl);
        if (image.ok) {
          parsed.theme.logo = image.dataUri;
          logoNote = `Found a logo (${Math.round(image.bytes / 1024)}kB ${image.type.replace('image/', '')}).`;
        } else {
          logoNote = `No logo: ${image.error}`;
        }
      } else {
        logoNote = 'No logo found on that page.';
      }

      // The hero photograph, same treatment: downloaded here so that what the
      // customer approves is the image itself, with its own outcome so a failure
      // costs the photo rather than the whole draft.
      let background = null;
      let backgroundNote = 'No background photo found on that page.';

      if (parsed.backgroundUrl) {
        const photo = await assets.fetchImage(parsed.backgroundUrl, {
          maxBytes: assets.MAX_BACKGROUND_BYTES,
        });
        if (photo.ok) {
          background = {
            type: photo.type,
            dataUri: photo.dataUri,
            source: parsed.backgroundUrl.slice(0, 300),
          };
          backgroundNote = `Took a background photo (${Math.round(photo.bytes / 1024)}kB ${photo.type.replace('image/', '')}).`;
        } else {
          backgroundNote = `No background: ${photo.error}`;
        }
      }

      // Checked here rather than left to Save. A palette that cannot be stored
      // should not be put in front of someone as though it can.
      const verdict = theme.validate(parsed.theme);
      if (!verdict.ok) {
        return res.status(502).json({
          error: `The colours that came back are not usable: ${verdict.error}`,
        });
      }

      // The real typefaces, downloaded the same way and reported the same way.
      // Each slot stands alone: a site whose headings are self-hosted and whose
      // body text comes from a foundry CDN should keep the one it may keep.
      const fonts = {};
      const fontNotes = [];

      for (const slot of ['display', 'ui']) {
        const found = parsed.files?.[slot];
        if (!found) {
          fontNotes.push(`No ${slot} font file found — using the closest match.`);
          continue;
        }

        const file = await assets.fetchFont(found.url);
        if (file.ok) {
          fonts[slot] = {
            family: theme.cssName(found.family),
            format: file.format,
            source: found.url.slice(0, 300),
            data: file.data,
          };
          fontNotes.push(`Took ${found.family} (${Math.round(file.bytes / 1024)}kB) for the ${slot}.`);
        } else {
          fontNotes.push(`${found.family} could not be used: ${file.error}`);
        }
      }

      const derived = theme.derive(verdict.theme, fonts, {
        background: Boolean(background),
      });

      res.json({
        theme: verdict.theme,
        sources: parsed.sources,
        derived: derived.vars,
        adjusted: derived.adjusted,
        logoNote,
        background,
        backgroundNote,
        // The scrim only exists when there is a photo behind it, so the preview
        // has to be derived with the same flag the served stylesheet will use.
        // Otherwise the dashboard would show the page without its wash.
        // Sent whole, because Save has to send them back — they are stored
        // fields, not something the dashboard can re-derive.
        fonts: {
          display: fonts.display ?? null,
          ui: fonts.ui ?? null,
        },
        fontNotes,
        url: resolved.sourceUrl,
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
    // The dashboard says whether a photograph is in play, because the scrim only
    // exists when one is — and a preview without it would be a preview of a page
    // nobody gets. It sends the flag rather than the image: this route derives,
    // it does not store, and the bytes are already on the other side.
    const derived = theme.derive(palette, {}, {
      background: Boolean(req.body?.background),
    });

    res.json({ theme: palette, derived: derived.vars, adjusted: derived.adjusted });
  }
);

/**
 * The rulebook: everything the writer is told about this business, as markdown.
 *
 * Temporary, and says so in its own first paragraph. It answers a question the
 * dashboard otherwise cannot — is a bad review the prompt's fault or this
 * business's settings? — and answers it with the real prompt rather than a
 * description of one.
 *
 * The five-star and low-rated samples are read live, because those are what is
 * genuinely in the prompt right now. The realism and avoid samples are not: they
 * are drawn at random per generation, so there is no value to print.
 */
router.get(
  '/businesses/:slug/rulebook',
  requireAccount,
  requireOwnVenue,
  async (req, res, next) => {
    try {
      const resolved = subscribers.settingsFor(req.venue);

      // Caught, not awaited into the happy path: a rulebook without its examples
      // is still worth reading, and this is a debugging view.
      const [examples, rejected] = await Promise.all([
        events.topRated(req.venue.id, 5).catch(() => []),
        events.poorlyRated(req.venue.id, 3).catch(() => []),
      ]);

      const markdown = context.rulebook({
        name: req.venue.name,
        systemPrompt: buildSystemPrompt(subscribers.venueFor(req.venue), {
          platformIds: PLATFORMS.map((p) => p.id).filter(
            (id) => resolved[`${id}Url`]
          ),
        }),
        topics: resolved.categories,
        examples,
        rejected,
        generatedAt: new Date().toISOString().slice(0, 10),
      });

      res.type('text/markdown').send(markdown);
    } catch (err) {
      next(err);
    }
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
