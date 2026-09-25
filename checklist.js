'use strict';

/**
 * What has to be done in a room, and how much of it has been.
 *
 * "Mark clean" was one button, which is one bit of information about twenty
 * minutes of work. It is enough for the desk — can somebody be put in there —
 * and it is nothing at all for the person doing the work, who has to hold the
 * standard in their head and remember whether they did the kettle.
 *
 * So a list, per room type, because the work genuinely differs: a loft has a
 * staircase, a family suite has a sofa bed, and a bungalow has neither. An
 * item with no type on it belongs to every room, which is where most of them
 * end up — the bathroom gets cleaned whatever the room is called.
 *
 * Pure. The rules for what a room's list is and when it counts as done can be
 * tested without a database, which matters because "done" is the thing the
 * desk reads.
 */

/** Long enough to be a standard, short enough that somebody reads it. */
const MAX_ITEMS = 24;
const MAX_LABEL = 80;

function clean(value, max = MAX_LABEL) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * @returns {string|null} why the label will not do, or null if it will
 */
function checkLabel(value) {
  const label = clean(value);
  if (!label) return 'Write what needs doing.';
  if (label.length < 2) return 'That is too short to be an instruction.';
  return null;
}

/**
 * The list for one room type, in order.
 *
 * Items with no type come first and then the type's own, each block in its own
 * sort order. General before specific because that is the order the work
 * happens in — strip and clean the room, then the thing this room has that the
 * others do not.
 *
 * @param {object[]} items - every item the venue has, any type
 * @param {number|null} groupId - the room type being cleaned
 */
function forGroup(items, groupId) {
  const mine = (items ?? []).filter(
    (i) => i.groupId === null || i.groupId === undefined || i.groupId === groupId
  );

  return mine
    .slice()
    .sort(
      (a, b) =>
        // Null group first: 0 before 1.
        (a.groupId == null ? 0 : 1) - (b.groupId == null ? 0 : 1) ||
        (a.sort ?? 0) - (b.sort ?? 0) ||
        a.id - b.id
    )
    .slice(0, MAX_ITEMS);
}

/**
 * One room's list for today, with what has already been ticked.
 *
 * @param {object[]} items - the list for this room's type, from forGroup
 * @param {Set<number>|number[]} done - item ids already ticked for this room
 * @returns {{items: object[], done: number, total: number, all: boolean}}
 */
function forRoom(items, done) {
  const ticked = done instanceof Set ? done : new Set(done ?? []);
  const list = (items ?? []).map((item) => ({
    id: item.id,
    label: item.label,
    groupId: item.groupId ?? null,
    // A flag, not the picture. "Bathroom clean" means something different to
    // everybody reading it, and a photograph settles in one glance what the
    // words cannot — but it is fetched from its own route, so a roomful of
    // them is not one download. See checklists.js.
    hasPhoto: Boolean(item.hasPhoto),
    done: ticked.has(item.id),
  }));

  const count = list.filter((i) => i.done).length;
  return {
    items: list,
    done: count,
    total: list.length,
    /*
     * A room with no list at all is not "all done" — it is a room with no
     * standard written for it yet, and saying everything is finished would be
     * a claim nobody made. The board shows nothing rather than a tick.
     */
    all: list.length > 0 && count === list.length,
  };
}

module.exports = { MAX_ITEMS, MAX_LABEL, clean, checkLabel, forGroup, forRoom };
