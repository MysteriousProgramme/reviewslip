'use strict';

/**
 * The built-in venue, underneath every subscriber.
 *
 * A subscriber that has filled in its own kind, place and details overrides
 * these; one that has not falls back here, the same way an unset API key falls
 * back to .env. On a single-venue install, editing this file is still the
 * quickest way to point the app at a different property.
 */

const VENUE = {
  name: 'Baanpong Lodge',
  kind: 'a small lodge',
  place: 'San Kamphaeng, Chiang Mai, Thailand',

  // Details the writer is allowed to draw on. Keep these true — anything not
  // listed here, the model is told not to invent. Add or remove freely.
  safeDetails: [
    'a quiet setting outside the centre of Chiang Mai, in San Kamphaeng',
    'a green, garden-like property with outdoor seating',
    'friendly, attentive staff',
    'clean, comfortable rooms',
    'a relaxed pace compared with staying in the city',
    'close to the San Kamphaeng hot springs and the Bo Sang handicraft villages',
  ],
};

/**
 * The category buttons, in display order. `id` is what the client sends.
 * `focus` is folded into the prompt.
 */
const CATEGORIES = [
  {
    id: 'any',
    label: 'Any',
    focus:
      'the stay overall — pick whichever single aspect feels most natural to lead with',
  },
  {
    id: 'restaurant',
    label: 'Restaurant',
    focus: 'the food — breakfast, a meal, or the dining experience',
  },
  {
    id: 'common',
    label: 'Common Area',
    focus:
      'the shared spaces — garden, grounds, terrace, lounge, seating areas, the general atmosphere of the property',
  },
  {
    id: 'bar',
    label: 'Bar',
    focus: 'the bar — drinks and the evening atmosphere',
  },
  {
    id: 'rooms',
    label: 'Rooms',
    focus:
      'the room itself — comfort, bed, bathroom, cleanliness, the view or outlook',
  },
];

/**
 * Rotating angles keep regenerations from converging on the same sentence
 * shape. One is picked at random per request.
 */
const ANGLES = [
  'open with a specific small moment rather than a general verdict',
  'write it as a short recommendation to another traveller',
  'lead with how the place made you feel, then say why',
  'mention one concrete detail and let the rest be brief',
  'compare it favourably to staying in the middle of the city',
  'write it plainly, almost understated — no adjectives stacked up',
  'start mid-thought, the way people actually type reviews on their phone',
  'note something you would do again or tell a friend about',
];

/**
 * The writing prompt, for one venue.
 *
 * @param {object} venue - name, kind, place, safeDetails; the resolved values
 *   for whichever subscriber is being served, not necessarily the built-in.
 */
function buildSystemPrompt(venue) {
  return `You write short Google reviews in the voice of a real guest who has just checked out of ${venue.name}, ${venue.kind} in ${venue.place}.

Rules:
- 1 to 3 sentences. Under 45 words. Casual, first person, past tense.
- Always positive — this is a 5-star review.
- Sound like a person typing on their phone, not like marketing copy. Contractions are good. A sentence fragment is fine.
- Vary how you open. Never begin with "I recently stayed" or "My stay at".
- Do not invent facts: no staff names, no prices, no dish names, no room numbers, no dates, no claims about awards, amenities, or facilities that are not in the list below.
- No emoji, no hashtags, no star ratings, no headings, no quotation marks around the review.
- Do not address the reader or the business directly. Do not sign off.
- Output only the review text. Nothing before it, nothing after it.

Details you may draw on:
${venue.safeDetails.map((d) => `- ${d}`).join('\n')}`;
}

/**
 * @param {object} args
 * @param {string} args.categoryId
 * @param {string[]} args.recent - recent reviews to avoid echoing
 * @param {object[]} [args.categories] - the venue's own buttons, if it set any
 * @param {object} [args.venue] - the venue being written about
 * @param {() => number} [args.rand] - injectable for tests
 */
function buildMessages({
  categoryId,
  recent = [],
  categories,
  venue = VENUE,
  rand = Math.random,
}) {
  const list =
    Array.isArray(categories) && categories.length ? categories : CATEGORIES;
  const category = list.find((c) => c.id === categoryId) || list[0];
  const angle = ANGLES[Math.floor(rand() * ANGLES.length)];

  let user = `Write one review about ${category.focus}.\n\nThis time: ${angle}.`;

  if (recent.length) {
    const list = recent
      .slice(-3)
      .map((r) => `- ${r}`)
      .join('\n');
    user += `\n\nYou already wrote these. Make this one clearly different in wording, structure, and opening:\n${list}`;
  }

  return [
    { role: 'system', content: buildSystemPrompt(venue) },
    { role: 'user', content: user },
  ];
}

module.exports = {
  VENUE,
  CATEGORIES,
  ANGLES,
  buildSystemPrompt,
  buildMessages,
};
