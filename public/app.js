'use strict';

const el = {
  logo: document.getElementById('logo'),
  eyebrow: document.getElementById('eyebrow'),
  chips: document.getElementById('chips'),
  browse: document.getElementById('browse'),
  lengths: document.getElementById('lengths'),
  lang: document.getElementById('lang'),
  slip: document.getElementById('slip'),
  review: document.getElementById('review'),
  notice: document.getElementById('notice'),
  regenerate: document.getElementById('regenerate'),
  copy: document.getElementById('copy'),
  destinations: document.getElementById('destinations'),
  hint: document.getElementById('hint'),

  // The furniture. Static text until the selector moved the page as well as the
  // review; these are the handles applyStrings() writes through.
  heading: document.getElementById('heading'),
  lede: document.getElementById('lede'),
  pickerLabel: document.getElementById('picker-label'),
  lengthLabel: document.getElementById('length-label'),
  slipLabel: document.getElementById('slip-label'),
  titleDot: document.getElementById('title-dot'),

  // The full topic list, in a modal.
  dialog: document.getElementById('topics-dialog'),
  allChips: document.getElementById('all-chips'),
  topicsTitle: document.getElementById('topics-title'),
  topicsDone: document.getElementById('topics-done'),
  topicsSearch: document.getElementById('topics-search'),
  topicsEmpty: document.getElementById('topics-empty'),
};

/**
 * Languages that do not end a sentence with a full stop.
 *
 * The coloured dot after the heading is a flourish in the English design, but a
 * flourish shaped like punctuation still reads as punctuation — and Thai ends
 * sentences with a space, while Chinese and Japanese use their own full-width
 * mark. Korean is not here: it does use a full stop.
 */
const NO_FULL_STOP = new Set(['th', 'zh', 'ja']);

/**
 * How many topics the picker offers before the guest asks for more.
 *
 * A business may keep thirty. Thirty buttons in front of someone with a bag in
 * one hand is a form, not a picker — so ten are drawn at random and the rest sit
 * behind one button. The randomness is the other half of the point: two guests
 * an hour apart are offered different tens, so they lead with different things,
 * and the listing does not fill up with reviews about the same three subjects.
 */
const SHOWN = 10;

/**
 * One string, in the language the guest has chosen.
 *
 * The table arrives from /i18n.js as a plain global, before this file runs. If
 * it somehow did not, every lookup returns the key's own name rather than
 * throwing — a page reading "browseMore" is poor, and a page that fails to boot
 * because a script 404'd is worse.
 *
 * Placeholders are {braced}, matching strings.js on the server, because half
 * these strings are read on one side and half on the other and two syntaxes
 * would be one too many.
 */
function t(key, vars = {}) {
  const table = window.RS_STRINGS || {};
  const raw =
    table[state.language]?.[key] ?? table.en?.[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (whole, name) =>
    name in vars ? String(vars[name]) : whole
  );
}

const state = {
  topics: [], // every topic the business has, {id, label}
  shown: [], // the ids currently on screen
  // A set, not one value: a guest may want the room and the food in one review.
  categoryIds: [],
  destinations: [], // {id, label, hex, path, url} for each link that is set

  reviewId: null, // the row behind what is on screen, for rating and proceeding
  recent: [], // last few generations, so the next one reads differently
  venue: '', // the business's name, kept for the document title
  language: 'en',
  length: 'any',
  busy: false,
  left: null, // regenerations remaining, once the server has said
  max: null, // and how many there were to begin with
};

let copyResetTimer = null;

/* ------------------------------------------------------------------ boot */

init();

async function init() {
  // Before the fetch, not after it. The first thing on screen should already be
  // in the guest's language — including the error, if the fetch is what fails.
  // renderLanguages narrows this later to what the business actually offers.
  state.language = guessLanguage(Object.keys(window.RS_STRINGS || { en: 1 }));
  applyStrings();

  autosize();
  el.review.addEventListener('input', autosize);
  el.regenerate.addEventListener('click', () => generate());
  el.copy.addEventListener('click', onCopy);
  el.browse.addEventListener('click', onBrowse);
  el.topicsDone.addEventListener('click', () => el.dialog.close());
  el.topicsSearch.addEventListener('input', filterTopics);
  // Enter in a search field submits, and a form-less input inside a dialog
  // closes it. The guest meant "that one", not "close".
  el.topicsSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.preventDefault();
  });
  // Tapping outside the sheet closes it. A <dialog> puts the backdrop behind
  // the element rather than in it, so a click on the backdrop lands on the
  // dialog itself — which is what this checks for.
  el.dialog.addEventListener('click', (event) => {
    if (event.target === el.dialog) el.dialog.close();
  });

  let config;
  try {
    const res = await fetch('/api/config');
    config = await res.json().catch(() => ({}));
    // A 404 here means the address does not belong to any venue, and the
    // server says so far more usefully than a generic message could.
    if (!res.ok) throw new Error(config.error || t('loadFailed'));

    state.destinations = Array.isArray(config.destinations)
      ? config.destinations
      : [];
    if (config.venue) {
      state.venue = config.venue;
      el.eyebrow.textContent = config.venue;
    }

    // The mark, once we know there is one. Its alt is empty on purpose: the
    // venue's name is already the line underneath it, and a screen reader
    // announcing the name twice is noise, not access.
    if (config.hasLogo) {
      el.logo.src = '/logo';
      el.logo.hidden = false;
      // A logo that 404s or is corrupt takes itself back off the page rather
      // than leaving a broken-image icon above the venue's name.
      el.logo.addEventListener('error', () => {
        el.logo.hidden = true;
      });
    }
    // Languages first: the two below draw buttons whose words come out of the
    // table, and rendering them before the language is settled would paint
    // English and then correct itself in front of the guest.
    renderLanguages(config.languages || []);
    applyStrings();
    renderTopics(config.categories || []);
    renderLengths(config.lengths || []);
    // Not awaited. The page is usable with the topics as written, and the
    // first guest to pick a language waits on a model call — behind the review
    // they came for rather than in front of it.
    translateTopics();
  } catch (err) {
    setBusy(false);
    say(err.message || t('loadFailed'), 'error');
    el.regenerate.disabled = true;
    return;
  }

  renderDestinations();
  generate();
}

/**
 * A venue may list on Google, on Tripadvisor, on both, or on neither — and a
 * button that goes nowhere is worse than no button, so each one only appears
 * once there is somewhere to send the guest.
 */
function renderDestinations() {
  el.destinations.replaceChildren();

  for (const [index, place] of state.destinations.entries()) {
    const row = document.createElement('div');
    row.className = 'destination';

    // The mark sits outside the button, on its own light tile. Brand guidelines
    // for these logos ask for clear space and a plain background — Google's is
    // four colours, and dropping it onto a marigold fill breaches both. Outside
    // it also stays legible when the button is outlined rather than filled.
    if (place.path) {
      const tile = document.createElement('span');
      tile.className = 'destination-mark';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '20');
      svg.setAttribute('height', '20');
      svg.setAttribute('aria-hidden', 'true');
      // Never recoloured. A mark tinted to match its surroundings has stopped
      // being that company's mark, and every one of these guidelines says so.
      svg.setAttribute('fill', place.hex);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', place.path);
      svg.append(path);
      tile.append(svg);
      row.append(tile);
    }

    const button = document.createElement('button');
    button.type = 'button';
    // Marigold is spent once, as a fill. The first listing keeps it and the
    // rest are outlined, however many there are.
    button.className = `btn btn-go${index ? ' btn-go-second' : ''}`;
    button.textContent = t('proceed', { place: place.label });
    button.addEventListener('click', () => onProceed(place.url, place.label));

    row.append(button);
    el.destinations.append(row);
  }

  el.hint.textContent = state.destinations.length ? t('hint') : t('noLink');
}

/* ---------------------------------------------------------------- topics */

/**
 * Takes the whole topic set and decides which ten to open with.
 *
 * The topics can be edited underneath a page that is already open, so a
 * remembered selection is not necessarily still on offer.
 */
function renderTopics(topics) {
  state.topics = topics;

  const offered = topics.map((t) => t.id);
  state.categoryIds = state.categoryIds.filter((id) => offered.includes(id));
  state.shown = sampleIds(topics, SHOWN);

  drawTopics();
}

/**
 * `count` ids drawn without replacement, in the order they arrived.
 *
 * That order is alphabetical — the server sorts the list once, so the picker
 * here and the editor in the dashboard agree. Preserved rather than shuffled: a
 * picker that reordered itself on every load would make the same ten feel like a
 * different ten. Random *which*, not random *where*.
 */
function sampleIds(topics, count) {
  if (topics.length <= count) return topics.map((t) => t.id);

  const pool = topics.map((_, index) => index);
  const taken = new Set();

  // Partial Fisher-Yates: swap a random unpicked index to the front, take it,
  // repeat. Cheaper than shuffling thirty to keep ten, and unbiased, which
  // sort(() => Math.random() - 0.5) is not.
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    taken.add(pool[i]);
  }

  return topics.filter((_, index) => taken.has(index)).map((t) => t.id);
}

/**
 * One topic button, wherever it is being drawn.
 *
 * Shared between the picker and the sheet because the same topic can be in both
 * at once — chosen in the sheet, then visible in the picker after it closes —
 * and two builders would eventually disagree about what a selected one looks
 * like.
 */
function topicChip(topic) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.textContent = topic.label;
  chip.dataset.id = topic.id;
  chip.setAttribute('aria-pressed', String(state.categoryIds.includes(topic.id)));

  // Toggling does not regenerate. Picking three topics would otherwise spend
  // three reviews to get one, and each costs tokens the business pays for —
  // Regenerate is one tap away once the selection is right.
  chip.addEventListener('click', () => {
    if (state.busy) return;

    const on = state.categoryIds.includes(topic.id);
    state.categoryIds = on
      ? state.categoryIds.filter((id) => id !== topic.id)
      : [...state.categoryIds, topic.id];

    chip.setAttribute('aria-pressed', String(!on));

    // Tapped inside the sheet, so the picker behind it is now out of date — a
    // topic chosen here has to be on screen once the sheet is gone, or the
    // guest is sending one they cannot see.
    //
    // Redrawn now rather than when the sheet closes. Closing has three routes —
    // the button, Escape and the backdrop — and the `close` event that would
    // catch all three does not fire in every engine. Doing it here needs no
    // event at all, and the picker is inert behind a modal, so nobody is
    // looking at what changes under it.
    if (chip.parentElement === el.allChips) drawTopics();
  });

  return chip;
}

function drawTopics() {
  // A topic the guest has already picked stays on screen even when it is not in
  // the sample — choosing something in the sheet, then closing it, must not
  // silently drop the choice while leaving it in the request.
  const visible = state.topics.filter(
    (t) => state.shown.includes(t.id) || state.categoryIds.includes(t.id)
  );

  el.chips.replaceChildren(...visible.map(topicChip));

  const more = state.topics.length - visible.length;
  el.browse.hidden = more <= 0;
  el.browse.textContent = t('browseMore', { n: more });

  // The button opens a dialog, so it is described by aria-haspopup rather than
  // aria-expanded — nothing expands in place any more.
  el.browse.setAttribute('aria-haspopup', 'dialog');
}

/**
 * Swaps the topic names for their translations, when there are any.
 *
 * The business writes its topics once, in its own language. A guest who has
 * switched the page to Thai is otherwise reading Thai chrome and tapping
 * English buttons, which is the half of the language selector that was still
 * missing.
 *
 * Fire and forget, on purpose. The server answers with the names as written
 * whenever it cannot do better — no key, no words, a model that will not
 * answer — so there is no failure here worth showing a guest, and nothing to
 * wait for before the page works. What arrives late simply redraws.
 *
 * Guarded against arriving out of order: two quick taps on the selector can
 * land their answers in either order, and the one that matters is the language
 * currently chosen rather than the one asked for first.
 */
async function translateTopics() {
  const asked = state.language;
  if (!state.topics.length) return;

  try {
    const res = await fetch(`/api/topics?lang=${encodeURIComponent(asked)}`);
    if (!res.ok) return;

    const data = await res.json();
    if (data.language !== state.language) return;
    if (!Array.isArray(data.categories) || !data.categories.length) return;

    // Labels only. Ids are what the selection and the request are keyed on, so
    // they are taken from what is already held rather than from the answer.
    const named = new Map(data.categories.map((c) => [c.id, c.label]));
    state.topics = state.topics.map((topic) =>
      named.has(topic.id) ? { ...topic, label: named.get(topic.id) } : topic
    );

    drawTopics();
    // The sheet sorts what it is given, so an open one is rebuilt rather than
    // left holding the old names in the old order.
    if (el.dialog.open) onBrowse();
  } catch {
    // An untranslated button is a working button.
  }
}

/**
 * Every topic the business has, alphabetically, in a modal.
 *
 * Sorted here as well as on the server. The server is where the order is
 * decided and both lists come from it already sorted — but this sheet is the
 * one place whose whole promise is "all of them, in order", and a promise that
 * depends on an upstream deploy having happened is not one worth making.
 *
 * Rebuilt on every open rather than kept: it has to reflect a selection made in
 * the picker since the last time it was seen, and fifty buttons is nothing.
 */
function onBrowse() {
  const all = [...state.topics].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  );

  el.allChips.replaceChildren(...all.map(topicChip));

  // Cleared on every open. A filter left over from last time would hide topics
  // the guest never chose to hide, and the box that explains why is above the
  // fold only until the keyboard is up.
  el.topicsSearch.value = '';
  filterTopics();

  el.dialog.showModal();
}

/**
 * Folds a label down to what a search should match.
 *
 * Case first, then accents, so "cafe" finds "Café" and "Zimmer" finds "zimmer".
 * The decomposition is a no-op for Thai and the CJK scripts — they have no
 * combining accents to strip — and substring matching is the right behaviour
 * there anyway, since neither language puts spaces between words.
 */
function fold(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/**
 * Shows the topics matching what has been typed, and hides the rest.
 *
 * Hidden rather than removed and rebuilt: a chip carries the guest's selection
 * in an attribute, and rebuilding on every keystroke would throw away the
 * focused element under a keyboard user mid-search.
 */
function filterTopics() {
  const query = fold(el.topicsSearch.value.trim());
  let matched = 0;

  for (const chip of el.allChips.children) {
    const hit = !query || fold(chip.textContent).includes(query);
    chip.hidden = !hit;
    if (hit) matched += 1;
  }

  el.topicsEmpty.hidden = matched > 0;
}



/* ---------------------------------------------------------------- length */

/**
 * How long the review should be — Any, Short or Detailed.
 *
 * Any is the default and means what the page did before this existed: a length
 * drawn at random per attempt. The other two narrow the pool rather than fixing
 * a number, so asking twice for Short still gives two different shapes.
 */
function renderLengths(lengths) {
  if (lengths.length < 2) {
    el.lengths.closest('.picker').hidden = true;
    return;
  }

  state.length = lengths.some((l) => l.id === state.length)
    ? state.length
    : lengths[0].id;

  const buttons = lengths.map((length) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.role = 'radio';
    // The server's label is the fallback, not the source: a length the page
    // has no word for still gets a button rather than a blank one.
    chip.dataset.id = length.id;
    chip.textContent =
      { any: t('lengthAny'), short: t('lengthShort'), detailed: t('lengthDetailed') }[
        length.id
      ] ?? length.label;
    chip.setAttribute('aria-checked', String(length.id === state.length));
    // One tab stop for the group, arrows to move within it — the radio pattern.
    chip.tabIndex = length.id === state.length ? 0 : -1;
    el.lengths.append(chip);
    return chip;
  });

  function pick(chip, { focus = false } = {}) {
    if (state.busy) return;
    state.length = chip.dataset.id;

    for (const other of buttons) {
      const on = other === chip;
      other.setAttribute('aria-checked', String(on));
      other.tabIndex = on ? 0 : -1;
    }
    if (focus) chip.focus();
  }

  for (const [index, chip] of buttons.entries()) {
    // Changing it does not regenerate, for the same reason toggling a topic does
    // not — every attempt is one of a limited number the guest has.
    chip.addEventListener('click', () => pick(chip));

    chip.addEventListener('keydown', (event) => {
      const step =
        event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -1
            : 0;
      if (!step) return;

      event.preventDefault();
      const next = (index + step + buttons.length) % buttons.length;
      pick(buttons[next], { focus: true });
    });
  }
}

/**
 * Puts every fixed word on the page into the current language.
 *
 * Called three times: at boot from the browser's own preference, once the
 * business's language list has narrowed that, and again whenever the guest
 * moves the selector. Everything it touches is furniture — the business's name,
 * its topics and its platforms are its own words and are left alone.
 *
 * The lists that are drawn rather than written (topics, lengths, destinations)
 * redraw themselves, because their text is built from the table too.
 */
function applyStrings() {
  document.documentElement.lang = state.language;

  document.title = state.venue
    ? `${t('title')} — ${state.venue}`
    : t('title');

  el.heading.textContent = t('heading');
  el.titleDot.hidden = NO_FULL_STOP.has(state.language);
  el.lede.textContent = t('lede');
  el.pickerLabel.textContent = t('picker');
  el.lengthLabel.textContent = t('lengthLabel');
  el.slipLabel.textContent = t('reviewLabel');
  el.review.placeholder = t('placeholder');
  el.lang.setAttribute('aria-label', t('language'));
  el.topicsTitle.textContent = t('allTopics');
  el.topicsDone.textContent = t('done');
  el.topicsSearch.placeholder = t('searchTopics');
  el.topicsSearch.setAttribute('aria-label', t('searchTopics'));
  el.topicsEmpty.textContent = t('noMatches');

  // Mid-copy: the button says "Copied" for a moment and must not be reset to
  // "Copy" by a language change landing inside that window.
  if (!copyResetTimer) el.copy.textContent = t('copy');

  // Regenerate carries a count once the server has sent one; renderCount owns
  // that wording, so defer to it rather than writing the label twice.
  if (state.max === null || state.left === null) {
    el.regenerate.textContent = t('regenerate');
  } else {
    renderCount();
  }

  // Drawn lists. Guarded because applyStrings runs once before any of them
  // exist, on a page that has not been told what the business offers yet.
  if (state.topics.length) drawTopics();
  for (const chip of el.lengths.children) {
    const key = {
      any: 'lengthAny',
      short: 'lengthShort',
      detailed: 'lengthDetailed',
    }[chip.dataset.id];
    if (key) chip.textContent = t(key);
  }
  if (state.destinations.length) renderDestinations();
}

/**
 * The browser's own preference, narrowed to a list we have words for.
 *
 * Used before the business's language list has arrived — at that point the only
 * constraint is which languages the strings table holds. A remembered choice
 * wins over the browser, the same way it does once the real list is in hand.
 */
function guessLanguage(offered) {
  const remembered = localStorage.getItem('reviewslip.lang');
  if (offered.includes(remembered)) return remembered;

  const asked = navigator.languages?.length
    ? navigator.languages
    : [navigator.language].filter(Boolean);

  for (const tag of asked) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (offered.includes(base)) return base;
  }

  return 'en';
}

/**
 * What to select before the guest has chosen anything.
 *
 * A previous choice wins. Otherwise the browser's own preferences, in the order
 * it lists them, matched on the base tag — zh-CN, zh-TW and zh all mean the same
 * offer here. A guest who cannot read English should not have to find the
 * selector before the page is any use to them.
 */
function preferredLanguage(languages) {
  const remembered = localStorage.getItem('reviewslip.lang');
  if (languages.some((l) => l.code === remembered)) return remembered;

  const offered = new Set(languages.map((l) => l.code));
  const asked = navigator.languages?.length
    ? navigator.languages
    : [navigator.language].filter(Boolean);

  for (const tag of asked) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (offered.has(base)) return base;
  }

  return languages[0].code;
}

/**
 * Which language the page and the review are both in.
 *
 * It used to be the review alone. That was half a feature: a guest who cannot
 * read English cannot read the buttons around the review either, and being
 * handed a Thai paragraph framed in English chrome says the review is a
 * translation of somebody else's words rather than their own.
 *
 * Hidden when a business offers one language, because a selector with one
 * option is furniture that does nothing. The page is still translated in that
 * case — into whichever single language is on offer.
 */
function renderLanguages(languages) {
  if (languages.length < 2) {
    el.lang.hidden = true;
    // One language is still a language. A business offering only Thai gets a
    // Thai page, with no selector to say so.
    if (languages.length === 1) state.language = languages[0].code;
    return;
  }

  state.language = preferredLanguage(languages);

  for (const language of languages) {
    const option = document.createElement('option');
    option.value = language.code;
    // Its own name, in its own script: someone looking for Thai is not reading
    // the English word for it.
    option.textContent = language.label;
    option.selected = language.code === state.language;
    el.lang.append(option);
  }

  // Changing it does not regenerate, for the same reason toggling a category
  // does not — every attempt is one of a limited number the guest has.
  el.lang.addEventListener('change', () => {
    state.language = el.lang.value;
    localStorage.setItem('reviewslip.lang', state.language);
    // The page changes now; the review changes on the next generation, for the
    // same reason toggling a topic does not regenerate. Saying so is the point
    // of the notice — the guest can see the page moved and needs telling that
    // the paragraph in front of them did not.
    applyStrings();
    translateTopics();
    say(t('languageChanged'));
  });
}

/* -------------------------------------------------------------- generate */

async function generate() {
  if (state.busy) return;
  clearReview();
  setBusy(true);
  say('');

  try {
    const res = await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        categoryIds: state.categoryIds,
        language: state.language,
        length: state.length,
        recent: state.recent,
      }),
    });

    const data = await res.json().catch(() => ({}));

    // Before the throw, not after it. A refusal carries a count too, and the
    // one that matters most is the refusal for being out — the page used to
    // read the count only on success, so being told "no more" left `state.left`
    // untouched, `setBusy(false)` re-enabled the button, and the guest could
    // tap it forever against a server that would never say yes again.
    applyQuota(data);

    if (!res.ok) throw new Error(data.error || 'Something went wrong.');

    el.review.value = data.review;
    state.reviewId = Number.isInteger(data.reviewId) ? data.reviewId : null;
    state.recent = [...state.recent, data.review].slice(-3);

    if (state.left === 0) {
      say(t('lastTry'));
    } else if (state.left !== null && state.left <= 3) {
      say(t(state.left === 1 ? 'triesOne' : 'triesMany', { n: state.left }));
    }

    setBusy(false);
    autosize();
    replay(el.review, 'settling');
  } catch (err) {
    setBusy(false);
    // setBusy re-enables the button unless the count says otherwise, which is
    // why applyQuota runs first: an ordinary failure should leave the guest
    // able to try again, and running out should not.
    say(err.message || t('writerFailed'), 'error');
  }
}

/**
 * Takes whatever the server said about the count and makes the page agree.
 *
 * The server is the only authority here — the map it counts against is keyed by
 * business and address, so reloading the page, clearing storage or opening a
 * new tab buys nothing. This only reflects that decision, and its whole job is
 * to make a refusal stick to the button rather than being announced once and
 * forgotten.
 *
 * @param {object} data - a response body, successful or not
 */
function applyQuota(data) {
  if (typeof data?.left !== 'number') return;

  state.left = data.left;
  if (typeof data.max === 'number') state.max = data.max;

  renderCount();
  if (state.left === 0) el.regenerate.disabled = true;
}

/* ----------------------------------------------------------- copy & post */

async function onCopy() {
  const ok = await copyReview();
  if (!ok) return;

  el.copy.textContent = t('copied');
  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => {
    el.copy.textContent = t('copy');
  }, 1800);
}

/**
 * Both destinations behave the same way: the review goes to the clipboard
 * first, then the listing opens. The guest is one paste away either side, and
 * a failed copy has to be said out loud — the listing opens regardless, and
 * arriving there with an empty clipboard is the one thing that wastes the trip.
 *
 * @param {string} url
 * @param {string} where - the listing's name, for the notice
 */
async function onProceed(url, where) {
  if (!url) return;

  // The draft becomes a review here, not when it was written. Sent before the
  // copy and never awaited: the listing opens either way, and a guest whose
  // trip is delayed by a request nobody is waiting for is a guest who posts
  // nothing.
  markProceeded();

  const copied = await copyReview();
  say(t(copied ? 'pasteCopied' : 'pasteManual', { place: where }));
  window.open(url, '_blank', 'noopener');
}

/**
 * Tells the server the guest took this one to a listing.
 *
 * Best effort by design. `keepalive` so it survives the page going into the
 * background behind the listing that just opened, and every failure is
 * swallowed — an unrecorded review is a gap in a list, while an error thrown
 * here would be one in front of somebody halfway out the door.
 */
function markProceeded() {
  if (!Number.isInteger(state.reviewId)) return;

  fetch('/api/proceeded', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewId: state.reviewId }),
    keepalive: true,
  }).catch(() => {});
}

async function copyReview() {
  const text = el.review.value.trim();
  if (!text) {
    say(t('nothingToCopy'), 'error');
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older mobile browsers, or a page not served over https/localhost.
    try {
      el.review.focus();
      el.review.setSelectionRange(0, el.review.value.length);
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

/* ----------------------------------------------------------------- utils */

/**
 * How many of the guest's tries are gone, on the button itself.
 *
 * On the button rather than in the notice, because the notice is where errors
 * and the copy confirmation go — a count that shares that line disappears the
 * moment anything else has something to say.
 */
function renderCount() {
  if (state.max === null || state.left === null) return;

  // Regenerations, both of them: the first draft arrives before the guest has
  // asked for anything, so counting it here would open the page on "1/10"
  // having spent nothing.
  el.regenerate.textContent = t('regenerateCount', {
    used: state.max - state.left,
    max: state.max,
  });
}

function setBusy(busy) {
  state.busy = busy;
  el.slip.setAttribute('aria-busy', String(busy));
  // Out of tries stays out of tries: unbusying must not re-enable it.
  el.regenerate.disabled = busy || state.left === 0;
  el.copy.disabled = busy;
}

function say(message, tone) {
  el.notice.textContent = message;
  if (tone) el.notice.dataset.tone = tone;
  else delete el.notice.dataset.tone;
}

/** The old review goes as soon as a new one is asked for, height included. */
function clearReview() {
  el.review.value = '';
  el.review.style.height = 'auto';
}

function autosize() {
  el.review.style.height = 'auto';
  el.review.style.height = `${el.review.scrollHeight}px`;
}

function replay(node, className) {
  node.classList.remove(className);
  void node.offsetWidth; // force the animation to restart
  node.classList.add(className);
}
