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

  gear: document.getElementById('open-settings'),
  sheet: document.getElementById('settings'),
  form: document.getElementById('settings-form'),
  cancel: document.getElementById('cancel-settings'),
  save: document.getElementById('save-settings'),
  sheetStatus: document.getElementById('settings-status'),
  apiKey: document.getElementById('api-key'),
  keyHint: document.getElementById('key-hint'),
  keyOrigin: document.getElementById('key-origin'),
  model: document.getElementById('model'),
  modelList: document.getElementById('model-list'),
  modelOrigin: document.getElementById('model-origin'),
  googleUrl: document.getElementById('google-url'),
  urlOrigin: document.getElementById('url-origin'),
};

const state = {
  categoryId: 'any',
  googleUrl: null,
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
  el.proceed.addEventListener('click', onProceed);
  el.gear.addEventListener('click', openSettings);
  el.cancel.addEventListener('click', () => el.sheet.close());
  el.form.addEventListener('submit', onSaveSettings);

  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(String(res.status));
    const config = await res.json();

    state.googleUrl = config.googleUrl;
    if (config.venue) {
      el.eyebrow.textContent = config.venue;
      document.title = `Leave a review — ${config.venue}`;
    }
    renderChips(config.categories || []);
  } catch {
    setBusy(false);
    say('Could not load the page settings. Refresh to try again.', 'error');
    el.regenerate.disabled = true;
    el.proceed.disabled = true;
    return;
  }

  generate();
}

function renderChips(categories) {
  el.chips.replaceChildren();

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

/* --------------------------------------------------------------- settings */

async function openSettings() {
  say('');
  sheetSay('');
  el.apiKey.value = '';
  el.sheet.showModal();

  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(String(res.status));
    fillSettings(await res.json());
  } catch {
    sheetSay('Could not load the current settings.', 'error');
  }

  loadModelList();
}

function fillSettings(s) {
  el.keyHint.textContent = s.apiKey.set
    ? `Current key ${s.apiKey.hint}. Leave blank to keep it.`
    : 'No key set yet.';
  el.apiKey.placeholder = s.apiKey.set ? 'Unchanged' : 'sk-or-v1-…';
  el.model.value = s.model.value;
  el.googleUrl.value = s.googleUrl.value;

  setOrigin(el.keyOrigin, s.apiKey.source, s.apiKey.set);
  setOrigin(el.modelOrigin, s.model.source, true);
  setOrigin(el.urlOrigin, s.googleUrl.source, true);
}

/** Says where a value came from, so .env and saved values are told apart. */
function setOrigin(node, source, present) {
  if (!present) {
    node.textContent = '';
    return;
  }
  node.textContent =
    source === 'env' ? 'from .env' : source === 'default' ? 'default' : 'saved';
}

async function loadModelList() {
  if (el.modelList.childElementCount) return;
  try {
    const res = await fetch('/api/models');
    if (!res.ok) return;
    const { models } = await res.json();
    el.modelList.replaceChildren();
    for (const model of models || []) {
      const option = document.createElement('option');
      option.value = model.id;
      option.label = model.name;
      el.modelList.append(option);
    }
  } catch {
    // The field still takes a typed slug — the list is only a convenience.
  }
}

async function onSaveSettings(event) {
  event.preventDefault();
  el.save.disabled = true;
  sheetSay('Saving…');

  const patch = {
    model: el.model.value,
    googleUrl: el.googleUrl.value,
  };
  // An empty key field means "keep what's there", not "clear it".
  if (el.apiKey.value.trim()) patch.apiKey = el.apiKey.value.trim();

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not save the settings.');

    fillSettings(data.settings);
    state.googleUrl = data.settings.googleUrl.value;
    el.apiKey.value = '';

    if (data.warning) {
      sheetSay(data.warning);
    } else {
      el.sheet.close();
      say('Settings saved.');
      if (!el.review.value.trim()) generate();
    }
  } catch (err) {
    sheetSay(err.message, 'error');
  } finally {
    el.save.disabled = false;
  }
}

function sheetSay(message, tone) {
  el.sheetStatus.textContent = message;
  if (tone) el.sheetStatus.dataset.tone = tone;
  else delete el.sheetStatus.dataset.tone;
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

async function onProceed() {
  if (!state.googleUrl) return;
  const copied = await copyReview();
  say(
    copied
      ? 'Copied. Tap "Write a review" on the listing, then paste.'
      : 'Select the review and copy it, then tap "Write a review" on the listing.'
  );
  window.open(state.googleUrl, '_blank', 'noopener');
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
