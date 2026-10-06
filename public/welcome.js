'use strict';

/**
 * The welcome page: a name and an email, then the venue's links, and how to
 * keep the page on the phone.
 *
 * The rules — what a valid sign-up is, what a link may point at — live on the
 * server (welcome.js). This file only draws them.
 */

const PASS_KEY = 'rs:welcome-pass';
const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- language */

/**
 * The guest's own language, if the page has it.
 *
 * From the browser rather than a selector: this page is a handful of words
 * read once, and a guest standing in a lobby should not have to find a menu to
 * read them. Matched on the base tag, as the server does.
 */
const STRINGS = window.RS_STRINGS || { en: {} };
const lang =
  (navigator.languages || [navigator.language || 'en'])
    .map((tag) => String(tag).toLowerCase().split('-')[0])
    .find((code) => STRINGS[code]) || 'en';

let venue = '';

function t(key) {
  const raw = (STRINGS[lang] && STRINGS[lang][key]) || (STRINGS.en && STRINGS.en[key]) || key;
  return raw.replace(/\{venue\}/g, venue);
}

function paint() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  $('heading').textContent = venue ? t('welcomeHeading') : t('welcomeTitle');
  document.title = venue ? `${t('welcomeTitle')} · ${venue}` : t('welcomeTitle');
}

/* ------------------------------------------------------------------- views */

function showForm() {
  $('signup').hidden = false;
  $('links-view').hidden = true;
  $('lede').hidden = false;
}

function showLinks(links) {
  $('signup').hidden = true;
  $('lede').hidden = true;
  $('links-view').hidden = false;

  const list = $('links');
  list.replaceChildren();
  for (const link of links) {
    const a = document.createElement('a');
    a.className = 'link-row';
    a.href = link.url;
    a.textContent = link.label;
    // A web page opens beside this one so the guest can come back to it; a
    // phone number or an email address goes to the phone's own app.
    if (/^https?:/i.test(link.url)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    const li = document.createElement('li');
    li.append(a);
    list.append(li);
  }
  $('no-links').hidden = links.length > 0;

  offerInstall();
}

/* ----------------------------------------------------------------- install */

const standalone =
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let deferred = null;

// Chrome and Edge announce that they can install the page. Held until the
// guest asks, because a browser prompt the moment the page opens is the kind
// of thing people dismiss on reflex.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferred = event;
  offerInstall();
});

window.addEventListener('appinstalled', () => {
  deferred = null;
  $('install-button').hidden = true;
  $('install-ios').hidden = true;
  $('install-android').hidden = true;
  $('install-done').hidden = false;
});

function offerInstall() {
  if (standalone || $('links-view').hidden) return;

  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);

  $('install').hidden = false;
  $('install-button').hidden = !deferred;
  // Steps for the phone in hand. On anything else — a laptop that opened the
  // link — both, since there is no telling which phone it is meant for.
  $('install-ios').hidden = deferred ? true : !(ios || !android);
  $('install-android').hidden = deferred ? true : !(android || !ios);
}

$('install-button').addEventListener('click', async () => {
  if (!deferred) return;
  deferred.prompt();
  await deferred.userChoice.catch(() => null);
  deferred = null;
  $('install-button').hidden = true;
});

/* ----------------------------------------------------------------- sign-up */

function readPass() {
  try {
    return localStorage.getItem(PASS_KEY) || '';
  } catch {
    return '';
  }
}

function writePass(pass) {
  try {
    if (pass) localStorage.setItem(PASS_KEY, pass);
    else localStorage.removeItem(PASS_KEY);
  } catch {
    // Private browsing: the guest is asked again next time, nothing worse.
  }
}

$('signup').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('error');
  error.textContent = '';

  const button = $('continue');
  button.disabled = true;
  try {
    const res = await fetch('/api/welcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('name').value,
        email: $('email').value,
        consent: $('consent').checked,
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      error.textContent = t(data.error || 'welcomeFailed');
      return;
    }

    writePass(data.pass);
    showLinks(data.links || []);
  } catch {
    error.textContent = t('welcomeFailed');
  } finally {
    button.disabled = false;
  }
});

/* -------------------------------------------------------------------- open */

async function open() {
  paint();

  try {
    const res = await fetch('/api/welcome');
    if (res.ok) {
      const data = await res.json();
      venue = data.venue || '';
      if (data.showName !== false) $('eyebrow').textContent = venue;
      if (data.hasLogo) {
        const logo = $('logo');
        logo.src = '/logo';
        logo.alt = venue;
        logo.hidden = false;
      }
      paint();
    }
  } catch {
    // The form works without the venue's name; it only reads less warmly.
  }

  // A guest who signed up before goes straight to the links. A pass that no
  // longer works — the venue deleted their details — is forgotten, and they
  // are asked again.
  const pass = readPass();
  if (pass) {
    try {
      const res = await fetch('/api/welcome/links', { headers: { 'X-Welcome-Pass': pass } });
      if (res.ok) {
        const data = await res.json();
        return showLinks(data.links || []);
      }
      writePass('');
    } catch {
      // Offline or a hiccup: the form is the safe thing to show.
    }
  }
  showForm();
}

open();
