'use strict';

/**
 * The prompt is the product, and nothing here needs a network or a database to
 * check: given a business and a guest's choices, the messages that go to the
 * model are a pure function. So they get tested as one.
 *
 * What this cannot tell you is whether the reviews are any good — that only
 * comes from reading them, which is what the dashboard's thumbs are for. What it
 * can tell you is that the guest's Short actually reached the prompt, that a
 * business with no details is not handed somebody else's, and that a superlative
 * typed into the context box does not survive to the listing.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const context = require('../context');
const config = require('../config');
const seed = require('../seed');
const settings = require('../settings');

/** A business that has described itself. */
const CLINIC = {
  name: 'Riverside Dental',
  kind: 'a dental clinic',
  place: 'Hobart, Tasmania',
  safeDetails: ['a quiet waiting room', 'parking right outside'],
};

const TOPICS = [
  { id: 'rooms', label: 'Rooms', focus: 'the room itself' },
  { id: 'staff', label: 'Staff', focus: 'how you were treated' },
];

/** Picks index 0 of every pool, so a drawn phrasing is assertable. */
const first = () => 0;

/* --------------------------------------------------------- generic context */

test('every compliance rule reaches every prompt', () => {
  // The point of this one: the published guide at reviewslip.com/faq is what
  // keeps a customer and a business out of trouble, and "the writer is told
  // about it" has to be a checked fact rather than something someone remembers.
  // A business with nothing filled in is the case that matters most, because it
  // is the one where every other section of the prompt is empty.
  assert.ok(context.COMPLIANCE_RULES.length >= 6);

  for (const venue of [CLINIC, { name: 'Somewhere', safeDetails: [] }]) {
    const [system] = config.buildMessages({ venue });
    for (const rule of context.COMPLIANCE_RULES) {
      assert.ok(
        system.content.includes(rule),
        `missing from the prompt: ${rule.slice(0, 60)}…`
      );
    }
  }
});

test('the compliance rules name the things that are actually banned', () => {
  const all = context.COMPLIANCE.toLowerCase();

  // Each of these maps to a question on the published guide. A rule quietly
  // reworded out of existence should fail here, not in front of a regulator.
  for (const banned of [
    'incentivised', // "Can I offer a discount or a free item for a review?"
    'insider', // "Can staff, friends or family leave reviews?"
    'solicited', // undisclosed solicitation
    'fabricated', // "What do these rules actually ban?"
    'awards',
  ]) {
    assert.match(all, new RegExp(banned));
  }
});

test('the generic context carries both halves of the craft', () => {
  assert.match(context.GENERIC_CONTEXT, /What a real review is like/);
  assert.match(context.GENERIC_CONTEXT, /look manufactured/);
  assert.match(context.GENERIC_CONTEXT, /Register/);
});

test('the generic context names no particular kind of business', () => {
  // The whole point of the split: this file ships to a clinic and a campsite.
  // "hotel"/"restaurant" appear once each in the register paragraph as examples
  // of how registers differ, so this checks for the old tenant, not for nouns.
  assert.doesNotMatch(context.GENERIC_CONTEXT, /Baanpong|Chiang Mai|San Kamphaeng/i);
});

test('a platform note needs exactly one known destination', () => {
  assert.equal(context.platformNote([]), '');
  assert.equal(context.platformNote(['google', 'tripadvisor']), '');
  assert.equal(context.platformNote(['nonsense']), '');
  assert.match(context.platformNote(['google']), /Google/);
});

/* ----------------------------------------------------------- system prompt */

test('the system prompt opens on this business, not a built-in one', () => {
  const prompt = config.buildSystemPrompt(CLINIC);

  assert.match(prompt, /Riverside Dental, a dental clinic in Hobart, Tasmania/);
  assert.match(prompt, /a quiet waiting room/);
  assert.match(prompt, /What a real review is like/);
});

test('a business with no details is told to claim nothing, not handed a lodge', () => {
  const prompt = config.buildSystemPrompt({ name: 'Somewhere', safeDetails: [] });

  assert.match(prompt, /None have been recorded/);
  assert.match(prompt, /state no specific fact/);
  // The regression this exists for: the built-in used to be the first customer.
  assert.doesNotMatch(prompt, /garden|Chiang Mai/i);
});

test('the context doc goes in framed as background, not as fact', () => {
  const prompt = config.buildSystemPrompt({
    ...CLINIC,
    contextDoc: 'Mostly families booking a check-up.',
  });

  assert.match(prompt, /Mostly families booking a check-up\./);
  assert.match(prompt, /do not treat anything here as a fact/i);
});

test('the length ceiling moves with the length choice', () => {
  const short = config.buildSystemPrompt(CLINIC, { length: 'short' });
  const detailed = config.buildSystemPrompt(CLINIC, { length: 'detailed' });

  assert.match(short, /Under 30 words/);
  assert.match(detailed, /Under 80 words/);
  // A "Detailed" review still capped at the default 45 would not be detailed.
  assert.doesNotMatch(detailed, /Under 45 words/);
});

test('the platform note reaches the rules when there is one destination', () => {
  const prompt = config.buildSystemPrompt(CLINIC, { platformIds: ['xiaohongshu'] });
  assert.match(prompt, /Xiaohongshu/);
});

/* ------------------------------------------------------------- the request */

test('short and detailed draw from their own pools only', () => {
  // Every index of every pool, rather than one sample: an off-by-one in
  // lengthPool would still pass a single draw.
  for (const [choice, pool] of [
    ['short', config.SHORT_LENGTHS],
    ['detailed', config.DETAILED_LENGTHS],
  ]) {
    const seen = new Set();

    for (let i = 0; i < 200; i++) {
      const [, user] = config.buildMessages({
        venue: CLINIC,
        length: choice,
        rand: Math.random,
      });
      const hit = pool.find((phrase) => user.content.includes(phrase));
      assert.ok(hit, `${choice} drew something outside its pool: ${user.content}`);
      seen.add(hit);
    }

    assert.equal(seen.size, pool.length, `${choice} never drew some of its pool`);
  }
});

test('any draws from both pools', () => {
  const drawn = new Set();

  for (let i = 0; i < 400; i++) {
    const [, user] = config.buildMessages({ venue: CLINIC, length: 'any' });
    if (config.SHORT_LENGTHS.some((p) => user.content.includes(p))) drawn.add('short');
    if (config.DETAILED_LENGTHS.some((p) => user.content.includes(p))) drawn.add('long');
  }

  assert.deepEqual([...drawn].sort(), ['long', 'short']);
});

test('an unknown length falls back to any rather than refusing', () => {
  assert.equal(config.lengthFor('enormous'), 'any');
  assert.equal(config.lengthFor(undefined), 'any');
  assert.equal(config.lengthFor('short'), 'short');

  const [system] = config.buildMessages({ venue: CLINIC, length: 'enormous' });
  assert.match(system.content, /Under 45 words/);
});

test('prior reviews come in as a realism reference, on manner not wording', () => {
  const [, user] = config.buildMessages({
    venue: CLINIC,
    realism: ['Quick and painless. In and out.'],
  });

  assert.match(user.content, /Quick and painless/);
  assert.match(user.content, /how a real one reads here/);
  assert.match(user.content, /Do not reuse their wording/);
});

test('the write-away-from block is last and keeps its own framing', () => {
  const [, user] = config.buildMessages({
    venue: CLINIC,
    realism: ['A realism sample.'],
    examples: ['An approved one.'],
    rejected: ['A rejected one.'],
    recent: ['Something already posted.'],
  });

  // Order is load-bearing: whichever instruction is nearest the model's own
  // output wins on phrasing, and that has to be "make this different".
  const at = (needle) => user.content.indexOf(needle);
  assert.ok(at('A realism sample.') < at('An approved one.'));
  assert.ok(at('An approved one.') < at('A rejected one.'));
  assert.ok(at('A rejected one.') < at('Something already posted.'));
  assert.match(user.content, /clearly different in wording, structure and opening/);
});

test('one topic is used directly and several are woven rather than listed', () => {
  const [, one] = config.buildMessages({
    venue: CLINIC,
    categories: TOPICS,
    categoryIds: ['rooms'],
  });
  assert.match(one.content, /Write one review about the room itself\./);

  const [, both] = config.buildMessages({
    venue: CLINIC,
    categories: TOPICS,
    categoryIds: ['rooms', 'staff'],
  });
  assert.match(both.content, /That is 2 things at once — do not list them/);
});

test('an unknown topic id is dropped, not fatal', () => {
  const [, user] = config.buildMessages({
    venue: CLINIC,
    categories: TOPICS,
    categoryIds: ['gone'],
  });
  // Falls back to the visit overall, which is also what tapping nothing gives.
  assert.match(user.content, /the visit overall/);
});

test('a non-English language is asked for last and only for the review', () => {
  const [, user] = config.buildMessages({
    venue: CLINIC,
    language: 'th',
    recent: ['Something already posted.'],
    rand: first,
  });

  assert.match(user.content, /Write the review in Thai\./);
  assert.ok(user.content.trimEnd().endsWith('do not add the English version.'));
});

/* ------------------------------------------------------------ topic drafts */

test('drafted topics are accepted under either key the model reaches for', () => {
  const asTopics = seed.parseTopics('{"topics":[{"label":"Rooms","focus":"the room"}]}');
  const asCategories = seed.parseTopics(
    '{"categories":[{"label":"Rooms","focus":"the room"}]}'
  );

  assert.deepEqual(asTopics, [{ label: 'Rooms', focus: 'the room' }]);
  assert.deepEqual(asCategories, asTopics);
});

test('drafted topics are capped, deduped and stripped of bad steers', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    label: `Topic ${String.fromCharCode(65 + (i % 26))}${i}`,
    focus: 'something',
  }));
  assert.equal(seed.parseTopics(JSON.stringify({ topics: many }), { max: 30 }).length, 30);

  const dupes = seed.parseTopics(
    '{"topics":[{"label":"Rooms","focus":"a"},{"label":"rooms","focus":"b"}]}'
  );
  assert.equal(dupes.length, 1);

  // A bad focus reaches every review under that button, so the steer goes and
  // the button stays — the label alone still works.
  const [screened] = seed.parseTopics(
    '{"topics":[{"label":"Bar","focus":"our award-winning bar"}]}'
  );
  assert.deepEqual(screened, { label: 'Bar', focus: '' });

  const [numbered] = seed.parseTopics(
    '{"topics":[{"label":"Rooms","focus":"all 12 of the rooms"}]}'
  );
  assert.equal(numbered.focus, '');
});

test('unusable topic output is null rather than an empty list', () => {
  assert.equal(seed.parseTopics('sorry, I could not read that page'), null);
  assert.equal(seed.parseTopics('{"topics":[]}'), null);
  assert.equal(seed.parseTopics('{"topics":[{"label":"  "}]}'), null);
});

/* ----------------------------------------------------- context doc drafts */

test('a drafted context keeps its paragraphs and drops only bad sentences', () => {
  const raw = JSON.stringify({
    contextDoc:
      'Families book check-ups here. It is our award-winning practice. The waiting room is quiet.\n\nReviews here are short.',
  });

  const parsed = seed.parseContextDoc(raw);

  assert.match(parsed.contextDoc, /Families book check-ups here\./);
  assert.match(parsed.contextDoc, /The waiting room is quiet\./);
  assert.match(parsed.contextDoc, /Reviews here are short\./);
  // Dropped, and reported — a silent gap would send the customer looking for a
  // bug, and leaving it in would only fail the validator on Save.
  assert.doesNotMatch(parsed.contextDoc, /award-winning/);
  assert.equal(parsed.dropped.length, 1);
  assert.match(parsed.dropped[0], /award-winning/);
  assert.ok(parsed.contextDoc.includes('\n\n'));
});

test('a drafted context is cut to the stored limit', () => {
  const raw = JSON.stringify({ contextDoc: 'a. '.repeat(500) });
  assert.ok(seed.parseContextDoc(raw, { maxChars: 200 }).contextDoc.length <= 200);
});

test('unusable context output is null', () => {
  assert.equal(seed.parseContextDoc('no json here'), null);
  assert.equal(seed.parseContextDoc('{"contextDoc":"   "}'), null);
  // Every sentence screened out is the same as nothing usable coming back.
  assert.equal(seed.parseContextDoc('{"contextDoc":"Our award-winning clinic."}'), null);
});

/* ----------------------------------------------------------- stored limits */

test('a business resolves to its own topics and details, or to none', () => {
  const bare = settings.resolve({});
  assert.deepEqual(bare.categories, []);
  assert.deepEqual(bare.safeDetails, []);
  assert.equal(bare.kind, '');
  assert.equal(bare.place, '');
  assert.equal(bare.contextDoc, '');
});

test('thirty topics are allowed and thirty-one are refused', () => {
  const rows = (n) =>
    Array.from({ length: n }, (_, i) => ({ label: `Topic ${i}`, focus: '' }));

  assert.equal(settings.MAX_TOPICS, 30);
  assert.ok(settings.validateCategories(rows(30)).ok);
  assert.equal(settings.validateCategories(rows(31)).ok, false);
});

test('topic ids survive a rename so a guest is not bounced off their choice', () => {
  const { categories } = settings.validateCategories([
    { id: 'breakfast', label: 'Breakfast & Coffee', focus: '' },
  ]);
  assert.equal(categories[0].id, 'breakfast');
  // A blank note falls back to the label, which reads fine in the prompt.
  assert.equal(categories[0].focus, 'Breakfast & Coffee');
});

test('the context doc refuses superlatives but allows figures', () => {
  assert.equal(settings.validate({ contextDoc: 'Our award-winning kitchen.' }).ok, false);

  // Unlike a detail, this is background the writer is told not to repeat — so a
  // number in it is not a claim that reaches the listing.
  assert.ok(settings.validate({ contextDoc: 'Open 7 days, busiest at 8pm.' }).ok);

  const long = settings.validate({ contextDoc: 'a'.repeat(settings.MAX_CONTEXT_DOC + 1) });
  assert.equal(long.ok, false);
  assert.match(long.error, /is the limit/);
});

test('a hand-typed detail is screened exactly as a drafted one is', () => {
  // The reason the details list could be made editable at all.
  assert.equal(settings.validate({ safeDetails: ['our award-winning bar'] }).ok, false);
  assert.equal(settings.validate({ safeDetails: ['12 rooms'] }).ok, false);
  assert.ok(settings.validate({ safeDetails: ['a quiet waiting room'] }).ok);
});
