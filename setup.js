'use strict';

const { PLATFORMS } = require('./platforms');

/**
 * Whether a venue is ready to take a review, and what is missing if not.
 *
 * Pure, and in its own file, because two very different screens have to agree
 * on the answer: the owner's dashboard, which says what is left to do, and the
 * guest page, which has to refuse honestly when the answer is "nothing works
 * yet". Those two disagreeing is the failure this replaces — a dashboard that
 * looked finished over a guest page that could not send anybody anywhere.
 *
 * The chain it exists to break is worth writing down, because every symptom in
 * it points somewhere else:
 *
 *   No listing link is set, so the guest page draws no Proceed button, so no
 *   review is ever marked as taken, so the owner's review list is permanently
 *   empty — and the list says "Nothing yet. Reviews appear here as guests
 *   generate them", which is the one reading of the situation that is wrong.
 *   The reviews exist. There was nowhere to take them.
 *
 * Nothing here touches a database.
 */

/**
 * A platform a venue has decided it is not on.
 *
 * The reason this is stored at all: without it, "have you set your Tripadvisor
 * link" has two answers that look identical — not yet, and never. A checklist
 * that cannot tell them apart can never reach complete for a venue that only
 * uses Google, which is most of them, so it nags forever and people stop
 * reading it. A nagging checklist that is wrong is worse than none.
 */
function isOff(offList, id) {
  return Array.isArray(offList) && offList.includes(id);
}

/**
 * What the venue has decided about each listing.
 *
 * @param {object} settings - resolved settings, as settings.js returns them
 * @param {string[]} off - platform ids explicitly marked as not used
 */
function listings(settings, off) {
  return PLATFORMS.map((p) => {
    const url = String(settings?.[`${p.id}Url`] ?? '').trim();
    return {
      id: p.id,
      label: p.label,
      url,
      linked: Boolean(url),
      // A link wins over the flag. Somebody who marked Tripadvisor unused and
      // later pasted a link has changed their mind, and making them untick a
      // box before the link works would be a rule enforcing itself against the
      // obvious intention.
      off: !url && isOff(off, p.id),
    };
  });
}

/**
 * The setup checklist.
 *
 * Only the steps a venue can actually do. The writing key is ours, not theirs
 * (see `waitingOnUs` below), so it is not in `steps` and not in `blocking`.
 *
 * @param {object} input
 * @param {object} input.settings - resolved settings
 * @param {string[]} [input.off] - platforms marked as not used
 * @returns {{steps: object[], done: number, total: number, complete: boolean,
 *   canTakeReviews: boolean, blocking: string[], waitingOnUs: boolean}}
 */
function progress({ settings = {}, off = [] } = {}) {
  const sites = listings(settings, off);
  const linked = sites.filter((s) => s.linked);
  const undecided = sites.filter((s) => !s.linked && !s.off);

  const topics = Array.isArray(settings.categories) ? settings.categories : [];

  /*
   * We buy the tokens, so we hold the key — it is set through the admin API and
   * there is no field for it on a customer's screen.
   *
   * It therefore cannot be a checklist step. A step nobody reading the list can
   * act on is not a checklist item, it is a locked door with a to-do written on
   * it: every venue started life showing a red, blocking "A writing key" that no
   * amount of clicking could clear. It comes back as `waitingOnUs` instead, which
   * says whose turn it is.
   *
   * It still stops the guest page working, which is why `canTakeReviews` below
   * asks for it separately.
   */
  const key = Boolean(String(settings.apiKey ?? '').trim());

  const steps = [
    {
      id: 'topics',
      label: 'Topics to write about',
      done: topics.length > 0,
      blocks: true,
      note: topics.length
        ? `${topics.length} topic${topics.length === 1 ? '' : 's'} guests can pick from.`
        : 'Guests pick a topic before anything is written.',
    },
    {
      id: 'listing',
      label: 'Somewhere to send guests',
      done: linked.length > 0,
      blocks: true,
      note: linked.length
        ? `${linked.map((s) => s.label).join(', ')}.`
        : 'A review with nowhere to go is never posted, and never appears in your list.',
    },
    {
      id: 'sites',
      label: 'Every review site decided',
      done: undecided.length === 0,
      // Not blocking. A venue with Google set and Tripadvisor untouched works
      // perfectly; this step exists so the checklist can finish, not so it can
      // hold anything up.
      blocks: false,
      note: undecided.length
        ? `${undecided.map((s) => s.label).join(', ')} — add a link, or mark as not used.`
        : 'Nothing outstanding.',
    },
  ];

  const blocking = steps.filter((s) => s.blocks && !s.done).map((s) => s.id);

  return {
    steps,
    sites,
    done: steps.filter((s) => s.done).length,
    total: steps.length,
    complete: steps.every((s) => s.done),
    /**
     * Whether the guest page can do its job at all.
     *
     * The key is asked for here and not through `blocking`, because `blocking`
     * answers "what is the venue still to do" and the key is never that.
     */
    canTakeReviews: blocking.length === 0 && key,
    blocking,
    /**
     * The venue has finished its side and is waiting on us to fit the key.
     *
     * Deliberately not `!key`: while the venue still has steps of its own, whose
     * turn it is has an obvious answer and saying "waiting for us" alongside a
     * list of their outstanding work would be an excuse, not information.
     */
    waitingOnUs: !key && blocking.length === 0,
  };
}

/**
 * What to tell a guest when the page cannot work.
 *
 * Said to the guest, so it names no setting and blames nobody: they did not
 * misconfigure anything and cannot fix it. The owner gets the detail on their
 * own screen.
 *
 * Takes the whole result of `progress()`, not its `blocking` list. It used to
 * take the list, and once the writing key left that list a venue missing only
 * its key would have had an empty `blocking`, no banner, and a Generate button
 * that quietly failed — the page claiming to work while it could not.
 *
 * @param {ReturnType<typeof progress>} ready
 */
function guestMessage(ready) {
  if (!ready || ready.canTakeReviews) return null;
  if (ready.blocking?.includes('listing')) {
    return 'This page is not finished being set up — there is nowhere to post a review yet.';
  }
  return 'This page is not finished being set up yet.';
}

module.exports = {
  progress,
  listings,
  guestMessage,
};
