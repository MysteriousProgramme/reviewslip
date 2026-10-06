'use strict';

require('dotenv').config();

const { pool, ready, tx } = require('../db');
const nights = require('../nights');
const steps = require('./demo-steps');

/**
 * Dummy booking data for a test venue: everything the booking screens and the
 * marketplace read, so a copied venue can be clicked through end to end.
 *
 *   node scripts/seed-test-venue.js --slug baanponglodge-test --dry-run
 *   node scripts/seed-test-venue.js --slug baanponglodge-test
 *   node scripts/seed-test-venue.js --slug baanponglodge-test --remove
 *
 * What it adds, only where the venue has none already:
 *   - room types and rooms (to at least eight rooms)
 *   - rates for each room type: a room-only and a bed-and-breakfast plan, with
 *     weekend and high-season prices, a closed night and a minimum stay
 *   - Online Booking details: description, amenities, contact, payment, room
 *     descriptions, rate terms, and placeholder photos
 *   - about four months of priced bookings across the calendar, every status
 *   - marketplace bookings with references, some still free to cancel
 *   - a few rooms left dirty for the housekeeping board
 *
 * Every booking it writes is `source = 'demo'`, which is what --remove deletes.
 * It does not list the venue on the marketplace — a "(test)" venue showing to
 * real guests on reviewslip.com is the one thing this must not do. Pass
 * --list on its own to list it, and --unlist to take it off again.
 *
 * Refuses any venue whose slug does not end in -test: these rows look exactly
 * like real bookings on every screen.
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

/* ------------------------------------------------------------------ run */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const slug = String(args.slug || '').trim().toLowerCase();
  if (!slug) {
    console.error('Usage: node scripts/seed-test-venue.js --slug <venue>-test [--dry-run] | --list | --unlist | --remove');
    process.exit(1);
  }
  if (!slug.endsWith('-test')) {
    console.error(`"${slug}" does not end in -test. This writes bookings that look real on every screen; it only runs on test venues.`);
    process.exit(1);
  }

  await ready;
  const { rows: [venue] } = await pool.query('SELECT * FROM subscribers WHERE slug = $1', [slug]);
  if (!venue) {
    const { rows } = await pool.query('SELECT slug FROM subscribers ORDER BY slug');
    console.error(`No venue called "${slug}". There is: ${rows.map((r) => r.slug).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const log = (line) => console.log(`  ${line}`);
  const today = nights.todayAt(venue.timezone || 'Asia/Bangkok');
  const ROLLBACK = Object.assign(new Error('dry run'), { dryRun: true });

  console.log(`${venue.name} (${slug})${args['dry-run'] ? ' — dry run, nothing will be saved' : ''}`);

  let made = [];
  try {
    await tx(async (c) => {
      if (args.remove) {
        const r = await c.query('DELETE FROM bookings WHERE subscriber_id = $1 AND source = $2', [venue.id, steps.DEMO]);
        log(`removed ${r.rowCount} dummy bookings (their nights went with them)`);
        log('rooms, rates, photos and the profile are left; scripts/blank-venue.js clears a venue entirely');
      } else if (args.list) {
        await c.query('UPDATE subscribers SET market_listed = true WHERE id = $1', [venue.id]);
        log('online booking: LISTED on the marketplace — run --unlist when done');
      } else if (args.unlist) {
        await c.query('UPDATE subscribers SET market_listed = false WHERE id = $1', [venue.id]);
        log('online booking: taken off the marketplace');
      } else {
        const { rows: [{ n }] } = await c.query(
          'SELECT count(*)::int AS n FROM bookings WHERE subscriber_id = $1 AND source = $2',
          [venue.id, steps.DEMO]
        );
        if (n > 0) {
          throw Object.assign(new Error(`Already has ${n} dummy bookings. Run with --remove first, then again.`), { plain: true });
        }
        await steps.ensureRooms(c, venue, log);
        await steps.ensureRoomsProfileAndRates(c, venue, today, log);
        await steps.ensureListingDetails(c, venue, log);
        await steps.seedCalendar(c, venue, today, log);
        made = await steps.seedMarketplace(c, venue, today, log);
        await steps.dirtyRooms(c, venue, log);
      }
      if (args['dry-run']) throw ROLLBACK;
    });
  } catch (err) {
    if (err.plain) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    if (!err.dryRun) throw err;
    console.log('Dry run: rolled back.');
    return;
  }

  if (made.length) {
    const site = String(process.env.SITE_URL || 'https://reviewslip.com').replace(/\/$/, '');
    console.log('\nMarketplace booking pages (open one to try cancelling):');
    for (const m of made) {
      console.log(`  ${m.reference}  ${m.arrival}  ${m.plan.padEnd(16)} ${m.key ? `${site}/stays/booking/${m.reference}?k=${m.key}` : '(SECRET_KEY not set: no link)'}`);
    }
  }
  if (!args.remove && !args.unlist && !args.list && !venue.market_listed) {
    console.log(`\nNot listed on the marketplace. To see it at /stays: node scripts/seed-test-venue.js --slug ${slug} --list`);
  }
  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
