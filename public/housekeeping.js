'use strict';

/*
 * The housekeeping board.
 *
 * One screen, two states: a PIN box, or today's rooms. Everything is a tap.
 *
 * The token lives in localStorage rather than a cookie because there is no
 * cross-site request to protect and a cookie would ride along on every asset
 * the venue's own domain serves. It is short-lived and bound to the PIN, so
 * the worst a stolen phone gives somebody is a room list until the PIN changes.
 */

const KEY = 'reviewslip.shift';

const el = {
  gate: document.getElementById('gate'),
  gateVenue: document.getElementById('gate-venue'),
  gateNote: document.getElementById('gate-note'),
  form: document.getElementById('pin-form'),
  pin: document.getElementById('pin'),
  go: document.getElementById('pin-go'),
  board: document.getElementById('board'),
  venue: document.getElementById('venue'),
  date: document.getElementById('date'),
  counts: document.getElementById('counts'),
  note: document.getElementById('note'),
  list: document.getElementById('list'),
  refresh: document.getElementById('refresh'),
  out: document.getElementById('out'),
};

const state = { token: null, busy: false, jobs: [] };

function token() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // Private browsing, or storage switched off. The shift then lasts as long
    // as the tab does, which is a worse experience and not a broken one.
    return state.token;
  }
}

function remember(value) {
  state.token = value;
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* held in memory above */
  }
}

async function call(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token() ? { Authorization: `Shift ${token()}` } : {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || 'Something went wrong.');
    error.status = res.status;
    error.signedOut = Boolean(data.signedOut);
    throw error;
  }
  return data;
}

/* ------------------------------------------------------------------ views */

function showGate(message) {
  el.board.hidden = true;
  el.gate.hidden = false;
  el.gateNote.textContent = message || '';
  el.pin.value = '';
  el.pin.focus();
}

function showBoard() {
  el.gate.hidden = true;
  el.board.hidden = false;
}

/** The date as somebody says it out loud, not as it is stored. */
function stamp(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function draw(board) {
  state.jobs = board.jobs;
  el.venue.textContent = board.venue || 'Housekeeping';
  el.date.textContent = stamp(board.date);

  const c = board.counts;
  el.counts.textContent = c.due
    ? `${c.due} to do before tonight · ${c.dirty} dirty of ${c.rooms}`
    : `Nothing due before tonight · ${c.dirty} dirty of ${c.rooms}`;
  el.counts.classList.toggle('due', c.due > 0);

  el.list.replaceChildren();

  for (const job of board.jobs) {
    const li = document.createElement('li');
    li.className = `hk-job ${job.kind}${job.dirty ? ' dirty' : ' done'}`;

    const main = document.createElement('div');
    main.className = 'hk-main';

    const name = document.createElement('b');
    name.className = 'hk-room';
    name.textContent = job.room;
    main.append(name);

    const what = document.createElement('span');
    what.className = 'hk-what';
    what.textContent = job.type ? `${job.label} · ${job.type}` : job.label;
    main.append(what);

    if (job.guests) {
      const who = document.createElement('span');
      who.className = 'hk-guests';
      who.textContent = job.guests === 1 ? '1 guest' : `${job.guests} guests`;
      main.append(who);
    }

    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'hk-mark';
    mark.dataset.room = String(job.roomId);
    mark.dataset.state = job.dirty ? 'clean' : 'dirty';
    mark.setAttribute('aria-pressed', String(!job.dirty));
    mark.textContent = job.dirty ? 'Mark clean' : '✓ Clean';

    li.append(main, mark);
    el.list.append(li);
  }
}

/* ----------------------------------------------------------------- actions */

async function load() {
  if (!token()) return showGate();
  try {
    draw(await call('/api/housekeeping/board'));
    showBoard();
    el.note.textContent = '';
  } catch (err) {
    if (err.signedOut || err.status === 401) {
      remember(null);
      showGate(err.message === 'shift ended' ? 'That shift has ended. Enter the PIN again.' : '');
      return;
    }
    showBoard();
    el.note.textContent = err.message;
  }
}

async function mark(button) {
  if (state.busy) return;
  const wanted = button.dataset.state;

  // Moves at once and goes back if the server disagrees. Somebody working
  // through twenty rooms should not wait on a round trip for each.
  const before = button.textContent;
  button.textContent = wanted === 'clean' ? '✓ Clean' : 'Mark clean';
  button.dataset.state = wanted === 'clean' ? 'dirty' : 'clean';
  button.setAttribute('aria-pressed', String(wanted === 'clean'));
  button.closest('.hk-job')?.classList.toggle('dirty', wanted !== 'clean');
  button.closest('.hk-job')?.classList.toggle('done', wanted === 'clean');

  state.busy = true;
  try {
    await call(`/api/housekeeping/rooms/${button.dataset.room}`, {
      method: 'POST',
      body: JSON.stringify({ state: wanted }),
    });
    el.note.textContent = '';
  } catch (err) {
    button.textContent = before;
    button.dataset.state = wanted;
    button.closest('.hk-job')?.classList.toggle('dirty', wanted === 'clean');
    button.closest('.hk-job')?.classList.toggle('done', wanted !== 'clean');
    if (err.signedOut || err.status === 401) {
      remember(null);
      return showGate('That shift has ended. Enter the PIN again.');
    }
    el.note.textContent = err.message;
  } finally {
    state.busy = false;
  }
}

el.list.addEventListener('click', (e) => {
  const button = e.target.closest('.hk-mark');
  if (button) void mark(button);
});

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = el.pin.value.trim();
  if (!pin) return;

  el.go.disabled = true;
  el.gateNote.textContent = '';
  try {
    const started = await call('/api/housekeeping/shift', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    });
    remember(started.token);
    el.gateVenue.textContent = started.venue || 'Housekeeping';
    await load();
  } catch (err) {
    el.gateNote.textContent = err.message;
    el.pin.value = '';
    el.pin.focus();
  } finally {
    el.go.disabled = false;
  }
});

el.refresh.addEventListener('click', () => void load());
el.out.addEventListener('click', () => {
  remember(null);
  showGate('');
});

// A board left open on a trolley all morning is a board showing breakfast's
// answer at lunchtime. Refreshed when the phone comes back to it, which is
// when somebody is about to read it.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !el.board.hidden) void load();
});

void load();
