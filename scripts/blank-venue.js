'use strict';

require('dotenv').config();

const { pool, ready, tx } = require('../db');
const subscribers = require('../subscribers');

/**
 * Empty a venue and put its settings back to nothing, keeping the slug.
 *
 *   node scripts/blank-venue.js --slug baanponglodge            (shows what would go)
 *   node scripts/blank-venue.js --slug baanponglodge --confirm baanponglodge
 *
 * For a venue that has been used as a sandbox and now has to start clean: the
 * address, the token and the account stay, so the QR codes already printed
 * still work and nobody has to be told a new URL. Everything the venue has
 * accumulated goes, and so does everything it was configured with.
 *
 * Separate from clone-venue.js on purpose. A command that copies and wipes in
 * one go is a command that can wipe without having copied, and the only
 * protection against that is making the wipe its own deliberate act.
 *
 * It refuses to do anything without --confirm naming the slug again, and it
 * prints the counts first either way. There is no undo: the only way back is
 * the nightly dump in S3.
 */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/**
 * Deleted child-first, although every one of these cascades from the venue.
 *
 * The cascade would do it, but only if the venue row went with it — and the
 * venue row is the one thing being kept. So each table is named, which also
 * means the count printed beside it is a count of rows that actually went
 * rather than a number the database was trusted to produce.
 */
const TABLES = [
  'room_checks',
  'room_nights',
  'booking_guests',
  'bookings',
  'rate_nights',
  'rate_plans',
  'checklist_items',
  'rooms',
  'room_groups',
  'external_reviews',
  'review_events',
];

/**
 * What a venue is configured with, as opposed to what it is.
 *
 * `slug`, `name`, `status`, `account_id` and `token_hash` stay: those are the
 * venue's identity and the reason the printed QR codes keep working. The
 * OpenRouter key stays too — it is the account's key, not sandbox data, and
 * clearing it would mean the venue cannot write a review until somebody
 * pastes it back in.
 *
 * Everything else was drafted, generated or typed while the venue was being
 * used as a sandbox, and "back to a blank venue" means all of it.
 */
const CLEARED = [
  'google_url',
  'tripadvisor_url',
  'website_url',
  'line_url',
  'facebook_url',
  'xiaohongshu_url',
  'wongnai_url',
  'categories',
  'kind',
  'place',
  'safe_details',
  'context_doc',
  'theme',
  'font_display',
  'font_ui',
  'background',
  'source_text',
  'topic_labels',
  'platforms_off',
  'housekeeping_pin',
  // Both, because that is what switching the board off through the dashboard
  // does. Leaving the timestamp behind would have the panel reporting when a
  // PIN that no longer exists was last changed.
  'housekeeping_pin_at',
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const slug = String(args.slug || '').trim().toLowerCase();

  if (!slug) {
    console.error('Usage: node scripts/blank-venue.js --slug <slug> [--confirm <slug>]');
    process.exit(1);
  }

  await ready;

  const venue = await subscribers.get(slug);
  if (!venue) {
    const { rows } = await pool.query('SELECT slug FROM subscribers ORDER BY slug');
    console.error(
      `No venue called "${slug}". There is: ${rows.map((r) => r.slug).join(', ') || '(none)'}`
    );
    process.exit(1);
  }

  // Counted before anything is decided, so the same numbers are shown whether
  // this is the dry run or the real thing.
  const counts = [];
  for (const table of TABLES) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE subscriber_id = $1`,
      [venue.id]
    );
    counts.push({ table, n: rows[0].n });
  }

  const total = counts.reduce((sum, c) => sum + c.n, 0);

  console.log(`Venue "${slug}" — ${venue.name}`);
  console.log('');
  for (const { table, n } of counts) {
    if (n) console.log(`  ${String(n).padStart(6)}  ${table}`);
  }
  if (!total) console.log('  (no rows hanging off it)');
  console.log('');
  console.log(`  ${total} row${total === 1 ? '' : 's'} would be deleted, and ${CLEARED.length}`);
  console.log('  settings columns set to null — the theme, the logo, the topics,');
  console.log('  the context document, the review links and the housekeeping PIN.');
  console.log('');
  console.log('  Kept: the slug, the name, the account and the API key, so the');
  console.log('  address and any printed QR codes go on working.');

  if (args.confirm !== slug) {
    console.log('');
    console.log('Nothing was changed. To go ahead, and having checked the copy first:');
    console.log(`  node scripts/blank-venue.js --slug ${slug} --confirm ${slug}`);
    console.log('');
    console.log('There is no undo. The only way back is the nightly dump in S3.');
    return;
  }

  const stamp = new Date().toISOString();

  const deleted = await tx(async (c) => {
    const went = [];
    for (const table of TABLES) {
      const { rowCount } = await c.query(`DELETE FROM ${table} WHERE subscriber_id = $1`, [
        venue.id,
      ]);
      went.push({ table, n: rowCount });
    }

    // `updated_at` is a text column on this table, like created_at. now() would
    // write a value in a shape nothing else on the row uses.
    const sets = CLEARED.map((col, i) => `${col} = $${i + 2}`).join(', ');
    await c.query(
      `UPDATE subscribers SET ${sets}, updated_at = $${CLEARED.length + 2} WHERE id = $1`,
      [venue.id, ...CLEARED.map(() => null), stamp]
    );

    return went;
  });

  console.log('');
  console.log(`Blanked "${slug}".`);
  for (const { table, n } of deleted) {
    if (n) console.log(`  ${String(n).padStart(6)}  ${table} deleted`);
  }
  console.log('');
  console.log('The venue is still there and still answers on its own address.');
  console.log('It has no theme, no topics and no rooms until somebody sets them up.');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err.message);
    await pool.end();
    process.exit(1);
  });
