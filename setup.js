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
 * @param {object} input
 * @param {object} input.settings - resolved settings
 * @param {string[]} [input.off] - platforms marked as not used
 * @returns {{steps: object[], done: number, total: number, complete: boolean,
 *   canTakeReviews: boolean, blocking: string[]}}
 */
function progress({ settings = {}, off = [] } = {}) {
  const sites = listings(settings, off);
  const linked = sites.filter((s) => s.linked);
  const undecided = sites.filter((s) => !s.linked && !s.off);

  const topics = Array.isArray(settings.categories) ? settings.categories : [];
  const key = String(settings.apiKey ?? '').trim();

  const steps = [
    {
      id: 'key',
      label: 'A writing key',
      done: Boolean(key),
      /*
       * Blocking, and the only step that stops a review being written at all.
       * Everything else here decides where a finished review goes; without this
       * there is no review.
       */
      blocks: true,
      note: key
        ? 'Reviews can be written.'
        : 'Without an OpenRouter key nothing can be written at all.',
    },
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
    /** Whether the guest page can do its job at all. */
    canTakeReviews: blocking.length === 0,
    blocking,
  };
}

/**
 * What to tell a guest when the page cannot work.
 *
 * Said to the guest, so it names no setting and blames nobody: they did not
 * misconfigure anything and cannot fix it. The owner gets the detail on their
 * own screen.
 */
function guestMessage(blocking) {
  if (!blocking || blocking.length === 0) return null;
  if (blocking.includes('listing')) {
    return 'This page is not finished being set up — there is nowhere to post a review yet.';
  }
  return 'This page is not finished being set up yet.';
}

module.exports = {
  progress,
  listings,
  guestMessage,
};
