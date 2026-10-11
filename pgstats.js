'use strict';

/**
 * What Postgres is doing, for the Server page: who holds connections, how big
 * each database is, and which tables take the room.
 *
 * Takes the client to ask through rather than requiring db.js, so the monitor
 * (its own short-lived connection) and the review app (its pool) read the same
 * numbers the same way.
 */

/**
 * Who each application name belongs to. The app's pool and the monitor name
 * themselves (db.js, scripts/monitor.js); pg_dump and psql name themselves.
 */
const KNOWN = {
  'reviewslip-app': 'Review app',
  'reviewslip-monitor': 'Server monitor',
  pg_dump: 'Nightly backup',
  psql: 'psql session',
};

function labelOf(app) {
  return KNOWN[app] || app || 'Unnamed client';
}

/**
 * Client connections grouped by who opened them, from where, and what they are
 * doing — not counting the connection asking.
 *
 * Background processes (autovacuum, the WAL writer, the checkpointer) are
 * counted apart: they are Postgres itself, always there, and adding them to
 * "connections" made a quiet server look busy.
 *
 * @param {{query: Function}} runner
 */
async function connections(runner) {
  // One after another, not side by side: on a pool, three at once is three
  // connections opened to count connections; on one client, the driver
  // queues them anyway and warns.
  const clients = await runner.query(`
      SELECT coalesce(nullif(application_name, ''), '') AS app,
             coalesce(usename, '') AS username,
             coalesce(host(client_addr), CASE WHEN client_port = -1 THEN 'local socket' ELSE 'hidden' END) AS client,
             coalesce(state, 'unknown') AS state,
             count(*)::int AS n,
             coalesce(max(extract(epoch FROM now() - state_change)), 0)::int AS oldest_seconds
        FROM pg_stat_activity
       WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
       GROUP BY 1, 2, 3, 4
       ORDER BY n DESC, app`);
  const background = await runner.query(`
      SELECT backend_type AS kind, count(*)::int AS n
        FROM pg_stat_activity
       WHERE backend_type <> 'client backend'
       GROUP BY 1 ORDER BY 2 DESC, 1`);
  const limits = await runner.query(`SELECT current_setting('max_connections')::int AS max_connections,
                         current_setting('superuser_reserved_connections')::int AS reserved`);

  const groups = clients.rows.map((r) => ({
    app: r.app,
    label: labelOf(r.app),
    user: r.username,
    client: r.client,
    state: r.state,
    count: r.n,
    oldestSeconds: r.oldest_seconds,
  }));

  // By who, across states and addresses: the headline the page leads with.
  const byApp = [];
  for (const g of groups) {
    const row = byApp.find((b) => b.app === g.app);
    if (row) {
      row.count += g.count;
      row[g.state === 'active' ? 'active' : g.state.startsWith('idle in transaction') ? 'idleInTransaction' : 'idle'] += g.count;
    } else {
      byApp.push({
        app: g.app,
        label: g.label,
        count: g.count,
        active: g.state === 'active' ? g.count : 0,
        idleInTransaction: g.state.startsWith('idle in transaction') ? g.count : 0,
        idle: g.state === 'active' || g.state.startsWith('idle in transaction') ? 0 : g.count,
      });
    }
  }
  byApp.sort((a, b) => b.count - a.count);

  return {
    total: groups.reduce((n, g) => n + g.count, 0),
    max: limits.rows[0].max_connections,
    reserved: limits.rows[0].reserved,
    byApp,
    groups,
    background: background.rows.map((r) => ({ kind: r.kind, count: r.n })),
  };
}

/** Every database's size, largest first. */
async function databases(runner) {
  const { rows } = await runner.query(`
    SELECT datname AS name, pg_database_size(datname)::bigint AS bytes
      FROM pg_database WHERE NOT datistemplate
     ORDER BY 2 DESC`);
  return rows.map((r) => ({ name: r.name, mb: Math.round((Number(r.bytes) / 1024 ** 2) * 10) / 10 }));
}

/** The tables taking the most room in this database, with their row counts. */
async function tables(runner, limit = 8) {
  const { rows } = await runner.query(
    `SELECT relname AS name, pg_total_relation_size(relid)::bigint AS bytes, n_live_tup::bigint AS rows
       FROM pg_stat_user_tables
      ORDER BY 2 DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({ name: r.name, mb: Math.round((Number(r.bytes) / 1024 ** 2) * 10) / 10, rows: Number(r.rows) }));
}

module.exports = { connections, databases, tables, labelOf };
