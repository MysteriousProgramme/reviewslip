'use strict';

const { pool, one } = require('./db');

/**
 * The review app's own health: is the database answering, how fast, and how
 * many requests have failed lately.
 *
 * Served at /healthz for the monitor (scripts/monitor.js) and for any outside
 * uptime checker, and read by the staff Server page. Says nothing a stranger
 * could use — no versions of anything, no hostnames, no counts of customers.
 */

const started = Date.now();

/* ------------------------------------------------------- failed requests */

const WINDOW_MS = 5 * 60_000;
const failures = [];

/**
 * Every response with a 5xx status, counted for five minutes.
 *
 * A server that is up but failing every third request passes a ping and is
 * still broken for the people using it; this is what tells the two apart.
 */
function noteResponse(status) {
  if (status < 500) return;
  const now = Date.now();
  failures.push(now);
  while (failures.length && failures[0] < now - WINDOW_MS) failures.shift();
  // A flood is a number, not a memory problem.
  if (failures.length > 10_000) failures.splice(0, failures.length - 10_000);
}

function recentFailures(now = Date.now()) {
  return failures.filter((t) => t >= now - WINDOW_MS).length;
}

/** Express middleware: counts 5xx responses as they finish. */
function countFailures(_req, res, next) {
  res.on('finish', () => noteResponse(res.statusCode));
  next();
}

/* ------------------------------------------------------------------ check */

const DB_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * @returns {Promise<{status: 'ok'|'down', database: object, failures5m: number,
 *   uptimeSeconds: number, schema: number|null, pool: object}>}
 */
async function check() {
  const at = Date.now();
  let database;
  let schema = null;
  try {
    const row = await withTimeout(one('SELECT version FROM schema_version'), DB_TIMEOUT_MS);
    schema = row ? Number(row.version) : null;
    database = { ok: true, ms: Date.now() - at };
  } catch (err) {
    database = { ok: false, ms: Date.now() - at, error: String(err.message || err).slice(0, 200) };
  }

  return {
    status: database.ok ? 'ok' : 'down',
    database,
    failures5m: recentFailures(),
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    schema,
    // Waiting above zero for long means the five connections are not enough,
    // or something is holding them.
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

module.exports = { check, countFailures, noteResponse, recentFailures };
