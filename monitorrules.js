'use strict';

/**
 * The server monitor's rules, with no I/O: what counts as a problem, when to
 * tell somebody, and what the email says.
 *
 * scripts/monitor.js gathers the readings every five minutes and hands them
 * here. The emails go to one inbox, so the rules are written to keep it quiet:
 * one email when a problem starts, a reminder every few hours while it lasts,
 * one when it clears, and a short daily note so a silent inbox means "fine"
 * rather than "the monitor died".
 */

/* ------------------------------------------------------------- thresholds */

const LIMITS = {
  diskWarnPct: 85,
  diskCriticalPct: 95,
  memoryWarnPct: 10, // available, of total
  memoryCriticalPct: 5,
  swapWarnPct: 50, // used, of total
  loadPerCore: 2,
  httpSlowMs: 3000,
  dbSlowMs: 1000,
  failures5m: 10,
  connectionsWarnPct: 80,
  longQuerySeconds: 120,
  idleInTransactionSeconds: 300,
  certWarnDays: 14,
  certCriticalDays: 3,
  backupMaxHours: 30,
};

/** Hours between reminders while a problem lasts. */
const REMIND_HOURS = 6;

/** The daily note, in Thailand's morning. */
const DAILY_HOUR = 8;
const TIME_ZONE = 'Asia/Bangkok';

/* --------------------------------------------------------------- evaluate */

function problem(key, severity, summary) {
  return { key, severity, summary };
}

/**
 * What is wrong, from one set of readings.
 *
 * A reading that could not be taken is null and is skipped, not reported — a
 * monitor run on a laptop has no /proc, and the problems worth an email are
 * the ones it can actually see. The two exceptions are the checks whose
 * failure is the problem: a service, a page or the database not answering.
 *
 * @param {object} r - see scripts/monitor.js for the shape
 * @returns {{key: string, severity: 'warning'|'critical', summary: string}[]}
 */
function evaluate(r = {}, limits = LIMITS) {
  const out = [];

  for (const service of r.services ?? []) {
    if (service.state !== 'active') {
      out.push(problem(`service:${service.name}`, 'critical', `${service.name} is ${service.state}`));
    }
  }

  for (const check of r.http ?? []) {
    if (!check.ok) {
      out.push(problem(`http:${check.name}`, 'critical', `${check.name} is not answering (${check.error || `HTTP ${check.status}`})`));
    } else if (check.ms > limits.httpSlowMs) {
      out.push(problem(`slow:${check.name}`, 'warning', `${check.name} took ${(check.ms / 1000).toFixed(1)}s to answer`));
    }
  }

  const app = r.app;
  if (app) {
    if (app.database && !app.database.ok) {
      out.push(problem('db:app', 'critical', `The review app cannot reach Postgres (${app.database.error || 'no answer'})`));
    } else if (app.database && app.database.ms > limits.dbSlowMs) {
      out.push(problem('db:slow', 'warning', `Postgres took ${app.database.ms}ms to answer the review app`));
    }
    if (app.failures5m >= limits.failures5m) {
      out.push(problem('app:failures', 'warning', `${app.failures5m} requests failed with a server error in the last 5 minutes`));
    }
    if (app.pool && app.pool.waiting > 0) {
      out.push(problem('app:pool', 'warning', `${app.pool.waiting} requests waiting for a database connection`));
    }
  }

  const sys = r.system;
  if (sys) {
    if (sys.diskUsedPct !== null && sys.diskUsedPct !== undefined) {
      if (sys.diskUsedPct >= limits.diskCriticalPct) {
        out.push(problem('disk', 'critical', `Disk ${sys.diskUsedPct}% full (${sys.diskFreeGb} GB left)`));
      } else if (sys.diskUsedPct >= limits.diskWarnPct) {
        out.push(problem('disk', 'warning', `Disk ${sys.diskUsedPct}% full (${sys.diskFreeGb} GB left)`));
      }
    }
    if (sys.memoryAvailablePct !== null && sys.memoryAvailablePct !== undefined) {
      if (sys.memoryAvailablePct < limits.memoryCriticalPct) {
        out.push(problem('memory', 'critical', `Only ${sys.memoryAvailablePct}% of memory available`));
      } else if (sys.memoryAvailablePct < limits.memoryWarnPct) {
        out.push(problem('memory', 'warning', `Only ${sys.memoryAvailablePct}% of memory available`));
      }
    }
    if (sys.swapTotalMb === 0) {
      out.push(problem('swap:none', 'warning', 'No swap: a memory spike kills a process instead of slowing it'));
    } else if (sys.swapUsedPct !== null && sys.swapUsedPct !== undefined && sys.swapUsedPct >= limits.swapWarnPct) {
      out.push(problem('swap', 'warning', `Swap ${sys.swapUsedPct}% used — the box is short of memory`));
    }
    if (sys.load1 !== null && sys.load1 !== undefined && sys.cores) {
      if (sys.load1 / sys.cores > limits.loadPerCore) {
        out.push(problem('load', 'warning', `Load ${sys.load1.toFixed(2)} on ${sys.cores} core${sys.cores === 1 ? '' : 's'}`));
      }
    }
  }

  const db = r.postgres;
  if (db) {
    if (!db.ok) {
      out.push(problem('db:monitor', 'critical', `Postgres is not answering (${db.error || 'no answer'})`));
    } else {
      const pct = db.maxConnections ? Math.round((db.connections / db.maxConnections) * 100) : 0;
      if (pct >= limits.connectionsWarnPct) {
        out.push(problem('db:connections', 'warning', `${db.connections} of ${db.maxConnections} Postgres connections in use`));
      }
      if (db.longestQuerySeconds >= limits.longQuerySeconds) {
        out.push(problem('db:long-query', 'warning', `A query has been running for ${Math.round(db.longestQuerySeconds / 60)} min`));
      }
      if (db.idleInTransactionSeconds >= limits.idleInTransactionSeconds) {
        out.push(problem('db:idle-tx', 'warning', `A transaction has been left open for ${Math.round(db.idleInTransactionSeconds / 60)} min, holding locks`));
      }
    }
  }

  for (const cert of r.certificates ?? []) {
    if (!cert.ok) {
      out.push(problem(`cert:${cert.host}`, 'warning', `Could not read the certificate for ${cert.host} (${cert.error})`));
    } else if (cert.daysLeft <= limits.certCriticalDays) {
      out.push(problem(`cert:${cert.host}`, 'critical', `The certificate for ${cert.host} expires in ${cert.daysLeft} day${cert.daysLeft === 1 ? '' : 's'}`));
    } else if (cert.daysLeft <= limits.certWarnDays) {
      out.push(problem(`cert:${cert.host}`, 'warning', `The certificate for ${cert.host} expires in ${cert.daysLeft} days — renewal may be failing`));
    }
  }

  const backup = r.backup;
  if (backup && backup.installed) {
    if (backup.result && backup.result !== 'success') {
      out.push(problem('backup:failed', 'critical', `The last database backup failed (${backup.result})`));
    } else if (backup.hoursAgo === null || backup.hoursAgo > limits.backupMaxHours) {
      out.push(problem('backup:stale', 'warning', backup.hoursAgo === null
        ? 'No database backup has run since the box started'
        : `The last database backup was ${Math.round(backup.hoursAgo)} hours ago`));
    }
  }

  return out;
}

/* ------------------------------------------------------------- transition */

/**
 * What to tell somebody, given what was wrong last time and what is wrong now.
 *
 * State is a map of problem key to when it opened and when it was last
 * mentioned. A problem that is new opens; one still there past the reminder
 * interval is mentioned again; one that has gone is resolved. A warning that
 * becomes critical counts as new, so it is not held back for six hours.
 *
 * @returns {{state: object, opened: object[], reminded: object[], resolved: object[]}}
 */
function transition(previous = {}, problems = [], now = Date.now(), { remindHours = REMIND_HOURS } = {}) {
  const open = previous.open ?? {};
  const next = {};
  const opened = [];
  const reminded = [];
  const resolved = [];

  for (const p of problems) {
    const was = open[p.key];
    if (!was || (was.severity === 'warning' && p.severity === 'critical')) {
      next[p.key] = { ...p, since: was?.since ?? now, told: now };
      opened.push(p);
    } else if (now - was.told >= remindHours * 3_600_000) {
      next[p.key] = { ...p, since: was.since, told: now };
      reminded.push({ ...p, since: was.since });
    } else {
      next[p.key] = { ...p, since: was.since, told: was.told };
    }
  }

  for (const [key, was] of Object.entries(open)) {
    if (!next[key]) resolved.push({ ...was, key, endedAt: now });
  }

  return { state: { ...previous, open: next }, opened, reminded, resolved };
}

/** The calendar day and hour in Thailand, for the daily note. */
function localDay(now, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** Whether today's daily note is due: past eight in the morning and not sent today. */
function dailyDue(previous = {}, now = Date.now(), { hour = DAILY_HOUR, timeZone = TIME_ZONE } = {}) {
  const today = localDay(now, timeZone);
  return today.hour >= hour && previous.dailySentFor !== today.day ? today.day : null;
}

/* ------------------------------------------------------------------ email */

function ago(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** The readings as lines anybody can scan, for the bottom of every email. */
function summaryLines(r = {}) {
  const lines = [];
  for (const s of r.services ?? []) lines.push(`Service ${s.name}: ${s.state}`);
  for (const h of r.http ?? []) lines.push(`${h.name}: ${h.ok ? `OK in ${h.ms}ms` : `DOWN (${h.error || h.status})`}`);
  if (r.app) lines.push(`Review app: database ${r.app.database?.ok ? `${r.app.database.ms}ms` : 'DOWN'}, ${r.app.failures5m} server errors in 5 min, up ${ago(r.app.uptimeSeconds * 1000)}`);
  const s = r.system;
  if (s) {
    if (s.diskUsedPct !== null && s.diskUsedPct !== undefined) lines.push(`Disk: ${s.diskUsedPct}% used, ${s.diskFreeGb} GB free`);
    if (s.memoryAvailablePct !== null && s.memoryAvailablePct !== undefined) lines.push(`Memory: ${s.memoryAvailablePct}% available of ${s.memoryTotalMb} MB`);
    if (s.swapTotalMb !== null && s.swapTotalMb !== undefined) lines.push(`Swap: ${s.swapTotalMb ? `${s.swapUsedPct}% used of ${s.swapTotalMb} MB` : 'none'}`);
    if (s.load1 !== null && s.load1 !== undefined) lines.push(`Load: ${s.load1.toFixed(2)} (${s.cores} cores)`);
  }
  const d = r.postgres;
  if (d) {
    lines.push(d.ok
      ? `Postgres: ${d.connections}/${d.maxConnections} connections, ${d.sizeMb} MB, cache hit ${d.cacheHitPct}%`
      : `Postgres: DOWN (${d.error})`);
  }
  for (const c of r.certificates ?? []) lines.push(`Certificate ${c.host}: ${c.ok ? `${c.daysLeft} days left` : c.error}`);
  if (r.backup?.installed) {
    lines.push(`Backup: ${r.backup.result || 'unknown'}, ${r.backup.hoursAgo === null ? 'not run since boot' : `${Math.round(r.backup.hoursAgo)} h ago`}`);
  }
  return lines;
}

/**
 * The email for this run, or null when there is nothing to say.
 *
 * @returns {{subject: string, text: string}|null}
 */
function composeEmail({ opened = [], reminded = [], resolved = [], open = [], daily = null, readings = {}, now = Date.now(), host = 'reviewslip' }) {
  const tag = `[Reviewslip ${host}]`;
  const any = opened.length || reminded.length || resolved.length;
  if (!any && !daily) return null;

  const worst = [...opened, ...reminded].some((p) => p.severity === 'critical') ? 'CRITICAL' : 'Warning';
  let subject;
  if (opened.length || reminded.length) {
    const list = [...opened, ...reminded];
    subject = `${tag} ${worst}: ${list[0].summary}${list.length > 1 ? ` (+${list.length - 1} more)` : ''}`;
  } else if (resolved.length) {
    subject = `${tag} Resolved: ${resolved[0].summary}${resolved.length > 1 ? ` (+${resolved.length - 1} more)` : ''}`;
  } else {
    subject = open.length
      ? `${tag} Daily health: ${open.length} problem${open.length === 1 ? '' : 's'} still open`
      : `${tag} Daily health: all good`;
  }

  const sections = [];
  if (opened.length) {
    sections.push(['New problems:', ...opened.map((p) => `  [${p.severity}] ${p.summary}`)].join('\n'));
  }
  if (reminded.length) {
    sections.push(['Still happening:', ...reminded.map((p) => `  [${p.severity}] ${p.summary} — for ${ago(now - p.since)}`)].join('\n'));
  }
  if (resolved.length) {
    sections.push(['Resolved:', ...resolved.map((p) => `  ${p.summary} — lasted ${ago(p.endedAt - p.since)}`)].join('\n'));
  }
  if (daily && !any) {
    sections.push(open.length
      ? ['Open problems:', ...open.map((p) => `  [${p.severity}] ${p.summary} — for ${ago(now - p.since)}`)].join('\n')
      : 'Everything checked is fine. This note comes once a day so you know the monitor is running.');
  }
  sections.push(['Readings:', ...summaryLines(readings).map((l) => `  ${l}`)].join('\n'));
  sections.push('Checked every 5 minutes by reviewslip-monitor. The Server page in the staff area shows the latest readings.');

  return { subject, text: sections.join('\n\n') };
}

module.exports = {
  LIMITS,
  REMIND_HOURS,
  evaluate,
  transition,
  dailyDue,
  localDay,
  composeEmail,
  summaryLines,
};
