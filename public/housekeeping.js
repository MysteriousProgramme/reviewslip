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

    /*
     * How far through the list, when there is one.
     *
     * Nothing at all when the venue has written no standard for this type —
     * "0 of 0" is a number about an absence and reads as work outstanding.
     */
    if (job.checks && job.checks.total) {
      const done = document.createElement('span');
      done.className = `hk-progress${job.checks.all ? ' all' : ''}`;
      done.textContent = `${job.checks.done}/${job.checks.total}`;
      main.append(done);
    }

    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'hk-mark';
    mark.dataset.room = String(job.roomId);
    mark.dataset.state = job.dirty ? 'clean' : 'dirty';
    mark.setAttribute('aria-pressed', String(!job.dirty));
    mark.textContent = job.dirty ? 'Mark clean' : '✓ Clean';

    const row = document.createElement('div');
    row.className = 'hk-row';
    row.append(main, mark);
    li.append(row);

    /*
     * The list opens under the room rather than on its own screen.
     *
     * A housekeeper standing in the doorway wants the room and the list at
     * once; a second screen means going back to find out which room they were
     * in. Fetched on the first open, because the board draws twenty rooms and
     * a dozen lines each is most of a payload nobody has asked for.
     */
    if (job.checks && job.checks.total) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'hk-open';
      open.dataset.room = String(job.roomId);
      open.setAttribute('aria-expanded', 'false');
      open.textContent = 'What to do';
      li.append(open);

      const panel = document.createElement('div');
      panel.className = 'hk-checks';
      panel.dataset.for = String(job.roomId);
      panel.hidden = true;
      li.append(panel);
    }

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

/* ------------------------------------------------------------- the checklist */

function drawChecks(panel, data) {
  panel.replaceChildren();

  const list = document.createElement('ul');
  list.className = 'hk-items';

  for (const item of data.items) {
    const li = document.createElement('li');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `hk-item${item.done ? ' done' : ''}`;
    button.dataset.item = String(item.id);
    button.dataset.room = panel.dataset.for;
    button.setAttribute('aria-pressed', String(item.done));

    const box = document.createElement('span');
    box.className = 'hk-box';
    box.setAttribute('aria-hidden', 'true');
    box.textContent = item.done ? '✓' : '';

    const label = document.createElement('span');
    label.textContent = item.label;

    button.append(box, label);
    li.append(button);
    list.append(li);
  }

  panel.append(list);
}

/** The counter on the room's own row, kept in step without a reload. */
function retally(roomId) {
  const panel = el.list.querySelector(`.hk-checks[data-for="${roomId}"]`);
  const li = panel?.closest('.hk-job');
  const tally = li?.querySelector('.hk-progress');
  if (!panel || !tally) return;

  const items = [...panel.querySelectorAll('.hk-item')];
  const done = items.filter((i) => i.classList.contains('done')).length;
  tally.textContent = `${done}/${items.length}`;
  tally.classList.toggle('all', items.length > 0 && done === items.length);
}

async function openChecks(button) {
  const roomId = button.dataset.room;
  const panel = el.list.querySelector(`.hk-checks[data-for="${roomId}"]`);
  if (!panel) return;

  const showing = !panel.hidden;
  panel.hidden = showing;
  button.setAttribute('aria-expanded', String(!showing));
  button.textContent = showing ? 'What to do' : 'Hide';
  if (showing || panel.dataset.loaded === 'yes') return;

  panel.textContent = 'Loading…';
  try {
    const data = await call(`/api/housekeeping/rooms/${roomId}/checklist`);
    drawChecks(panel, data);
    panel.dataset.loaded = 'yes';
  } catch (err) {
    if (err.signedOut || err.status === 401) {
      remember(null);
      return showGate('That shift has ended. Enter the PIN again.');
    }
    panel.textContent = err.message;
  }
}

async function tick(button) {
  const done = !button.classList.contains('done');

  // Moves under the thumb and goes back if the server disagrees. Somebody
  // working down a list of twelve should not wait on a round trip for each.
  button.classList.toggle('done', done);
  button.setAttribute('aria-pressed', String(done));
  button.querySelector('.hk-box').textContent = done ? '✓' : '';
  retally(button.dataset.room);

  try {
    await call(
      `/api/housekeeping/rooms/${button.dataset.room}/checklist/${button.dataset.item}`,
      { method: 'POST', body: JSON.stringify({ done }) }
    );
    el.note.textContent = '';
  } catch (err) {
    button.classList.toggle('done', !done);
    button.setAttribute('aria-pressed', String(!done));
    button.querySelector('.hk-box').textContent = !done ? '✓' : '';
    retally(button.dataset.room);
    if (err.signedOut || err.status === 401) {
      remember(null);
      return showGate('That shift has ended. Enter the PIN again.');
    }
    el.note.textContent = err.message;
  }
}

el.list.addEventListener('click', (e) => {
  const item = e.target.closest('.hk-item');
  if (item) return void tick(item);

  const open = e.target.closest('.hk-open');
  if (open) return void openChecks(open);

  const button = e.target.closest('.hk-mark');
  if (button) void mark(button);
});

// Typed, pasted or dictated — only digits reach the box.
el.pin.addEventListener('input', () => {
  const cleaned = el.pin.value.replace(/\D/g, '').slice(0, 6);
  if (cleaned !== el.pin.value) el.pin.value = cleaned;
});

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // Digits only, six of them. The field is filtered as it is typed so a
  // paste of "PIN: 482913" cannot be submitted as-is and refused by the
  // server for a reason nobody can see from a corridor.
  const pin = el.pin.value.replace(/\D/g, '').slice(0, 6);
  el.pin.value = pin;
  if (pin.length !== 6) {
    el.gateNote.textContent = 'The PIN is six digits.';
    return;
  }

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
