'use strict';

require('dotenv').config();

const crypto = require('crypto');

const { pool, ready, tx } = require('../db');
const subscribers = require('../subscribers');

/**
 * Copy a venue and everything hanging off it to a new slug.
 *
 *   node scripts/clone-venue.js --from baanponglodge --to baanponglodge-test
 *
 * For taking a working venue and making a sandbox out of it: the same rooms,
 * the same bookings, the same reviews, under a slug nobody has given to a
 * guest. What comes out is a venue that works — it has its own address and its
 * own token, and nothing about it points back at the original.
 *
 * Deliberately does not touch the source. Blanking a venue is blank-venue.js,
 * and it is a separate file for one reason: a command that copies and wipes in
 * one go is a command that can wipe without having copied. Run this, look at
 * what you got, then run the other one.
 *
 * Eleven tables hang off a venue and most of them point at each other, so this
 * is not eleven INSERT ... SELECTs. Each is copied in dependency order and
 * every new id is remembered, because a booking copied without remapping its
 * room_id is a booking in the original venue's room.
 *
 * Which columns need remapping is read out of the database rather than listed
 * here. That is not cleverness for its own sake: the hand written list had
 * `bookings.room_id` and `bookings.rate_plan_id` and quietly missed
 * `bookings.group_id`, which would have left every copied booking pointing at
 * the source venue's room type — and a list like that goes stale every time a
 * migration adds a column. The catalogue cannot be out of date with itself.
 */

/**
 * The tables a venue owns, as opposed to the ones it merely appears in.
 *
 * Support tickets and referrals belong to the account: a sandbox venue should
 * not come with a second copy of somebody's support thread. Sessions belong
 * to a person. What is left is everything the venue itself accumulated.
 */
const OWNED = [
  'room_groups',
  'rooms',
  'rate_plans',
  'rate_nights',
  'checklist_items',
  'bookings',
  'booking_guests',
  'room_nights',
  'room_checks',
  'external_reviews',
  'review_events',
];

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
 * Everything on a venue row that is not its own identity.
 *
 * `slug`, `id`, `token_hash` and the timestamps are what make a venue that
 * venue, and the copy gets its own. Everything else — the palette, the logo,
 * the topics, the review links, the API key — is what makes it the same
 * business, and is carried across.
 */
const CARRIED = [
  'name',
  'status',
  'account_id',
  'api_key',
  'model',
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
  'timezone',
  'currency',
  'platforms_off',
];

/**
 * One table, copied with its foreign keys remapped.
 *
 * `maps` holds `oldId -> newId` for every table already copied. Columns are
 * read off the source row rather than listed here, so a migration that adds a
 * column does not silently stop copying it — which is the failure a hand
 * written column list would have every few months.
 *
 * `keyed: false` is for the tables with no id of their own, where the key is
 * a pair of foreign keys and a date.
 */
async function shape(c, tables) {
  const { rows: keys } = await c.query(
    `SELECT con.conrelid::regclass::text AS tbl,
            att.attname               AS col,
            con.confrelid::regclass::text AS ref
       FROM pg_constraint con
       JOIN unnest(con.conkey) AS k(attnum) ON true
       JOIN pg_attribute att
         ON att.attrelid = con.conrelid AND att.attnum = k.attnum
      WHERE con.contype = 'f'
        AND con.conrelid::regclass::text = ANY($1)`,
    [tables]
  );

  const { rows: ids } = await c.query(
    `SELECT table_name AS tbl FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id' AND table_name = ANY($1)`,
    [tables]
  );
  const hasId = new Set(ids.map((r) => r.tbl));

  const remaps = new Map(tables.map((t) => [t, {}]));
  for (const { tbl, col, ref } of keys) {
    // The venue's own column is set explicitly, and a composite key into
    // room_groups carries one.
    if (col === 'subscriber_id') continue;
    // A key out of the set being copied — an account, a support ticket —
    // points at something the copy shares rather than something it owns.
    if (!remaps.has(ref)) continue;
    remaps.get(tbl)[col] = ref;
  }

  /*
   * Dependency order, worked out rather than written down.
   *
   * A table can be copied once every table it points at has been. Repeated
   * passes rather than a proper topological sort: there are eleven of them
   * and this is clearer than the sort would be.
   */
  const order = [];
  const left = new Set(tables);
  while (left.size) {
    const ready = [...left].filter((t) =>
      Object.values(remaps.get(t)).every((ref) => ref === t || !left.has(ref))
    );
    if (!ready.length) {
      throw new Error(`Cannot order ${[...left].join(', ')} — they reference each other.`);
    }
    for (const t of ready) {
      order.push(t);
      left.delete(t);
    }
  }

  return { order, remaps, hasId };
}

async function copyTable(c, { table, sourceId, targetId, remap = {}, maps, keyed = true }) {
  const { rows } = await c.query(
    `SELECT * FROM ${table} WHERE subscriber_id = $1 ORDER BY ${keyed ? 'id' : 'ctid'}`,
    [sourceId]
  );
  if (!rows.length) return { table, copied: 0 };

  const made = new Map();

  for (const row of rows) {
    const values = { ...row };
    if (keyed) delete values.id;
    values.subscriber_id = targetId;

    for (const [column, from] of Object.entries(remap)) {
      if (values[column] === null || values[column] === undefined) continue;

      const mapped = maps[from]?.get(values[column]);
      if (mapped === undefined) {
        /*
         * Louder than it needs to be, on purpose. The whole risk in this
         * script is a row that keeps a foreign key pointing into the source
         * venue — a sandbox booking sitting in a live room, which nothing
         * downstream would notice until somebody moved it.
         */
        throw new Error(
          `${table}.${column} = ${values[column]} points at a ${from} row that was not copied. ` +
            'Refusing to write a row that would reference the original venue.'
        );
      }
      values[column] = mapped;
    }

    const columns = Object.keys(values);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    const { rows: back } = await c.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})` +
        (keyed ? ' RETURNING id' : ''),
      columns.map((k) => values[k])
    );

    if (keyed) made.set(row.id, back[0].id);
  }

  maps[table] = made;
  return { table, copied: rows.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = String(args.from || '').trim().toLowerCase();
  const to = String(args.to || '').trim().toLowerCase();

  if (!from || !to) {
    console.error('Usage: node scripts/clone-venue.js --from <slug> --to <slug> [--name "..."]');
    process.exit(1);
  }

  const check = subscribers.checkSlug(to);
  if (!check.ok) {
    console.error(`That new slug will not do: ${check.error}`);
    process.exit(1);
  }

  await ready;

  const source = await subscribers.get(from);
  if (!source) {
    const { rows } = await pool.query('SELECT slug FROM subscribers ORDER BY slug');
    console.error(
      `No venue called "${from}". There is: ${rows.map((r) => r.slug).join(', ') || '(none)'}`
    );
    process.exit(1);
  }

  const clash = await subscribers.get(to);
  if (clash) {
    console.error(`"${to}" already exists. Pick a slug nothing is using.`);
    process.exit(1);
  }

  /*
   * Its own token, not a copy of the source's.
   *
   * The token is what lets a caller act as this venue. Two venues sharing one
   * would mean the sandbox's token opens the live venue, which is the exact
   * opposite of what a sandbox is for.
   */
  const token = 'rs_' + crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const name = String(args.name || `${source.name} (test)`).slice(0, 120);
  // Text columns, like everywhere else on this row. Not now().
  const stamp = new Date().toISOString();

  const summary = await tx(async (c) => {
    const carried = CARRIED.slice(1);
    const columns = ['slug', 'name', 'token_hash', 'created_at', 'updated_at', ...carried];
    const values = [to, name, tokenHash, stamp, stamp, ...carried.map((k) => source[k] ?? null)];

    const { rows } = await c.query(
      `INSERT INTO subscribers (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING id`,
      values
    );

    const targetId = rows[0].id;
    const maps = {};
    const done = [];

    const { order, remaps, hasId } = await shape(c, OWNED);

    for (const table of order) {
      done.push(
        await copyTable(c, {
          table,
          sourceId: source.id,
          targetId,
          remap: remaps.get(table),
          maps,
          keyed: hasId.has(table),
        })
      );
    }

    return { targetId, done };
  });

  console.log(`Copied "${from}" to "${to}".`);
  console.log('');
  for (const { table, copied } of summary.done) {
    if (copied) console.log(`  ${String(copied).padStart(6)}  ${table}`);
  }

  console.log('');
  console.log(`The new venue is at https://${to}.reviewslip.com`);
  console.log('Its API token, which is stored only as a hash and will not be shown again:');
  console.log(`  ${token}`);
  console.log('');
  console.log(`Nothing about "${from}" was touched. Look at the copy before blanking it.`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err.message);
    await pool.end();
    process.exit(1);
  });
