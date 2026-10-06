'use strict';

require('dotenv').config();

const zlib = require('zlib');

const { pool, ready, tx } = require('../db');
const nights = require('../nights');
const rates = require('../rates');
const market = require('../market');

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

const DEMO = 'demo';

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

/* ------------------------------------------------------------- the data */

const ROOM_TYPES = [
  {
    name: 'Garden Bungalow', capacity: 2, rooms: 4, prefix: 'G', base: 1800,
    profile: { description: 'A teak bungalow in the garden with its own veranda, a short walk from the pool.', bed: '1 queen bed', sizeSqm: 26, amenities: ['aircon', 'wifi', 'shower', 'kettle', 'terrace'] },
  },
  {
    name: 'River View Room', capacity: 2, rooms: 3, prefix: 'R', base: 2400,
    profile: { description: 'Upstairs in the main house, with a balcony over the river and the hills behind.', bed: '1 king bed', sizeSqm: 30, amenities: ['aircon', 'wifi', 'balcony', 'view', 'bathtub', 'fridge'] },
  },
  {
    name: 'Family Suite', capacity: 4, rooms: 2, prefix: 'F', base: 3600,
    profile: { description: 'Two rooms and a sitting area for a family: a king bed and two singles, with a kitchenette.', bed: '1 king bed and 2 single beds', sizeSqm: 48, amenities: ['aircon', 'wifi', 'tv', 'kitchenette', 'fridge', 'shower'] },
  },
];

const PROFILE = {
  about:
    'A family-run lodge in a teak house by the river, twenty minutes from Chiang Mai old city.\n' +
    'Breakfast on the terrace, bikes to borrow, and the San Kamphaeng hot springs down the road.\n\n' +
    'This is a test venue with dummy data.',
  amenities: ['wifi', 'parking', 'pool', 'restaurant', 'breakfast', 'garden', 'airport', 'laundry', 'family'],
  contact: { phone: '+66 80 000 0000', email: 'test@example.com', line: '@reviewslip-test', whatsapp: '+66800000000' },
  checkIn: '14:00',
  checkOut: '11:00',
  payment: { mode: 'deposit', depositPct: 30 },
};

const FIRSTS = ['Anna', 'Tom', 'Priya', 'Wei', 'Somchai', 'Maria', 'Jonas', 'Yuki', 'Alexander', 'Fatima',
  'Diego', 'Nadia', 'Ravi', 'Ingrid', 'Kwame', 'Elena', 'Hiroshi', 'Amara', 'Lukas', 'Chen', 'Napat', 'Siriporn'];
const LASTS = ['Lindqvist', 'Becker', 'Raman', 'Zhang', 'Preecha', 'Oduya', 'Meyer', 'Tanaka', 'Sterling',
  'Haddad', 'Alvarez', 'Petrova', 'Kapoor', 'Berg', 'Mensah', 'Rossi', 'Yamada', 'Okafor', 'Novak', 'Lim', 'Wongsakul'];
const NOTES = ['Late arrival, around 10pm.', 'Celebrating an anniversary.', 'Vegetarian breakfast, please.',
  'Needs airport pickup.', 'Quiet room if possible.', 'Travelling with a baby — cot please.'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

function guest() {
  const first = pick(FIRSTS);
  const last = pick(LASTS);
  return {
    name: `${first} ${last}`,
    // example.test: a reserved domain, so nothing ever mails a real person.
    email: `${first}.${last}${between(1, 999)}@example.test`.toLowerCase(),
    phone: `+66 8${between(1, 9)} ${between(100, 999)} ${between(1000, 9999)}`,
  };
}

/** A small placeholder PNG: sky, sun and hills in a palette. Not a real photo, and does not pretend to be. */
function png(seed) {
  const palettes = [
    [[135, 190, 230], [220, 200, 150], [255, 220, 120]],
    [[250, 180, 120], [120, 80, 120], [255, 240, 200]],
    [[90, 150, 120], [40, 80, 60], [240, 230, 180]],
    [[200, 220, 240], [100, 140, 170], [255, 255, 230]],
    [[60, 60, 110], [180, 120, 90], [255, 200, 140]],
    [[170, 210, 190], [70, 110, 90], [250, 250, 220]],
  ];
  const [top, bottom, sun] = palettes[seed % palettes.length];
  const w = 640;
  const h = 420;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = y / h;
      let c = top.map((v, i) => Math.round(v + (bottom[i] - v) * t));
      const dx = x - w * (0.25 + (seed % 3) * 0.25);
      const dy = y - h * 0.3;
      if (dx * dx + dy * dy < (h * 0.11) ** 2) c = sun;
      if (y > h * 0.62 + Math.sin(x / (30 + seed * 4)) * 18) c = c.map((v) => Math.round(v * 0.45));
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const file = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${file.toString('base64')}`;
}

/* ---------------------------------------------------------------- steps */

async function ensureRooms(c, venue, log) {
  const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM rooms WHERE subscriber_id = $1', [venue.id]);
  if (n >= 8) {
    log(`rooms: has ${n} already, left alone`);
    return;
  }
  let made = 0;
  for (const type of ROOM_TYPES) {
    await c.query(
      `INSERT INTO room_groups (subscriber_id, name, capacity) VALUES ($1, $2, $3)
       ON CONFLICT (subscriber_id, lower(name)) DO NOTHING`,
      [venue.id, type.name, type.capacity]
    );
    const { rows: [group] } = await c.query(
      'SELECT id FROM room_groups WHERE subscriber_id = $1 AND lower(name) = lower($2)',
      [venue.id, type.name]
    );
    for (let i = 1; i <= type.rooms; i++) {
      const r = await c.query(
        `INSERT INTO rooms (subscriber_id, group_id, name, sort) VALUES ($1, $2, $3, $4)
         ON CONFLICT (subscriber_id, lower(name)) DO NOTHING`,
        [venue.id, group.id, `${type.prefix}${String(i).padStart(2, '0')}`, i]
      );
      made += r.rowCount;
    }
  }
  log(`rooms: added ${made}`);
}

/**
 * A room type this script did not create — a copied venue's own — described
 * from its own name and size, so nothing says "river view" about a garden room.
 */
function roomFor(group) {
  const big = group.capacity >= 3;
  return {
    base: big ? 3600 : 2000,
    profile: {
      description: `The ${group.name}: air conditioning, a private bathroom with a hot shower, and fast Wi-Fi. Sleeps ${group.capacity}.`,
      bed: big ? '1 king bed and 2 single beds' : '1 king bed',
      sizeSqm: big ? 45 : 28,
      amenities: big ? ['aircon', 'wifi', 'tv', 'fridge', 'shower'] : ['aircon', 'wifi', 'kettle', 'shower'],
    },
  };
}

/** Room descriptions where empty, two rates per room type where it has none. */
async function ensureRoomsProfileAndRates(c, venue, today, log) {
  const { rows: groups } = await c.query('SELECT * FROM room_groups WHERE subscriber_id = $1 ORDER BY id', [venue.id]);
  let plansMade = 0;
  let profiles = 0;
  for (const g of groups) {
    const known = ROOM_TYPES.find((t) => t.name.toLowerCase() === g.name.toLowerCase()) ?? roomFor(g);
    if (!g.profile) {
      const checked = market.validateRoomProfile(known.profile);
      await c.query('UPDATE room_groups SET profile = $2 WHERE id = $1', [g.id, JSON.stringify(checked.room)]);
      profiles++;
    }

    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM rate_plans WHERE group_id = $1', [g.id]);
    if (n > 0) continue;

    const base = known.base * 100;
    const plans = [
      { name: 'Room only', base, breakfast: false, cancelDays: null },
      { name: 'Bed & breakfast', base: base + 40000, breakfast: true, cancelDays: 3 },
    ];
    for (const p of plans) {
      const { rows: [plan] } = await c.query(
        `INSERT INTO rate_plans (subscriber_id, group_id, name, base_minor, breakfast, cancel_days)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [venue.id, g.id, p.name, p.base, p.breakfast, p.cancelDays]
      );
      plansMade++;

      // Weekends a fifth dearer, the new-year fortnight forty percent, for the
      // next five months; New Year's Eve two nights minimum; one night closed.
      const rows = [];
      for (let d = 0; d < 150; d++) {
        const night = nights.addDays(today, d);
        const date = new Date(`${night}T00:00:00Z`);
        const weekday = date.getUTCDay();
        const md = night.slice(5);
        let factor = 1;
        if (md >= '12-20' || md <= '01-05') factor = 1.4;
        else if (weekday === 5 || weekday === 6) factor = 1.2;
        const minNights = md === '12-31' ? 2 : null;
        if (factor !== 1 || minNights) rows.push([night, Math.round((p.base * factor) / 100) * 100, minNights]);
      }
      for (const [night, amount, minNights] of rows) {
        await c.query(
          `INSERT INTO rate_nights (subscriber_id, plan_id, night, amount_minor, min_nights)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (plan_id, night) DO NOTHING`,
          [venue.id, plan.id, night, amount, minNights]
        );
      }
      await c.query(
        `INSERT INTO rate_nights (subscriber_id, plan_id, night, closed)
         VALUES ($1, $2, $3, true) ON CONFLICT (plan_id, night) DO UPDATE SET closed = true`,
        [venue.id, plan.id, nights.addDays(today, 45)]
      );
    }
  }
  await c.query("UPDATE subscribers SET currency = coalesce(currency, 'THB') WHERE id = $1", [venue.id]);
  log(`rates: added ${plansMade} plan${plansMade === 1 ? '' : 's'}; room descriptions: ${profiles}`);
}

async function ensureListingDetails(c, venue, args, log) {
  if (!venue.market_profile) {
    const checked = market.validateProfile(PROFILE);
    await c.query(
      "UPDATE subscribers SET market_profile = $2, place = coalesce(place, 'San Kamphaeng, Chiang Mai') WHERE id = $1",
      [venue.id, JSON.stringify(checked.profile)]
    );
    log('online booking: profile written');
  } else {
    log('online booking: has a profile already, left alone');
  }

  const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM market_photos WHERE subscriber_id = $1', [venue.id]);
  if (n > 0) {
    log(`photos: has ${n} already, left alone`);
    return;
  }
  let seed = 0;
  for (let i = 0; i < 4; i++) {
    await c.query('INSERT INTO market_photos (subscriber_id, data, sort) VALUES ($1, $2, $3)', [venue.id, png(seed++), i]);
  }
  const { rows: groups } = await c.query('SELECT id FROM room_groups WHERE subscriber_id = $1', [venue.id]);
  for (const g of groups) {
    for (let i = 0; i < 2; i++) {
      await c.query('INSERT INTO market_photos (subscriber_id, group_id, data, sort) VALUES ($1, $2, $3, $4)', [venue.id, g.id, png(seed++), i]);
    }
  }
  log(`photos: added ${seed} placeholders`);
}

async function priceOf(c, venueId, planId, arrival, departure) {
  const list = nights.nightsBetween(arrival, departure);
  const price = (await rates.pricesOn(c, { subscriberId: venueId, list, planIds: [planId] })).get(planId);
  return price?.totalMinor ?? null;
}

/**
 * The calendar: walk each room forward from six weeks ago to three months
 * ahead, laying stays end to end with gaps, never over a night somebody real
 * already holds. The status follows the dates, as a real one would.
 */
async function seedCalendar(c, venue, today, log) {
  const from = nights.addDays(today, -45);
  const to = nights.addDays(today, 90);
  const { rows: rooms } = await c.query(
    "SELECT id, group_id FROM rooms WHERE subscriber_id = $1 AND status = 'active' ORDER BY id",
    [venue.id]
  );
  const { rows: plans } = await c.query('SELECT id, group_id FROM rate_plans WHERE subscriber_id = $1', [venue.id]);
  const counts = {};
  let skipped = 0;

  for (const room of rooms) {
    const roomPlans = plans.filter((p) => p.group_id === room.group_id);
    let day = nights.addDays(from, between(0, 4));
    while (day < to) {
      const len = between(1, 6);
      const departure = nights.addDays(day, len);
      if (departure >= to) break;

      let status;
      if (departure <= today) status = Math.random() < 0.08 ? 'no_show' : 'checked_out';
      else if (day <= today) status = 'in_house';
      else status = Math.random() < 0.06 ? 'cancelled' : 'confirmed';
      const holds = ['confirmed', 'in_house', 'checked_out'].includes(status);

      if (holds) {
        const { rows: [taken] } = await c.query(
          'SELECT 1 FROM room_nights WHERE room_id = $1 AND night >= $2 AND night < $3 LIMIT 1',
          [room.id, day, departure]
        );
        if (taken) {
          skipped++;
          day = nights.addDays(departure, 1);
          continue;
        }
      }

      const who = guest();
      const plan = roomPlans.length ? pick(roomPlans) : null;
      const total = plan ? await priceOf(c, venue.id, plan.id, day, departure) : null;
      const { rows: [booking] } = await c.query(
        `INSERT INTO bookings
           (subscriber_id, group_id, room_id, guest_name, guest_email, guest_phone, adults, children,
            arrival, departure, status, source, notes, rate_plan_id, total_minor,
            cancelled_at, cancelled_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 CASE WHEN $11 = 'cancelled' THEN now() END, CASE WHEN $11 = 'cancelled' THEN 'venue' END)
         RETURNING id`,
        [venue.id, room.group_id, room.id, who.name, who.email, who.phone, between(1, 2),
          Math.random() < 0.2 ? 1 : 0, day, departure, status, DEMO,
          Math.random() < 0.15 ? pick(NOTES) : null, plan?.id ?? null, total]
      );
      if (holds) {
        await c.query(
          `INSERT INTO room_nights (subscriber_id, room_id, night, booking_id)
           SELECT $1, $2, night::date, $3 FROM unnest($4::text[]) AS night`,
          [venue.id, room.id, booking.id, nights.nightsBetween(day, departure)]
        );
      }
      counts[status] = (counts[status] || 0) + 1;
      day = nights.addDays(departure, between(0, 4));
    }
  }
  log(`calendar: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ')}${skipped ? `; stepped over ${skipped} spans already taken` : ''}`);
}

/**
 * Marketplace bookings: unassigned, as a channel's are, with references. Some
 * still inside their free-cancellation window, so cancelling online can be
 * tried; one on a non-refundable rate, so the refusal can be seen.
 */
async function seedMarketplace(c, venue, today, log) {
  const { rows: plans } = await c.query(
    `SELECT p.id, p.group_id, p.cancel_days, p.name, g.capacity FROM rate_plans p
       JOIN room_groups g ON g.id = p.group_id WHERE p.subscriber_id = $1 ORDER BY p.id`,
    [venue.id]
  );
  if (!plans.length) return [];
  const payment = market.parseProfile((await c.query('SELECT market_profile FROM subscribers WHERE id = $1', [venue.id])).rows[0].market_profile).payment;
  const made = [];

  for (let i = 0; i < 8; i++) {
    const plan = i === 0 ? plans.find((p) => p.cancel_days === null) ?? plans[0] : pick(plans);
    const arrival = nights.addDays(today, between(5, 60));
    const departure = nights.addDays(arrival, between(1, 4));
    const list = nights.nightsBetween(arrival, departure);
    const [free] = await rates.availabilityOn(c, { subscriberId: venue.id, list, groupId: plan.group_id });
    if (!free || free.free < 1) continue;
    const total = await priceOf(c, venue.id, plan.id, arrival, departure);
    if (total === null) continue;

    const who = guest();
    const reference = market.makeReference();
    await c.query(
      `INSERT INTO bookings
         (subscriber_id, group_id, guest_name, guest_email, guest_phone, adults, children,
          arrival, departure, status, source, notes, rate_plan_id, total_minor,
          reference, due_now_minor, payment_status, free_cancel_until)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,'confirmed',$9,$10,$11,$12,$13,$14,'not_connected',$15)`,
      [venue.id, plan.group_id, who.name, who.email, who.phone, Math.min(2, plan.capacity), arrival, departure,
        DEMO, Math.random() < 0.3 ? pick(NOTES) : null, plan.id, total, reference, market.dueNow(total, payment),
        market.freeCancelUntil({ arrival, cancelDays: plan.cancel_days, today })]
    );
    made.push({ reference, key: market.accessKeyFor(reference), arrival, plan: plan.name });
  }
  log(`marketplace: ${made.length} bookings with references`);
  return made;
}

async function dirtyRooms(c, venue, log) {
  const r = await c.query(
    `UPDATE rooms SET housekeeping = 'dirty'
      WHERE id IN (SELECT id FROM rooms WHERE subscriber_id = $1 AND status = 'active' ORDER BY random() LIMIT 3)`,
    [venue.id]
  );
  log(`housekeeping: ${r.rowCount} rooms marked dirty`);
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
        const r = await c.query('DELETE FROM bookings WHERE subscriber_id = $1 AND source = $2', [venue.id, DEMO]);
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
          [venue.id, DEMO]
        );
        if (n > 0) {
          throw Object.assign(new Error(`Already has ${n} dummy bookings. Run with --remove first, then again.`), { plain: true });
        }
        await ensureRooms(c, venue, log);
        await ensureRoomsProfileAndRates(c, venue, today, log);
        await ensureListingDetails(c, venue, args, log);
        await seedCalendar(c, venue, today, log);
        made = await seedMarketplace(c, venue, today, log);
        await dirtyRooms(c, venue, log);
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
