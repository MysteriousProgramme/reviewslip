'use strict';

const { all, one, query } = require('./db');
const checklist = require('./checklist');

/**
 * The checklist in the database: the standard, and the ticks against it.
 *
 * The rules for what a room's list is and when it counts as done live in
 * checklist.js, which is pure. This is the half that reads and writes.
 */

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function toItem(row) {
  return {
    id: row.id,
    groupId: row.group_id ?? null,
    groupName: row.group_name ?? null,
    label: row.label,
    sort: row.sort,
    /*
     * Whether there is a photograph, not the photograph.
     *
     * A standard can run to two dozen lines and each picture is up to 250kB;
     * inlining them would make one list a six megabyte download, every
     * morning, on a phone in a corridor. They are served from their own route
     * instead, so the browser fetches each one once and caches it.
     */
    hasPhoto: Boolean(row.has_photo),
  };
}

/** Every item a venue has, whatever type it belongs to. */
async function items(subscriberId) {
  const rows = await all(
    // Named columns rather than c.*, so the photograph is not read out of the
    // database on every listing only to be thrown away.
    `SELECT c.id, c.group_id, c.label, c.sort,
            (c.photo IS NOT NULL) AS has_photo,
            g.name AS group_name
       FROM checklist_items c
       LEFT JOIN room_groups g ON g.id = c.group_id
      WHERE c.subscriber_id = $1
      ORDER BY (c.group_id IS NOT NULL), c.sort, c.id`,
    [subscriberId]
  );
  return rows.map(toItem);
}

/**
 * The picture itself, for the route that serves it.
 *
 * Scoped to the venue like everything else here: an item id is a small
 * integer and guessing one belonging to another business must return nothing
 * rather than somebody else's photograph.
 *
 * @returns {Promise<string|null>} the stored data URI
 */
async function photo({ subscriberId, id }) {
  const row = await one(
    'SELECT photo FROM checklist_items WHERE id = $1 AND subscriber_id = $2',
    [id, subscriberId]
  );
  return row?.photo ?? null;
}

/**
 * Attach a photograph to a line, or take it off with null.
 *
 * The bytes are checked by the caller against assets.isStoredPhoto — raster
 * only, and capped — because this module does not know what a picture is.
 */
async function setPhoto({ subscriberId, id, photo: value }) {
  const row = await one(
    `UPDATE checklist_items
        SET photo = $3
      WHERE id = $1 AND subscriber_id = $2
      RETURNING id, (photo IS NOT NULL) AS has_photo`,
    [id, subscriberId, value ?? null]
  );
  if (!row) throw fail(404, 'No such item.');
  return { id: row.id, hasPhoto: Boolean(row.has_photo) };
}

/**
 * Add a line to the standard.
 *
 * `groupId` null means every room. The type is checked against this venue's
 * own groups rather than trusted, because the id arrives from a form.
 */
async function add({ subscriberId, groupId = null, label }) {
  const wrong = checklist.checkLabel(label);
  if (wrong) throw fail(400, wrong);

  const existing = await one(
    'SELECT count(*)::int AS n FROM checklist_items WHERE subscriber_id = $1',
    [subscriberId]
  );
  if ((existing?.n ?? 0) >= checklist.MAX_ITEMS) {
    throw fail(
      400,
      `That is already ${checklist.MAX_ITEMS} things to check. A list nobody reads to the end is not a standard.`
    );
  }

  let group = null;
  if (groupId !== null && groupId !== undefined && groupId !== '') {
    const found = await one(
      'SELECT id FROM room_groups WHERE id = $1 AND subscriber_id = $2',
      [Number(groupId), subscriberId]
    );
    if (!found) throw fail(404, 'No such room type.');
    group = found.id;
  }

  // Appended, so a new line lands at the bottom of the list it belongs to
  // rather than in the middle of a sequence somebody arranged.
  const last = await one(
    `SELECT coalesce(max(sort), 0) AS n FROM checklist_items
      WHERE subscriber_id = $1 AND group_id IS NOT DISTINCT FROM $2`,
    [subscriberId, group]
  );

  const row = await one(
    `INSERT INTO checklist_items (subscriber_id, group_id, label, sort)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [subscriberId, group, checklist.clean(label), Number(last?.n ?? 0) + 1]
  );
  return toItem(row);
}

/** Take a line out. Its ticks go with it — see the migration. */
async function remove({ subscriberId, id }) {
  const row = await one(
    'DELETE FROM checklist_items WHERE id = $1 AND subscriber_id = $2 RETURNING id',
    [id, subscriberId]
  );
  if (!row) throw fail(404, 'No such item.');
  return { id: row.id };
}

/**
 * One room's list for a day, with what has been ticked.
 *
 * @returns {Promise<{items: object[], done: number, total: number, all: boolean}>}
 */
async function forRoom({ subscriberId, roomId, groupId, day }) {
  const [every, ticks] = await Promise.all([
    items(subscriberId),
    all(
      'SELECT item_id FROM room_checks WHERE subscriber_id = $1 AND room_id = $2 AND on_day = $3',
      [subscriberId, roomId, day]
    ),
  ]);

  return checklist.forRoom(
    checklist.forGroup(every, groupId),
    ticks.map((t) => t.item_id)
  );
}

/**
 * Every room's progress for a day, keyed by room id.
 *
 * One query rather than one per room: the board draws twenty-odd rooms and a
 * round trip each would be the slowest thing on a screen that is opened on a
 * phone in a corridor.
 */
async function progress({ subscriberId, day, rooms }) {
  const every = await items(subscriberId);
  const ticks = await all(
    'SELECT room_id, item_id FROM room_checks WHERE subscriber_id = $1 AND on_day = $2',
    [subscriberId, day]
  );

  const byRoom = new Map();
  for (const t of ticks) {
    const set = byRoom.get(t.room_id);
    if (set) set.add(t.item_id);
    else byRoom.set(t.room_id, new Set([t.item_id]));
  }

  const out = new Map();
  for (const room of rooms) {
    const list = checklist.forGroup(every, room.groupId ?? null);
    out.set(room.id, checklist.forRoom(list, byRoom.get(room.id) ?? new Set()));
  }
  return out;
}

/**
 * Tick one, or untick it.
 *
 * The insert does nothing when it is already there, so a second tap on a bad
 * signal is harmless rather than an error somebody sees in a corridor.
 */
async function setChecked({ subscriberId, roomId, itemId, day, done }) {
  const room = await one(
    'SELECT id FROM rooms WHERE id = $1 AND subscriber_id = $2',
    [roomId, subscriberId]
  );
  if (!room) throw fail(404, 'No such room.');

  const item = await one(
    'SELECT id FROM checklist_items WHERE id = $1 AND subscriber_id = $2',
    [itemId, subscriberId]
  );
  if (!item) throw fail(404, 'No such item.');

  if (done) {
    await query(
      `INSERT INTO room_checks (subscriber_id, room_id, item_id, on_day)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_id, item_id, on_day) DO NOTHING`,
      [subscriberId, roomId, itemId, day]
    );
  } else {
    await query(
      'DELETE FROM room_checks WHERE room_id = $1 AND item_id = $2 AND on_day = $3',
      [roomId, itemId, day]
    );
  }

  return { itemId, done: Boolean(done) };
}

/**
 * Start the room again.
 *
 * Called when a room is put back to dirty: the ticks described a room that no
 * longer exists in that state, and leaving them would tell the next person the
 * work was already done.
 */
async function clearRoom({ subscriberId, roomId, day }) {
  await query(
    'DELETE FROM room_checks WHERE subscriber_id = $1 AND room_id = $2 AND on_day = $3',
    [subscriberId, roomId, day]
  );
}

module.exports = {
  items,
  add,
  remove,
  photo,
  setPhoto,
  forRoom,
  progress,
  setChecked,
  clearRoom,
};
