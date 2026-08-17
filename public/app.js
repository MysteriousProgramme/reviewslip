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

};

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

const state = {
  topics: [], // every topic the business has, {id, label}
  shown: [], // the ids currently on screen
  browsing: false, // whether the guest opened the full list
  // A set, not one value: a guest may want the room and the food in one review.
  categoryIds: [],
  destinations: [], // {id, label, hex, path, url} for each link that is set

  recent: [], // last few generations, so the next one reads differently
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
  autosize();
  el.review.addEventListener('input', autosize);
  el.regenerate.addEventListener('click', () => generate());
  el.copy.addEventListener('click', onCopy);
  el.browse.addEventListener('click', onBrowse);

  let config;
  try {
    const res = await fetch('/api/config');
    config = await res.json().catch(() => ({}));
    // A 404 here means the address does not belong to any venue, and the
    // server says so far more usefully than a generic message could.
    if (!res.ok) throw new Error(config.error || 'Could not load the page.');

    state.destinations = Array.isArray(config.destinations)
      ? config.destinations
      : [];
    if (config.venue) {
      el.eyebrow.textContent = config.venue;
      document.title = `Leave a review — ${config.venue}`;
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
    renderTopics(config.categories || []);
    renderLengths(config.lengths || []);
    renderLanguages(config.languages || []);
  } catch (err) {
    setBusy(false);
    say(err.message || 'Could not load the page settings.', 'error');
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
    button.textContent = `Proceed to ${place.label}`;
    button.addEventListener('click', () => onProceed(place.url, place.label));

    row.append(button);
    el.destinations.append(row);
  }

  el.hint.textContent = state.destinations.length
    ? 'Copies your review, then opens the listing.'
    : 'No review link set yet.';
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
  state.browsing = false;
  state.shown = sampleIds(topics, SHOWN);

  drawTopics();
}

/**
 * `count` ids drawn without replacement, in the business's own order.
 *
 * Order preserved rather than shuffled: the topic list is written most-obvious
 * first, and a picker that reorders itself on every load would make the same ten
 * feel like a different ten. Random *which*, not random *where*.
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

function drawTopics() {
  el.chips.replaceChildren();

  // A topic the guest has already picked stays on screen even when it is not in
  // the sample — browsing, choosing something, then collapsing the list must not
  // silently drop the choice while leaving it in the request.
  const visible = state.browsing
    ? state.topics
    : state.topics.filter(
        (t) => state.shown.includes(t.id) || state.categoryIds.includes(t.id)
      );

  for (const topic of visible) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = topic.label;
    chip.dataset.id = topic.id;
    chip.setAttribute(
      'aria-pressed',
      String(state.categoryIds.includes(topic.id))
    );

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
    });

    el.chips.append(chip);
  }

  const more = state.topics.length - visible.length;
  el.browse.hidden = !state.browsing && more <= 0;
  el.browse.textContent = state.browsing
    ? 'Show fewer topics'
    : `Browse for more topics (${more})`;
  el.browse.setAttribute('aria-expanded', String(state.browsing));
}

function onBrowse() {
  state.browsing = !state.browsing;
  drawTopics();
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
    chip.textContent = length.label;
    chip.dataset.id = length.id;
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
 * Which language the review is written in — not the page.
 *
 * A guest who cannot read English still needs the review itself in their own
 * language: it is the thing they are about to post publicly under their name,
 * and they cannot judge a sentence they cannot read.
 */
function renderLanguages(languages) {
  if (languages.length < 2) {
    el.lang.hidden = true;
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
    say('The next one will be written in that language.');
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
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');

    el.review.value = data.review;
    state.recent = [...state.recent, data.review].slice(-3);

    // The server decides; this only reflects it, so a reload cannot buy more.
    if (typeof data.left === 'number') {
      state.left = data.left;
      state.max = typeof data.max === 'number' ? data.max : state.max;
      renderCount();
      if (data.left === 0) {
        el.regenerate.disabled = true;
        say('That is the last one for now. Edit it however you like.');
      } else if (data.left <= 3) {
        say(`${data.left} more ${data.left === 1 ? 'try' : 'tries'} for now.`);
      }
    }

    setBusy(false);
    autosize();
    replay(el.review, 'settling');
  } catch (err) {
    setBusy(false);
    say(err.message || 'Could not reach the writer. Try again.', 'error');
  }
}

/* ----------------------------------------------------------- copy & post */

async function onCopy() {
  const ok = await copyReview();
  if (!ok) return;

  el.copy.textContent = 'Copied';
  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => {
    el.copy.textContent = 'Copy';
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

  const copied = await copyReview();
  say(
    copied
      ? `Copied. Tap "Write a review" on ${where}, then paste.`
      : `Select the review and copy it, then tap "Write a review" on ${where}.`
  );
  window.open(url, '_blank', 'noopener');
}

async function copyReview() {
  const text = el.review.value.trim();
  if (!text) {
    say('Nothing to copy yet.', 'error');
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
  const used = state.max - state.left;
  el.regenerate.textContent = `Regenerate (${used}/${state.max})`;
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
