'use strict';

const note = require('./note');

/**
 * What the owner wants from the look, in their own words.
 *
 * Reading the site gets the colours the site is painted with, which is not
 * always the same as the colours the business wants to be seen in. A site
 * built in 2014 that everybody is embarrassed by still measures accurately.
 * The owner knows things the stylesheet does not: that the blue is the old
 * blue, that the gold only appears on the sign outside, that the table card
 * wants to be calmer than the website.
 *
 * So: a line of instruction that rides along with the draft.
 *
 * This is a different thing from the guest's note in note.js, and it is worth
 * saying why the checking here is lighter. That one is anonymous free text
 * from the public, going into a prompt whose output is published under the
 * business's name. This one is a signed-in owner steering the styling of
 * their own page — they can already type any hex code they like into the four
 * boxes beside this one, so there is nothing here to defend that is not
 * already theirs to change.
 *
 * What the checking is for, then, is their own time. A note that talks the
 * model out of returning a JSON object costs them thirty seconds of reading
 * and an error that explains nothing. Refusing it in front of them, before
 * anybody pays for a completion, is the kinder answer.
 *
 * The model's answer is no more trusted for having a note attached. Colours
 * still go through theme.validate, fonts still resolve to the shipped list,
 * and every address still goes through assets.js.
 */

/**
 * Long enough for a sentence or two of direction.
 *
 * Longer than the guest's note, because this one is allowed to be specific —
 * "use the green from the sign, not the blue on the website, and keep the
 * table card quiet" is a good instruction and it does not fit in 200.
 */
const MAX = 300;

/**
 * @returns {{ok: true, note: string}|{ok: false, reason: string}}
 */
function check(value) {
  const text = note.clean(value);

  if (!text) return { ok: true, note: '' };

  if (text.length > MAX) {
    return {
      ok: false,
      reason: `Keep it to about ${MAX} characters — a sentence or two of direction is what helps.`,
    };
  }

  /*
   * Phrased as "this will not work" rather than as a refusal, because that is
   * what it is. Nobody typing this is doing anything wrong; they have asked
   * for something the reader cannot do, and the useful thing to say is what it
   * can do instead.
   */
  if (note.AIMED_AT_THE_MODEL.some((re) => re.test(text))) {
    return {
      ok: false,
      reason:
        'That reads as an instruction to the reader rather than a note about the look. Say what you want the colours and type to do — "warmer", "use the green from our sign", "the card should be calmer than the site".',
    };
  }

  return { ok: true, note: text };
}

/**
 * How the note reaches the model.
 *
 * Last in the user message, after the evidence, because where the two
 * disagree the owner wins: the measurements say what the site is painted
 * with, and this says what the business wants to look like. A site nobody is
 * happy with measures perfectly accurately.
 *
 * It does not get to move the output contract, and that is said here rather
 * than left implied — the failure it prevents is the expensive one.
 */
function forPrompt(text) {
  if (!text) return '';

  return `

The owner of this business asked for the following. It is their own words about how they want the place to look:

"""
${text}
"""

Weigh it above what you measured off the site where the two disagree — they know which colours are current and which are left over, and you do not. It does not change anything else: the answer is still the one JSON object described above, with all four colours present, a dark ground and a light paper.`;
}

module.exports = { MAX, check, forPrompt };
