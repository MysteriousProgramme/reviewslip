#!/usr/bin/env bash
#
# One Postgres dump, uploaded to S3. Run by reviewslip-backup.timer.
#
# What is in this dump matters more than usual. The subscribers table holds
# every venue's OpenRouter key in plain text, and the accounts table holds
# customer emails and password hashes — so this file is the most sensitive
# object the business owns, and the bucket it lands in has to be treated that
# way. See "Backups" in the README for the bucket and IAM setup that goes with
# this script; without it, this is an unencrypted copy of every key you hold
# sitting in a bucket somebody might make public by accident.
#
# Deliberately does not delete anything. Retention belongs in an S3 lifecycle
# rule, which is declarative and reversible, rather than in a shell script that
# runs unattended at 3am with the ability to remove things.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/reviewslip}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"

fail() {
  echo "backup: $*" >&2
  exit 1
}

# Read one value out of the .env the app itself uses, rather than keeping a
# second copy of the connection string somewhere that can drift from it.
#
# Parsed rather than sourced: sourcing runs whatever is in the file, and a `$`
# or a backtick in a password would be executed instead of read. Last assignment
# wins, matching how dotenv parses.
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" \
    | tail -n 1 \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# The environment wins over the file, so a one-off run can point somewhere else
# without editing anything.
DATABASE_URL="${DATABASE_URL:-$(env_value DATABASE_URL)}"
BACKUP_S3_URI="${BACKUP_S3_URI:-$(env_value BACKUP_S3_URI)}"
BACKUP_KMS_KEY_ID="${BACKUP_KMS_KEY_ID:-$(env_value BACKUP_KMS_KEY_ID)}"
BACKUP_HEARTBEAT_URL="${BACKUP_HEARTBEAT_URL:-$(env_value BACKUP_HEARTBEAT_URL)}"

[ -n "$DATABASE_URL" ] || fail "DATABASE_URL is not set in $ENV_FILE or the environment."
[ -n "$BACKUP_S3_URI" ] || fail "BACKUP_S3_URI is not set. Add it to $ENV_FILE, e.g. s3://my-bucket"

# s3://bucket/prefix -> bucket, prefix. Needed because head-object below takes
# them separately, and that check is the only proof the upload actually landed.
rest="${BACKUP_S3_URI#s3://}"
[ "$rest" != "$BACKUP_S3_URI" ] || fail "BACKUP_S3_URI must start with s3://"
bucket="${rest%%/*}"
prefix="${rest#"$bucket"}"
prefix="${prefix#/}"
prefix="${prefix%/}"

command -v pg_dump >/dev/null 2>&1 || fail "pg_dump not found. apt install postgresql-client"
command -v aws >/dev/null 2>&1 || fail "aws not found. Install the AWS CLI."

# The database's own name, read off the connection string rather than written
# in here. It becomes both the folder and the start of the filename, so an
# object says which database it holds without anyone having to remember which
# box wrote it — and a second database on the same box lands beside this one
# instead of overwriting it.
#
# Everything after the last slash, minus any ?query. Reduced to the characters
# a database name can actually contain, so a malformed URL cannot put a slash
# or a space into an object key.
db="${DATABASE_URL##*/}"
db="${db%%\?*}"
db="$(printf '%s' "$db" | tr -cd 'A-Za-z0-9_-')"
[ -n "$db" ] || fail "could not read a database name out of DATABASE_URL."

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
name="$db-$stamp.dump"
key="${prefix:+$prefix/}$db/$name"

# In /var/tmp rather than /tmp: /tmp is often a tmpfs sized as a fraction of
# RAM, and this box is small. A dump that grows past it would fail at 3am with
# a message about no space rather than anything useful.
tmp="$(mktemp /var/tmp/reviewslip-backup.XXXXXX)"
chmod 600 "$tmp"
trap 'rm -f "$tmp"' EXIT

# --format=custom is compressed already, and lets pg_restore pull one table out
# of it rather than forcing an all-or-nothing restore. --no-owner and
# --no-privileges so it restores cleanly into a database with a different role
# name, which is what a restore onto a fresh box actually is.
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$tmp"

# A dump pg_restore cannot read is not a backup, and the difference is only
# discoverable on the day it matters unless something checks. This reads the
# archive's table of contents, which is enough to catch a truncated or corrupt
# file without the cost of a full restore.
pg_restore --list "$tmp" >/dev/null 2>&1 \
  || fail "pg_dump produced a file pg_restore cannot read. Not uploading it."

bytes="$(stat -c %s "$tmp" 2>/dev/null || stat -f %z "$tmp")"
[ "$bytes" -gt 1024 ] || fail "dump is only $bytes bytes — something is wrong."

# Server-side encryption either way. KMS when a key is given, because a key
# policy can let this box *write* backups it is not allowed to read back —
# which is what you want from a machine that faces the internet.
if [ -n "$BACKUP_KMS_KEY_ID" ]; then
  sse=(--sse aws:kms --sse-kms-key-id "$BACKUP_KMS_KEY_ID")
else
  sse=(--sse AES256)
fi

aws s3 cp "$tmp" "s3://$bucket/$key" "${sse[@]}" --only-show-errors

# Trust but verify. `aws s3 cp` exiting zero means the request was accepted;
# comparing the stored length is what says the object is actually there and
# whole.
remote="$(aws s3api head-object --bucket "$bucket" --key "$key" \
  --query ContentLength --output text)"
[ "$remote" = "$bytes" ] \
  || fail "uploaded object is $remote bytes, expected $bytes."

echo "backup: s3://$bucket/$key ($bytes bytes)"

# A backup that silently stops running is worse than no backup, because you
# believe in it. If a heartbeat URL is set — healthchecks.io, BetterStack, any
# dead-man's switch — this is the only thing that pings it, so a failed or
# skipped run alerts by not arriving.
if [ -n "$BACKUP_HEARTBEAT_URL" ]; then
  curl -fsS -m 10 --retry 3 "$BACKUP_HEARTBEAT_URL" >/dev/null \
    || echo "backup: uploaded, but the heartbeat ping failed" >&2
fi
