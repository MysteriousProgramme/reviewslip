'use strict';

/**
 * Topic names, in the language the guest picked.
 *
 * A business writes its topics once, in its own language. A guest who switches
 * the page to Thai then reads Thai chrome, gets a Thai review — and taps a row
 * of English buttons to choose what it is about. That gap is what this closes.
 *
 * Names only. The description is read by the model, not by the guest, and the
 * model writes the review in the guest's language whether the paragraph it was
 * given is English or not — so translating descriptions would double the
 * storage and the spend to change nothing anybody sees.
 *
 * Translated on demand and then kept. The first guest to pick a language pays
 * for one model call; every guest after them reads what it produced. Nothing is
 * translated for a business whose guests never ask, which for most of them is
 * every language on the list.
 *
 * Staleness needs no timestamps. Each stored name remembers the name it was
 * made from, so a label the owner has since edited no longer matches and counts
 * as missing.
 */

const { languageFor } = require('./config');

/**
 * Bumped whenever the prompt above changes in a way that should re-translate
 * what is already stored.
 *
 * Without this, a stored table is invalidated only by its own label changing —
 * so a rule that fixes bad output fixes it for businesses set up afterwards and
 * for nobody else. The first version left names in their original script, which
 * put Latin buttons on a Thai page; a business that had already been translated
 * would have kept them forever.
 *
 * The cost of a bump is one model call per language per business, the next time
 * a guest asks for it. That is the same cost as the first guest ever paid.
 */
const VERSION = 2;

/** Sent once per language per business, so it can afford to be exact. */
const SYSTEM = `You translate the labels on a row of buttons. Each one is the name of something a customer might write a review about — a dish, a room type, a service, or an ordinary part of a visit.

Return a single JSON object mapping each id to its translation, and nothing else:
{ "rooms": "ห้องพัก", "sunday-roast": "Sunday Roast" }

Rules:
- These are buttons on a phone. Keep each translation as short as the original, and never longer than four words.
- Translate what the label means to a customer choosing a subject, not word by word.
- Every label comes back written in the script of the language you were asked for. A label left in the original script is one the customer cannot read, and a button they cannot read is one they will not press.
- A name is rendered, not kept. A dish, a room type, a product or a service the business has named still has to be readable: translate the ordinary words in it and write the rest the way it sounds in the target script. "Family Junior Suite" asked for in Thai comes back in Thai characters, never in Latin ones.
- The exception is a language written in the same script as the label already. Spanish, French, German, Italian, Portuguese and Dutch readers can read "Sunday Roast" as it stands, so leave a name alone in those rather than inventing a translation of it.
- No punctuation at the end, no quotation marks, no emoji, no explanation.
- Return every id you were given, even the ones you left unchanged.

Output only the JSON object. Nothing before it, nothing after it.`;

/**
 * @param {object} args
 * @param {string} args.language - a code from config.js's LANGUAGES
 * @param {{id: string, label: string}[]} args.topics - only the ones needing it
 */
function buildLabelMessages({ language, topics }) {
  const name = languageFor(language).name;
  const list = topics.map((t) => `${t.id}: ${t.label}`).join('\n');

  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Translate these button labels into ${name}.\n\n${list}`,
    },
  ];
}

/** @returns {Record<string, string>} id to translation, empty when unusable */
function parseLabels(raw) {
  const start = String(raw ?? '').indexOf('{');
  const end = String(raw ?? '').lastIndexOf('}');
  if (start === -1 || end <= start) return {};

  let data;
  try {
    data = JSON.parse(String(raw).slice(start, end + 1));
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object') return {};

  const out = {};
  for (const [id, value] of Object.entries(data)) {
    // Same ceiling as a stored label. A model that answers with a sentence
    // gets that entry dropped rather than a button that wraps to three lines.
    const label = typeof value === 'string' ? value.trim().slice(0, 40) : '';
    if (label) out[id] = label;
  }
  return out;
}

/**
 * The topics still needing a translation in this language.
 *
 * A topic is missing when it has no entry, or when the entry was made from a
 * label the owner has since changed.
 *
 * @param {object} table - the stored table for one language
 * @param {{id: string, label: string}[]} topics
 */
function missing(table, topics) {
  return topics.filter((t) => {
    const held = table?.[t.id];
    return !held || held.of !== t.label || held.v !== VERSION;
  });
}

/**
 * The stored table for one language, updated with what came back.
 *
 * Entries for topics that no longer exist are dropped rather than carried: a
 * business that has replaced its whole topic set should not keep paying to
 * store translations of the old one.
 */
function merge(table, fresh, topics) {
  const out = {};
  for (const topic of topics) {
    const label = fresh[topic.id];
    if (label) {
      out[topic.id] = { label, of: topic.label, v: VERSION };
    } else if (
      table?.[topic.id]?.of === topic.label &&
      table[topic.id].v === VERSION
    ) {
      // Kept only if it is still current in both senses. An entry from an older
      // prompt is carried no further than the call that failed to replace it.
      out[topic.id] = table[topic.id];
    }
  }
  return out;
}

/**
 * The topics as the guest should see them.
 *
 * Anything without a usable translation keeps its own label rather than
 * disappearing or showing an id. A half-translated list is worse than an
 * untranslated one only if the gaps are blank.
 */
function apply(table, topics) {
  return topics.map((topic) => {
    const held = table?.[topic.id];
    // Shown even when it is from an older prompt: a translation that is merely
    // out of date beats a Latin button on a Thai page, and `missing` has
    // already asked for a better one.
    return held && held.of === topic.label
      ? { ...topic, label: held.label }
      : topic;
  });
}

module.exports = {
  buildLabelMessages,
  parseLabels,
  missing,
  merge,
  apply,
  SYSTEM,
  VERSION,
};
