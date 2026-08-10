'use strict';

const subscribers = require('./subscribers');

/**
 * Which subscriber a request belongs to, worked out from the hostname.
 *
 *   baanpong.reviews.example  ->  slug "baanpong"
 *   reviews.example           ->  the apex; no subscriber
 *   anything else             ->  no subscriber
 *
 * BASE_DOMAIN defaults to `localhost`, because browsers resolve every
 * *.localhost name to the loopback address without touching a hosts file —
 * so http://baanpong.localhost:3000 works on a fresh clone with no DNS setup.
 */

const BASE_DOMAIN = String(process.env.BASE_DOMAIN || 'localhost')
  .trim()
  .toLowerCase()
  .replace(/^\.+|\.+$/g, '');

// An escape hatch for running one venue without DNS: any host that does not
// resolve to a subscriber falls back to this slug.
const DEFAULT_SLUG = String(process.env.DEFAULT_SUBSCRIBER || '')
  .trim()
  .toLowerCase();

/** @returns {string|null} the label in front of BASE_DOMAIN, if there is one */
function slugFromHost(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, ''); // a fully-qualified name may carry a trailing dot

  if (!host || host === BASE_DOMAIN) return null;

  const suffix = `.${BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;

  const label = host.slice(0, -suffix.length);
  // Deeper nesting (a.b.reviews.example) is not a subscriber address, and a
  // reserved label belongs to the platform.
  if (!label || label.includes('.') || subscribers.RESERVED.has(label)) {
    return null;
  }
  return label;
}

/** The address a guest's QR code should point at. */
function publicUrl(slug) {
  const local = BASE_DOMAIN === 'localhost' || BASE_DOMAIN.endsWith('.localhost');
  const port = Number(process.env.PORT) || 3000;
  return local
    ? `http://${slug}.${BASE_DOMAIN}:${port}`
    : `https://${slug}.${BASE_DOMAIN}`;
}

/* -------------------------------------------------------------- middleware */

/**
 * Attaches req.subscriber (or null). An unknown host is not an error here —
 * see requireTenant — but an unreachable store is, and express 4 does not catch
 * a rejected promise on its own, so it is handed to next() by hand.
 */
async function resolveTenant(req, res, next) {
  try {
    const slug = slugFromHost(req.hostname) || DEFAULT_SLUG || null;
    req.subscriberSlug = slug;
    req.subscriber = slug ? await subscribers.get(slug) : null;
    next();
  } catch (err) {
    next(err);
  }
}

/** Rejects anything that did not resolve to a usable subscriber. */
function requireTenant(req, res, next) {
  if (!req.subscriber) {
    return res.status(404).json({
      error: req.subscriberSlug
        ? `No venue is set up at ${req.hostname}.`
        : `Open a venue's own address — for example ${publicUrl('venue-name')}.`,
    });
  }
  if (req.subscriber.status !== 'active') {
    return res
      .status(403)
      .json({ error: 'This review page is not active right now.' });
  }
  next();
}

module.exports = {
  BASE_DOMAIN,
  DEFAULT_SLUG,
  slugFromHost,
  publicUrl,
  resolveTenant,
  requireTenant,
};
