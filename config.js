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
 * The languages a guest may write in.
 *
 * `label` is what the selector shows — in that language, because someone
 * looking for Thai is not reading the English word "Thai". `name` is what the
 * prompt says, in English, because that is what the model reliably understands.
 */
const LANGUAGES = [
  { code: 'en', label: 'English', name: 'English' },
  { code: 'th', label: 'ไทย', name: 'Thai' },
  { code: 'zh', label: '中文', name: 'Simplified Chinese' },
  { code: 'ja', label: '日本語', name: 'Japanese' },
  { code: 'ko', label: '한국어', name: 'Korean' },
  { code: 'es', label: 'Español', name: 'Spanish' },
  { code: 'fr', label: 'Français', name: 'French' },
  { code: 'de', label: 'Deutsch', name: 'German' },
  { code: 'it', label: 'Italiano', name: 'Italian' },
  { code: 'pt', label: 'Português', name: 'Portuguese' },
  { code: 'nl', label: 'Nederlands', name: 'Dutch' },
];

const DEFAULT_LANGUAGE = 'en';

function languageFor(code) {
  return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
}

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
 * @param {string[]} args.categoryIds - the topics the guest picked, if any
 * @param {string[]} args.recent - recent reviews to avoid echoing
 * @param {object[]} [args.categories] - the venue's own buttons, if it set any
 * @param {object} [args.venue] - the venue being written about
 * @param {string[]} [args.examples] - reviews this business approved
 * @param {string} [args.language] - which language to write in
 * @param {() => number} [args.rand] - injectable for tests
 */
function buildMessages({
  categoryIds = [],
  recent = [],
  categories,
  venue = VENUE,
  examples = [],
  language = DEFAULT_LANGUAGE,
  rand = Math.random,
}) {
  // No fallback to the built-in set. A business with no categories has none,
  // and CATEGORIES describes a lodge — handing it to a dentist was worse than
  // having no buttons.
  const list = Array.isArray(categories) ? categories : [];
  const picked = list.filter((c) => categoryIds.includes(c.id));
  const angle = ANGLES[Math.floor(rand() * ANGLES.length)];

  // Nothing picked, or nothing to pick: write about the visit rather than
  // refusing. A guest who goes straight to Regenerate still gets something.
  let about =
    'the visit overall — pick whichever single aspect feels most natural to lead with';

  if (picked.length === 1) {
    about = picked[0].focus;
  } else if (picked.length > 1) {
    // Woven, not listed. Several topics in 45 words becomes an inventory unless
    // the prompt says otherwise, and an inventory does not read like a guest.
    about =
      picked.map((c) => c.focus).join('; and ') +
      `.\n\nThat is ${picked.length} things at once — do not list them. Lead with whichever felt most worth saying and let the rest show up in passing, or leave one out if it will not fit naturally`;
  }

  let user = `Write one review about ${about}.\n\nThis time: ${angle}.`;

  // Approved samples pull towards a house voice; the recent list below pushes
  // away from repetition. They would fight if both asked about wording, so this
  // one asks only for tone and length — and it goes first, so the "make this
  // clearly different" instruction is the last thing read and wins on phrasing.
  if (examples.length) {
    const list = examples
      .slice(0, 3)
      .map((r) => `- ${r}`)
      .join('\n');
    user += `\n\nThis business approved these earlier reviews. Match their tone and length, not their wording:\n${list}`;
  }

  if (recent.length) {
    const list = recent
      // Eight, not three: three was one guest's own session, and this list now
      // carries what the business has published lately too. Each costs prompt
      // tokens, so this is a ceiling rather than everything on file.
      .slice(-8)
      .map((r) => `- ${r}`)
      .join('\n');
    user += `\n\nThese reviews already exist for this business. Make this one clearly different in wording, structure and opening — someone reading the listing must not see the same review twice:\n${list}`;
  }

  // Last, and stated plainly: a language instruction buried above the examples
  // gets ignored, and the examples are almost certainly in a different language
  // from the one being asked for.
  const chosen = languageFor(language);
  if (chosen.code !== DEFAULT_LANGUAGE) {
    user += `

Write the review in ${chosen.name}. Only the review — do not translate or restate anything else, and do not add the English version.`;
  }

  return [
    { role: 'system', content: buildSystemPrompt(venue) },
    { role: 'user', content: user },
  ];
}

module.exports = {
  VENUE,
  CATEGORIES,
  LANGUAGES,
  DEFAULT_LANGUAGE,
  languageFor,
  ANGLES,
  buildSystemPrompt,
  buildMessages,
};
