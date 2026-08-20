'use strict';

/**
 * The built-in fallback venue.
 *
 * Deliberately not a real place any more. It used to be Baanpong Lodge, the
 * first customer, and every business that had not yet described itself
 * inherited it — so a dental clinic's guests were handed reviews about a garden
 * in San Kamphaeng. Categories had already been cut loose from their built-in
 * for exactly that reason; these are the rest of it.
 *
 * A name is all that is left of it. Everything else a review may say now
 * travels with the topic the guest picked, so there is nothing here to inherit
 * and nothing to get wrong: a business with no topics is told to keep to the
 * guest's own impression rather than inventing a garden.
 */
const VENUE = {
  name: 'the business',
};

const { GENERIC_CONTEXT, platformNote } = require('./context');

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

/* ------------------------------------------------------------------ length */

/**
 * How long the review should be.
 *
 * Real listings are not uniform, and every review being the same length is
 * itself one of the tells in the generic context document — so a length is drawn
 * per request rather than fixed. What the guest picks is which pool it is drawn
 * from, not an exact length: "Short" twice must still give two different shapes.
 *
 * `Any` draws from both pools, which is what the page did before this selector
 * existed.
 */
const SHORT_LENGTHS = [
  'a single line, under fifteen words',
  'one sentence, and stop there',
  'one short sentence, with nothing after it',
  'two very short sentences',
];

const DETAILED_LENGTHS = [
  'one short sentence and one longer one',
  'two sentences, the second longer than the first',
  'two sentences, the second much shorter',
  'three short sentences',
  'three sentences, the middle one the longest',
  'four short sentences',
];

/**
 * The ceiling that goes in the system prompt, per choice.
 *
 * It has to move with the pool. "Detailed" while still capped at 45 words is not
 * detailed, and "Short" left at 45 lets the model spend all of them.
 */
const LENGTH_RULES = {
  any: 'One to three sentences. Under 45 words.',
  short: 'One or two sentences. Under 30 words.',
  detailed: 'Two to four sentences. Under 80 words.',
};

/** What the guest's selector offers. Sent to the page so the two cannot drift. */
const LENGTH_CHOICES = [
  { id: 'any', label: 'Any' },
  { id: 'short', label: 'Short' },
  { id: 'detailed', label: 'Detailed' },
];

const DEFAULT_LENGTH = 'any';

/** An unknown id falls back to `any` rather than refusing — a stale page still works. */
function lengthFor(id) {
  return LENGTH_CHOICES.some((c) => c.id === id) ? id : DEFAULT_LENGTH;
}

/** @returns {string[]} the phrasings a given choice may draw from */
function lengthPool(choice) {
  if (choice === 'short') return SHORT_LENGTHS;
  if (choice === 'detailed') return DETAILED_LENGTHS;
  return [...SHORT_LENGTHS, ...DETAILED_LENGTHS];
}

/* ------------------------------------------------------------------ voice */

const VOICES = [
  'plain and unfussy, the way most people write',
  'warm, but not gushing',
  'clipped, like someone typing quickly on a phone',
  'a little more considered, as if they thought before writing',
  'understated — the praise is there but quiet',
];

/**
 * Rotating angles keep regenerations from converging on the same sentence
 * shape. One is picked at random per request.
 *
 * Kept free of anything only a hotel guest could do: this list is used for a
 * clinic and a garage too, so "compare it favourably to staying in the middle of
 * the city" had to go.
 */
const ANGLES = [
  'open with a specific small moment rather than a general verdict',
  'write it as a short recommendation to someone else looking',
  'lead with how the place made you feel, then say why',
  'mention one concrete detail and let the rest be brief',
  'write it plainly, almost understated — no adjectives stacked up',
  'start mid-thought, the way people actually type on their phone',
  'note something you would do again or tell a friend about',
  'say what you expected and then that it was better than that',
];

/* ------------------------------------------------------------------ prompt */

/**
 * The system prompt: the generic context document, then this business.
 *
 * Generic first. It is the same on every call, for every business, so it sits at
 * the front where a prompt cache can keep it — and the business-specific half
 * reads as the exception to a rule already stated, which is the order it is
 * meant to be read in.
 *
 * @param {object} venue - the business being served: its name, and nothing
 *   else. Everything a review may say about it now travels with the topic.
 * @param {object} [options]
 * @param {string} [options.length] - which length choice is in force
 * @param {string[]} [options.platformIds] - the platforms this business links to
 */
function buildSystemPrompt(venue, { length = DEFAULT_LENGTH, platformIds = [] } = {}) {
  const note = platformNote(platformIds);

  const parts = [
    `You write short, positive reviews in the voice of a real customer who has just finished at ${venue.name}.`,
    GENERIC_CONTEXT,
  ];

  // Where the no-fabrication guarantee lives now.
  //
  // It used to be a list of details checked line by line against the business's
  // own website, sitting here in the system prompt. That list is gone and the
  // topic description in the request has taken its place, so this block's whole
  // job is to say that the description is a boundary and not a starting point.
  //
  // In the system prompt rather than beside the description itself, for two
  // reasons. It is the same words on every generation, so it sits in the half a
  // prompt cache can keep. And a limit stated in the same breath as the material
  // it limits reads as a caveat; stated first, it reads as the rule that material
  // arrives under.
  parts.push(
    `What you may say about this business

Everything you know about ${venue.name} is in the topic description in the request below. The business wrote it itself, and it is a boundary rather than a starting point.

- You may say what that description says, in the customer's own words rather than the business's.
- You may say how the visit felt and how the customer was treated. That is theirs to report and needs no source.
- You may not add anything else about this business: not a service, not a facility, not a speciality, not a detail that a business of this kind usually has. If the description does not mention it, it does not exist as far as you are concerned.
- If the request names no topic then you have no description, and you must write about how the visit felt and nothing specific about the place at all.`
  );

  parts.push(`Rules

- ${LENGTH_RULES[length] || LENGTH_RULES[DEFAULT_LENGTH]} Casual, first person, past tense.
- Always positive — this is a five-star review.
- Do not invent facts: no staff names, no prices, no room numbers, no dates, no claims about awards, amenities or facilities that the description does not make.
- You may name the specific thing the description names — a dish, a product, a treatment, a room type — because the business wrote it and the customer chose it. Nothing else by name, and never a name you have supplied yourself. If the description names nothing specific, name nothing.
- No numbers of any kind. No emoji, no hashtags, no star ratings, no headings, no quotation marks around the review.
- Do not address the reader or the business. Do not sign off.
- Output only the review text. Nothing before it, nothing after it.${note ? `\n- ${note}` : ''}`);

  return parts.join('\n\n');
}

/**
 * @param {object} args
 * @param {string[]} args.categoryIds - the topics the guest picked, if any
 * @param {string[]} args.recent - reviews to write away from
 * @param {object[]} [args.categories] - the business's own topics, if it set any
 * @param {object} [args.venue] - the business being written about
 * @param {string[]} [args.examples] - reviews this business approved
 * @param {string[]} [args.realism] - reviews already written for this business,
 *   as a reference for how real ones read. Must not overlap `recent`.
 * @param {string[]} [args.rejected] - reviews this business turned down
 * @param {string} [args.language] - which language to write in
 * @param {string} [args.length] - 'any' | 'short' | 'detailed'
 * @param {string[]} [args.platformIds] - the platforms this business links to
 * @param {() => number} [args.rand] - injectable for tests
 */
function buildMessages({
  categoryIds = [],
  recent = [],
  categories,
  venue = VENUE,
  examples = [],
  realism = [],
  rejected = [],
  language = DEFAULT_LANGUAGE,
  length = DEFAULT_LENGTH,
  platformIds = [],
  rand = Math.random,
}) {
  // No fallback to a built-in set. A business with no topics has none, and the
  // old built-in five described a lodge — handing them to a dentist was worse
  // than having no buttons.
  const list = Array.isArray(categories) ? categories : [];
  const picked = list.filter((c) => categoryIds.includes(c.id));

  const choice = lengthFor(length);
  const pool = lengthPool(choice);

  const angle = ANGLES[Math.floor(rand() * ANGLES.length)];
  const shape = pool[Math.floor(rand() * pool.length)];
  const voice = VOICES[Math.floor(rand() * VOICES.length)];

  // One topic's label and the paragraph the business wrote under it.
  //
  // Quoted as the business's own words rather than folded into the instruction,
  // because the two are read differently: an instruction is something to carry
  // out, while quoted material is something to draw from — and the system prompt
  // above has already said this paragraph is the edge of what may be claimed.
  const describe = (c) =>
    c.focus && c.focus !== c.label
      ? `${c.label}\n\nWhat the business says about it:\n${c.focus}`
      : c.label;

  // Nothing picked, or nothing to pick: write about the visit rather than
  // refusing. A guest who goes straight to Regenerate still gets something —
  // and with no description in hand, the system prompt has already told the
  // writer that means feelings only.
  let about = `the visit overall. There is no topic and so no description: write about how it felt and name nothing specific about the place`;

  if (picked.length === 1) {
    about = describe(picked[0]);
  } else if (picked.length > 1) {
    // Woven, not listed. Several topics in one short review becomes an inventory
    // unless the prompt says otherwise, and an inventory does not read like a
    // customer — it is one of the tells in the generic document.
    about =
      picked.map(describe).join(`\n\n---\n\n`) +
      `\n\nThat is ${picked.length} things at once — do not list them. Lead with whichever felt most worth saying and let the rest show up in passing, or leave one out if it will not fit naturally.`;
  }

  let user = `Write one review about ${about}\n\nThis time: ${angle}. Make it ${shape}, and write it ${voice}.`;

  // What has actually been posted for this business, as a calibration sample.
  // This is the closest thing to training the product does: the writer is shown
  // real output from the same listing and asked to match how real it reads,
  // rather than being asked in the abstract to sound authentic.
  //
  // On manner only, and explicitly not on subject — the "write away from these"
  // block below is a different, disjoint sample, and the two would fight if both
  // spoke about wording.
  if (realism.length) {
    const sample = realism
      .slice(0, 4)
      .map((r) => `- ${r}`)
      .join('\n');
    user += `\n\nReviews already written for this business, as a reference for how a real one reads here — their length, their level of detail, how much they say and how much they leave out. Match that. Do not reuse their wording, their openings or the things they talk about:\n${sample}`;
  }

  // Approved samples pull towards a house voice. Narrower than the realism
  // block above and stronger, because a human chose each one.
  if (examples.length) {
    const sample = examples
      .slice(0, 3)
      .map((r) => `- ${r}`)
      .join('\n');
    user += `\n\nThis business approved these earlier reviews. Match their tone and length, not their wording:\n${sample}`;
  }

  // A rejected review says what this business does not want said about it,
  // which the approved ones cannot express.
  if (rejected.length) {
    const sample = rejected
      .slice(0, 3)
      .map((r) => `- ${r}`)
      .join('\n');
    user += `\n\nThis business rejected these. Do not write anything like them:\n${sample}`;
  }

  // Last but for the language, so "make this clearly different" is the
  // instruction nearest the model's own output and wins on phrasing.
  if (recent.length) {
    const sample = recent
      // Eight, not three: three was one guest's own session, and this list now
      // carries what the business has published lately too. Each costs prompt
      // tokens, so this is a ceiling rather than everything on file.
      .slice(-8)
      .map((r) => `- ${r}`)
      .join('\n');
    user += `\n\nThese reviews already exist for this business. Make this one clearly different in wording, structure and opening — someone reading the listing must not see the same review twice:\n${sample}`;
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
    {
      role: 'system',
      content: buildSystemPrompt(venue, { length: choice, platformIds }),
    },
    { role: 'user', content: user },
  ];
}

module.exports = {
  VENUE,
  LANGUAGES,
  DEFAULT_LANGUAGE,
  languageFor,
  ANGLES,
  VOICES,
  SHORT_LENGTHS,
  DETAILED_LENGTHS,
  LENGTH_CHOICES,
  LENGTH_RULES,
  DEFAULT_LENGTH,
  lengthFor,
  lengthPool,
  buildSystemPrompt,
  buildMessages,
};
