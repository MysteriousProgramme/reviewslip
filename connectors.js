'use strict';

const inbound = require('./inbound');

/**
 * Where reviews are fetched from, and what is needed before each can be.
 *
 * One shape for every source, so the screen can list them and say honestly
 * which ones are switched on. The difference between the connectors is not
 * code — it is paperwork, and the paperwork is the part that takes weeks:
 *
 *   Google needs the Business Profile API, which is allow-listed per project
 *   rather than simply enabled. You apply, Google reads the application, and
 *   it takes as long as it takes. Then an owner of the listing has to sign in
 *   and grant access; a venue cannot read its own reviews through somebody
 *   else's consent.
 *
 *   Tripadvisor's Content API is a partner agreement, and the review endpoints
 *   are not in the free tier.
 *
 *   Facebook needs a Page access token with pages_read_engagement, which means
 *   an app review of its own.
 *
 * So each connector says whether it is ready and, when it is not, what is
 * missing — in words an owner can act on. A "Connect" button that fails with
 * nothing to do next is worse than a line explaining the wait.
 *
 * `paste` is not a stopgap. Somebody who exports their reviews and pastes them
 * in gets the same de-duplication, the same thirty-day window and the same
 * reply tracking as an API would give, because all of that lives in inbound.js
 * on the near side of the connector.
 */

/** @typedef {{ok: boolean, missing?: string}} Ready */

const CONNECTORS = [
  {
    id: 'paste',
    platform: null,
    label: 'Paste or upload',
    /** Always. It needs nothing but somebody with the reviews in front of them. */
    ready: () => ({ ok: true }),
    fetch: null,
  },

  {
    id: 'google',
    platform: 'google',
    label: 'Google Business Profile',
    ready: (settings) => {
      if (!settings?.googleUrl) {
        return { ok: false, missing: 'a Google review link in Settings' };
      }
      if (!process.env.GOOGLE_BUSINESS_CLIENT_ID) {
        return {
          ok: false,
          missing:
            'access to the Google Business Profile API — it is allow-listed per project, so it has to be applied for',
        };
      }
      if (!settings.googleRefreshToken) {
        return {
          ok: false,
          missing: 'an owner of the listing to sign in and grant access',
        };
      }
      return { ok: true };
    },
    /**
     * Not written, deliberately, and this is the honest place to say so.
     *
     * Writing it against a guess at the response shape would produce code that
     * looks finished, cannot be run, and is wrong in ways nobody finds until
     * the credentials arrive. What it will do is already decided: page
     * accounts.locations.reviews since the window, hand each page to
     * inbound.batch('google', …), and hand that to listings.store — which is
     * why the de-duplication and the reply tracking are already built and
     * tested without it.
     */
    fetch: null,
  },

  {
    id: 'tripadvisor',
    platform: 'tripadvisor',
    label: 'Tripadvisor',
    ready: (settings) => {
      if (!settings?.tripadvisorUrl) {
        return { ok: false, missing: 'a Tripadvisor link in Settings' };
      }
      return {
        ok: false,
        missing:
          'a Tripadvisor Content API agreement — the review endpoints are not in the free tier',
      };
    },
    fetch: null,
  },
];

/**
 * Every connector, with whether it can run for this venue.
 *
 * Shown in full rather than filtered to the working ones: an owner asking why
 * their Tripadvisor reviews are not here deserves to see Tripadvisor on the
 * list with the reason beside it, not an absence.
 */
function list(settings = {}) {
  return CONNECTORS.map((c) => {
    const ready = c.ready(settings);
    return {
      id: c.id,
      platform: c.platform,
      label: c.label,
      ready: ready.ok,
      missing: ready.missing ?? null,
      /** Whether anything would actually happen if it were run. */
      automatic: Boolean(c.fetch),
    };
  });
}

/**
 * Run every connector that can run, for one venue.
 *
 * Each one on its own: a source that is down must not stop the others, and a
 * fetch that half-worked is still worth storing. What comes back says what
 * each did, because "nothing happened" and "nothing has changed" look the same
 * on a screen and are not the same thing.
 */
async function fetchAll({ settings, days = inbound.WINDOW_DAYS }) {
  const from = inbound.since(days);
  const results = [];

  for (const c of CONNECTORS) {
    if (!c.fetch) continue;

    const ready = c.ready(settings);
    if (!ready.ok) {
      results.push({ id: c.id, ran: false, reason: ready.missing });
      continue;
    }

    try {
      const rows = await c.fetch({ settings, from });
      results.push({ id: c.id, platform: c.platform, ran: true, rows });
    } catch (err) {
      console.error(`Could not fetch ${c.id} reviews:`, err.message);
      results.push({ id: c.id, ran: false, reason: 'the source could not be reached' });
    }
  }

  return { from, days, results };
}

module.exports = { CONNECTORS, list, fetchAll };
