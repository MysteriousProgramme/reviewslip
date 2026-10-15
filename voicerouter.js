'use strict';

const express = require('express');

const voice = require('./voice');
const hub = require('./voicehub');
const rules = require('./voicerules');
const emails = require('./emails');
const mailer = require('./mailer');
const { throttled } = require('./throttle');

/**
 * The softphone's HTTP side, at /api/voice. The ringing itself is a WebSocket
 * (voicehub.js); this is everything around it.
 *
 * Two kinds of caller, two doors:
 *
 *   Call buttons, on any Reviewslip page   /status, /voicemail — open to any
 *     origin and uncredentialed: they say only whether a line can be called,
 *     and take a message for a call that just went unanswered.
 *
 *   The phone page, /phone/ on this host   everything else — the rs_phone
 *     cookie, and only from the page's own origin.
 *
 * Mounted before the tenant resolver: the phone answers for every venue.
 */

const router = express.Router();

const COOKIE = 'rs_phone';
const COOKIE_DAYS = 30;
const secureCookies = hub.VOICE_URL.startsWith('https:');

function setCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_DAYS * 86400 * 1000,
  });
}

function cookieOf(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return '';
}

function sendError(res, err) {
  if (err.expose) return res.status(err.status || 400).json({ error: err.message });
  console.error('Softphone:', err);
  return res.status(500).json({ error: 'Something went wrong. Try again.' });
}

/* ---------------------------------------------------- call buttons (open) */

function openCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

/** open | voicemail | off for a line — "reviewslip" or a venue's address. */
router.all('/status', openCors, async (req, res) => {
  try {
    const value = await hub.status(req.query.line, req.query.team);
    res.set('Cache-Control', 'no-store');
    res.json({ status: value });
  } catch (err) {
    sendError(res, err);
  }
});

/** A message for a call nobody answered. The call id is the permission. */
router.all('/voicemail', openCors, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (throttled(`voicemail:${req.ip}`, { max: 4 })) {
    return res.status(429).json({ error: 'Too many messages. Try again in a minute.' });
  }
  const checked = rules.checkVoicemail(req.body || {});
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  try {
    const saved = await voice.saveVoicemail(req.body.callId, checked.value);
    res.status(201).json({ ok: true });
    tellVoicemail(saved, checked.value).catch((err) => console.error('Voicemail email failed:', err.message));
  } catch (err) {
    sendError(res, err);
  }
});

async function tellVoicemail(saved, vm) {
  if (!mailer.configured) return;
  const to = saved.subscriberId ? await voice.emailsFor(saved) : [mailer.SUPPORT].filter(Boolean);
  if (!to.length) return;
  const email = emails.voicemailEmail({
    line: saved.title,
    caller: vm.name,
    contact: vm.contact,
    seconds: vm.seconds,
    url: `${hub.VOICE_URL}/phone/`,
  });
  for (const address of to) await mailer.send({ to: address, ...email });
}

/* ------------------------------------------------------- the phone page */

/**
 * The phone page's own origin only. The cookie is SameSite=Lax, which already
 * keeps other sites' POSTs from carrying it; this holds for a browser that
 * gets SameSite wrong.
 */
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Not from here.' });
    } catch {
      return res.status(403).json({ error: 'Not from here.' });
    }
  }
  next();
}

router.use(sameOrigin);

async function requireAgent(req, res, next) {
  try {
    const agent = await voice.fromSession(cookieOf(req));
    if (!agent) return res.status(401).json({ error: 'Sign in first.' });
    req.agent = agent;
    next();
  } catch (err) {
    next(err);
  }
}

router.post('/login', async (req, res) => {
  if (throttled(`voice-login:${req.ip}`, { max: 8 })) {
    return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  }
  try {
    setCookie(res, await voice.login(req.body?.email, req.body?.password));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** From the dashboard's Open the phone: a one-time token for a session. */
router.post('/handoff', async (req, res) => {
  if (throttled(`voice-login:${req.ip}`, { max: 8 })) {
    return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  }
  try {
    setCookie(res, await voice.exchangeHandoff(String(req.body?.token || '')));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/invite', async (req, res) => {
  try {
    res.json(await voice.inviteFor(String(req.query.token || '')));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/invite', async (req, res) => {
  if (throttled(`voice-login:${req.ip}`, { max: 8 })) {
    return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  }
  try {
    setCookie(res, await voice.acceptInvite(String(req.body?.token || ''), req.body?.password));
    hub.changed();
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/logout', async (req, res) => {
  await voice.endSession(cookieOf(req)).catch(() => {});
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAgent, async (req, res) => {
  try {
    const [lines, hours] = await Promise.all([voice.linesFor(req.agent.id), voice.hoursFor(req.agent.id)]);
    res.set('Cache-Control', 'no-store');
    res.json({
      agent: { id: req.agent.id, name: req.agent.name, email: req.agent.email, onDuty: req.agent.onDuty },
      lines,
      timezone: req.agent.timezone,
      hours: rules.hoursOut(hours),
      pushKey: hub.PUSH_PUBLIC_KEY,
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/duty', requireAgent, async (req, res) => {
  try {
    await voice.setDuty(req.agent.id, req.body?.on === true);
    hub.changed();
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/lines', requireAgent, async (req, res) => {
  try {
    const off = Array.isArray(req.body?.off) ? req.body.off.map(String) : [];
    await voice.setLinesOff(req.agent.id, off);
    hub.changed();
    res.json({ lines: await voice.linesFor(req.agent.id) });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/hours', requireAgent, async (req, res) => {
  const checked = rules.checkHours(req.body?.hours);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  const tz = req.body?.timezone;
  if (tz && !rules.validZone(tz)) return res.status(400).json({ error: 'That time zone is not one we know.' });
  try {
    await voice.setHours(req.agent.id, checked.rows, tz || null);
    hub.changed();
    res.json({ hours: rules.hoursOut(checked.rows) });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/push', requireAgent, async (req, res) => {
  try {
    await voice.addPush(req.agent.id, req.body?.subscription);
    hub.changed();
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/push', requireAgent, async (req, res) => {
  try {
    await voice.removePush(String(req.body?.endpoint || ''), req.agent.id);
    hub.changed();
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/voicemails', requireAgent, async (req, res) => {
  try {
    const lines = await voice.linesFor(req.agent.id);
    res.set('Cache-Control', 'no-store');
    res.json({ voicemails: await voice.voicemailsFor(lines) });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/voicemails/:id/audio', requireAgent, async (req, res) => {
  try {
    const lines = await voice.linesFor(req.agent.id);
    const row = await voice.voicemailAudio(req.params.id, lines);
    if (!row) return res.status(404).end();
    res.set('Content-Type', row.mime);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(row.audio);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/voicemails/:id/heard', requireAgent, async (req, res) => {
  try {
    const lines = await voice.linesFor(req.agent.id);
    await voice.markHeard(req.params.id, lines, req.agent, req.body?.heard !== false);
    res.json({ voicemails: await voice.voicemailsFor(lines) });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/calls', requireAgent, async (req, res) => {
  try {
    const lines = await voice.linesFor(req.agent.id);
    res.set('Cache-Control', 'no-store');
    res.json({ calls: await voice.recentCalls(lines) });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
