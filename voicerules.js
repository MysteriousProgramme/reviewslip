'use strict';

/**
 * The softphone's rules, with no database and no sockets: which line a call is
 * for, whether someone is inside their hours, what a call button should say,
 * which pages may place a call, and what a voicemail or an invite must hold.
 *
 * voice.js stores, voicehub.js rings; both decide through here, and
 * test/prompt.test.js holds every rule.
 */

/** Reviewslip's own line picks one of these; a venue's line has one desk. */
const TEAMS = ['sales', 'support'];

/** How long a call rings before it goes to voicemail. */
const RING_SECONDS = 30;
/** Longer when someone was rung by push: a phone in a pocket takes a moment. */
const PUSH_EXTRA_SECONDS = 15;
/** An on-duty agent whose page dropped this recently is still reachable. */
const DUTY_GRACE_SECONDS = 90;
/** A voicemail must follow its call within this. */
const VOICEMAIL_WINDOW_MINUTES = 15;
const VOICEMAIL_MAX_SECONDS = 120;
/** Two minutes at 24 kbps is about 360 KB; the rest is room for a browser that ignores the bitrate. */
const VOICEMAIL_MAX_BYTES = 1_200_000;
const VOICEMAIL_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac'];
const INVITE_DAYS = 14;

function team(value) {
  return TEAMS.includes(value) ? value : 'sales';
}

/**
 * The key a line is known by in voice_lines_off and on the phone page.
 *
 * @param {{subscriberId: number|null, team?: string}} line
 */
function lineKey(line) {
  return line.subscriberId ? `v${line.subscriberId}` : team(line.team);
}

/** Free text from a caller or an owner: one line, trimmed, capped. */
function clean(value, max = 80) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/* ------------------------------------------------------------------ hours */

/** Whether the runtime knows this IANA zone. */
function validZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function minutesOf(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

function hhmm(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * A week of hours as the phone page sends it: [{day: 1-7 (Monday first),
 * from: "HH:MM", to: "HH:MM"}]. A "to" at or before "from" runs past midnight.
 *
 * @returns {{ok: true, rows: {weekday: number, startMin: number, endMin: number}[]} | {ok: false, error: string}}
 */
function checkHours(input) {
  if (!Array.isArray(input)) return { ok: false, error: 'Hours must be a list.' };
  if (input.length > 21) return { ok: false, error: 'At most three shifts a day.' };
  const rows = [];
  for (const item of input) {
    const weekday = Number(item?.day);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      return { ok: false, error: 'Each shift needs a day.' };
    }
    const startMin = minutesOf(item.from);
    const endRaw = minutesOf(item.to);
    if (startMin === null || endRaw === null || startMin === 1440) {
      return { ok: false, error: 'Times are like 09:00.' };
    }
    if (startMin === endRaw) return { ok: false, error: 'A shift has to last some time.' };
    // Midnight as an end is the end of the day, not its start.
    const endMin = endRaw === 0 ? 1440 : endRaw;
    rows.push({ weekday, startMin, endMin });
  }
  return { ok: true, rows };
}

/** Rows back as the phone page sends them. */
function hoursOut(rows) {
  return rows
    .map((r) => ({ day: r.weekday, from: hhmm(r.startMin), to: hhmm(r.endMin % 1440) }))
    .sort((a, b) => a.day - b.day || a.from.localeCompare(b.from));
}

/** The weekday (1 Monday … 7 Sunday) and minute of the day at `date` in `tz`. */
function localTime(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: validZone(tz) ? tz : 'Asia/Bangkok',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { weekday, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/**
 * Whether someone with these hours is working at `date`. No hours at all
 * means whenever they are on duty: duty is the switch, hours only narrow it.
 *
 * @param {{weekday: number, startMin: number, endMin: number}[]} rows
 */
function inHours(rows, tz, date = new Date()) {
  if (!rows || !rows.length) return true;
  const { weekday, minute } = localTime(date, tz);
  const yesterday = weekday === 1 ? 7 : weekday - 1;
  return rows.some((r) => {
    const overnight = r.endMin <= r.startMin;
    if (r.weekday === weekday) {
      return overnight ? minute >= r.startMin : minute >= r.startMin && minute < r.endMin;
    }
    // Yesterday's night shift, still running this morning.
    return overnight && r.weekday === yesterday && minute < r.endMin;
  });
}

/* --------------------------------------------------------------- the line */

/**
 * Whether an agent would ring right now.
 *
 * @param {{onDuty: boolean, connected: boolean, droppedAt?: number|null,
 *   hasPush: boolean, busy: boolean, hours: object[], timezone: string}} a
 */
function reachable(a, now = Date.now()) {
  if (!a.onDuty || a.busy) return false;
  const present =
    a.connected ||
    a.hasPush ||
    (a.droppedAt != null && now - a.droppedAt < DUTY_GRACE_SECONDS * 1000);
  return present && inHours(a.hours, a.timezone, new Date(now));
}

/**
 * Where someone stands, for Who's on, in the order it matters: on a call,
 * off duty, outside their hours, ringable, or on duty with no way to ring them.
 *
 * @returns {'call'|'off'|'hours'|'available'|'closed'}
 */
function personState(a, now = Date.now()) {
  if (a.busy) return 'call';
  if (!a.onDuty) return 'off';
  if (!inHours(a.hours, a.timezone, new Date(now))) return 'hours';
  return reachable(a, now) ? 'available' : 'closed';
}

/**
 * What a call button says.
 *
 *   open       someone would ring now — "Call Reservations"
 *   voicemail  the line has people, none free — "Leave a message"
 *   off        nobody answers this line at all — no button, the phone number stays
 *
 * @param {object[]} agents  everyone on the line, as `reachable` takes them
 */
function lineStatus(agents, now = Date.now()) {
  if (!agents.length) return 'off';
  return agents.some((a) => reachable(a, now)) ? 'open' : 'voicemail';
}

/* ---------------------------------------------------------------- origins */

/**
 * Which pages may place a call: Reviewslip's own site and its venue
 * addresses. Another website embeds the booking pages from reviewslip.com,
 * so its calls arrive from there too. Locally, any localhost port.
 *
 * @param {string} origin  the Origin header
 * @param {{baseDomain: string, extra?: string[]}} opts
 */
function originAllowed(origin, { baseDomain, extra = [] }) {
  let url;
  try {
    url = new URL(String(origin || ''));
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (extra.includes(url.origin)) return true;
  const host = url.hostname;
  const local = baseDomain === 'localhost' || baseDomain.endsWith('.localhost');
  if (local) {
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost'))
    );
  }
  if (url.protocol !== 'https:' || url.port) return false;
  return host === baseDomain || host.endsWith(`.${baseDomain}`);
}

/* -------------------------------------------------------------- voicemail */

/**
 * A voicemail as the call button posts it.
 *
 * @returns {{ok: true, value: {mime: string, audio: Buffer, seconds: number,
 *   name: string, contact: string}} | {ok: false, error: string}}
 */
function checkVoicemail(input = {}) {
  const mime = String(input.mime || '').split(';')[0].trim().toLowerCase();
  if (!VOICEMAIL_TYPES.includes(mime)) return { ok: false, error: 'That recording cannot be played back here.' };
  const b64 = String(input.audio || '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, error: 'There is no recording.' };
  const audio = Buffer.from(b64, 'base64');
  if (audio.length < 200) return { ok: false, error: 'There is no recording.' };
  if (audio.length > VOICEMAIL_MAX_BYTES) return { ok: false, error: 'That message is too long.' };
  const seconds = Math.round(Number(input.seconds));
  if (!Number.isFinite(seconds) || seconds < 1) return { ok: false, error: 'There is no recording.' };
  if (seconds > VOICEMAIL_MAX_SECONDS + 5) return { ok: false, error: 'That message is too long.' };
  return {
    ok: true,
    value: {
      mime,
      audio,
      seconds: Math.min(seconds, VOICEMAIL_MAX_SECONDS),
      name: clean(input.name, 80),
      contact: clean(input.contact, 120),
    },
  };
}

/* ----------------------------------------------------------------- invite */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Someone a customer adds to answer their calls. */
function checkInvite(input = {}) {
  const name = clean(input.name, 60);
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!name) return { ok: false, error: 'Add their name.' };
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { ok: false, error: 'That does not look like an email address.' };
  }
  return { ok: true, value: { name, email } };
}

/* ------------------------------------------------------------------ calls */

/** What the person answering reads about the call, before they pick up. */
function callTitle({ venueName, team: t }) {
  if (venueName) return venueName;
  return t === 'support' ? 'Reviewslip Support' : 'Reviewslip Sales';
}

/**
 * The page the call came from, as a short path for the agent to read —
 * never a query string, which can carry a booking key.
 */
function pageOf(value) {
  try {
    const url = new URL(String(value || ''));
    return clean(url.pathname, 120);
  } catch {
    return '';
  }
}

module.exports = {
  TEAMS,
  RING_SECONDS,
  PUSH_EXTRA_SECONDS,
  DUTY_GRACE_SECONDS,
  VOICEMAIL_WINDOW_MINUTES,
  VOICEMAIL_MAX_SECONDS,
  INVITE_DAYS,
  team,
  lineKey,
  clean,
  validZone,
  checkHours,
  hoursOut,
  localTime,
  inHours,
  reachable,
  personState,
  lineStatus,
  originAllowed,
  checkVoicemail,
  checkInvite,
  callTitle,
  pageOf,
};
