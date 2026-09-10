'use strict';

const { one, all, query } = require('./db');
const nights = require('./nights');
const tariff = require('./tariff');

/**
 * What a room type costs, and whether there is one free.
 *
 * A plan carries a base price. rate_nights holds only the nights that differ
 * from it, so a property with one price all year stores nothing here and one
 * with a high season stores the high season. Resolution is COALESCE: the
 * override if there is one, the base otherwise, and null if neither — which
 * means "we cannot quote this", not "this is free".
 */

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

/** Postgres counts arrive as strings. */
function count(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/* ------------------------------------------------------------------- plans */

function toPlan(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name ?? null,
    name: row.name,
    baseMinor: row.base_minor,
    base: row.base_minor === null ? null : tariff.formatAmount(row.base_minor),
  };
}

async function listPlans(subscriberId) {
  const rows = await all(
    `SELECT p.*, g.name AS group_name
       FROM rate_plans p
       JOIN room_groups g ON g.id = p.group_id
      WHERE p.subscriber_id = $1
      ORDER BY g.sort, lower(g.name), lower(p.name)`,
    [subscriberId]
  );
  return rows.map(toPlan);
}

async function createPlan({ subscriberId, groupId, name, base }) {
  const label = String(name ?? '').trim();
  if (!label) throw fail(400, 'Give the rate a name.');
  if (label.length > 60) throw fail(400, 'That name is too long.');

  const group = await one(
    'SELECT id FROM room_groups WHERE id = $1 AND subscriber_id = $2',
    [groupId, subscriberId]
  );
  if (!group) throw fail(404, 'No such room type.');

  // An empty base is allowed — a plan can exist before anybody has priced it.
  // A base that was typed and could not be read is not.
  let baseMinor = null;
  if (base !== undefined && base !== null && String(base).trim() !== '') {
    baseMinor = tariff.parseAmount(base);
    if (baseMinor === null) throw fail(400, 'That is not an amount.');
  }

  try {
    const row = await one(
      `INSERT INTO rate_plans (subscriber_id, group_id, name, base_minor)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [subscriberId, groupId, label, baseMinor]
    );
    return toPlan(row);
  } catch (err) {
    if (err?.code === '23505') {
      throw fail(409, 'That room type already has a rate with that name.');
    }
    throw err;
  }
}

async function setPlanBase({ subscriberId, id, base }) {
  let baseMinor = null;
  if (base !== undefined && base !== null && String(base).trim() !== '') {
    baseMinor = tariff.parseAmount(base);
    if (baseMinor === null) throw fail(400, 'That is not an amount.');
  }

  const row = await one(
    `UPDATE rate_plans SET base_minor = $3, updated_at = now()
      WHERE id = $1 AND subscriber_id = $2
      RETURNING *`,
    [id, subscriberId, baseMinor]
  );
  if (!row) throw fail(404, 'No such rate.');
  return toPlan(row);
}

async function deletePlan({ subscriberId, id }) {
  const row = await one(
    'DELETE FROM rate_plans WHERE id = $1 AND subscriber_id = $2 RETURNING id',
    [id, subscriberId]
  );
  if (!row) throw fail(404, 'No such rate.');
  return true;
}

/* ------------------------------------------------------- nights and ranges */

/**
 * Price or restrict a run of nights at once.
 *
 * One statement for the whole range rather than a night at a time: setting a
 * three-month high season is one round trip, and it either all lands or none
 * of it does.
 *
 * A field left undefined is not touched, so raising a price does not silently
 * clear a minimum-stay rule set last week. Passing null clears that field.
 *
 * @param {{subscriberId: number, planId: number, from: string, to: string,
 *          amount?: unknown, minNights?: unknown, closed?: unknown,
 *          closedToArrival?: unknown}} input
 */
async function setRange(input) {
  const { subscriberId, planId, from, to } = input;

  const plan = await one(
    'SELECT id FROM rate_plans WHERE id = $1 AND subscriber_id = $2',
    [planId, subscriberId]
  );
  if (!plan) throw fail(404, 'No such rate.');

  // `to` is inclusive here, unlike a departure date. A person setting a high
  // season means "the 1st of December to the 31st of January" and expects the
  // 31st included; a departure means the morning somebody leaves. Different
  // words, different rule, and worth being explicit about which this is.
  const start = nights.parse(from);
  const end = nights.parse(to);
  if (!start || !end) throw fail(400, 'Those are not dates.');
  if (end < start) throw fail(400, 'The last night has to be on or after the first.');

  const list = nights.nightsBetween(start, nights.addDays(end, 1));
  if (!list.length) throw fail(400, 'That range covers no nights.');

  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);

  let amount;
  if (has('amount')) {
    if (input.amount === null || String(input.amount).trim() === '') {
      amount = null;
    } else {
      amount = tariff.parseAmount(input.amount);
      if (amount === null) throw fail(400, 'That is not an amount.');
    }
  }

  let minNights;
  if (has('minNights')) {
    if (input.minNights === null || String(input.minNights).trim() === '') {
      minNights = null;
    } else {
      const n = Number(input.minNights);
      if (!Number.isSafeInteger(n) || n < 1 || n > 90) {
        throw fail(400, 'A minimum stay is a number of nights from 1 to 90.');
      }
      minNights = n;
    }
  }

  const closed = has('closed') ? Boolean(input.closed) : undefined;
  const cta = has('closedToArrival') ? Boolean(input.closedToArrival) : undefined;

  // COALESCE on the excluded value keeps a field that was not sent. The
  // alternative — building the column list per call — would mean a different
  // statement for each combination, and the combination that gets it wrong is
  // the one nobody tested.
  await query(
    `INSERT INTO rate_nights
       (subscriber_id, plan_id, night, amount_minor, min_nights, closed, closed_to_arrival)
     SELECT $1, $2, night::date, $4, $5, $6, $7 FROM unnest($3::text[]) AS night
     ON CONFLICT (plan_id, night) DO UPDATE SET
       amount_minor      = CASE WHEN $8  THEN EXCLUDED.amount_minor      ELSE rate_nights.amount_minor END,
       min_nights        = CASE WHEN $9  THEN EXCLUDED.min_nights        ELSE rate_nights.min_nights END,
       closed            = CASE WHEN $10 THEN EXCLUDED.closed            ELSE rate_nights.closed END,
       closed_to_arrival = CASE WHEN $11 THEN EXCLUDED.closed_to_arrival ELSE rate_nights.closed_to_arrival END,
       updated_at = now()`,
    [
      subscriberId,
      planId,
      list,
      amount ?? null,
      minNights ?? null,
      closed ?? null,
      cta ?? null,
      has('amount'),
      has('minNights'),
      has('closed'),
      has('closedToArrival'),
    ]
  );

  return { nights: list.length, from: start, to: end };
}

/**
 * What each night of a window costs on each plan, with its restrictions.
 *
 * Returned per plan per night with the base already folded in, so the caller
 * never has to remember that a missing row means "the base" rather than
 * "nothing".
 */
async function forWindow({ subscriberId, start, days }) {
  const window = nights.window(start, days);
  if (!window.length) throw fail(400, 'That is not a date to start from.');

  const plans = await listPlans(subscriberId);
  const rows = await all(
    `SELECT plan_id, night, amount_minor, min_nights, closed, closed_to_arrival
       FROM rate_nights
      WHERE subscriber_id = $1 AND night BETWEEN $2 AND $3`,
    [subscriberId, window[0], window[window.length - 1]]
  );

  const overrides = new Map();
  for (const row of rows) {
    if (!overrides.has(row.plan_id)) overrides.set(row.plan_id, new Map());
    overrides.get(row.plan_id).set(row.night, row);
  }

  return {
    nights: window,
    plans: plans.map((plan) => {
      const mine = overrides.get(plan.id);
      return {
        ...plan,
        byNight: window.map((night) => {
          const row = mine?.get(night);
          const minor = row?.amount_minor ?? plan.baseMinor;
          return {
            night,
            amountMinor: minor,
            amount: minor === null || minor === undefined ? null : tariff.formatAmount(minor),
            minNights: row?.min_nights ?? null,
            closed: row?.closed === true,
            closedToArrival: row?.closed_to_arrival === true,
            // Whether this night is priced differently from the plan's base —
            // what the calendar shades to show a season at a glance.
            override: row?.amount_minor !== null && row?.amount_minor !== undefined,
          };
        }),
      };
    }),
  };
}

/* ---------------------------------------------------------------- quoting */

/**
 * What a stay would cost on a plan, and whether it may be sold at all.
 *
 * Both together, because they are the same question asked at the same moment
 * and answering them separately means two round trips and a window in which
 * one of them changes.
 */
async function quote({ subscriberId, planId, arrival, departure }) {
  const stay = nights.checkStay({ arrival, departure });
  if (!stay.ok) throw fail(400, stay.error);

  const plan = await one(
    'SELECT * FROM rate_plans WHERE id = $1 AND subscriber_id = $2',
    [planId, subscriberId]
  );
  if (!plan) throw fail(404, 'No such rate.');

  const list = nights.nightsBetween(arrival, departure);
  const rows = await all(
    `SELECT night, amount_minor, min_nights, closed, closed_to_arrival
       FROM rate_nights
      WHERE plan_id = $1 AND night = ANY($2::date[])`,
    [planId, list]
  );

  const byNight = {};
  for (const row of rows) {
    byNight[row.night] = {
      minNights: row.min_nights,
      closed: row.closed === true,
      closedToArrival: row.closed_to_arrival === true,
    };
  }

  const allowed = tariff.checkRestrictions({ nights: list, byNight });

  const priced = list.map((night) => {
    const row = rows.find((r) => r.night === night);
    return row?.amount_minor ?? plan.base_minor;
  });

  const sum = tariff.total(priced);

  return {
    planId: plan.id,
    planName: plan.name,
    nights: list.length,
    // Null when any night has no price at all. A stay we cannot quote is not a
    // stay that costs nothing, and the caller has to be able to tell.
    totalMinor: sum ? sum.total : null,
    total: sum ? tariff.formatAmount(sum.total) : null,
    perNight: list.map((night, i) => ({
      night,
      amountMinor: priced[i] ?? null,
      amount: priced[i] === null || priced[i] === undefined ? null : tariff.formatAmount(priced[i]),
    })),
    sellable: allowed.ok,
    reason: allowed.ok ? null : allowed.error,
  };
}

/* ----------------------------------------------------------- availability */

/**
 * How many rooms of each type are free for a whole stay.
 *
 * The minimum across the stay's nights, not the average and not the last one: a
 * type with three rooms free on four nights and none on the fifth can sell
 * nobody a five-night stay. Taking anything but the minimum is how a booking
 * gets accepted that cannot be housed.
 *
 * Unassigned bookings are counted against their type. They hold no room and so
 * no room-nights, but they are real stays somebody has promised — leaving them
 * out would sell the same room twice and only notice at the moment somebody
 * tried to put them both in it.
 */
async function availability({ subscriberId, arrival, departure }) {
  const stay = nights.checkStay({ arrival, departure });
  if (!stay.ok) throw fail(400, stay.error);

  const list = nights.nightsBetween(arrival, departure);

  const rows = await all(
    `WITH the_nights AS (
       SELECT night::date AS night FROM unnest($2::text[]) AS night
     ),
     grid AS (
       SELECT g.id AS group_id, g.name, n.night,
              (SELECT count(*) FROM rooms r
                WHERE r.group_id = g.id AND r.status = 'active') AS rooms,
              (SELECT count(*) FROM room_nights rn
                 JOIN rooms r ON r.id = rn.room_id
                WHERE r.group_id = g.id AND rn.night = n.night) AS taken,
              (SELECT count(*) FROM bookings b
                WHERE b.group_id = g.id
                  AND b.room_id IS NULL
                  AND b.status = ANY(ARRAY['confirmed','in_house','checked_out'])
                  AND b.arrival <= n.night AND b.departure > n.night) AS floating
         FROM room_groups g CROSS JOIN the_nights n
        WHERE g.subscriber_id = $1
     )
     SELECT group_id, name,
            min(rooms) AS rooms,
            min(rooms - taken - floating) AS free
       FROM grid
      GROUP BY group_id, name
      ORDER BY name`,
    [subscriberId, list]
  );

  return {
    arrival,
    departure,
    nights: list.length,
    groups: rows.map((row) => ({
      groupId: row.group_id,
      name: row.name,
      rooms: count(row.rooms),
      // Clamped: an over-allocated type — more unassigned stays than rooms —
      // is a real state, and it should read as none free rather than as a
      // negative number that some caller treats as truthy.
      free: Math.max(0, Number(row.free) || 0),
    })),
  };
}

module.exports = {
  listPlans,
  createPlan,
  setPlanBase,
  deletePlan,
  setRange,
  forWindow,
  quote,
  availability,
};
