'use strict';

require('dotenv').config();

const { pool, ready, tx } = require('../db');
const nights = require('../nights');
const crypto = require('crypto');
const steps = require('./demo-steps');

/**
 * Demo venues for the marketplace, so reviewslip.com/stays has something to
 * show before real venues list themselves.
 *
 *   node scripts/seed-demo-marketplace.js --dry-run   show what it would do
 *   node scripts/seed-demo-marketplace.js             create, fill and list them
 *   node scripts/seed-demo-marketplace.js --unlist    take them off the marketplace, keep them
 *   node scripts/seed-demo-marketplace.js --list      put them back
 *   node scripts/seed-demo-marketplace.js --remove    delete them and everything in them
 *
 * Six venues in six places, each with rooms, rates (weekend and high-season
 * prices), photos, reviews, a calendar of bookings and a few marketplace
 * bookings — enough for search, filters, sorting, the venue page, checkout and
 * cancelling to all have something to do.
 *
 * They are on the public site, so they say what they are: every name ends
 * "(demo)" and every description says bookings there are not real. They have
 * no owner account, so nobody is emailed when a guest books one. Their slugs
 * end in -test, so the other scripts treat them as test venues too.
 *
 * Running it again skips venues that already exist.
 */

const DEMO_NOTE = '\n\nThis is a demo venue to show how booking on Reviewslip works. Bookings here are not real.';

function type(name, capacity, rooms, prefix, base, description, bed, sizeSqm, amenities) {
  return { name, capacity, rooms, prefix, base, profile: { description, bed, sizeSqm, amenities } };
}

function profile(about, amenities, deposit) {
  return {
    about: about + DEMO_NOTE,
    amenities,
    contact: { phone: '+66 80 000 0000', email: 'demo@example.com', line: '', whatsapp: '' },
    checkIn: '14:00',
    checkOut: '12:00',
    payment: deposit ? { mode: 'deposit', depositPct: deposit } : { mode: 'full', depositPct: null },
  };
}

const VENUES = [
  {
    slug: 'demo-teakhouse-test',
    name: 'Old City Teak House (demo)',
    place: 'Old City, Chiang Mai',
    lean: 4.7,
    profile: profile('A restored teak house inside the old city moat, a short walk from Wat Phra Singh and the Sunday walking street.', ['wifi', 'breakfast', 'garden', 'aircon', 'laundry', 'airport'], 30),
    types: [
      type('Courtyard Room', 2, 4, 'C', 1500, 'Opens onto the frangipani courtyard. Teak floors, rain shower.', '1 queen bed', 22, ['aircon', 'wifi', 'shower', 'kettle']),
      type('Teak Suite', 3, 2, 'T', 2900, 'The upstairs suite with a sitting room and a balcony over the lane.', '1 king bed and 1 sofa bed', 40, ['aircon', 'wifi', 'balcony', 'bathtub', 'tv', 'fridge']),
    ],
  },
  {
    slug: 'demo-pai-test',
    name: 'Pai Valley Huts (demo)',
    place: 'Pai, Mae Hong Son',
    lean: 4.4,
    profile: profile('Bamboo huts among rice fields, ten minutes by scooter from Pai walking street. Hammocks, a fire pit and mountain views.', ['wifi', 'parking', 'garden', 'restaurant', 'pets'], null),
    types: [
      type('Bamboo Hut', 2, 5, 'H', 850, 'A simple hut on stilts with a fan, a mosquito net and a porch facing the hills.', '1 double bed', 16, ['fan', 'wifi', 'terrace', 'view']),
      type('Family Hut', 4, 2, 'F', 1600, 'Two rooms under one roof, with an outdoor shower.', '1 double bed and 2 single beds', 32, ['fan', 'wifi', 'terrace', 'shower']),
    ],
  },
  {
    slug: 'demo-sukhumvit-test',
    name: 'Sukhumvit Loft Hotel (demo)',
    place: 'Sukhumvit, Bangkok',
    lean: 4.2,
    profile: profile('A small design hotel two minutes from BTS Asok, with a rooftop pool and a 24-hour front desk.', ['wifi', 'pool', 'gym', 'restaurant', 'frontdesk24', 'aircon', 'laundry'], null),
    types: [
      type('Loft Double', 2, 6, 'L', 2200, 'Floor-to-ceiling windows over the city, a work desk and blackout curtains.', '1 king bed', 28, ['aircon', 'wifi', 'tv', 'desk', 'safe', 'shower']),
      type('Skyline Suite', 2, 2, 'S', 4800, 'Corner suite on the top floor with a bathtub by the window.', '1 king bed', 52, ['aircon', 'wifi', 'tv', 'bathtub', 'view', 'fridge', 'desk']),
    ],
  },
  {
    slug: 'demo-kata-test',
    name: 'Kata Beach Bungalows (demo)',
    place: 'Kata Beach, Phuket',
    lean: 4.6,
    profile: profile('Garden bungalows a three-minute walk from Kata beach, with a pool, a beach bar and scooters to rent.', ['wifi', 'pool', 'restaurant', 'breakfast', 'parking', 'airport', 'family'], 50),
    types: [
      type('Garden Bungalow', 2, 5, 'G', 2600, 'A private bungalow in the tropical garden with a terrace and an outdoor shower.', '1 king bed', 30, ['aircon', 'wifi', 'terrace', 'shower', 'fridge']),
      type('Pool Villa', 4, 2, 'V', 7900, 'Two bedrooms around a private plunge pool.', '1 king bed and 2 single beds', 85, ['aircon', 'wifi', 'tv', 'kitchenette', 'terrace', 'bathtub']),
    ],
  },
  {
    slug: 'demo-aonang-test',
    name: 'Ao Nang Cliff Lodge (demo)',
    place: 'Ao Nang, Krabi',
    lean: 4.3,
    profile: profile('A lodge under the limestone cliffs, with long-tail boats to Railay from the beach below.', ['wifi', 'pool', 'restaurant', 'spa', 'shuttle', 'aircon'], 30),
    types: [
      type('Cliff View Room', 2, 5, 'R', 1900, 'Balcony facing the karst cliffs; best at sunset.', '1 queen bed', 26, ['aircon', 'wifi', 'balcony', 'view', 'shower']),
      type('Family Room', 4, 2, 'F', 3200, 'Space for four, with a sofa corner and a fridge.', '2 double beds', 38, ['aircon', 'wifi', 'tv', 'fridge', 'shower']),
    ],
  },
  {
    slug: 'demo-huahin-test',
    name: 'Hua Hin Seaside Inn (demo)',
    place: 'Hua Hin, Prachuap Khiri Khan',
    lean: 3.9,
    profile: profile('A family inn across the road from the beach, near the night market and the railway station.', ['wifi', 'parking', 'breakfast', 'family', 'laundry'], null),
    types: [
      type('Sea Breeze Room', 2, 6, 'B', 1300, 'Simple and bright, with a small balcony and a glimpse of the sea.', '1 double bed', 20, ['aircon', 'wifi', 'balcony', 'shower']),
      type('Family Suite', 4, 2, 'F', 2400, 'Two rooms and a kitchenette for longer stays.', '1 double bed and 2 single beds', 42, ['aircon', 'wifi', 'kitchenette', 'tv']),
    ],
  },
];

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => [a.slice(2), true]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ready;

  const slugs = VENUES.map((v) => v.slug);
  const log = (line) => console.log(`    ${line}`);
  const ROLLBACK = Object.assign(new Error('dry run'), { dryRun: true });
  const today = nights.todayAt('Asia/Bangkok');

  try {
    await tx(async (c) => {
      if (args.remove) {
        const { rows } = await c.query('SELECT id, name FROM subscribers WHERE slug = ANY($1)', [slugs]);
        const ids = rows.map((r) => r.id);
        // Bookings first: a booking's room type is ON DELETE RESTRICT, so the
        // venue's cascade could otherwise reach the room types before them.
        const b = await c.query('DELETE FROM bookings WHERE subscriber_id = ANY($1)', [ids]);
        await c.query('DELETE FROM subscribers WHERE id = ANY($1)', [ids]);
        console.log(`Removed ${rows.length} demo venue${rows.length === 1 ? '' : 's'} and ${b.rowCount} bookings.`);
      } else if (args.list || args.unlist) {
        const r = await c.query('UPDATE subscribers SET market_listed = $2 WHERE slug = ANY($1)', [slugs, Boolean(args.list)]);
        console.log(`${args.list ? 'Listed' : 'Unlisted'} ${r.rowCount} demo venue${r.rowCount === 1 ? '' : 's'}.`);
      } else {
        for (const [index, v] of VENUES.entries()) {
          const { rows: [existing] } = await c.query('SELECT id FROM subscribers WHERE slug = $1', [v.slug]);
          if (existing) {
            console.log(`  ${v.name}: already there, skipped`);
            continue;
          }
          console.log(`  ${v.name} — ${v.place}`);
          // Made here rather than through subscribers.create, which writes
          // through the pool and so outside this transaction. The token is the
          // hash of random bytes nobody is shown: a demo venue has no owner and
          // nothing to configure with one.
          const at = new Date().toISOString();
          const { rows: [venue] } = await c.query(
            `INSERT INTO subscribers (slug, name, status, token_hash, created_at, updated_at, currency, place)
             VALUES ($1, $2, 'active', $3, $4, $4, 'THB', $5) RETURNING *`,
            [v.slug, v.name, crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), at, v.place]
          );
          await steps.ensureRooms(c, venue, log, v.types);
          await steps.ensureRoomsProfileAndRates(c, venue, today, log, v.types);
          await steps.ensureListingDetails(c, venue, log, { profile: v.profile, place: v.place, photoOffset: index * 2 });
          await steps.seedReviews(c, venue, log, { count: 12 + index * 3, lean: v.lean });
          // Emptier than the test venue's calendar: on a results page every
          // card saying "only 1 left" stops meaning anything.
          await steps.seedCalendar(c, venue, today, log, { maxGap: 10 });
          await steps.seedMarketplace(c, venue, today, log);
          await c.query('UPDATE subscribers SET market_listed = true WHERE id = $1', [venue.id]);
          log('listed on the marketplace');
        }
      }
      if (args['dry-run']) throw ROLLBACK;
    });
  } catch (err) {
    if (!err.dryRun) throw err;
    console.log('Dry run: rolled back, nothing saved.');
    return;
  }

  if (!args.remove && !args.unlist) {
    const site = String(process.env.SITE_URL || 'https://reviewslip.com').replace(/\/$/, '');
    console.log(`\nSee them at ${site}/stays — remove them all with: node scripts/seed-demo-marketplace.js --remove`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
