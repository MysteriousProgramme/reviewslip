# Monitoring, health checks and server tuning

Built 2026-10-07.

## What watches what

| | |
|---|---|
| `GET /healthz` (review app) | Database answering and how fast, schema version, 5xx count in the last 5 minutes, pool use. 503 when the database is down. Any host. |
| `GET /api/health` (website) | Up, and able to reach the review app. 503 when it cannot. |
| `scripts/monitor.js` | Every 5 minutes via `reviewslip-monitor.timer`. Reads the services, both health endpoints, the public site and a venue address through nginx and TLS, Postgres (connections, longest query, open transactions, size, cache hit), disk, memory, swap, load, certificate expiry and the last nightly backup. |
| `monitorrules.js` | Pure, tested: thresholds, when to email, what the email says. |
| **Server** page | **Admin › Server** in the dashboard sidebar, for admin accounts only (`/dashboard/server`), and the same page at `admin.reviewslip.com/server`. The monitor's last readings plus what the review app sees right now. |

## Emails

To `MONITOR_EMAIL` (default `info@reviewslip.com`), through the same SES sender as everything else.

- **One email when a problem starts**, a reminder every 6 hours while it lasts, one when it clears.
  A warning that becomes critical is emailed at once.
- **A daily note after 08:00 Bangkok** — "all good" or the open problems. If it stops arriving,
  the monitor has stopped: check `systemctl status reviewslip-monitor.timer`.
- An email that fails to send is retried on the next run, not counted as sent.

Thresholds are `LIMITS` in `monitorrules.js`: disk 85% / 95%, memory under 10% / 5% available,
swap over 50% used or no swap at all, load over 2 per core, a page slower than 3s, 10 server errors
in 5 minutes, Postgres connections over 80%, a query over 2 minutes, a transaction open over 5
minutes, a certificate within 14 / 3 days, a backup older than 30 hours or failed.

## Install on the server

```
cd /opt/reviewslip
sudo cp deploy/reviewslip-monitor.service deploy/reviewslip-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now reviewslip-monitor.timer
node scripts/monitor.js --test-email     # one email to info@reviewslip.com now
node scripts/monitor.js --print          # the readings, nothing sent or saved
journalctl -u reviewslip-monitor -n 20   # each run logs one line
```

The timer only watches what is on the box. If the whole box goes down, nothing on it can send an
email — the missing daily note is the sign. For a second opinion from outside, point a free uptime
checker (UptimeRobot, Better Stack) at `https://baanponglodge.reviewslip.com/healthz`.

## Swap and Postgres: `deploy/tune-server.sh`

```
cd /opt/reviewslip
sudo bash deploy/tune-server.sh --dry-run   # what it would do
sudo bash deploy/tune-server.sh
```

- **Swap:** creates `/swapfile` only when there is no swap — 2GB on a box of 2GB or less, the size
  of memory up to 8GB — never leaving less than 2GB of disk free. `vm.swappiness = 10` and
  `vm.vfs_cache_pressure = 50`, so swap is a safety net rather than a working area.
- **Postgres:** writes `conf.d/reviewslip.conf`, sized from the box's memory: a fifth of it for
  `shared_buffers` on a small box (a quarter from 4GB), half as `effective_cache_size`,
  `max_connections = 40` (the app uses 5), SSD costs, smoother checkpoints, JIT off, quicker
  autovacuum on small tables, open transactions closed after 10 minutes, and statements over
  500ms logged.
- The configuration is parsed before Postgres restarts; if it is rejected, or Postgres does not
  come back, the previous file is restored. A few seconds of downtime on the restart.
- Rerun it after resizing the instance.
