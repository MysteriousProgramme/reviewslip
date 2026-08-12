'use strict';

const el = {
  eyebrow: document.getElementById('eyebrow'),
  chips: document.getElementById('chips'),
  slip: document.getElementById('slip'),
  review: document.getElementById('review'),
  notice: document.getElementById('notice'),
  regenerate: document.getElementById('regenerate'),
  copy: document.getElementById('copy'),
  proceed: document.getElementById('proceed'),
  proceedTa: document.getElementById('proceed-ta'),
  hint: document.getElementById('hint'),

};

const state = {
  categoryId: 'any',
  googleUrl: null,
  tripadvisorUrl: null,

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
  el.proceed.addEventListener('click', () => onProceed(state.googleUrl, 'Google'));
  el.proceedTa.addEventListener('click', () =>
    onProceed(state.tripadvisorUrl, 'Tripadvisor')
  );

  let config;
  try {
    const res = await fetch('/api/config');
    config = await res.json().catch(() => ({}));
    // A 404 here means the address does not belong to any venue, and the
    // server says so far more usefully than a generic message could.
    if (!res.ok) throw new Error(config.error || 'Could not load the page.');

    state.googleUrl = config.googleUrl;
    state.tripadvisorUrl = config.tripadvisorUrl;
    if (config.venue) {
      el.eyebrow.textContent = config.venue;
      document.title = `Leave a review — ${config.venue}`;
    }
    renderChips(config.categories || []);
  } catch (err) {
    setBusy(false);
    say(err.message || 'Could not load the page settings.', 'error');
    el.regenerate.disabled = true;
    el.proceed.disabled = true;
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
  const google = Boolean(state.googleUrl);
  const tripadvisor = Boolean(state.tripadvisorUrl);

  el.proceed.hidden = !google;
  el.proceedTa.hidden = !tripadvisor;
  // Marigold is spent once, as a fill. With both listings up Google keeps it;
  // alone, Tripadvisor takes it rather than sitting there as a lone outline.
  el.proceedTa.classList.toggle('btn-go-second', google && tripadvisor);

  el.hint.textContent =
    google || tripadvisor
      ? 'Copies your review, then opens the listing.'
      : 'No review link set yet.';
}

function renderChips(categories) {
  el.chips.replaceChildren();

  // The categories can be edited underneath a page that is already open, so a
  // remembered selection is not necessarily still on offer.
  if (!categories.some((c) => c.id === state.categoryId)) {
    state.categoryId = categories[0]?.id;
  }

  for (const category of categories) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = category.label;
    chip.dataset.id = category.id;
    chip.setAttribute('aria-pressed', String(category.id === state.categoryId));

    chip.addEventListener('click', () => {
      if (state.busy || state.categoryId === category.id) return;
      state.categoryId = category.id;
      for (const other of el.chips.children) {
        other.setAttribute(
          'aria-pressed',
          String(other.dataset.id === category.id)
        );
      }
      generate();
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
        categoryId: state.categoryId,
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
