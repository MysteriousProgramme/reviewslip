'use strict';

const el = {
  eyebrow: document.getElementById('eyebrow'),
  chips: document.getElementById('chips'),
  slip: document.getElementById('slip'),
  review: document.getElementById('review'),
  notice: document.getElementById('notice'),
  regenerate: document.getElementById('regenerate'),
  copy: document.getElementById('copy'),
  destinations: document.getElementById('destinations'),
  hint: document.getElementById('hint'),

};

const state = {
  // A set, not one value: a guest may want the room and the food in one review.
  categoryIds: [],
  destinations: [], // {id, label, hex, path, url} for each link that is set

  recent: [], // last few generations, so the next one reads differently
  busy: false,
};

let copyResetTimer = null;

/* ------------------------------------------------------------------ boot */

init();

async function init() {
  autosize();
  el.review.addEventListener('input', autosize);
  el.regenerate.addEventListener('click', () => generate());
  el.copy.addEventListener('click', onCopy);

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
    renderChips(config.categories || []);
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
    const button = document.createElement('button');
    button.type = 'button';
    // Marigold is spent once, as a fill. The first listing keeps it and the
    // rest are outlined, however many there are.
    button.className = `btn btn-go${index ? ' btn-go-second' : ''}`;

    if (place.path) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '17');
      svg.setAttribute('height', '17');
      svg.setAttribute('aria-hidden', 'true');
      // The brand's own colour, not the button's — a mark recoloured to match a
      // button stops being that brand's mark.
      svg.setAttribute('fill', place.hex);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', place.path);
      svg.append(path);
      button.append(svg);
    }

    button.append(document.createTextNode(`Proceed to ${place.label}`));
    button.addEventListener('click', () => onProceed(place.url, place.label));
    el.destinations.append(button);
  }

  el.hint.textContent = state.destinations.length
    ? 'Copies your review, then opens the listing.'
    : 'No review link set yet.';
}

function renderChips(categories) {
  el.chips.replaceChildren();

  // The categories can be edited underneath a page that is already open, so a
  // remembered selection is not necessarily still on offer.
  const offered = categories.map((c) => c.id);
  state.categoryIds = state.categoryIds.filter((id) => offered.includes(id));

  for (const category of categories) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = category.label;
    chip.dataset.id = category.id;
    chip.setAttribute(
      'aria-pressed',
      String(state.categoryIds.includes(category.id))
    );

    // Toggling does not regenerate. Picking three topics would otherwise spend
    // three reviews to get one, and each costs tokens the business pays for —
    // Regenerate is one tap away once the selection is right.
    chip.addEventListener('click', () => {
      if (state.busy) return;

      const on = state.categoryIds.includes(category.id);
      state.categoryIds = on
        ? state.categoryIds.filter((id) => id !== category.id)
        : [...state.categoryIds, category.id];

      chip.setAttribute('aria-pressed', String(!on));
    });

    el.chips.append(chip);
  }
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
        recent: state.recent,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');

    el.review.value = data.review;
    state.recent = [...state.recent, data.review].slice(-3);

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

function setBusy(busy) {
  state.busy = busy;
  el.slip.setAttribute('aria-busy', String(busy));
  el.regenerate.disabled = busy;
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
