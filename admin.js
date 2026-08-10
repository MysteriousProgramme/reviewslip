'use strict';

const express = require('express');

const subscribers = require('./subscribers');
const openrouter = require('./openrouter');
const { requireAdmin } = require('./auth');
const { publicUrl } = require('./tenant');

/**
 * The admin API: create and manage subscribers.
 *
 * Mounted before tenant resolution, so it answers on any hostname — an
 * operator should not have to guess which venue's subdomain to aim at in order
 * to create the next one. Every route is behind ADMIN_TOKEN.
 */

const router = express.Router();

router.use(requireAdmin);

/** Records carry the guest-facing address, which only tenant.js can build. */
function withUrl(record) {
  return { ...record, url: publicUrl(record.slug) };
}

/* ------------------------------------------------------------------ routes */

router.get('/subscribers', (req, res) => {
  res.json({ subscribers: subscribers.list().map(withUrl) });
});

router.post('/subscribers', async (req, res, next) => {
  try {
    const body = req.body || {};

    // Check the key and slug before writing, so a subscriber is never created
    // in a state that fails on its first guest.
    const verdict = await openrouter.vet(body);
    if (verdict.error) return res.status(400).json({ error: verdict.error });

    const { record, token } = subscribers.create(body);

    res.status(201).json({
      subscriber: withUrl(record),
      // Shown once. Only the hash is stored, so a lost token has to be rotated.
      token,
      warning: verdict.warning,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/subscribers/:slug', (req, res) => {
  const row = subscribers.get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'No subscriber at that address.' });
  res.json({ subscriber: withUrl(subscribers.toRecord(row)) });
});

router.patch('/subscribers/:slug', async (req, res, next) => {
  try {
    const body = req.body || {};

    const verdict = await openrouter.vet(body);
    if (verdict.error) return res.status(400).json({ error: verdict.error });

    const record = subscribers.update(req.params.slug, body);
    res.json({ subscriber: withUrl(record), warning: verdict.warning });
  } catch (err) {
    next(err);
  }
});

router.delete('/subscribers/:slug', (req, res) => {
  if (!subscribers.remove(req.params.slug)) {
    return res.status(404).json({ error: 'No subscriber at that address.' });
  }
  res.status(204).end();
});

/** Rotating invalidates the old token straight away. */
router.post('/subscribers/:slug/token', (req, res, next) => {
  try {
    res.json({ token: subscribers.rotateToken(req.params.slug) });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ errors */

// Store failures arrive as errors carrying a status; anything else is a bug
// here, and the client gets nothing but a 500.
router.use((err, req, res, _next) => {
  if (err?.expose && err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('Admin API error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

module.exports = router;
