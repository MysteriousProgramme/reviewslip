'use strict';

/**
 * The prompt is the product, and nothing here needs a network or a database to
 * check: given a business and a guest's choices, the messages that go to the
 * model are a pure function. So they get tested as one.
 *
 * What this cannot tell you is whether the reviews are any good — that only
 * comes from reading them, which is what the dashboard's thumbs are for. What it
 * can tell you is that the guest's Short actually reached the prompt, that a
 * business with no topics is not handed somebody else's, and that a superlative
 * typed into a topic description does not survive to the listing.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const context = require('../context');
const config = require('../config');
const seed = require('../seed');
const settings = require('../settings');
const strings = require('../strings');
const platforms = require('../platforms');
const quota = require('../quota');
const translate = require('../translate');
const theme = require('../theme');
const assets = require('../assets');

/**
 * A business is a name now. Everything a review may say about one travels with
 * the topic the guest picked, so there is nothing else here to get wrong.
 */
const CLINIC = { name: 'Riverside Dental' };

const TOPICS = [
  {
    id: 'rooms',
    label: 'Rooms',
    focus:
      'The treatment rooms look out over the river. Each has its own chair and screen, and the blinds come down if you would rather not watch.',
  },
  {
    id: 'staff',
    label: 'Staff',
    focus: 'How you were greeted, and whether anyone explained what was happening before it happened.',
  },
];

/** Picks index 0 of every pool, so a drawn phrasing is assertable. */
const first = () => 0;

/**
 * A prompt with its line breaks flattened, for asserting on what it says.
 *
 * The topic instructions live in context_topic.md and are wrapped as prose, so
 * a sentence there is split across lines at whatever column it reached. A test
 * matching contiguous text fails the first time somebody reflows a paragraph —
 * which is a test failing for the document being edited the way it was meant to
 * be. The words are what matter here, not where they wrap.
 */
const flat = (prompt) => prompt.replace(/\s+/g, ' ');

/* --------------------------------------------------------- generic context */

test('every compliance rule reaches every prompt', () => {
  // The point of this one: the published guide at reviewslip.com/faq is what
  // keeps a customer and a business out of trouble, and "the writer is told
  // about it" has to be a checked fact rather than something someone remembers.
  // A business with nothing filled in is the case that matters most, because it
  // is the one where every other section of the prompt is empty.
  assert.ok(context.COMPLIANCE_RULES.length >= 6);

  for (const venue of [CLINIC, { name: 'Somewhere' }]) {
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
    'incentivised', // FAQ: "Can I offer a discount or a free item for a review?"
    'insider', // FAQ: "Can staff, friends or family leave reviews?"
    'solicited', // undisclosed solicitation
    'fabricated', // FAQ: "What do these rules actually ban?"
    'awards',
    'defamatory', // Terms 5: unlawful, fraudulent, deceptive or abusive
    'identifiable person', // Privacy 2B: nobody else ends up in the review
    'competitor', // Terms 5: only the business named
  ]) {
    assert.match(all, new RegExp(banned));
  }
});

test('the rules cite the documents they come from', () => {
  // These are not house style — each is something we have published, and a
  // review that breaks one puts the customer who posted it in the wrong. If a
  // rule stops being traceable to its source, that is worth failing over.
  for (const clause of ['Terms 5', 'Terms 7', 'Privacy 2B']) {
    assert.ok(
      context.COMPLIANCE.includes(clause),
      `no rule cites ${clause} any more`
    );
  }

  // And the clauses themselves are in the document, not linked. A writer
  // cannot open a URL mid-generation, so a citation is only checkable if the
  // text it cites is present. These are the load-bearing phrases from each.
  for (const [clause, quote] of [
    ['Terms 4', 'genuine customer experience with the business'],
    ['Terms 5', 'fake, misleading or fabricated reviews'],
    ['Terms 7', 'invent false customer experiences'],
    ['Privacy 2B', 'sensitive personal identifiers'],
  ]) {
    assert.ok(
      context.GENERIC_CONTEXT.includes(quote),
      `${clause} is no longer quoted in context.md`
    );
  }
});

test('the generic context is context.md, and every section of it', () => {
  // The words live in a markdown file so they can be edited as prose. This is
  // what stops that being a way to lose one: the document's whole body is what
  // goes into the prompt, and each named section has to be inside it.
  const doc = fs.readFileSync(path.join(__dirname, '..', 'context.md'), 'utf8');

  // The whole file, with nothing held back and nothing added. The loader still
  // strips a leading HTML comment, so this does too — a note put back at the
  // top of the document would be for whoever edits it, not for the model.
  const body = doc.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
  assert.equal(context.GENERIC_CONTEXT, body);

  for (const section of [context.COMPLIANCE, context.CRAFT, context.TELLS, context.REGISTER]) {
    assert.ok(context.GENERIC_CONTEXT.includes(section));
  }

  // A business can download this. It has to open as the document rather than
  // as a note to ourselves about how to maintain it — that now lives in
  // context.js, next to the code the constraints are about.
  assert.match(doc, /^# How to write a review/);
  assert.doesNotMatch(context.GENERIC_CONTEXT, /context\.js/);
});

test('a context.md missing a section refuses to load', () => {
  // The alternative is a prompt that quietly ships with no compliance rules in
  // it, which is the one failure this whole file exists to prevent. Better to
  // not start: systemd restarts on failure, so a bad edit fails at deploy
  // rather than at three in the morning.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  const copy = path.join(dir, 'context.js');

  fs.copyFileSync(path.join(__dirname, '..', 'context.js'), copy);
  // A template literal, so the fixture needs no escapes and reads as the
  // document it stands in for.
  fs.writeFileSync(
    path.join(dir, 'context.md'),
    `## Register

Something.
`
  );

  assert.throws(() => require(copy), /missing the "## Rules you must not break"/);

  // And a document that is not there at all.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  fs.copyFileSync(path.join(__dirname, '..', 'context.js'), path.join(bare, 'context.js'));
  assert.throws(() => require(path.join(bare, 'context.js')), /Could not read/);
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

  assert.match(prompt, /just finished at Riverside Dental\./);
  assert.match(prompt, /What a real review is like/);
  // The regression this exists for: the built-in used to be the first customer,
  // and every business that had not described itself inherited it.
  assert.doesNotMatch(prompt, /garden|Chiang Mai/i);
});

test('the description is named as the edge of what a review may claim', () => {
  // The whole no-fabrication guarantee now rests on one paragraph the business
  // wrote, so the prompt has to say that it is a boundary rather than a
  // starting point — and has to say it before the paragraph arrives.
  const prompt = config.buildSystemPrompt(CLINIC);

  assert.match(prompt, /Everything you know about Riverside Dental is in the topic description/);
  assert.match(prompt, /boundary rather than a starting point/);
  assert.match(prompt, /it does not exist as far as you are concerned/);
  // And the empty case, which is a guest who tapped nothing.
  assert.match(prompt, /If the request names no topic/);

  // Stated before the request, so it reads as the rule the material arrives
  // under rather than as a caveat attached to it.
  // Anchored on a rule that appears once. Searching for "Rules" would find
  // "## Rules you must not break" inside context.md, which is earlier and is
  // not the block meant here.
  assert.ok(
    prompt.indexOf('What you may say about this business') <
      prompt.indexOf('Do not invent facts'),
    'the boundary has to be stated before the rules that lean on it'
  );
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
  const prompt = config.buildSystemPrompt(CLINIC, { platformIds: ['wongnai'] });
  assert.match(prompt, /Wongnai/);
});

test('every platform on offer has a note, and nothing else does', () => {
  // The two lists have to agree: a platform with no note loses the one line
  // that tells the writer what genre it is writing in, and a note for a
  // platform nobody can pick is dead weight nobody will think to delete.
  for (const { id, label } of platforms.PLATFORMS) {
    assert.match(
      context.platformNote([id]),
      new RegExp(label),
      `no platform note mentions ${label}`
    );
  }

  // And the ones that were taken off the list are gone from both.
  for (const id of ['line', 'xiaohongshu']) {
    assert.equal(context.platformNote([id]), '');
    assert.ok(!platforms.PLATFORMS.some((p) => p.id === id));
  }
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
  assert.match(one.content, /Write one review about Rooms/);
  // The paragraph travels with it, quoted as the business's own words rather
  // than folded into the instruction — the two are read differently.
  assert.match(one.content, /What the business says about it:/);
  assert.match(one.content, /look out over the river/);

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

test('a page that will not read is told what to do about it', () => {
  // Any address can be handed to this: a website, a Facebook page, a listing.
  // The one that matters is Facebook, which answers a signed-out fetch with a
  // sign-in wall rather than a 404 — so the model gets a page, just not the
  // one it asked for. Left to itself it describes what it can see, which is a
  // login form, or invents what a business of that kind usually has.
  const [, user] = seed.buildTopicMessages({
    url: 'https://facebook.com/riverside',
    max: 50,
  });

  assert.match(user.content, /^Read https:\/\/facebook\.com\/riverside and /);
  assert.match(user.content, /shows a sign-in wall/);
  assert.match(user.content, /Do not describe a business you could not read/);
  // The honest fallback: topics true of any visit need no page behind them.
  assert.match(user.content, /only the topics of the third kind/);
  assert.doesNotMatch(user.content, /undefined/);
});

test('a URL still reads as a fetch, unchanged', () => {
  const [, user] = seed.buildTopicMessages({ url: 'https://riverside.example' });

  assert.match(user.content, /^Read https:\/\/riverside\.example and /);
  assert.doesNotMatch(user.content, /There is no page to fetch/);
});

test('a business is read from one address, whatever kind of page it is', () => {
  // There is no second kind of source any more. A caller reading sourceText
  // would get undefined and put it in a prompt, so it has to be gone rather
  // than merely blank.
  const bare = settings.resolve({});
  assert.ok(!('sourceText' in bare), 'sourceText is still being resolved');
  assert.ok(!('sourceText' in settings.describe({})));

  // And it cannot be smuggled back in through a save.
  const saved = settings.validate({ sourceText: 'A cafe on Bridge Street.' });
  assert.ok(saved.ok);
  assert.ok(!('sourceText' in saved));
});

test('the topic prompt aims at the cap but licenses falling short', () => {
  // Aiming at a number is the instruction a model answers with filler, and a
  // padded topic produces a vague review. What keeps this honest is not the
  // target but the two things either side of it: a deep well of topics that are
  // true of every business by definition, and permission to land short.
  const [system] = seed.buildTopicMessages({ url: 'https://x.example', max: 50 });
  const said = flat(system.content);

  assert.match(said, /Aim for close to 50 topics/);
  assert.match(said, /Falling short is fine\. Inventing is not\./);

  // The third kind is the well. If it stops being listed, the number can only
  // be reached by making things up.
  for (const universal of ['the welcome', 'how long you waited', 'whether you would come back']) {
    assert.ok(said.includes(universal), `the well lost "${universal}"`);
  }

  // And the ban on the ways a model would otherwise pad.
  assert.match(said, /split one thing into three/);
  assert.match(said, /never invent|not do to reach the number/i);
});

test('the topic cap is one number, in the prompt and in the store', () => {
  // Two places said thirty and fifty at different times. The prompt's ceiling
  // comes from settings.js so they cannot disagree again.
  const [system] = seed.buildTopicMessages({
    url: 'https://x.example',
    max: settings.MAX_TOPICS,
  });
  assert.match(system.content, new RegExp(`At most ${settings.MAX_TOPICS} topics`));
  assert.match(system.content, new RegExp(`Aim for close to ${settings.MAX_TOPICS}`));

  // And the parser will not hand back more than the store would accept.
  const many = Array.from({ length: 80 }, (_, i) => ({ label: `T ${i}`, focus: 'x' }));
  const parsed = seed.parseTopics(JSON.stringify({ topics: many }), {
    max: settings.MAX_TOPICS,
  });
  assert.equal(parsed.length, settings.MAX_TOPICS);
  assert.ok(settings.validateCategories(parsed).ok);
});

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

/* ----------------------------------------------------------- stored limits */

test('a business resolves to its own topics, or to none', () => {
  const bare = settings.resolve({});
  assert.deepEqual(bare.categories, []);

  // The four that used to describe a business are gone, not merely blank. A
  // caller reading one would silently get undefined and put it in a prompt.
  for (const field of ['kind', 'place', 'safeDetails', 'contextDoc']) {
    assert.ok(!(field in bare), `${field} is still being resolved`);
  }
});

test('fifty topics are allowed and fifty-one are refused', () => {
  const rows = (n) =>
    Array.from({ length: n }, (_, i) => ({ label: `Topic ${i}`, focus: '' }));

  assert.equal(settings.MAX_TOPICS, 50);
  assert.ok(settings.validateCategories(rows(50)).ok);
  assert.equal(settings.validateCategories(rows(51)).ok, false);
});

test('the writer may name what the topic names, and nothing else', () => {
  // The two rules used to contradict each other: topics can be a signature
  // dish, while the writing prompt banned dish names outright. A button the
  // writer is forbidden to talk about is worse than no button.
  const prompt = config.buildSystemPrompt(CLINIC);

  assert.match(prompt, /You may name the specific thing the description names/);
  assert.match(prompt, /never a name you have supplied yourself/);
  // The blanket ban is gone; the parts of it that still hold are not.
  assert.doesNotMatch(prompt, /no dish names/);
  assert.match(prompt, /no staff names/);
  assert.match(prompt, /no prices/);
});

test('a signature dish survives topic drafting', () => {
  // The focus screen drops a steer carrying a number or an unverifiable claim.
  // A named dish is neither, and losing it would defeat the whole point.
  const [dish] = seed.parseTopics(
    '{"topics":[{"label":"The Pad Thai","focus":"the pad thai — how it tasted and whether you would order it again"}]}'
  );
  assert.deepEqual(dish, {
    label: 'The Pad Thai',
    focus: 'the pad thai — how it tasted and whether you would order it again',
  });

  // A boast about it still loses the steer and keeps the button.
  const [boast] = seed.parseTopics(
    '{"topics":[{"label":"The Pad Thai","focus":"our award-winning pad thai"}]}'
  );
  assert.equal(boast.label, 'The Pad Thai');
  assert.equal(boast.focus, '');
});

test('topic ids survive a rename so a guest is not bounced off their choice', () => {
  const { categories } = settings.validateCategories([
    { id: 'breakfast', label: 'Breakfast & Coffee', focus: '' },
  ]);
  assert.equal(categories[0].id, 'breakfast');
  // A blank note falls back to the label, which reads fine in the prompt.
  assert.equal(categories[0].focus, 'Breakfast & Coffee');
});

test('a topic description is screened, and the refusal says why', () => {
  const one = (focus) =>
    settings.validateCategories([{ label: 'Rooms', focus }]);

  // Screened harder than the old background document was, because it is no
  // longer background: whatever is in here is what a review may assert.
  const superlative = one('Our award-winning rooms are lovely.');
  assert.equal(superlative.ok, false);
  assert.match(superlative.error, /award/);

  // Numbers used to be allowed in the background document, on the grounds that
  // the writer was told not to repeat it. Nothing is background any more.
  const numeric = one('There are 12 rooms, all with a river view.');
  assert.equal(numeric.ok, false);
  assert.match(numeric.error, /number/);

  const long = one('a'.repeat(settings.MAX_DESCRIPTION + 1));
  assert.equal(long.ok, false);
  assert.match(long.error, /is the limit/);

  const fine = one('The rooms look out over the river, and the blinds come down if you would rather not watch.');
  assert.ok(fine.ok);
  assert.match(fine.categories[0].focus, /look out over the river/);

  // Reported rather than dropped. These are prose an owner typed, and prose
  // that vanishes on save with no explanation is worse than a refusal.
  assert.equal(settings.MAX_DESCRIPTION, 600);
});

test('a topic with no description of its own falls back to its label', () => {
  // Which is what a topic typed by hand in a hurry will be, and it still reads:
  // "write one review about Rooms".
  const { categories } = settings.validateCategories([{ label: 'Rooms', focus: '' }]);
  assert.equal(categories[0].focus, 'Rooms');
});

/* ------------------------------------------------------------------ themes */

/** Every pair the design renders as text, with the ratio it has to clear. */
const PAIRS = [
  ['--ink', '--paper', theme.RATIOS.reviewText, 'review text'],
  ['--ink-soft', '--paper', theme.RATIOS.softText, 'soft text'],
  ['--jade', '--shade', theme.RATIOS.bodyText, 'labels'],
  ['--marigold', '--shade', theme.RATIOS.actionText, 'action text'],
  ['--on-marigold', '--marigold', theme.RATIOS.onHighlight, 'button label'],
  ['--warn', '--shade', theme.RATIOS.bodyText, 'error notice'],
  ['--paper', '--shade', theme.RATIOS.surface, 'paper against ground'],
  ['--card-ink', '#ffffff', theme.RATIOS.reviewText, 'card name'],
  ['--card-muted', '#ffffff', theme.RATIOS.softText, 'card small print'],
];

test('any palette that validates produces a readable page', () => {
  // The point of the whole module: a brand palette is not an interface palette,
  // and the ones that go wrong are not exotic. A mid-tone highlight is the case
  // that caught the first implementation — it pushed the button label toward
  // white, which never reaches 4.5 on coral, when black clears it at once.
  const palettes = {
    shipped: theme.DEFAULT_THEME,
    'navy and coral': { ground: '#0b1b33', paper: '#fbf7f0', accent: '#3fa7a0', highlight: '#ff6f5e' },
    'all mid-tone': { ground: '#4a4a4a', paper: '#b0b0b0', accent: '#7a7a7a', highlight: '#808080' },
    'hot pink': { ground: '#2b0a1e', paper: '#fff0f6', accent: '#ff4fa3', highlight: '#ffd166' },
    'light ground': { ground: '#f7f4ee', paper: '#1a1a1a', accent: '#7a5c2e', highlight: '#0057b8' },
    'maximum contrast': { ground: '#000000', paper: '#ffffff', accent: '#ffff00', highlight: '#ffff00' },
    'pale brand on dark': { ground: '#101010', paper: '#f6f6f6', accent: '#fff8d0', highlight: '#fffbe0' },
  };

  for (const [name, palette] of Object.entries(palettes)) {
    assert.ok(theme.validate(palette).ok, `${name} should validate`);
    const { vars } = theme.derive(palette);

    for (const [a, b, target, what] of PAIRS) {
      const front = vars[a];
      const back = vars[b] ?? b;
      const ratio = theme.contrast(front, back);
      assert.ok(
        ratio >= target - 0.005,
        `${name}: ${what} is ${ratio.toFixed(2)}:1, needs ${target}:1`
      );
    }
  }
});

test('a photograph behind the page cannot break the contrast guarantees', () => {
  // The whole reason a background image is allowed at all. Every ratio in this
  // file is measured against the ground; a photo behind the text would make
  // those numbers meaningless unless the wash over it is strong enough. The
  // extremes bound every photo that could ever be uploaded.
  const palettes = [
    theme.DEFAULT_THEME,
    { ground: '#0b1b33', paper: '#fbf7f0', accent: '#3fa7a0', highlight: '#ff6f5e' },
    { ground: '#2b0a1e', paper: '#fff0f6', accent: '#ff4fa3', highlight: '#ffd166' },
    { ground: '#f7f4ee', paper: '#1a1a1a', accent: '#7a5c2e', highlight: '#0057b8' },
  ];

  for (const palette of palettes) {
    const { vars } = theme.derive(palette, {}, { background: true });

    const alpha = Number(vars['--scrim'].match(/([\d.]+)\)$/)[1]);
    assert.ok(alpha > 0 && alpha <= 1, 'a scrim must be emitted with a photo');

    for (const photo of ['#ffffff', '#000000', '#7f7f7f']) {
      const behind = theme.mix(photo, palette.ground, alpha);

      for (const [name, need] of [
        ['--jade', theme.RATIOS.bodyText],
        ['--marigold', theme.RATIOS.actionText],
        ['--warn', theme.RATIOS.bodyText],
      ]) {
        const got = theme.contrast(vars[name], behind);
        assert.ok(
          got >= need - 0.005,
          `${palette.ground} over ${photo}: ${name} is ${got.toFixed(2)}, needs ${need}`
        );
      }
    }
  }
});

test('no photograph means no scrim and no backdrop', () => {
  // Without an image the ground is already the background, and a second layer of
  // it would cost a paint and change nothing.
  const { vars } = theme.derive(theme.DEFAULT_THEME);
  assert.equal(vars['--scrim'], undefined);
  assert.equal(vars['--backdrop'], undefined);

  assert.match(theme.css(theme.DEFAULT_THEME, {}, { background: true }), /--scrim/);
  assert.doesNotMatch(theme.css(theme.DEFAULT_THEME), /--scrim/);
});

test('a ground and paper too close to tell apart is refused', () => {
  // The one case derivation cannot rescue: every text colour is pushed toward
  // white or black, and that needs a direction to push in.
  const flat = { ground: '#ffffff', paper: '#fffdf5', accent: '#f5e6b8', highlight: '#ffe9a8' };
  const verdict = theme.validate(flat);

  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /too close to tell apart/);
});

test('colours are normalised, and anything that is not one is refused', () => {
  const short = theme.validate({
    ground: '#012', paper: '#FFF', accent: '#0A0', highlight: '#F80',
  });
  assert.ok(short.ok);
  // Shorthand expanded and lowercased, so the store holds one shape.
  assert.equal(short.theme.ground, '#001122');
  assert.equal(short.theme.accent, '#00aa00');

  for (const bad of ['rebeccapurple', 'rgb(1,2,3)', '#12345', '', null]) {
    const verdict = theme.validate({ ...theme.DEFAULT_THEME, accent: bad });
    assert.equal(verdict.ok, false, `${bad} should be refused`);
  }
});

test('an unthemed business gets an empty stylesheet, not a rebuilt one', () => {
  // The shipped palette lives in styles.css. Reconstructing it from arithmetic
  // would land close but not exact, so a business with no theme is served
  // nothing at all and the file it already loaded stands.
  assert.equal(theme.css(null), '');
  assert.equal(settings.resolve({}).theme, null);

  const themed = theme.css(theme.DEFAULT_THEME);
  assert.match(themed, /^:root \{/);
  assert.match(themed, /--marigold: #e9a03b;/);
});

test('a stored theme resolves and survives a round trip', () => {
  const palette = { ground: '#0b1b33', paper: '#fbf7f0', accent: '#3fa7a0', highlight: '#ff6f5e' };

  const resolved = settings.resolve({ theme: palette });
  // Colours as given, plus the normalised font ids and an empty logo — a theme
  // is always stored complete, so nothing downstream has to guess.
  assert.deepEqual(resolved.theme, {
    ...palette,
    display: theme.DEFAULT_DISPLAY,
    ui: theme.DEFAULT_UI,
    logo: '',
  });

  const described = settings.describe({ theme: palette });
  assert.equal(described.theme.source, 'subscriber');
  assert.deepEqual(described.theme.value, resolved.theme);
  // The dashboard draws its preview from these, so they have to be there.
  assert.ok(described.theme.derived['--ink']);
  assert.ok(described.theme.derived['--card-ink']);

  // And an unusable stored value falls back rather than throwing.
  assert.equal(settings.resolve({ theme: { ground: 'nonsense' } }).theme, null);
  assert.equal(settings.describe({}).theme.source, 'default');
});

test('a font is an id from the list, or it is the shipped one', () => {
  // The load-bearing property: a font name never becomes part of a URL. If a
  // model returns something that is not on the list, it resolves rather than
  // reaching fontsUrl.
  const chosen = theme.validate({
    ...theme.DEFAULT_THEME,
    display: 'playfair',
    ui: 'inter',
  });
  assert.ok(chosen.ok);
  assert.equal(chosen.theme.display, 'playfair');
  assert.equal(chosen.theme.ui, 'inter');

  const injected = theme.validate({
    ...theme.DEFAULT_THEME,
    display: 'evil&family=Whatever:wght@400',
    ui: 'https://example.com/x.css',
  });
  assert.ok(injected.ok);
  assert.equal(injected.theme.display, theme.DEFAULT_DISPLAY);
  assert.equal(injected.theme.ui, theme.DEFAULT_UI);

  // And nothing unexpected can reach the stylesheet address either way.
  const url = theme.fontsUrl(injected.theme);
  assert.ok(url.startsWith('https://fonts.googleapis.com/css2?'));
  assert.doesNotMatch(url, /evil|example\.com/);

  // The stack always ends in a generic family, so a Thai or Japanese review
  // falls through to the device font instead of rendering as boxes.
  const { vars } = theme.derive({ ...theme.DEFAULT_THEME, display: 'playfair' });
  assert.match(vars['--display'], /^'Playfair Display'.*serif$/);
  assert.match(vars['--ui'], /sans-serif$/);
});

test('a grabbed font is served from us, and the shortlist is the fallback', () => {
  const font = (family) => ({ family, format: 'woff2', data: 'AAAA', source: 'https://x.example/f.woff2' });

  // Nothing grabbed: a redirect to Google, which is what every unthemed venue
  // gets and the cheapest thing that can happen.
  const none = theme.fontsCss(theme.DEFAULT_THEME, {});
  assert.ok(none.redirect.startsWith('https://fonts.googleapis.com/'));

  // Both grabbed: our own rules, our own font routes, no Google at all.
  const both = theme.fontsCss(theme.DEFAULT_THEME, {
    display: font('Canela'),
    ui: font('Founders Grotesk'),
  });
  assert.equal(both.redirect, undefined);
  assert.match(both.css, /font-family: 'Canela'/);
  assert.match(both.css, /url\('\/font\/display'\) format\('woff2'\)/);
  assert.match(both.css, /url\('\/font\/ui'\)/);
  assert.doesNotMatch(both.css, /googleapis/);

  // One of each: the shortlist covers the slot that could not be grabbed, and
  // the @import has to come first for the stylesheet to be valid.
  const mixed = theme.fontsCss(theme.DEFAULT_THEME, { display: font('Canela') });
  assert.ok(mixed.css.startsWith('@import url("https://fonts.googleapis.com/'));
  assert.match(mixed.css, /family=Bai\+Jamjuree/);
  assert.doesNotMatch(mixed.css, /family=Trirong/);

  // And the stack names the grabbed family rather than the fallback.
  const { vars } = theme.derive(theme.DEFAULT_THEME, { display: font('Canela') });
  assert.match(vars['--display'], /^'Canela',/);
  assert.match(vars['--ui'], /^'Bai Jamjuree',/);
});

test('a family name off someone else\'s stylesheet cannot break out of the rule', () => {
  // The name is read from a third party's CSS and written straight back into a
  // rule we serve, so a quote or a brace in it would end the declaration and
  // begin whatever came after.
  const nasty = "Evil'; } body { display: none; } @font-face { font-family: 'x";

  // Asserted as a property rather than an exact string: what matters is that
  // nothing which can end a declaration survives, not the precise spacing left
  // behind.
  assert.doesNotMatch(theme.cssName(nasty), /['"{};@\\<>()]/);
  assert.ok(theme.cssName(nasty).length <= 80);
  assert.equal(theme.cssName('Founders Grotesk'), 'Founders Grotesk');
  assert.equal(theme.cssName('Neue Haas Grotesk Display Pro'), 'Neue Haas Grotesk Display Pro');

  const { css } = theme.fontsCss(theme.DEFAULT_THEME, {
    display: { family: nasty, format: 'woff2', data: 'AAAA' },
    ui: { family: 'Fine', format: 'woff2', data: 'AAAA' },
  });
  assert.doesNotMatch(css, /body \{/);
  assert.equal((css.match(/@font-face/g) || []).length, 2);
});

test('per-domain foundries are refused rather than downloaded', () => {
  // These license by website and forbid redistribution, so serving their file
  // from our domain would be our breach, not the customer's.
  for (const host of [
    'use.typekit.net', 'p.typekit.net', 'fast.fonts.net',
    'cloud.typography.com', 'sub.use.typekit.net',
  ]) {
    assert.match(assets.licensedHost(host), /licenses fonts per website/);
  }

  // A business's own domain and Google's open-licensed files are fine.
  for (const host of ['riverside.example', 'fonts.gstatic.com', 'cdn.shopify.com']) {
    assert.equal(assets.licensedHost(host), '');
  }
});

test('only a checked font file can be stored', () => {
  const good = { family: 'Canela', format: 'woff2', data: 'QUJD' };
  assert.ok(assets.isStoredFont(good));

  for (const bad of [
    null,
    { family: '', format: 'woff2', data: 'QUJD' },
    { family: 'Canela', format: 'exe', data: 'QUJD' },
    { family: 'Canela', format: 'woff2', data: 'not base64!' },
    { family: 'Canela', format: 'woff2', data: 'A'.repeat(900_000) },
    { family: 'Canela', format: 'woff2' },
  ]) {
    assert.equal(assets.isStoredFont(bad), false, `${JSON.stringify(bad)?.slice(0, 50)} should be refused`);
  }

  // And the settings layer drops anything that fails, rather than storing it —
  // this must not become a way to put arbitrary bytes behind a font URL on our
  // own domain.
  assert.equal(settings.validate({ fontDisplay: { family: 'x', format: 'exe', data: 'QQ' } }).fontDisplay, null);
  assert.deepEqual(settings.validate({ fontUi: good }).fontUi, good);
});

test('a logo must be a stored image, never a link to somebody else', () => {
  const tiny =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  assert.ok(theme.validate({ ...theme.DEFAULT_THEME, logo: tiny }).ok);
  assert.equal(theme.validate({ ...theme.DEFAULT_THEME, logo: '' }).theme.logo, '');

  // A URL would mean the guest's phone fetching from a third party on every
  // page load, so it is refused rather than quietly fetched during validation.
  for (const bad of [
    'https://example.com/logo.svg',
    'data:text/html;base64,PHNjcmlwdD4=',
    'javascript:alert(1)',
    `data:image/png;base64,${'A'.repeat(400_000)}`,
  ]) {
    assert.equal(
      theme.validate({ ...theme.DEFAULT_THEME, logo: bad }).ok,
      false,
      `${String(bad).slice(0, 40)} should be refused`
    );
  }
});

test('the private network is not reachable from a logo address', () => {
  // The URL comes off a page a third party controls, so this is the check that
  // stops "fetch this image" becoming a request to the instance metadata
  // service. 169.254.169.254 is the one that matters on EC2.
  const blocked = [
    '169.254.169.254', '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1',
    '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1',
  ];
  for (const ip of blocked) {
    assert.equal(assets.isPrivateAddress(ip), true, `${ip} must be blocked`);
  }

  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.7', '2606:4700::1111']) {
    assert.equal(assets.isPrivateAddress(ip), false, `${ip} should be allowed`);
  }

  // http is refused outright: a logo fetched in the clear can be swapped in
  // transit and would then be served from our own domain.
  assert.equal(assets.parseUrl('http://example.com/logo.png').ok, false);
  assert.equal(assets.parseUrl('ftp://example.com/logo.png').ok, false);
  assert.equal(assets.parseUrl('not a url').ok, false);
  assert.ok(assets.parseUrl('https://example.com/logo.png').ok);
});

test('a literal private address is blocked without a DNS lookup', async () => {
  // The check has to cover addresses as well as names, or passing an IP
  // straight in would skip it entirely.
  const direct = await assets.checkHost('169.254.169.254');
  assert.equal(direct.ok, false);

  const loopback = await assets.checkHost('127.0.0.1');
  assert.equal(loopback.ok, false);
});

test('a drafted theme is read from either shape the model returns', () => {
  const asObjects = seed.parseTheme(`{
    "ground": { "hex": "#0b1b33", "source": "the site header" },
    "paper": { "hex": "#fbf7f0", "source": "the page background" },
    "accent": { "hex": "#3fa7a0", "source": "the link colour" },
    "highlight": { "hex": "#ff6f5e", "source": "the Book Now button" }
  }`);

  assert.equal(asObjects.theme.ground, '#0b1b33');
  assert.equal(asObjects.sources.highlight, 'the Book Now button');

  // A model told to return objects still sometimes returns bare strings, and
  // refusing that would cost the customer another page read for nothing.
  const asStrings = seed.parseTheme(
    '{"ground":"#0b1b33","paper":"#fbf7f0","accent":"#3fa7a0","highlight":"#ff6f5e"}'
  );
  assert.equal(asStrings.theme.paper, '#fbf7f0');

  assert.equal(seed.parseTheme('no json at all'), null);
  assert.equal(seed.parseTheme('{"ground":"#0b1b33"}'), null);
});

test('topics come back in alphabetical order, whatever order they were stored in', () => {
  const stored = [
    { id: 'a', label: 'Ambience' },
    { id: 'b', label: 'room 10' },
    { id: 'c', label: 'Room 2' },
    { id: 'd', label: 'coffee' },
  ];

  const labels = settings
    .resolve({ categories: stored })
    .categories.map((c) => c.label);

  // Case-insensitive, so 'coffee' sits between the two capitalised words
  // instead of after them, and numeric, so Room 2 precedes Room 10.
  assert.deepEqual(labels, ['Ambience', 'coffee', 'Room 2', 'room 10']);

  // The stored array is the subscriber's row. Sorting a copy is the difference
  // between a display order and a silent rewrite of what they saved.
  assert.equal(stored[0].label, 'Ambience');
  assert.equal(stored[1].label, 'room 10');

  // Same list, same order, through the dashboard's view of it.
  assert.deepEqual(
    settings.describe({ categories: stored }).categories.value.map((c) => c.label),
    labels
  );
});

/* ------------------------------------------------------------------ strings */

test('every language the page offers has every word the page says', () => {
  // A language in the selector with no words behind it shows a guest a page in
  // English and a review in their own language, which is the exact confusion
  // the selector exists to remove.
  for (const { code } of config.LANGUAGES) {
    assert.ok(strings.STRINGS[code], `no strings for ${code}, but it is offered`);

    const missing = strings.KEYS.filter((key) => !(key in strings.STRINGS[code]));
    assert.deepEqual(missing, [], `${code} is missing: ${missing.join(', ')}`);
  }

  // And nothing translated that is not offered — a table entry nobody can pick
  // is dead weight that still has to be maintained.
  for (const code of Object.keys(strings.STRINGS)) {
    assert.ok(
      config.LANGUAGES.some((l) => l.code === code),
      `${code} has strings but is not in LANGUAGES`
    );
  }
});

test('a translation cannot drop a placeholder', () => {
  // "{n} more tries" translated without its {n} loses the number silently: the
  // sentence still reads, so nothing catches it except a guest wondering how
  // many they have left.
  const placeholders = (text) =>
    (text.match(/\{\w+\}/g) || []).slice().sort().join(',');

  for (const key of strings.KEYS) {
    const expected = placeholders(strings.STRINGS.en[key]);
    for (const code of Object.keys(strings.STRINGS)) {
      assert.equal(
        placeholders(strings.STRINGS[code][key]),
        expected,
        `${code}.${key} does not carry the same placeholders as English`
      );
    }
  }
});

test('strings fill in, fall back per key, and never come back blank', () => {
  assert.equal(strings.t('en', 'proceed', { place: 'Google' }), 'Proceed to Google');
  assert.equal(strings.t('th', 'proceed', { place: 'Google' }), 'ไปที่ Google');

  // Per key, not per language: an unknown key falls back to English, and an
  // unknown language falls back to English, but neither returns empty.
  assert.equal(strings.t('th', 'nosuchkey'), 'nosuchkey');
  assert.equal(strings.t('xx', 'copy'), 'Copy');

  // A missing variable leaves its placeholder rather than printing "undefined".
  assert.equal(strings.t('en', 'triesMany'), '{n} more tries for now.');

  for (const code of Object.keys(strings.STRINGS)) {
    for (const key of strings.KEYS) {
      assert.ok(
        strings.t(code, key).trim().length > 0,
        `${code}.${key} is empty`
      );
    }
  }
});

test('the language for a guest we have not heard from yet', () => {
  assert.equal(strings.fromHeader('th-TH,th;q=0.9,en;q=0.8'), 'th');
  // Base tag, so the three Chinese tags are one offer here.
  assert.equal(strings.fromHeader('zh-Hant-TW'), 'zh');
  // Order of preference wins over position in our own table.
  assert.equal(strings.fromHeader('ko,en'), 'ko');
  assert.equal(strings.fromHeader('xx-YY'), 'en');
  assert.equal(strings.fromHeader(''), 'en');
  assert.equal(strings.fromHeader(undefined), 'en');
});

/* ------------------------------------------------------------------- quota */

test('a guest gets ten regenerations, and the eleventh is refused', () => {
  // The count that survived a release without working: it was inside server.js,
  // which cannot be required without a database, so nothing could exercise it.
  let clock = 0;
  const q = quota.createQuota({ now: () => clock });

  // The first draft is not a regeneration. Nobody asked for it — the page
  // writes it on load — so it must not spend one of the ten.
  const first = q.count('riverside:1.2.3.4');
  assert.deepEqual(first, { allowed: true, used: 0, left: 10 });

  for (let i = 1; i <= 10; i += 1) {
    const r = q.count('riverside:1.2.3.4');
    assert.ok(r.allowed, `regeneration ${i} should be allowed`);
    assert.equal(r.used, i);
    assert.equal(r.left, 10 - i);
  }

  // And it stays refused rather than refusing once and forgiving.
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(q.count('riverside:1.2.3.4'), {
      allowed: false,
      used: 10,
      left: 0,
    });
  }
});

test('the count is per guest and per business, and lets go after an hour', () => {
  let clock = 0;
  const q = quota.createQuota({ now: () => clock });

  for (let i = 0; i < 11; i += 1) q.count('riverside:1.2.3.4');
  assert.equal(q.count('riverside:1.2.3.4').allowed, false);

  // A different address at the same business, and the same address at a
  // different business, both start fresh. One busy guest must not close the
  // page for everyone else in the room.
  assert.equal(q.count('riverside:5.6.7.8').left, 10);
  assert.equal(q.count('otherplace:1.2.3.4').left, 10);

  // An hour on, the window has rolled.
  clock += quota.WINDOW_MS + 1;
  assert.deepEqual(q.count('riverside:1.2.3.4'), {
    allowed: true,
    used: 0,
    left: 10,
  });
});

/* ------------------------------------------------------- topic translation */

test('a topic is translated once, and again only when its name changes', () => {
  const topics = [
    { id: 'rooms', label: 'Rooms' },
    { id: 'roast', label: 'Sunday Roast' },
  ];

  // Nothing stored: both need doing.
  assert.deepEqual(translate.missing({}, topics).map((t) => t.id), ['rooms', 'roast']);

  const table = translate.merge(
    {},
    { rooms: 'ห้องพัก', roast: 'Sunday Roast' },
    topics
  );
  assert.deepEqual(translate.missing(table, topics), []);

  // The owner renames one. Only that one is stale — the entry remembers the
  // label it was made from, which is the whole invalidation story.
  const renamed = [{ id: 'rooms', label: 'Bedrooms' }, topics[1]];
  assert.deepEqual(translate.missing(table, renamed).map((t) => t.id), ['rooms']);

  // And the stale one falls back to its own label rather than showing the
  // translation of a name that is no longer there.
  assert.deepEqual(translate.apply(table, renamed), [
    { id: 'rooms', label: 'Bedrooms' },
    { id: 'roast', label: 'Sunday Roast' },
  ]);
});

test('a translation that comes back short or broken leaves the buttons working', () => {
  const topics = [
    { id: 'rooms', label: 'Rooms' },
    { id: 'bar', label: 'The Bar' },
  ];

  // Half an answer: the missing half keeps its own label, so the list is
  // never blank and never shows an id.
  const half = translate.merge({}, translate.parseLabels('{"rooms":"ห้องพัก"}'), topics);
  assert.deepEqual(translate.apply(half, topics), [
    { id: 'rooms', label: 'ห้องพัก' },
    { id: 'bar', label: 'The Bar' },
  ]);

  // No answer at all.
  assert.deepEqual(translate.parseLabels('not json'), {});
  assert.deepEqual(translate.parseLabels(''), {});
  assert.deepEqual(translate.apply(translate.merge({}, {}, topics), topics), topics);

  // A model that explains itself instead of answering gets that entry dropped
  // rather than a button that wraps to three lines.
  const wordy = translate.parseLabels(
    JSON.stringify({ rooms: 'x'.repeat(200), bar: '  ' })
  );
  assert.equal(wordy.rooms.length, 40);
  assert.ok(!('bar' in wordy));
});

test('translations of topics that no longer exist are not kept', () => {
  const before = translate.merge(
    {},
    { rooms: 'ห้องพัก', gone: 'หายไป' },
    [{ id: 'rooms', label: 'Rooms' }, { id: 'gone', label: 'Gone' }]
  );
  assert.ok('gone' in before);

  // The business replaces its topic set. Paying to store translations of a
  // list nobody can pick from any more is a slow leak, not a saving.
  const after = translate.merge(before, {}, [{ id: 'rooms', label: 'Rooms' }]);
  assert.deepEqual(Object.keys(after), ['rooms']);
});

test('the label prompt names the language and refuses to rename a dish', () => {
  const [system, user] = translate.buildLabelMessages({
    language: 'th',
    topics: [{ id: 'roast', label: 'Sunday Roast' }],
  });

  // The English name of the language, because that is what the model reads.
  assert.match(user.content, /into Thai/);
  assert.match(user.content, /roast: Sunday Roast/);

  // The rule that stops "Sunday Roast" becoming a Thai phrase nobody can find
  // on the menu when they get to the restaurant.
  assert.match(system.content, /A proper name stays as it is/);
  assert.match(system.content, /never longer than four words/);
});

test('a locked topic keeps its lock, and only a real one counts', () => {
  const { categories } = settings.validateCategories([
    { label: 'Rooms', focus: 'What the rooms get you.', locked: true },
    { label: 'Bar', focus: '' },
    // Anything other than the boolean is not a lock. This arrives from a form,
    // where "false" and "0" are both truthy strings.
    { label: 'Spa', focus: '', locked: 'false' },
  ]);

  assert.equal(categories[0].locked, true);
  // Absent rather than false: a `locked: false` on every one of fifty rows is
  // weight in a column read on every guest page load.
  assert.ok(!('locked' in categories[1]));
  assert.ok(!('locked' in categories[2]));
});

test('a description is asked for the benefit, not the definition', () => {
  // The failure this exists for: "Weekend Stay — a short break over the
  // weekend" restates the label and leaves the writer with nothing.
  for (const prompt of [
    seed.buildDescribeMessages({ url: 'https://x.example', label: 'Weekend Stay' })[0].content,
    seed.buildTopicMessages({ url: 'https://x.example', max: 50 })[0].content,
  ].map(flat)) {
    assert.match(prompt, /what a customer gets out of it, not what it is/i);

    // The example is only useful if it cannot be read as one to copy. "NEVER
    // write" has to come before it, and the definition has to be named as a
    // definition after it.
    const never = prompt.indexOf('NEVER write a description like this');
    const example = prompt.indexOf('A short break over the weekend.');
    assert.ok(never !== -1, 'the example is not marked as one to avoid');
    assert.ok(never < example, 'the warning has to come before the example');
    assert.match(prompt, /That is a definition of the label/);

    // And a replacement, because "not that" without "this instead" is half an
    // instruction.
    assert.ok(
      prompt.indexOf('Two nights is enough to stop rushing about') > example,
      'there is no example of what to write instead'
    );
  }
});

test('a description keeps its bullets through drafting and through a save', () => {
  const list = '- Two nights is enough to stop rushing\n- The kitchen is open late';

  // The bug this exists for: `text` collapses every run of whitespace, which is
  // right for a label and turns a list into one long line. Both paths that
  // touch a description have to use the other one.
  const drafted = seed.parseDescription(JSON.stringify({ description: list }));
  assert.equal(drafted, list);

  const { categories } = settings.validateCategories([
    { label: 'Weekend Stay', focus: list },
  ]);
  assert.equal(categories[0].focus, list);
});

test('a pasted list is tidied into the one shape everything downstream expects', () => {
  // Nobody typing into a textarea should have to know which bullet character
  // this wants, or that a blank line between bullets will be dropped.
  assert.equal(
    seed.bullets('  • First\r\n\r\n*  Second\n\n\n– Third   thing  ', 600),
    '- First\n- Second\n- Third thing'
  );

  // A description written before any of this is still a description.
  assert.equal(seed.bullets('One plain  sentence.', 600), 'One plain sentence.');
  assert.equal(seed.bullets(null, 600), '');
});

test('both prompts ask for several bullets rather than a paragraph', () => {
  for (const prompt of [
    seed.buildDescribeMessages({ url: 'https://x.example', label: 'Weekend Stay' })[0].content,
    seed.buildTopicMessages({ url: 'https://x.example', max: 50 })[0].content,
  ].map(flat)) {
    assert.match(prompt, /bullet points, not a paragraph/);
    // How many is the topic's business, not a quota — a quota is answered with
    // filler. "Never one" is the only fixed end of it, because a single bullet
    // is a paragraph wearing a dash.
    assert.match(prompt, /depends on the topic/i);
    assert.match(prompt, /Never one/);
    assert.match(prompt, /never a line invented to reach a number/);
    assert.match(prompt, /One bullet per thing/);
  }
});

test('the topic instructions come from context_topic.md, whole', () => {
  // Same contract as context.md: the words live in a markdown file so they can
  // be edited as prose, and this is what stops that being a way to lose half of
  // them. The document's whole body is what the model is sent.
  const doc = fs
    .readFileSync(path.join(__dirname, '..', 'context_topic.md'), 'utf8')
    .replace(/^<!--[\s\S]*?-->\s*/, '')
    .trim();

  const [system] = seed.buildTopicMessages({ url: 'https://x.example', max: 50 });
  assert.equal(system.content, doc.split('{max}').join('50'));

  // Every placeholder filled. One left behind would reach the model as the
  // literal "{max}", which reads as an instruction to output a placeholder.
  assert.doesNotMatch(system.content, /\{max\}/);
  assert.ok(doc.includes('{max}'), 'the document no longer takes the cap');
});

test('the topic prompt reads the review listings, and says what for', () => {
  const [, user] = seed.buildTopicMessages({
    url: 'https://riverside.example',
    listings: [
      'https://riverside.example',
      'https://maps.google.com/riverside',
      'https://tripadvisor.com/riverside',
    ],
    max: 50,
  });

  assert.match(user.content, /Then read the reviews this business already has/);
  assert.match(user.content, /maps\.google\.com\/riverside/);
  assert.match(user.content, /tripadvisor\.com\/riverside/);

  // The source page is not asked for twice. A business whose only address is
  // its Facebook page has that address in both lists.
  assert.equal(user.content.match(/riverside\.example/g).length, 1);

  // The distinction with consequences, stated where the listings are handed
  // over rather than only in the document.
  assert.match(user.content, /what matters, never what is true/);
  assert.match(user.content, /quoted or reworded/);
});

test('a business with no listings is asked to read one page, and told nothing about reviews', () => {
  const [, user] = seed.buildTopicMessages({ url: 'https://x.example', max: 50 });
  assert.doesNotMatch(user.content, /Then read the reviews/);
  assert.doesNotMatch(user.content, /undefined/);
});

test('the document keeps a claim and a review apart', () => {
  const [system] = seed.buildTopicMessages({ url: 'https://x.example', max: 50 });
  const said = flat(system.content);

  // This is the rule that stops the listings becoming a second source of
  // facts. Reviews say what is worth writing about; only the business's own
  // pages say what is true about it.
  assert.match(said, /A \*\*claim\*\* may only come from the business's own pages/);
  assert.match(said, /Never quote or paraphrase a review/);
  assert.match(said, /one person's experience/);
});
