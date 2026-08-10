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

  gear: document.getElementById('open-settings'),
  sheet: document.getElementById('settings'),
  form: document.getElementById('settings-form'),
  cancel: document.getElementById('cancel-settings'),
  save: document.getElementById('save-settings'),
  unlock: document.getElementById('unlock-settings'),
  sheetStatus: document.getElementById('settings-status'),
  sheetVenue: document.getElementById('sheet-venue'),
  lock: document.getElementById('settings-lock'),
  body: document.getElementById('settings-body'),
  token: document.getElementById('settings-token'),
  apiKey: document.getElementById('api-key'),
  keyHint: document.getElementById('key-hint'),
  keyOrigin: document.getElementById('key-origin'),
  model: document.getElementById('model'),
  modelList: document.getElementById('model-list'),
  modelOrigin: document.getElementById('model-origin'),
  googleUrl: document.getElementById('google-url'),
  urlOrigin: document.getElementById('url-origin'),
  tripadvisorUrl: document.getElementById('tripadvisor-url'),
  taOrigin: document.getElementById('ta-origin'),
  cats: document.getElementById('cats'),
  addCategory: document.getElementById('add-category'),
  suggestCategories: document.getElementById('suggest-categories'),
  catsStatus: document.getElementById('cats-status'),
  categoriesOrigin: document.getElementById('categories-origin'),
  websiteUrl: document.getElementById('website-url'),
  websiteOrigin: document.getElementById('website-origin'),
  draft: document.getElementById('draft'),
  seedStatus: document.getElementById('seed-status'),
  seedOut: document.getElementById('seed-out'),
  kind: document.getElementById('venue-kind'),
  kindOrigin: document.getElementById('kind-origin'),
  place: document.getElementById('venue-place'),
  placeOrigin: document.getElementById('place-origin'),
  details: document.getElementById('details'),
  addDetail: document.getElementById('add-detail'),
  detailsStatus: document.getElementById('details-status'),
  detailsOrigin: document.getElementById('details-origin'),
};

const state = {
  categoryId: 'any',
  googleUrl: null,
  tripadvisorUrl: null,
  maxCategories: 5, // replaced by the server's own limit on first load
  maxDetails: 10, // same

  recent: [], // last few generations, so the next one reads differently
  busy: false,
  unlocked: false, // whether the settings token has been accepted this tab
};

let copyResetTimer = null;

/* ----------------------------------------------------------- settings auth */

/**
 * The settings panel edits one venue's OpenRouter key, so it is behind that
 * venue's token. Session storage, not local: staff unlock once on the tablet
 * behind the desk, and closing the tab locks it again.
 */
const TOKEN_KEY = 'reviewapp.settings-token';

function savedToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return ''; // private mode with storage disabled — unlock every time
  }
}

function rememberToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to fall back to; the panel simply asks again next time.
  }
}

/** fetch with the token attached. A rejected token drops straight back to the
    lock, so a rotated token cannot leave the panel half-working. */
async function authFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${savedToken()}`,
    },
  });

  if (res.status === 401) {
    rememberToken('');
    showLock();
  }
  return res;
}

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
  el.gear.addEventListener('click', openSettings);
  el.cancel.addEventListener('click', () => el.sheet.close());
  el.form.addEventListener('submit', onSaveSettings);
  el.draft.addEventListener('click', onDraftFromWebsite);
  el.addCategory.addEventListener('click', () => {
    addCategoryRow().querySelector('.cat-label').focus();
  });
  el.suggestCategories.addEventListener('click', onSuggestCategories);
  el.addDetail.addEventListener('click', () => {
    addDetailRow().querySelector('.cat-focus').focus();
  });

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
    if (config.subscriber?.name) {
      el.sheetVenue.textContent = `Settings for ${config.subscriber.name}.`;
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
      : 'No review link set yet — add one in Settings.';
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

/* --------------------------------------------------------------- settings */

async function openSettings() {
  say('');
  sheetSay('');
  el.apiKey.value = '';
  seedSay('');
  catsSay('');
  detailsSay('');
  el.seedOut.hidden = true;
  el.seedOut.replaceChildren();
  el.sheet.showModal();

  // A token already accepted this tab goes straight through; anything else
  // gets the lock, so a guest tapping the gear sees a token field and no more.
  if (savedToken()) await loadSettings();
  else showLock();
}

function showLock() {
  state.unlocked = false;
  el.lock.hidden = false;
  el.body.hidden = true;
  el.unlock.hidden = false;
  el.save.hidden = true;
  el.token.value = '';
  el.token.focus();
}

function showUnlocked() {
  state.unlocked = true;
  el.lock.hidden = true;
  el.body.hidden = false;
  el.unlock.hidden = true;
  el.save.hidden = false;
}

/** @returns {boolean} whether the panel is now showing real settings */
async function loadSettings() {
  try {
    const res = await authFetch('/api/settings');
    if (res.status === 401) {
      sheetSay('That token was not accepted.', 'error');
      return false;
    }
    if (!res.ok) throw new Error(String(res.status));

    fillSettings(await res.json());
    showUnlocked();
    loadModelList();
    return true;
  } catch {
    sheetSay('Could not load the current settings.', 'error');
    return false;
  }
}

async function onUnlock() {
  const token = el.token.value.trim();
  if (!token) {
    sheetSay('Paste the settings token for this venue.', 'error');
    return;
  }

  el.unlock.disabled = true;
  sheetSay('Checking…');
  rememberToken(token);

  const ok = await loadSettings();
  el.unlock.disabled = false;
  if (ok) sheetSay('');
}

function fillSettings(s) {
  el.keyHint.textContent = s.apiKey.set
    ? `Current key ${s.apiKey.hint}. Leave blank to keep it.`
    : 'No key set yet.';
  el.apiKey.placeholder = s.apiKey.set ? 'Unchanged' : 'sk-or-v1-…';
  el.model.value = s.model.value;
  el.googleUrl.value = s.googleUrl.value;
  el.tripadvisorUrl.value = s.tripadvisorUrl.value;
  el.websiteUrl.value = s.websiteUrl.value;
  el.kind.value = s.kind.value;
  el.place.value = s.place.value;
  if (s.limits?.categories) state.maxCategories = s.limits.categories;
  if (s.limits?.safeDetails) state.maxDetails = s.limits.safeDetails;
  renderCategories(s.categories.value);
  renderDetails(s.safeDetails.value);

  setOrigin(el.keyOrigin, s.apiKey.source, s.apiKey.set);
  setOrigin(el.modelOrigin, s.model.source, true);
  setOrigin(el.urlOrigin, s.googleUrl.source, Boolean(s.googleUrl.value));
  setOrigin(
    el.taOrigin,
    s.tripadvisorUrl.source,
    Boolean(s.tripadvisorUrl.value)
  );
  setOrigin(el.websiteOrigin, s.websiteUrl.source, Boolean(s.websiteUrl.value));
  setOrigin(el.categoriesOrigin, s.categories.source, true);
  setOrigin(el.kindOrigin, s.kind.source, Boolean(s.kind.value));
  setOrigin(el.placeOrigin, s.place.source, Boolean(s.place.value));
  setOrigin(el.detailsOrigin, s.safeDetails.source, true);
}

/* ---------------------------------------------------------- venue details */

function renderDetails(list) {
  el.details.replaceChildren();
  for (const detail of list || []) addDetailRow(detail);
  updateDetailControls();
}

/** The cap is the server's; the button just stops offering what it would reject. */
function updateDetailControls() {
  const full = el.details.childElementCount >= state.maxDetails;
  el.addDetail.disabled = full;
  el.addDetail.textContent = full
    ? `${state.maxDetails} is the maximum`
    : 'Add detail';
}

function addDetailRow(detail = '') {
  const row = document.createElement('div');
  row.className = 'cat';

  const text = document.createElement('input');
  text.type = 'text';
  text.className = 'cat-focus';
  text.placeholder = 'something a guest could see for themselves';
  text.maxLength = 180;
  text.value = detail || '';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'cat-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'Remove detail');
  remove.addEventListener('click', () => {
    row.remove();
    updateDetailControls();
  });

  row.append(text, remove);
  el.details.append(row);
  updateDetailControls();
  return row;
}

/** The rows as the server wants them. It drops the blank ones. */
function readDetails() {
  return [...el.details.children].map(
    (row) => row.querySelector('.cat-focus').value
  );
}

function detailsSay(message, tone) {
  el.detailsStatus.textContent = message;
  if (tone) el.detailsStatus.dataset.tone = tone;
  else delete el.detailsStatus.dataset.tone;
}

/* ------------------------------------------------------------- categories */

function renderCategories(list) {
  el.cats.replaceChildren();
  for (const category of list || []) addCategoryRow(category);
  updateCategoryControls();
}

/** The cap is the server's; the button just stops offering what it would reject. */
function updateCategoryControls() {
  const full = el.cats.childElementCount >= state.maxCategories;
  el.addCategory.disabled = full;
  el.addCategory.textContent = full
    ? `${state.maxCategories} is the maximum`
    : 'Add category';
}

function addCategoryRow(category = {}) {
  const row = document.createElement('div');
  row.className = 'cat';
  // Kept so an edited label kicks no guest off the category they are on — the
  // server reuses an id it recognises rather than minting a new one.
  row.dataset.id = category.id || '';

  const label = document.createElement('input');
  label.type = 'text';
  label.className = 'cat-label';
  label.placeholder = 'Rooms';
  label.maxLength = 40;
  label.value = category.label || '';

  const focus = document.createElement('input');
  focus.type = 'text';
  focus.className = 'cat-focus';
  // Deliberately generic: this shows on every blank row, so an example tied to
  // one category would read as advice about whichever row it landed on.
  focus.placeholder = 'what a review under this button should talk about';
  focus.maxLength = 200;
  // The server fills a blank note in with the label, so showing that back
  // would turn "no note" into a note the moment it was saved twice.
  focus.value = category.focus === category.label ? '' : category.focus || '';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'cat-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `Remove ${category.label || 'category'}`);
  remove.addEventListener('click', () => {
    row.remove();
    updateCategoryControls();
  });

  row.append(label, focus, remove);
  el.cats.append(row);
  updateCategoryControls();
  return row;
}

/**
 * Draft the picker from the venue website. Like the venue-details draft, this
 * only fills the editor — the rows are ordinary rows afterwards, editable and
 * removable, and nothing is stored until Save.
 */
async function onSuggestCategories() {
  const url = el.websiteUrl.value.trim();
  if (!url) {
    catsSay('Add the venue website address first.', 'error');
    el.websiteUrl.focus();
    return;
  }

  el.suggestCategories.disabled = true;
  catsSay('Reading the website…');

  try {
    // Save first, so the server reads the address that is on screen.
    const saved = await authFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteUrl: url }),
    });
    const savedData = await saved.json().catch(() => ({}));
    if (!saved.ok) {
      throw new Error(savedData.error || 'Could not save the address.');
    }

    const res = await authFetch('/api/categories/suggest', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not read the website.');

    renderCategories(data.categories);
    catsSay(
      `${data.categories.length} suggested. Edit anything, then Save to keep them.`
    );
  } catch (err) {
    catsSay(err.message, 'error');
  } finally {
    el.suggestCategories.disabled = false;
  }
}

function catsSay(message, tone) {
  el.catsStatus.textContent = message;
  if (tone) el.catsStatus.dataset.tone = tone;
  else delete el.catsStatus.dataset.tone;
}

/** The rows as the server wants them. It drops the blank ones. */
function readCategories() {
  return [...el.cats.children].map((row) => ({
    id: row.dataset.id || undefined,
    label: row.querySelector('.cat-label').value,
    focus: row.querySelector('.cat-focus').value,
  }));
}

/**
 * Says where a value came from. With a platform-wide .env underneath every
 * venue, "this venue" versus "from .env" is the difference between changing
 * one listing and inheriting someone else's setting.
 */
function setOrigin(node, source, present) {
  if (!present) {
    node.textContent = '';
    return;
  }
  node.textContent =
    source === 'env'
      ? 'from .env'
      : source === 'default'
        ? 'default'
        : 'this venue';
}

async function loadModelList() {
  if (el.modelList.childElementCount) return;
  try {
    const res = await authFetch('/api/models');
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
  // The same form does both jobs; which one depends on whether it is unlocked.
  if (!state.unlocked) return onUnlock();

  el.save.disabled = true;
  sheetSay('Saving…');

  const patch = {
    model: el.model.value,
    googleUrl: el.googleUrl.value,
    tripadvisorUrl: el.tripadvisorUrl.value,
    websiteUrl: el.websiteUrl.value,
    categories: readCategories(),
    kind: el.kind.value,
    place: el.place.value,
    safeDetails: readDetails(),
  };
  // An empty key field means "keep what's there", not "clear it".
  if (el.apiKey.value.trim()) patch.apiKey = el.apiKey.value.trim();

  try {
    const res = await authFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not save the settings.');

    fillSettings(data.settings);
    el.apiKey.value = '';

    // The page behind the panel is now out of date: a link may have appeared,
    // and the category buttons may have been renamed out from under it.
    state.googleUrl = data.settings.googleUrl.value;
    state.tripadvisorUrl = data.settings.tripadvisorUrl.value;
    renderDestinations();
    renderChips(
      data.settings.categories.value.map(({ id, label }) => ({ id, label }))
    );

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

/* ---------------------------------------------------------------- seeding */

/**
 * Reads the venue website and shows the details it proposes. This only ever
 * displays a draft — approving it into the venue config is a separate step.
 */
async function onDraftFromWebsite() {
  const url = el.websiteUrl.value.trim();
  if (!url) {
    seedSay('Add the venue website address first.', 'error');
    el.websiteUrl.focus();
    return;
  }

  el.draft.disabled = true;
  el.seedOut.hidden = true;
  el.seedOut.replaceChildren();
  seedSay('Reading the website…');

  try {
    // Save first, so the server reads the address that's on screen.
    const saved = await authFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteUrl: url }),
    });
    const savedData = await saved.json().catch(() => ({}));
    if (!saved.ok) throw new Error(savedData.error || 'Could not save the address.');
    fillSettings(savedData.settings);

    const res = await authFetch('/api/seed', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not read the website.');

    renderProposal(data);
    seedSay('Draft only — check each detail before using it.');
  } catch (err) {
    seedSay(err.message, 'error');
  } finally {
    el.draft.disabled = false;
  }
}

function renderProposal({ proposal, dropped }) {
  const frag = document.createDocumentFragment();

  const head = document.createElement('p');
  head.className = 'seed-head';
  head.textContent = [proposal.name, proposal.kind, proposal.place]
    .filter(Boolean)
    .join(' — ');
  if (proposal.categories.length) {
    const cats = document.createElement('span');
    cats.textContent = `  ·  ${proposal.categories.join(', ')}`;
    head.append(cats);
  }
  frag.append(head);

  const list = document.createElement('ul');
  list.className = 'seed-list';
  for (const item of proposal.safeDetails) {
    const li = document.createElement('li');
    li.textContent = item.detail;
    const quote = document.createElement('q');
    quote.textContent = item.source;
    li.append(quote);
    list.append(li);
  }
  frag.append(list);

  if (dropped?.length) {
    const note = document.createElement('p');
    note.className = 'seed-dropped';
    note.textContent = `${dropped.length} ${
      dropped.length === 1 ? 'claim' : 'claims'
    } left out: ${dropped.map((d) => d.reason).join('; ')}.`;
    frag.append(note);
  }

  // The draft is worth nothing until it lands in the fields, but it stays a
  // draft even then: this fills the editor, and Save is still a separate,
  // deliberate act.
  const use = document.createElement('button');
  use.type = 'button';
  use.className = 'btn btn-quiet btn-small';
  use.textContent = 'Use this draft';
  use.addEventListener('click', () => {
    if (proposal.kind) el.kind.value = proposal.kind;
    if (proposal.place) el.place.value = proposal.place;
    renderDetails(proposal.safeDetails.map((item) => item.detail));
    detailsSay('Filled from the draft. Check each line, then Save.');
    el.kind.scrollIntoView({ block: 'nearest' });
  });
  frag.append(use);

  el.seedOut.replaceChildren(frag);
  el.seedOut.hidden = false;
}

function seedSay(message, tone) {
  el.seedStatus.textContent = message;
  if (tone) el.seedStatus.dataset.tone = tone;
  else delete el.seedStatus.dataset.tone;
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
