'use strict';

const { one, all, tx } = require('./db');
const nights = require('./nights');

/**
 * Stays, and the nights they hold.
 *
 * A booking and its room nights are one fact written in two tables, so every
 * write here goes through a transaction. Half of it landing is either a stay
 * holding no inventory — a room sold twice — or inventory held by no stay,
 * which is a room nobody can sell and nothing to explain why.
 *
 * The room nights are the inventory. A booking with no room holds none: it is
 * counted against its group, and shows on the calendar as unassigned. Assigning
 * it is what writes the nights, and that write is the moment a clash can
 * happen — refused by the unique index on (room_id, night) rather than by a
 * check in front of it, because two requests arriving together both pass any
 * check and only one can win the index.
 */

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

/** Postgres unique-violation. The only one this module can provoke is a clash. */
const CONFLICT = '23505';

const NAME_MAX = 120;
const NOTE_MAX = 2000;

/** Stays that hold a room. A cancellation gives its nights back immediately. */
const HOLDS_INVENTORY = ['confirmed', 'in_house', 'checked_out'];

/* ------------------------------------------------------------------- shape */

function toRecord(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name ?? null,
    roomId: row.room_id,
    roomName: row.room_name ?? null,
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    guestPhone: row.guest_phone,
    adults: row.adults,
    children: row.children,
    // Already strings: db.js turns off the driver's date parsing, so these
    // arrive as 'YYYY-MM-DD' and go to the browser unchanged.
    arrival: row.arrival,
    departure: row.departure,
    nights: nights.nightCount(row.arrival, row.departure),
    status: row.status,
    source: row.source,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

/* ---------------------------------------------------------------- creating */

/**
 * Take a booking.
 *
 * The room is optional. An unassigned stay is a real, valid booking — it is
 * what arrives from every OTA, which sells a type and never picks the room —
 * and refusing to store one until somebody has chosen would mean either
 * inventing an assignment or dropping the reservation.
 *
 * @param {{subscriberId: number, groupId: number, roomId?: number|null,
 *          guestName: string, arrival: string, departure: string}} input
 */
async function create(input) {
  const {
    subscriberId,
    groupId,
    roomId = null,
    guestName,
    guestEmail = null,
    guestPhone = null,
    adults = 1,
    children = 0,
    arrival,
    departure,
    source = 'direct',
    notes = null,
  } = input;

  const name = String(guestName ?? '').trim();
  if (!name) throw fail(400, 'Whose booking is it? A name is enough.');
  if (name.length > NAME_MAX) throw fail(400, 'That name is too long.');

  const stay = nights.checkStay({ arrival, departure });
  if (!stay.ok) throw fail(400, stay.error);

  const heads = Number(adults);
  const kids = Number(children);
  if (!Number.isSafeInteger(heads) || heads < 1 || heads > 20) {
    throw fail(400, 'Adults is a number from 1 to 20.');
  }
  if (!Number.isSafeInteger(kids) || kids < 0 || kids > 20) {
    throw fail(400, 'Children is a number from 0 to 20.');
  }

  const group = await one(
    'SELECT id FROM room_groups WHERE id = $1 AND subscriber_id = $2',
    [groupId, subscriberId]
  );
  if (!group) throw fail(404, 'No such room type.');

  if (roomId !== null && roomId !== undefined) {
    const room = await one(
      'SELECT id FROM rooms WHERE id = $1 AND subscriber_id = $2 AND group_id = $3',
      [roomId, subscriberId, groupId]
    );
    if (!room) throw fail(404, 'No such room in that room type.');
  }

  return tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO bookings
         (subscriber_id, group_id, room_id, guest_name, guest_email, guest_phone,
          adults, children, arrival, departure, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        subscriberId,
        groupId,
        roomId ?? null,
        name,
        guestEmail || null,
        guestPhone || null,
        heads,
        kids,
        arrival,
        departure,
        String(source).slice(0, 40),
        notes ? String(notes).slice(0, NOTE_MAX) : null,
      ]
    );

    const booking = rows[0];
    if (roomId) await holdNights(client, booking);
    return toRecord(booking);
  });
}

/**
 * Write the nights a stay occupies.
 *
 * One statement rather than a loop, so a clash on any night rolls the whole
 * stay back — a booking holding four of its five nights is worse than one
 * refused, because it looks booked and the fifth night is quietly resold.
 *
 * The count is checked against nightCount before the write. nightsBetween caps
 * itself against absurd input, and a capped set here would be a stay silently
 * holding less than it should. This is the assertion that makes that
 * impossible rather than merely unlikely.
 */
async function holdNights(client, booking) {
  const list = nights.nightsBetween(booking.arrival, booking.departure);
  const expected = nights.nightCount(booking.arrival, booking.departure);

  if (list.length !== expected || expected === 0) {
    throw fail(400, 'Those dates do not describe a stay.');
  }

  try {
    await client.query(
      `INSERT INTO room_nights (subscriber_id, room_id, night, booking_id)
       SELECT $1, $2, night::date, $3 FROM unnest($4::text[]) AS night`,
      [booking.subscriber_id, booking.room_id, booking.id, list]
    );
  } catch (err) {
    if (err?.code === CONFLICT) {
      throw fail(409, 'That room is already taken for one of those nights.');
    }
    throw err;
  }
}

/* ---------------------------------------------------------------- editing */

/**
 * Correct a booking.
 *
 * Dates, guest, headcount, and the room type. Every one of those can move the
 * nights it holds, so all of it goes through the same delete-then-re-hold as
 * assign, inside one transaction — a stay whose dates were changed but whose
 * nights were not is a room held on the wrong days and free on the right ones,
 * and nothing on the calendar would say so.
 *
 * Moving to a different room type unassigns the room, because a room belongs to
 * exactly one type: keeping it would mean a Family Suite booking sitting in a
 * Garden Bungalow. The stay lands on the unassigned strip, which is visible and
 * fixable, rather than in a room that contradicts its own type.
 *
 * Absent fields are left alone. This is a correction, not a replacement, and
 * the caller sends what changed.
 *
 * @param {{subscriberId: number, id: number}} input
 */
async function update(input) {
  const { subscriberId, id } = input;

  return tx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM bookings WHERE id = $1 AND subscriber_id = $2 FOR UPDATE',
      [id, subscriberId]
    );
    const current = rows[0];
    if (!current) throw fail(404, 'No such booking.');

    const pick = (key, fallback) =>
      input[key] === undefined ? fallback : input[key];

    const arrival = String(pick('arrival', current.arrival));
    const departure = String(pick('departure', current.departure));

    const stay = nights.checkStay({ arrival, departure });
    if (!stay.ok) throw fail(400, stay.error);

    const guestName = String(pick('guestName', current.guest_name)).trim();
    if (!guestName) throw fail(400, 'Whose booking is it? A name is enough.');
    if (guestName.length > NAME_MAX) throw fail(400, 'That name is too long.');

    const adults = Number(pick('adults', current.adults));
    const children = Number(pick('children', current.children));
    if (!Number.isSafeInteger(adults) || adults < 1 || adults > 20) {
      throw fail(400, 'Adults is a number from 1 to 20.');
    }
    if (!Number.isSafeInteger(children) || children < 0 || children > 20) {
      throw fail(400, 'Children is a number from 0 to 20.');
    }

    let groupId = Number(pick('groupId', current.group_id));
    let roomId = current.room_id;

    if (groupId !== current.group_id) {
      const group = await client.query(
        'SELECT id FROM room_groups WHERE id = $1 AND subscriber_id = $2',
        [groupId, subscriberId]
      );
      if (!group.rows[0]) throw fail(404, 'No such room type.');

      // The room cannot follow the booking into another type.
      const stillFits = roomId
        ? await client.query(
            'SELECT id FROM rooms WHERE id = $1 AND group_id = $2',
            [roomId, groupId]
          )
        : { rows: [] };
      if (!stillFits.rows[0]) roomId = null;
    }

    await client.query('DELETE FROM room_nights WHERE booking_id = $1', [id]);

    const updated = await client.query(
      `UPDATE bookings
          SET group_id = $2, room_id = $3, guest_name = $4, guest_email = $5,
              guest_phone = $6, adults = $7, children = $8,
              arrival = $9, departure = $10, notes = $11, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        id,
        groupId,
        roomId,
        guestName,
        pick('guestEmail', current.guest_email) || null,
        pick('guestPhone', current.guest_phone) || null,
        adults,
        children,
        arrival,
        departure,
        (() => {
          const note = pick('notes', current.notes);
          return note ? String(note).slice(0, NOTE_MAX) : null;
        })(),
      ]
    );

    const next = updated.rows[0];
    if (next.room_id && HOLDS_INVENTORY.includes(next.status)) {
      await holdNights(client, next);
    }

    return toRecord(next);
  });
}

/* --------------------------------------------------------------- assigning */

/**
 * Put a booking in a room, move it between rooms, or take it out of one.
 *
 * This is what the calendar's drag and drop will call. Delete then insert
 * inside one transaction: moving a stay one room along would otherwise clash
 * with itself on every night, since its old nights are still held while the
 * new ones go in.
 *
 * @param {{subscriberId: number, id: number, roomId: number|null}} input
 */
async function assign({ subscriberId, id, roomId }) {
  return tx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM bookings WHERE id = $1 AND subscriber_id = $2 FOR UPDATE',
      [id, subscriberId]
    );
    const booking = rows[0];
    if (!booking) throw fail(404, 'No such booking.');

    if (roomId !== null) {
      const check = await client.query(
        'SELECT id FROM rooms WHERE id = $1 AND subscriber_id = $2 AND group_id = $3 AND status = $4',
        [roomId, subscriberId, booking.group_id, 'active']
      );
      if (!check.rows[0]) {
        throw fail(404, 'No room like that is available in this room type.');
      }
    }

    await client.query('DELETE FROM room_nights WHERE booking_id = $1', [id]);

    const updated = await client.query(
      'UPDATE bookings SET room_id = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, roomId]
    );

    const next = updated.rows[0];
    if (roomId && HOLDS_INVENTORY.includes(next.status)) {
      await holdNights(client, next);
    }

    return toRecord(next);
  });
}

/**
 * Change a stay's status.
 *
 * Cancelling and no-show give the nights back at once; the booking row keeps
 * the status as the record of what happened. Anything else re-takes them, so a
 * cancellation reversed on the same day gets the room back only if nobody else
 * has taken it — which is the truth, and better told now than at check-in.
 */
async function setStatus({ subscriberId, id, status }) {
  const allowed = ['confirmed', 'in_house', 'checked_out', 'cancelled', 'no_show'];
  if (!allowed.includes(status)) throw fail(400, 'Not a status.');

  return tx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM bookings WHERE id = $1 AND subscriber_id = $2 FOR UPDATE',
      [id, subscriberId]
    );
    if (!rows[0]) throw fail(404, 'No such booking.');

    const updated = await client.query(
      'UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, status]
    );
    const next = updated.rows[0];

    await client.query('DELETE FROM room_nights WHERE booking_id = $1', [id]);
    if (next.room_id && HOLDS_INVENTORY.includes(next.status)) {
      await holdNights(client, next);
    }

    return toRecord(next);
  });
}

/* ----------------------------------------------------------------- reading */

/**
 * Everything the calendar needs for a window of nights, in three queries.
 *
 * The rooms, the nights that are taken, and the stays that have no room yet.
 * Joined in the browser rather than in SQL because the calendar draws a grid of
 * rooms against nights, and a flat join would send the booking's details once
 * per night it occupies — a fortnight's view of a fifty-room property being
 * about seven hundred copies of the same guest name.
 */
async function calendar({ subscriberId, start, days }) {
  const window = nights.window(start, days);
  if (!window.length) throw fail(400, 'That is not a date to start from.');

  const from = window[0];
  const to = window[window.length - 1];

  const taken = await all(
    `SELECT n.room_id, n.night, n.booking_id,
            b.guest_name, b.status, b.arrival, b.departure, b.source
       FROM room_nights n
       JOIN bookings b ON b.id = n.booking_id
      WHERE n.subscriber_id = $1 AND n.night BETWEEN $2 AND $3
      ORDER BY n.room_id, n.night`,
    [subscriberId, from, to]
  );

  // Unassigned stays that touch the window. Departure is exclusive, so a stay
  // leaving on the first night of the window does not overlap it.
  const unassigned = await all(
    `SELECT b.*, g.name AS group_name
       FROM bookings b
       JOIN room_groups g ON g.id = b.group_id
      WHERE b.subscriber_id = $1
        AND b.room_id IS NULL
        AND b.status = ANY($4)
        AND b.arrival <= $3
        AND b.departure > $2
      ORDER BY b.arrival, b.id`,
    [subscriberId, from, to, HOLDS_INVENTORY]
  );

  return {
    start: from,
    nights: window,
    taken: taken.map((row) => ({
      roomId: row.room_id,
      night: row.night,
      bookingId: row.booking_id,
      guestName: row.guest_name,
      status: row.status,
      arrival: row.arrival,
      departure: row.departure,
      source: row.source,
    })),
    unassigned: unassigned.map(toRecord),
  };
}

/** One booking, scoped to its venue. */
async function get({ subscriberId, id }) {
  const row = await one(
    `SELECT b.*, g.name AS group_name, r.name AS room_name
       FROM bookings b
       JOIN room_groups g ON g.id = b.group_id
       LEFT JOIN rooms r ON r.id = b.room_id
      WHERE b.id = $1 AND b.subscriber_id = $2`,
    [id, subscriberId]
  );
  if (!row) throw fail(404, 'No such booking.');
  return toRecord(row);
}

/** Arrivals, departures and who is in house, for a single day. */
async function onDate({ subscriberId, date }) {
  const day = nights.parse(date);
  if (!day) throw fail(400, 'That is not a date.');

  const rows = await all(
    `SELECT b.*, g.name AS group_name, r.name AS room_name
       FROM bookings b
       JOIN room_groups g ON g.id = b.group_id
       LEFT JOIN rooms r ON r.id = b.room_id
      WHERE b.subscriber_id = $1
        AND b.status <> 'cancelled'
        AND b.arrival <= $2 AND b.departure >= $2
      ORDER BY b.arrival, lower(b.guest_name)`,
    [subscriberId, day]
  );

  const list = rows.map(toRecord);

  return {
    date: day,
    arrivals: list.filter((b) => b.arrival === day),
    departures: list.filter((b) => b.departure === day),
    // Here for the night of `day`: arrived on or before it, leaving after it.
    inHouse: list.filter((b) => b.arrival <= day && b.departure > day),
  };
}

module.exports = {
  HOLDS_INVENTORY,
  create,
  update,
  assign,
  setStatus,
  calendar,
  get,
  onDate,
};
