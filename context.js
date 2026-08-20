'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The generic context document: what the writer knows before it knows anything
 * about the business it is writing for.
 *
 * The words themselves live in context.md, next door. They are prose a model
 * reads, not configuration, and keeping them in a markdown file means they can
 * be read and edited as prose — by someone who is not going to open a .js file
 * to do it, and in a diff that shows the argument changing rather than a string
 * literal changing.
 *
 * This is a commercial product sold to whoever wants it — a lodge, a dental
 * clinic, a garage — so nothing in that file may describe a particular kind of
 * business. Everything in it is craft: what a real review reads like, and what a
 * page of manufactured ones reads like. The business-specific half arrives
 * separately, from that business's own row: its details, its topics, and its own
 * About text.
 *
 * The split matters because these two kinds of knowledge have different
 * lifetimes. context.md is reviewed, versioned and deployed like code, because a
 * bad edit there degrades every review on the platform at once. A business's own
 * context is edited by its owner, in the dashboard, and can only affect them.
 *
 * It is folded into the system prompt on every single generation, which the
 * business pays for by the token. So it earns its length or it comes out.
 */

const DOC = path.join(__dirname, 'context.md');

/**
 * The headings context.md must contain, and what each is called here.
 *
 * Looked up by name rather than by position, so reordering the document is
 * harmless while renaming a heading is not — which is the right way round. A
 * missing section means a prompt with no compliance rules in it, and that must
 * never reach a guest.
 */
const SECTIONS = {
  COMPLIANCE: 'Rules you must not break',
  CRAFT: 'What a real review is like',
  TELLS: 'What makes a set of reviews look manufactured',
  REGISTER: 'Register',
};

/**
 * Reads context.md once, at require time.
 *
 * Once rather than per request: it is the same for every business and every
 * generation, and re-reading it on the guest path would put a disk hit in front
 * of every review to support an edit nobody makes without deploying. A change
 * takes effect on restart, which is how it gets deployed anyway.
 *
 * Throws rather than degrades. Every alternative is worse than not starting: an
 * empty document would silently ship reviews with no compliance rules in them,
 * and a partial one would ship them with some. systemd restarts on failure, so
 * a broken edit fails visibly at deploy rather than invisibly at three in the
 * morning.
 */
function load() {
  let raw;
  try {
    raw = fs.readFileSync(DOC, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read ${DOC}: ${err.message}. The generic context document is ` +
        'required — every review on the platform is written from it.'
    );
  }

  // The HTML comment at the top is a note to whoever edits the file, not part
  // of what the model is told.
  const body = raw.replace(/^<!--[\s\S]*?-->\s*/, '').trim();

  // Split on the headings so each section keeps its own, which is what goes
  // into the prompt.
  const found = {};
  for (const part of body.split(/^## /m).filter(Boolean)) {
    const nl = part.indexOf('\n');
    const heading = part.slice(0, nl).trim();
    found[heading] = `## ${heading}

${part.slice(nl).trim()}`;
  }

  const out = {};
  for (const [name, heading] of Object.entries(SECTIONS)) {
    if (!found[heading]) {
      throw new Error(
        `${DOC} is missing the "## ${heading}" section. Every review is written ` +
          'from this document; refusing to start without it.'
      );
    }
    out[name] = found[heading];
  }

  // The file's whole body, not the four joined back together: what a reader
  // sees is what the model gets, and anything added to the document reaches the
  // prompt without also having to be added to a list in here.
  return { ...out, ALL: body };
}

const { COMPLIANCE, CRAFT, TELLS, REGISTER, ALL } = load();

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

/**
 * The always-on document: context.md's own body, with the editor's note
 * stripped off the top.
 *
 * The whole file rather than the four named sections joined back together, so
 * that a section added to the document reaches the prompt without anyone
 * having to remember to add it here as well. The names above exist for the
 * tests and the rulebook; they do not decide what gets sent.
 */
const GENERIC_CONTEXT = ALL;

/**
 * The compliance lines, as a list, so a test can assert each one survives into
 * the assembled prompt. Reformatting the block above must not be able to drop
 * one silently.
 */
const COMPLIANCE_RULES = COMPLIANCE.split('\n')
  .filter((line) => line.startsWith('- '))
  .map((line) => line.slice(2));

/* ---------------------------------------------------------------- rulebook */

/**
 * Everything the writer is told about one business, as a markdown file.
 *
 * A debugging view, and marked temporary in its own text. It exists because
 * "what is the AI actually working from" is otherwise answerable only by reading
 * five files and a database row — and the person who most needs the answer, the
 * owner deciding whether a bad review is the prompt's fault or their own
 * settings', has access to neither.
 *
 * Built from the same `buildSystemPrompt` that serves the guest page rather than
 * from a description of it. A document explaining the prompt in its own words
 * would drift from the prompt within a release, and a drifted one is worse than
 * none, because it would still be believed.
 *
 * `generatedAt` is passed in rather than read here so this stays a pure function
 * of its arguments, like the rest of the file.
 */
function rulebook({
  name,
  systemPrompt,
  topics = [],
  examples = [],
  rejected = [],
  generatedAt,
}) {
  const bullets = (items, empty) =>
    items.length ? items.map((item) => `- ${item}`).join('\n') : `_${empty}_`;

  const fence = '```';

  return [
    `# What the writer is told about ${name}`,
    '',
    `Generated ${generatedAt}.`,
    '',
    '> **This is a temporary debugging view.** It is produced by the same code',
    '> that builds the real prompt, so it cannot drift from it — but it is a',
    '> snapshot, and anything you change in Settings changes what is below.',
    '',
    '## 1. The system prompt, exactly as sent',
    '',
    'Every review for this business is written with this in front of it. The',
    'first half is the same for every business on the platform; the second half',
    'is yours, from your Settings.',
    '',
    fence,
    systemPrompt,
    fence,
    '',
    '## 2. The topics a customer can pick',
    '',
    'The guest page shows ten of these at random, with the rest behind a browse',
    'button and a search. Whichever they tap becomes the subject, and the',
    'description beside it is the whole of what a review about that topic may',
    'claim. There is nothing else: if something about your business is not in',
    'one of these paragraphs, no review will ever say it.',
    '',
    topics.length
      ? topics
          .map((t) => `- **${t.label}** — ${t.focus || t.label}`)
          .join('\n')
      : '_None set. Until there are some, every review is about the visit overall._',
    '',
    '## 3. What your ratings are feeding back',
    '',
    'Five stars means "write more like this", and those reviews are shown to the',
    'writer on every generation from then on. One and two stars are shown as',
    'things to avoid. Three and four are recorded and fed back neither way.',
    '',
    '### Five-star examples currently in the prompt',
    '',
    bullets(examples, 'None yet. Rate a review five stars and it appears here.'),
    '',
    '### One and two star reviews currently in the prompt',
    '',
    bullets(rejected, 'None.'),
    '',
    '## 4. What is deliberately not in here',
    '',
    '- The **realism sample** and the **write-away-from list**, drawn fresh and',
    '  at random from your recent reviews on every generation. They differ every',
    '  time, so there is no fixed value to print.',
    '- The **length** and the **language**, which the customer picks on the page.',
    '- The **angle** and the **voice**, drawn at random per review so that two',
    '  customers an hour apart do not get the same sentence shape.',
    '',
  ].join('\n');
}

module.exports = {
  COMPLIANCE,
  COMPLIANCE_RULES,
  CRAFT,
  TELLS,
  REGISTER,
  PLATFORM_NOTES,
  GENERIC_CONTEXT,
  platformNote,
  rulebook,
};
