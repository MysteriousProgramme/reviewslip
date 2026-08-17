'use strict';

/**
 * The generic context document: what the writer knows before it knows anything
 * about the business it is writing for.
 *
 * This is a commercial product sold to whoever wants it — a lodge, a dental
 * clinic, a garage — so nothing in this file may describe a particular kind of
 * business. Everything here is craft: what a real review reads like, and what a
 * page of manufactured ones reads like. The business-specific half arrives
 * separately, from that business's own row: its details, its topics, and its own
 * context document.
 *
 * The split matters because these two kinds of knowledge have different
 * lifetimes. This file is reviewed, versioned and deployed like code, because a
 * bad edit here degrades every review on the platform at once. A business's own
 * context is edited by its owner, in the dashboard, and can only affect them.
 *
 * It is folded into the system prompt on every single generation, which the
 * business pays for by the token. So it earns its length or it comes out.
 */

/**
 * What a real review is like.
 *
 * Written as observations rather than instructions on purpose. "Be casual" is
 * an instruction a model satisfies by writing casual-sounding marketing copy;
 * "someone standing outside with their bag in one hand writes a line or two"
 * gives it a person to be instead.
 */
const CRAFT = `What a real review is like

- Most are short. Someone with their bag already in one hand writes a line or two, not a paragraph — and across a real listing the lengths are uneven, because the people were.
- They name one or two specific things and stop. A tour of every aspect of the visit is how a business describes itself, not how a customer does.
- They are about the writer's own experience, in the first person and the past tense. Not about the business as an institution, and never addressed to it.
- They do not reach for the words a business uses about itself. Nobody who has just paid a bill says "nestled", "boasts", "state-of-the-art" or "a true gem".
- They are slightly imperfect. A fragment, a contraction, a sentence starting with "and", a thought arriving a little out of order — all normal in real writing, all absent from copy written to be read.
- They rarely explain themselves. "Rooms were clean and quiet" is a review. "The rooms were clean and quiet, which made for a restful stay" is an advertisement for one.`;

/**
 * What a page of them looks like when it was not written by customers.
 *
 * This half is the reason the generic document exists at all. Every one of these
 * tells is invisible inside a single review and obvious across a listing — and
 * every review this writer produces lands on the same listing, so it is the
 * failure mode the product actually has. The list is the authenticity section of
 * our own published guide, turned into instructions for the writer.
 */
const TELLS = `What makes a set of reviews look manufactured

These patterns are invisible in one review and obvious across a listing, and every review you write lands on the same listing as the last one. Avoid all of them:

- A repeated opening formula. "I recently visited", "My stay at", "What a wonderful" — the same opening twice down one listing is the clearest tell there is.
- Uniform length. Six reviews all of two tidy sentences did not come from six people.
- A recurring vocabulary: the same two or three adjectives, the same intensifier, the same word for the staff.
- The same features named in the same order, as if working down a list.
- Stacked superlatives. "Amazing, incredible, the best we've ever had."
- Praise so general it would fit any business of the kind. If swapping in a different name would leave it true, it says nothing.
- A closing endorsement. "Highly recommend!", "Will definitely be back!", "A must-visit!" — common in written-to-order reviews, much rarer in real ones.`;

/**
 * Register, in one paragraph.
 *
 * The alternative was a table of business types, which would have been longer,
 * always incomplete, and wrong for the first business that did not fit a row.
 * Naming the axis and pointing at the business description does the same work.
 */
const REGISTER = `Register

Write in the register that kind of business actually attracts. What a customer notices, and how much warmth is normal, is not the same everywhere: a clinic is judged on competence and on being put at ease, a restaurant on one dish and the room, a hotel on the bed and the staff, a trade on turning up and doing the job. Take the cue from the business described below and write the way its own customers write — not the way hospitality reviews sound.`;

/**
 * Where the review is going, when we can tell.
 *
 * A Google review and a Xiaohongshu post are different genres, and writing one
 * in the register of the other is its own kind of tell. We only know the
 * destination when the business has set exactly one link — a guest picks the
 * button after the review is already written — so this is included then and
 * left out otherwise rather than guessed at.
 */
const PLATFORM_NOTES = {
  google:
    'This is going on a Google listing, where reviews are plain, unstructured and often very short.',
  tripadvisor:
    'This is going on Tripadvisor, where reviewers write a little more, and often mention how it compared with somewhere else they went.',
  line:
    'This is going through LINE, where the tone sits closer to a message than to a review: short and conversational.',
  facebook:
    'This is going on Facebook, where a review reads like a post to friends and is the most casual of any platform.',
  xiaohongshu:
    'This is going on Xiaohongshu, where posts are personal and written to other people looking for somewhere to go, rather than about the business.',
  wongnai:
    'This is going on Wongnai, where reviewers are direct about the food and get to the point quickly.',
};

/**
 * @param {string[]} platformIds - the platforms this business has links for
 * @returns {string} the note, or '' when the destination is unknown or unknowable
 */
function platformNote(platformIds = []) {
  if (platformIds.length !== 1) return '';
  return PLATFORM_NOTES[platformIds[0]] || '';
}

/** The always-on document, in reading order. */
const GENERIC_CONTEXT = [CRAFT, TELLS, REGISTER].join('\n\n');

module.exports = {
  CRAFT,
  TELLS,
  REGISTER,
  PLATFORM_NOTES,
  GENERIC_CONTEXT,
  platformNote,
};
