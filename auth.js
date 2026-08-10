'use strict';

const crypto = require('crypto');
const subscribers = require('./subscribers');

/**
 * Two bearer tokens, two jobs.
 *
 *   ADMIN_TOKEN (from .env)  creates, lists and deletes subscribers, and can
 *                            act on any one of them.
 *   a subscriber's token     edits only that subscriber's own settings.
 *
 * The settings panel guards an OpenRouter key, so a wrong token is worth
 * slowing down: repeated failures from one address get locked out for a while.
 */

const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();

/* ------------------------------------------------------------- comparison */

function bearer(req) {
  const header = String(req.get('authorization') || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

/** Constant-time, and length-safe because both sides are hashed first. */
function sameToken(presented, expected) {
  if (!presented || !expected) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function isAdmin(req) {
  return Boolean(ADMIN_TOKEN) && sameToken(bearer(req), ADMIN_TOKEN);
}

/* ------------------------------------------------------------- brute force */

const LOCKOUT_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const failures = new Map();

function lockedOut(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function noteFailure(ip) {
  const now = Date.now();
  const entry = failures.get(ip);

  if (!entry || now > entry.until) {
    failures.set(ip, { count: 1, until: now + LOCKOUT_MS });
    if (failures.size > 5000) failures.clear();
    return;
  }
  // The window is fixed from the first failure, deliberately. Extending it on
  // every attempt would let someone hammering the endpoint keep the venue's
  // own staff locked out indefinitely — and a venue's staff and its guests
  // often share one address behind the same router.
  entry.count += 1;
}

function noteSuccess(ip) {
  failures.delete(ip);
}

/* -------------------------------------------------------------- middleware */

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error: 'The admin API is off. Set ADMIN_TOKEN in .env and restart.',
    });
  }
  if (lockedOut(req.ip)) return tooMany(res);

  if (!isAdmin(req)) {
    noteFailure(req.ip);
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Admin token required.' });
  }

  noteSuccess(req.ip);
  req.actor = 'admin';
  next();
}

/** Requires the resolved subscriber's own token, or the admin token. */
function requireSubscriber(req, res, next) {
  if (lockedOut(req.ip)) return tooMany(res);

  if (isAdmin(req)) {
    noteSuccess(req.ip);
    req.actor = 'admin';
    return next();
  }

  if (subscribers.verifyToken(req.subscriber, bearer(req))) {
    noteSuccess(req.ip);
    req.actor = 'subscriber';
    return next();
  }

  noteFailure(req.ip);
  res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ error: 'Settings token required.' });
}

function tooMany(res) {
  return res
    .status(429)
    .json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
}

module.exports = {
  ADMIN_TOKEN,
  bearer,
  isAdmin,
  requireAdmin,
  requireSubscriber,
};
