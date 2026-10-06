#!/usr/bin/env bash
#
# Swap and Postgres settings for the reviewslip box, sized from its own memory.
#
#   sudo bash deploy/tune-server.sh --dry-run   show what it would do
#   sudo bash deploy/tune-server.sh             do it
#
# Safe to run again: swap is only created when there is none, and the Postgres
# settings live in one file of their own (conf.d/reviewslip.conf) that is
# rewritten each time. The previous copy is kept beside it. Postgres is
# restarted once, and if it will not come back the old file is put back.
#
# Why these numbers: one small box runs Postgres, both Node apps and nginx.
# Postgres's stock settings assume a 1990s machine (128MB of shared buffers,
# spinning disks); its common tuning advice assumes a database server with the
# whole machine to itself. This sits between: a fifth to a quarter of memory for
# Postgres's own cache, the rest left to the apps and the OS page cache, and
# SSD costs because EBS is SSD.

set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '%s\n' "$*"; }
die() { printf 'tune-server: %s\n' "$*" >&2; exit 1; }
do_() { if [ "$DRY" = 1 ]; then say "  would run: $*"; else "$@"; fi; }

[ "$(id -u)" = 0 ] || die "run with sudo"

MEM_MB=$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo)
CORES=$(nproc)
say "Memory: ${MEM_MB} MB, ${CORES} core(s)"

clamp() { # value min max
  local v=$1
  [ "$v" -lt "$2" ] && v=$2
  [ "$v" -gt "$3" ] && v=$3
  echo "$v"
}

# --------------------------------------------------------------------- swap
#
# Without swap, the first time memory runs short the kernel kills a process —
# usually the biggest, which is Postgres or Next.js — and the site is down until
# somebody notices. With swap the box slows down instead, and the monitor emails
# about swap use while there is still time to act.

say ""
say "== Swap"
if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
  say "Already has swap; leaving it alone:"
  swapon --show
else
  if [ "$MEM_MB" -le 2048 ]; then SWAP_MB=2048
  elif [ "$MEM_MB" -le 8192 ]; then SWAP_MB=$MEM_MB
  else SWAP_MB=8192
  fi
  FREE_MB=$(df -Pm / | awk 'NR == 2 { print $4 }')
  # Never take the disk below 2GB free for the sake of swap: a full disk is a
  # worse outage than the one swap prevents.
  if [ "$FREE_MB" -lt $((SWAP_MB + 2048)) ]; then
    SWAP_MB=$(( FREE_MB - 2048 ))
    [ "$SWAP_MB" -lt 512 ] && die "only ${FREE_MB} MB of disk free; grow the volume before adding swap"
  fi
  say "Creating a ${SWAP_MB} MB swap file at /swapfile"
  if [ "$DRY" = 0 ]; then
    fallocate -l "${SWAP_MB}M" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB" status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi

# Swap as a safety net, not a place to live: only page out under real
# pressure, and keep the filesystem cache Postgres leans on.
say "Kernel: swappiness 10, vfs_cache_pressure 50"
if [ "$DRY" = 0 ]; then
  cat > /etc/sysctl.d/99-reviewslip.conf <<'EOF'
# Written by /opt/reviewslip/deploy/tune-server.sh
vm.swappiness = 10
vm.vfs_cache_pressure = 50
EOF
  sysctl --quiet --load /etc/sysctl.d/99-reviewslip.conf
fi

# ----------------------------------------------------------------- postgres

say ""
say "== Postgres"
PG_VERSION=$(ls /etc/postgresql 2>/dev/null | sort -n | tail -n 1)
[ -n "$PG_VERSION" ] || die "no /etc/postgresql — is Postgres installed from the Ubuntu packages?"
CONF_DIR="/etc/postgresql/$PG_VERSION/main"
CONF_FILE="$CONF_DIR/postgresql.conf"
TUNE_FILE="$CONF_DIR/conf.d/reviewslip.conf"
BIN="/usr/lib/postgresql/$PG_VERSION/bin"
say "Version $PG_VERSION, settings in $TUNE_FILE"

if ! grep -Eq "^[[:space:]]*include_dir[[:space:]]*=[[:space:]]*'conf.d'" "$CONF_FILE"; then
  say "Adding include_dir = 'conf.d' to postgresql.conf"
  do_ sh -c "echo \"include_dir = 'conf.d'\" >> '$CONF_FILE'"
fi
do_ mkdir -p "$CONF_DIR/conf.d"

# A fifth of memory on a small shared box, a quarter on a bigger one.
if [ "$MEM_MB" -lt 4096 ]; then SHARED=$(( MEM_MB / 5 )); else SHARED=$(( MEM_MB / 4 )); fi
SHARED=$(clamp "$SHARED" 128 8192)
CACHE=$(clamp $(( MEM_MB / 2 )) 256 32768)
MAINT=$(clamp $(( MEM_MB / 16 )) 64 1024)
MAX_CONN=40
# A query can use several work_mem at once (a sort and a hash), so a quarter of
# memory is shared across three per connection.
WORK=$(clamp $(( MEM_MB / 4 / (MAX_CONN * 3) )) 4 64)
WORKERS=$(clamp "$CORES" 2 8)

NEW=$(cat <<EOF
# Written by /opt/reviewslip/deploy/tune-server.sh for ${MEM_MB} MB and ${CORES} core(s).
# Rerun the script after resizing the instance; edit there, not here.

# The app's pool is 5; the monitor, backups and a psql session are a few more.
# Each allowed connection reserves memory whether used or not.
max_connections = ${MAX_CONN}

shared_buffers = ${SHARED}MB
effective_cache_size = ${CACHE}MB
maintenance_work_mem = ${MAINT}MB
work_mem = ${WORK}MB

# EBS is SSD: random reads cost about what sequential ones do.
random_page_cost = 1.1
effective_io_concurrency = 200

# Fewer, smoother checkpoints.
wal_buffers = 16MB
min_wal_size = 256MB
max_wal_size = 1GB
checkpoint_completion_target = 0.9

max_worker_processes = ${WORKERS}
max_parallel_workers = ${WORKERS}
max_parallel_workers_per_gather = $(( WORKERS / 2 ))

# Short OLTP queries: compiling them costs more than it saves.
jit = off

# Small tables that change often: vacuum and re-plan them sooner.
autovacuum_vacuum_scale_factor = 0.05
autovacuum_analyze_scale_factor = 0.02

# A transaction left open holds locks and blocks vacuum; nothing here holds one
# for ten minutes on purpose.
idle_in_transaction_session_timeout = '10min'

# What to look at when something is slow.
log_min_duration_statement = 500ms
log_lock_waits = on
log_temp_files = 0
log_checkpoints = on
log_autovacuum_min_duration = 10s
track_io_timing = on
EOF
)

say "$NEW" | sed 's/^/  /'
[ "$DRY" = 1 ] && { say ""; say "Dry run: nothing changed."; exit 0; }

BACKUP=""
if [ -f "$TUNE_FILE" ]; then
  BACKUP="$TUNE_FILE.$(date +%Y%m%d%H%M%S).bak"
  cp "$TUNE_FILE" "$BACKUP"
fi
printf '%s\n' "$NEW" > "$TUNE_FILE"
chown postgres:postgres "$TUNE_FILE"

# Parse the whole configuration before restarting: -C reads every file and
# fails on a bad one, so a typo never takes the database down.
if ! sudo -u postgres "$BIN/postgres" -D "/var/lib/postgresql/$PG_VERSION/main" -c config_file="$CONF_FILE" -C shared_buffers >/dev/null 2>&1; then
  say "Postgres rejects the new settings; putting the old ones back."
  if [ -n "$BACKUP" ]; then mv "$BACKUP" "$TUNE_FILE"; else rm -f "$TUNE_FILE"; fi
  exit 1
fi

say ""
say "Restarting Postgres (a few seconds of downtime)…"
systemctl restart postgresql
for _ in $(seq 1 30); do
  pg_isready -q && break
  sleep 1
done
if ! pg_isready -q; then
  say "Postgres did not come back; restoring the previous settings."
  if [ -n "$BACKUP" ]; then mv "$BACKUP" "$TUNE_FILE"; else rm -f "$TUNE_FILE"; fi
  systemctl restart postgresql
  die "restored; check: journalctl -u postgresql@${PG_VERSION}-main -n 50"
fi

# The app's pool reconnects by itself; a restart just makes it clean.
systemctl restart reviewslip 2>/dev/null || true

say ""
say "Done. In force now:"
# With where each value came from: a setting made earlier with ALTER SYSTEM
# (postgresql.auto.conf) is read after conf.d and wins over it.
sudo -u postgres psql -Atc "SELECT name || ' = ' || setting || coalesce(unit, '') || '   (' || coalesce(sourcefile, source) || ')' FROM pg_settings WHERE name IN ('max_connections','shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','random_page_cost','jit') ORDER BY name" | sed 's/^/  /'
if sudo -u postgres psql -Atc "SELECT 1 FROM pg_settings WHERE sourcefile LIKE '%postgresql.auto.conf' LIMIT 1" | grep -q 1; then
  say ""
  say "Some settings come from postgresql.auto.conf (set earlier with ALTER SYSTEM) and override this file."
  say "To let this file decide: sudo -u postgres psql -c \"ALTER SYSTEM RESET ALL\" && sudo systemctl restart postgresql"
fi
say ""
free -m
