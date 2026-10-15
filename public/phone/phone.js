/*
 * The Reviewslip phone: go on duty, ring when a guest presses Call, answer in
 * the browser, and listen to the messages left when nobody could.
 *
 * Signed in by the rs_phone cookie (voicerouter.js). A venue's owner arrives
 * from the dashboard with a one-time #handoff token; invited staff arrive with
 * #invite and set a password, then sign in with it.
 *
 * Duty is kept by the server, so a reload, a closed tab or a dropped network
 * never takes anyone off duty — only the button does, or signing out.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------- words */

  var WORDS = {
    en: {
      brand: 'Reviewslip Phone', signOut: 'Sign out', signInTitle: 'Sign in to answer calls',
      signInNote: 'Staff a venue invited sign in here. Venue owners open the phone from their dashboard.',
      email: 'Email', password: 'Password', signIn: 'Sign in', newPassword: 'Choose a password',
      start: 'Start answering calls', inviteTitle: 'Hello {name}', inviteNote: 'Set a password to answer calls for {venues}.',
      tapForSound: 'Tap anywhere to turn the ringtone on', mute: 'Mute', unmute: 'Unmute', hangUp: 'Hang up',
      goOn: 'Go on duty', goOff: 'Go off duty', onDuty: 'On duty', offDuty: 'Off duty',
      onNote: 'This page rings when a guest calls. Keep it open, or turn on ringing below.',
      offNote: 'Calls will not ring here. Guests can still leave a message.',
      reconnecting: 'Reconnecting…', takingFor: 'Taking calls for', pushTitle: 'Ring this phone when the page is closed',
      pushOn: 'On for this device', pushOff: 'Turn on', pushOffNow: 'Turn off', pushBlocked: 'Notifications are blocked in this browser’s settings.',
      pushIos: 'On iPhone, add this page to the Home Screen first (Share › Add to Home Screen).',
      pushHelp: 'A notification rings even when this page is closed.', voicemail: 'Voicemail', recent: 'Recent calls',
      hours: 'My hours', noVoicemail: 'No messages.', noCalls: 'No calls yet.',
      hoursNote: 'Tick the days you work. With no day ticked, this phone rings whenever you are on duty.',
      timezone: 'Time zone', save: 'Save', saved: 'Saved', incoming: 'Incoming call', aGuest: 'A guest',
      answer: 'Answer', decline: 'Decline', reservations: 'Reservations', frontDesk: 'Front desk', sales: 'Sales', support: 'Support',
      fromPage: 'From {page}', taken: '{name} answered', gone: 'Someone else answered first.', micBlocked: 'The microphone is blocked. Allow it for this page to answer.',
      callFailed: 'The call could not connect.', newTag: 'New', heardBy: 'Heard by {name}', heard: 'Heard', markUnheard: 'Mark unheard',
      noContact: 'No number or email left.', answered: 'Answered by {name}', missed: 'Missed', abandoned: 'Hung up while ringing',
      leftMessage: 'Left a message', live: 'In progress', confirmSignOut: 'Signing out ends the call. Sign out?',
      days: 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', to: 'to', lang: 'ภาษาไทย', expired: 'Your sign-in has ended. Sign in again.',
      nightShift: 'Ends the next morning',
    },
    th: {
      brand: 'Reviewslip Phone', signOut: 'ออกจากระบบ', signInTitle: 'เข้าสู่ระบบเพื่อรับสาย',
      signInNote: 'พนักงานที่ได้รับเชิญเข้าสู่ระบบที่นี่ เจ้าของที่พักเปิดโทรศัพท์จากแดชบอร์ด',
      email: 'อีเมล', password: 'รหัสผ่าน', signIn: 'เข้าสู่ระบบ', newPassword: 'ตั้งรหัสผ่าน',
      start: 'เริ่มรับสาย', inviteTitle: 'สวัสดี {name}', inviteNote: 'ตั้งรหัสผ่านเพื่อรับสายของ {venues}',
      tapForSound: 'แตะที่ใดก็ได้เพื่อเปิดเสียงเรียกเข้า', mute: 'ปิดไมค์', unmute: 'เปิดไมค์', hangUp: 'วางสาย',
      goOn: 'เริ่มเข้ากะ', goOff: 'ออกจากกะ', onDuty: 'อยู่ในกะ', offDuty: 'ไม่อยู่ในกะ',
      onNote: 'หน้านี้จะดังเมื่อมีแขกโทรเข้า เปิดหน้านี้ไว้ หรือเปิดการแจ้งเตือนด้านล่าง',
      offNote: 'สายจะไม่ดังที่นี่ แขกยังฝากข้อความได้',
      reconnecting: 'กำลังเชื่อมต่อใหม่…', takingFor: 'รับสายของ', pushTitle: 'ให้โทรศัพท์ดังแม้ปิดหน้านี้',
      pushOn: 'เปิดแล้วบนอุปกรณ์นี้', pushOff: 'เปิด', pushOffNow: 'ปิด', pushBlocked: 'การแจ้งเตือนถูกบล็อกในการตั้งค่าเบราว์เซอร์',
      pushIos: 'บน iPhone ให้เพิ่มหน้านี้ไปที่หน้าจอโฮมก่อน (แชร์ › เพิ่มไปยังหน้าจอโฮม)',
      pushHelp: 'การแจ้งเตือนจะดังแม้ปิดหน้านี้อยู่', voicemail: 'ข้อความเสียง', recent: 'สายล่าสุด',
      hours: 'เวลาทำงาน', noVoicemail: 'ไม่มีข้อความ', noCalls: 'ยังไม่มีสาย',
      hoursNote: 'เลือกวันที่ทำงาน ถ้าไม่เลือกวันใดเลย โทรศัพท์จะดังทุกครั้งที่อยู่ในกะ',
      timezone: 'เขตเวลา', save: 'บันทึก', saved: 'บันทึกแล้ว', incoming: 'สายเรียกเข้า', aGuest: 'แขก',
      answer: 'รับสาย', decline: 'ปฏิเสธ', reservations: 'ฝ่ายจองห้องพัก', frontDesk: 'แผนกต้อนรับ', sales: 'ฝ่ายขาย', support: 'ฝ่ายบริการลูกค้า',
      fromPage: 'จาก {page}', taken: '{name} รับสายแล้ว', gone: 'มีคนรับสายไปก่อนแล้ว', micBlocked: 'ไมโครโฟนถูกบล็อก โปรดอนุญาตให้หน้านี้ใช้ไมโครโฟน',
      callFailed: 'ไม่สามารถเชื่อมต่อสายได้', newTag: 'ใหม่', heardBy: '{name} ฟังแล้ว', heard: 'ฟังแล้ว', markUnheard: 'ทำเป็นยังไม่ฟัง',
      noContact: 'ไม่ได้ฝากเบอร์หรืออีเมล', answered: '{name} รับสาย', missed: 'ไม่ได้รับ', abandoned: 'วางสายขณะรอ',
      leftMessage: 'ฝากข้อความ', live: 'กำลังสนทนา', confirmSignOut: 'การออกจากระบบจะวางสาย ต้องการออกจากระบบหรือไม่',
      days: 'จ.,อ.,พ.,พฤ.,ศ.,ส.,อา.', to: 'ถึง', lang: 'English', expired: 'หมดเวลาเข้าสู่ระบบ โปรดเข้าสู่ระบบอีกครั้ง',
      nightShift: 'สิ้นสุดเช้าวันถัดไป',
    },
  };

  function readLang() {
    try {
      var saved = localStorage.getItem('rs-phone-lang');
      if (saved && WORDS[saved]) return saved;
    } catch (e) { /* private mode */ }
    return /^th/i.test(navigator.language || '') ? 'th' : 'en';
  }
  var LANG = readLang();

  function t(key, vars) {
    var text = (WORDS[LANG] && WORDS[LANG][key]) || WORDS.en[key] || key;
    if (vars) Object.keys(vars).forEach(function (k) { text = text.split('{' + k + '}').join(vars[k]); });
    return text;
  }

  function paintWords() {
    document.documentElement.lang = LANG;
    Array.prototype.forEach.call(document.querySelectorAll('[data-t]'), function (node) {
      node.textContent = t(node.getAttribute('data-t'));
    });
    $('lang-toggle').textContent = t('lang');
  }

  /* ----------------------------------------------------------- helpers */

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch('/api/voice' + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && path !== '/login' && path !== '/handoff' && path !== '/invite') {
          showLogin(t('expired'));
          throw new Error(t('expired'));
        }
        if (!r.ok) throw new Error(d.error || 'Something went wrong.');
        return d;
      });
    });
  }

  function clock(seconds) {
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function when(iso) {
    var d = new Date(iso);
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    var locale = LANG === 'th' ? 'th-TH' : undefined;
    return sameDay
      ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function desk(call) {
    if (call.venue) return call.team === 'support' ? t('frontDesk') : t('reservations');
    return call.team === 'support' ? t('support') : t('sales');
  }

  /** A message at the top of the phone for a few seconds: no dialog to dismiss mid-call. */
  var flashTimer = null;
  function flash(message) {
    var box = $('flash');
    box.textContent = message;
    box.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { box.hidden = true; }, 8000);
  }

  function show(id) {
    ['view-login', 'view-invite', 'view-phone'].forEach(function (v) { $(v).hidden = v !== id; });
    $('menu').hidden = id !== 'view-phone';
  }

  /* ------------------------------------------------------------- state */

  var me = null;
  var ws = null;
  var wsTries = 0;
  var wsTimer = null;
  var ice = [];
  var rings = {};
  var active = null;
  var vmCache = [];

  /* ------------------------------------------------------------- sound */

  var audioCtx = null;
  var unlocked = false;

  function unlock() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    unlocked = true;
    $('sound-banner').hidden = true;
  }

  // On click, not pointerdown: the banner goes as the tap ends, so nothing
  // under the finger moves before the tap lands.
  document.addEventListener('click', unlock, true);
  document.addEventListener('keydown', unlock, true);

  var ringTimer = null;

  /** Two short bursts every three seconds, while anything rings. */
  function ringtone(on) {
    clearTimeout(ringTimer);
    if (!on) return;
    function burst() {
      if (audioCtx && audioCtx.state === 'running') {
        [0, 0.45].forEach(function (offset) {
          var start = audioCtx.currentTime + offset;
          var gain = audioCtx.createGain();
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
          gain.gain.setValueAtTime(0.25, start + 0.35);
          gain.gain.linearRampToValueAtTime(0, start + 0.4);
          gain.connect(audioCtx.destination);
          [440, 480].forEach(function (f) {
            var osc = audioCtx.createOscillator();
            osc.frequency.value = f;
            osc.connect(gain);
            osc.start(start);
            osc.stop(start + 0.42);
          });
        });
      }
      if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
      ringTimer = setTimeout(burst, 3000);
    }
    burst();
  }

  /* ------------------------------------------------------------ sign-in */

  function showLogin(message) {
    stopSocket();
    show('view-login');
    var err = $('login-error');
    err.textContent = message || '';
    err.hidden = !message;
  }

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target;
    var err = $('login-error');
    err.hidden = true;
    api('/login', { method: 'POST', body: { email: form.email.value, password: form.password.value } })
      .then(load)
      .catch(function (x) { err.textContent = x.message; err.hidden = false; });
  });

  var inviteToken = '';
  $('invite-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('invite-error');
    err.hidden = true;
    api('/invite', { method: 'POST', body: { token: inviteToken, password: e.target.password.value } })
      .then(load)
      .catch(function (x) { err.textContent = x.message; err.hidden = false; });
  });

  $('menu-button').addEventListener('click', function () {
    var list = $('menu-list');
    list.hidden = !list.hidden;
    $('menu-button').setAttribute('aria-expanded', String(!list.hidden));
  });

  document.addEventListener('click', function (e) {
    if (!$('menu').contains(e.target)) {
      $('menu-list').hidden = true;
      $('menu-button').setAttribute('aria-expanded', 'false');
    }
  });

  $('lang-toggle').addEventListener('click', function () {
    LANG = LANG === 'th' ? 'en' : 'th';
    try { localStorage.setItem('rs-phone-lang', LANG); } catch (e) { /* private mode */ }
    paintWords();
    if (me) paintAll();
  });

  $('sign-out').addEventListener('click', function () {
    if (active && !window.confirm(t('confirmSignOut'))) return;
    endCall(true);
    api('/logout', { method: 'POST' }).catch(function () {}).then(function () {
      me = null;
      showLogin();
    });
  });

  /* --------------------------------------------------------------- load */

  function load() {
    return api('/me').then(function (data) {
      me = data;
      show('view-phone');
      $('me-name').textContent = me.agent.name;
      $('me-email').textContent = me.agent.email;
      $('avatar').textContent = (me.agent.name || '?').trim().charAt(0).toUpperCase();
      $('sound-banner').hidden = unlocked;
      paintAll();
      loadVoicemail();
      if (me.agent.onDuty) startSocket();
      registerWorker();
    });
  }

  function paintAll() {
    paintDuty();
    paintLines();
    paintPush();
    paintHours();
    paintVoicemail();
  }

  /* --------------------------------------------------------------- duty */

  function paintDuty() {
    var on = me.agent.onDuty;
    var live = ws && ws.readyState === 1;
    $('duty-dot').dataset.state = on ? (live ? 'on' : 'away') : 'off';
    $('duty-title').textContent = on ? t('onDuty') : t('offDuty');
    $('duty-note').textContent = on ? (live ? t('onNote') : t('reconnecting')) : t('offNote');
    $('duty-on').hidden = on;
    $('duty-off').hidden = !on;
  }

  function setDuty(on) {
    unlock();
    api('/duty', { method: 'PUT', body: { on: on } }).then(function () {
      me.agent.onDuty = on;
      if (on) startSocket();
      else stopSocket();
      paintDuty();
    }).catch(function (x) { flash(x.message); });
  }

  $('duty-on').addEventListener('click', function () { setDuty(true); });
  $('duty-off').addEventListener('click', function () { setDuty(false); });

  function paintLines() {
    var box = $('lines-list');
    box.innerHTML = '';
    $('lines').hidden = me.lines.length < 2;
    me.lines.forEach(function (line) {
      var input = el('input', { type: 'checkbox', value: line.key });
      input.checked = line.taking;
      input.addEventListener('change', saveLines);
      box.appendChild(el('label', {}, [input, line.name]));
    });
  }

  function saveLines() {
    var off = Array.prototype.filter
      .call($('lines-list').querySelectorAll('input'), function (i) { return !i.checked; })
      .map(function (i) { return i.value; });
    api('/lines', { method: 'PUT', body: { off: off } })
      .then(function (d) { me.lines = d.lines; paintLines(); })
      .catch(function (x) { flash(x.message); paintLines(); });
  }

  /* ------------------------------------------------------------- socket */

  function startSocket() {
    if (ws && ws.readyState <= 1) return;
    clearTimeout(wsTimer);
    ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/voice/ws?as=agent');
    ws.onopen = function () {
      wsTries = 0;
      sendVisibility();
      paintDuty();
    };
    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (x) { return; }
      onMessage(msg);
    };
    ws.onclose = function (e) {
      ws = null;
      if (active) endCall(false, t('callFailed'));
      clearRings();
      paintDuty();
      if (e.code === 1008 || !me || !me.agent.onDuty) return;
      // A refused upgrade is a session that ended; ask once before retrying.
      wsTries += 1;
      var wait = Math.min(15000, 1000 * Math.pow(2, Math.min(wsTries, 4)));
      wsTimer = setTimeout(function () {
        api('/me').then(function (d) { me = d; if (me.agent.onDuty) startSocket(); paintDuty(); }).catch(function () {});
      }, wait);
    };
  }

  function stopSocket() {
    clearTimeout(wsTimer);
    if (ws) {
      var old = ws;
      ws = null;
      old.onclose = null;
      old.close();
    }
    clearRings();
  }

  function sendWs(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function sendVisibility() {
    sendWs({ t: 'visibility', hidden: document.visibilityState === 'hidden' });
  }
  document.addEventListener('visibilitychange', function () {
    sendVisibility();
    if (document.visibilityState === 'visible' && me) loadVoicemail();
  });

  function onMessage(msg) {
    if (msg.t === 'hello') {
      ice = msg.ice || [];
    } else if (msg.t === 'ring') {
      rings[msg.call.id] = msg.call;
      paintRings();
      notify(msg.call);
    } else if (msg.t === 'cancelled' || msg.t === 'taken') {
      dropRing(msg.callId);
      if (msg.t === 'cancelled') setTimeout(loadVoicemail, 4000);
    } else if (msg.t === 'gone') {
      dropRing(msg.callId);
      if (active && active.id === msg.callId) endCall(false, t('gone'));
    } else if (msg.t === 'won') {
      if (active && active.id === msg.callId) {
        ice = msg.ice || ice;
        connectCall();
      }
    } else if (msg.t === 'signal') {
      onSignal(msg.data);
    } else if (msg.t === 'ended') {
      if (active && active.id === msg.callId) endCall(false);
    }
  }

  /* -------------------------------------------------------------- rings */

  function clearRings() {
    rings = {};
    paintRings();
  }

  function dropRing(id) {
    delete rings[id];
    closeNotification(id);
    paintRings();
  }

  function paintRings() {
    var box = $('rings');
    box.innerHTML = '';
    var list = Object.keys(rings).map(function (k) { return rings[k]; })
      .sort(function (a, b) { return a.startedAt - b.startedAt; });
    // Not while on a call: one call at a time, and the server rings someone
    // else while you talk.
    if (active) list = [];
    list.forEach(function (call, i) {
      var who = call.caller || t('aGuest');
      var card = el('section', { class: 'card ring' + (i ? ' later' : '') }, [
        el('p', { class: 'eyebrow', text: t('incoming') + ' · ' + call.title + ' · ' + desk(call) }),
        el('h2', { text: who }),
        call.page ? el('p', { class: 'muted small', text: t('fromPage', { page: call.page }) }) : null,
        el('div', { class: 'row' }, [
          el('button', { type: 'button', class: 'btn ' + (i ? '' : 'round ') + 'danger', text: t('decline'), onclick: function () { decline(call.id); } }),
          el('button', { type: 'button', class: 'btn ' + (i ? '' : 'round ') + 'answer', text: t('answer'), onclick: function () { answer(call); } }),
        ]),
      ]);
      box.appendChild(card);
    });
    ringtone(list.length > 0 && !active);
    document.title = list.length ? '📞 ' + t('incoming') + ' — ' + t('brand') : t('brand');
  }

  function decline(id) {
    sendWs({ t: 'decline', callId: id });
    dropRing(id);
  }

  /* --------------------------------------------------------------- call */

  function answer(call) {
    unlock();
    ringtone(false);
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        active = { id: call.id, call: call, stream: stream, pc: null, queued: [], since: null, timer: null, muted: false };
        delete rings[call.id];
        closeNotification(call.id);
        paintRings();
        paintCall(t('reconnecting'));
        sendWs({ t: 'answer', callId: call.id });
      })
      .catch(function () {
        flash(t('micBlocked'));
        paintRings();
      });
  }

  function connectCall() {
    var a = active;
    var pc = new RTCPeerConnection({ iceServers: ice });
    a.pc = pc;
    a.stream.getTracks().forEach(function (tr) { pc.addTrack(tr, a.stream); });
    var audio = el('audio', { autoplay: '' });
    audio.style.display = 'none';
    document.body.appendChild(audio);
    a.audio = audio;
    pc.ontrack = function (e) { audio.srcObject = e.streams[0]; audio.play().catch(function () {}); };
    pc.onicecandidate = function (e) {
      if (e.candidate) sendWs({ t: 'signal', callId: a.id, data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'connected' && !a.since) {
        a.since = Date.now();
        a.timer = setInterval(function () {
          $('call-time').textContent = clock(Math.round((Date.now() - a.since) / 1000));
        }, 1000);
        $('call-time').textContent = '0:00';
      } else if (pc.connectionState === 'failed') {
        endCall(true, t('callFailed'));
      }
    };
  }

  function onSignal(data) {
    var a = active;
    if (!a || !a.pc || !data) return;
    if (data.sdp) {
      a.pc.setRemoteDescription(data.sdp)
        .then(function () {
          a.queued.forEach(function (c) { a.pc.addIceCandidate(c).catch(function () {}); });
          a.queued = [];
          if (data.sdp.type === 'offer') {
            return a.pc.createAnswer().then(function (ans) { return a.pc.setLocalDescription(ans); }).then(function () {
              sendWs({ t: 'signal', callId: a.id, data: { sdp: a.pc.localDescription } });
            });
          }
        })
        .catch(function () { endCall(true, t('callFailed')); });
    } else if (data.candidate) {
      if (a.pc.remoteDescription) a.pc.addIceCandidate(data.candidate).catch(function () {});
      else a.queued.push(data.candidate);
    }
  }

  function paintCall(status) {
    var a = active;
    $('call').hidden = !a;
    if (!a) return;
    $('call-line').textContent = a.call.title + ' · ' + desk(a.call);
    $('call-who').textContent = a.call.caller || t('aGuest');
    $('call-time').textContent = status || (a.since ? clock(Math.round((Date.now() - a.since) / 1000)) : '');
    $('mute').textContent = a.muted ? t('unmute') : t('mute');
    $('mute').setAttribute('aria-pressed', String(a.muted));
  }

  function endCall(tellServer, message) {
    var a = active;
    if (!a) return;
    if (tellServer) sendWs({ t: 'hangup', callId: a.id });
    active = null;
    clearInterval(a.timer);
    if (a.pc) try { a.pc.close(); } catch (e) { /* closed */ }
    if (a.stream) a.stream.getTracks().forEach(function (tr) { tr.stop(); });
    if (a.audio) a.audio.remove();
    paintCall();
    paintRings();
    if (message) flash(message);
    if (!$('panel-calls').hidden) loadCalls();
  }

  $('hang-up').addEventListener('click', function () { endCall(true); });
  $('mute').addEventListener('click', function () {
    if (!active) return;
    active.muted = !active.muted;
    active.stream.getAudioTracks().forEach(function (tr) { tr.enabled = !active.muted; });
    paintCall();
  });

  window.addEventListener('beforeunload', function (e) {
    if (active) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ------------------------------------------------- notifications, push */

  var worker = null;

  function registerWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/phone/sw.js', { scope: '/phone/' }).then(function (reg) {
      worker = reg;
      paintPush();
    }).catch(function () { /* push stays off */ });
  }

  /** The page's own ring when it is open but behind other windows. */
  function notify(call) {
    if (document.visibilityState === 'visible' || !worker || !window.Notification || Notification.permission !== 'granted') return;
    worker.showNotification(t('incoming'), {
      body: (call.caller || t('aGuest')) + ' · ' + call.title,
      tag: 'call-' + call.id,
      renotify: true,
      requireInteraction: true,
      icon: '/phone/icon.svg',
      data: { url: '/phone/?call=' + call.id },
    }).catch(function () {});
  }

  function closeNotification(id) {
    if (!worker || !worker.getNotifications) return;
    worker.getNotifications({ tag: 'call-' + id }).then(function (list) {
      list.forEach(function (n) { n.close(); });
    }).catch(function () {});
  }

  function urlKey(base64) {
    var pad = '='.repeat((4 - (base64.length % 4)) % 4);
    var raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function paintPush() {
    var box = $('push');
    var note = $('push-note');
    var btn = $('push-button');
    if (!me || !me.pushKey) { box.hidden = true; return; }
    box.hidden = false;
    var ios = /iPhone|iPad/.test(navigator.userAgent) && !window.navigator.standalone;
    if (!('PushManager' in window) || !worker) {
      note.textContent = ios ? t('pushIos') : t('pushHelp');
      btn.hidden = true;
      return;
    }
    if (window.Notification && Notification.permission === 'denied') {
      note.textContent = t('pushBlocked');
      btn.hidden = true;
      return;
    }
    worker.pushManager.getSubscription().then(function (sub) {
      btn.hidden = false;
      note.textContent = sub ? t('pushOn') : t('pushHelp');
      btn.textContent = sub ? t('pushOffNow') : t('pushOff');
      btn.onclick = function () {
        btn.disabled = true;
        var done = function () { btn.disabled = false; paintPush(); };
        if (sub) {
          var endpoint = sub.endpoint;
          sub.unsubscribe().then(function () {
            return api('/push', { method: 'DELETE', body: { endpoint: endpoint } });
          }).catch(function () {}).then(done);
        } else {
          Notification.requestPermission().then(function (perm) {
            if (perm !== 'granted') return;
            return worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(me.pushKey) })
              .then(function (s) { return api('/push', { method: 'POST', body: { subscription: s.toJSON() } }); });
          }).catch(function (x) { flash(x.message); }).then(done);
        }
      };
    });
  }

  /* ---------------------------------------------------------- voicemail */

  function loadVoicemail() {
    return api('/voicemails').then(function (d) {
      vmCache = d.voicemails;
      paintVoicemail();
    }).catch(function () {});
  }

  function paintVoicemail() {
    var list = $('vm-list');
    list.innerHTML = '';
    var fresh = vmCache.filter(function (v) { return !v.heard; }).length;
    $('vm-count').hidden = !fresh;
    $('vm-count').textContent = String(fresh);
    $('vm-empty').hidden = vmCache.length > 0;
    vmCache.forEach(function (v) {
      var audio = el('audio', { controls: '', preload: 'none', src: '/api/voice/voicemails/' + v.id + '/audio' });
      audio.addEventListener('play', function () {
        if (!v.heard) {
          api('/voicemails/' + v.id + '/heard', { method: 'POST', body: { heard: true } })
            .then(function (d) { vmCache = d.voicemails; paintVoicemail(); })
            .catch(function () {});
        }
      }, { once: true });
      var contact = v.contact
        ? contactLink(v.contact)
        : el('span', { class: 'muted small', text: t('noContact') });
      var status = v.heard
        ? el('span', { class: 'tag', text: v.heardBy ? t('heardBy', { name: v.heardBy }) : t('heard') })
        : el('span', { class: 'tag new', text: t('newTag') });
      list.appendChild(el('li', {}, [
        el('div', { class: 'item-top' }, [
          el('span', { text: v.line + ' · ' + clock(v.seconds) }),
          el('span', { text: when(v.at) }),
        ]),
        el('div', { class: 'row' }, [el('span', { class: 'item-who', text: v.caller || t('aGuest') }), status]),
        contact,
        audio,
        v.heard
          ? el('div', {}, [el('button', { type: 'button', class: 'btn link small', text: t('markUnheard'), onclick: function () {
              api('/voicemails/' + v.id + '/heard', { method: 'POST', body: { heard: false } })
                .then(function (d) { vmCache = d.voicemails; paintVoicemail(); })
                .catch(function () {});
            } })])
          : null,
      ]));
    });
  }

  function contactLink(value) {
    var email = /\S+@\S+\.\S+/.test(value);
    var digits = value.replace(/[^\d+]/g, '');
    if (email) return el('a', { href: 'mailto:' + value.trim(), text: value });
    if (digits.length >= 6) return el('a', { href: 'tel:' + digits, text: value });
    return el('span', { text: value });
  }

  /* -------------------------------------------------------------- calls */

  function loadCalls() {
    api('/calls').then(function (d) {
      var list = $('call-list');
      list.innerHTML = '';
      $('calls-empty').hidden = d.calls.length > 0;
      d.calls.forEach(function (c) {
        var outcome =
          c.outcome === 'answered' ? t('answered', { name: c.answeredBy }) + (c.seconds != null ? ' · ' + clock(c.seconds) : '')
            : c.outcome === 'voicemail' ? t('leftMessage')
            : c.outcome === 'abandoned' ? t('abandoned')
            : c.outcome === 'live' ? t('live')
            : t('missed');
        list.appendChild(el('li', {}, [
          el('div', { class: 'item-top' }, [el('span', { text: c.line + ' · ' + desk(c) }), el('span', { text: when(c.startedAt) })]),
          el('span', { class: 'item-who', text: c.caller || t('aGuest') }),
          el('span', { class: 'muted small', text: outcome + (c.page ? ' · ' + c.page : '') }),
        ]));
      });
    }).catch(function () {});
  }

  /* -------------------------------------------------------------- hours */

  var ZONES = ['Asia/Bangkok', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Jakarta', 'Asia/Ho_Chi_Minh', 'Asia/Manila',
    'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Dubai', 'Australia/Sydney',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC'];

  function paintHours() {
    var days = t('days').split(',');
    var box = $('hours-days');
    box.innerHTML = '';
    for (var d = 1; d <= 7; d++) {
      var shift = (me.hours || []).filter(function (h) { return h.day === d; })[0];
      var check = el('input', { type: 'checkbox', 'data-day': String(d) });
      check.checked = Boolean(shift);
      var from = el('input', { type: 'time', 'data-from': String(d), value: shift ? shift.from : '09:00', 'aria-label': days[d - 1] + ' from' });
      var to = el('input', { type: 'time', 'data-to': String(d), value: shift ? shift.to : '17:00', 'aria-label': days[d - 1] + ' ' + t('to') });
      from.disabled = to.disabled = !check.checked;
      (function (c, f, tt) {
        c.addEventListener('change', function () { f.disabled = tt.disabled = !c.checked; });
      })(check, from, to);
      box.appendChild(el('div', { class: 'day' }, [el('label', {}, [check, days[d - 1]]), from, el('span', { class: 'muted small', text: t('to') }), to]));
    }
    var tz = $('hours-tz');
    tz.innerHTML = '';
    var zones = ZONES.indexOf(me.timezone) === -1 ? [me.timezone].concat(ZONES) : ZONES;
    zones.forEach(function (z) {
      var opt = el('option', { value: z, text: z.replace(/_/g, ' ') });
      if (z === me.timezone) opt.selected = true;
      tz.appendChild(opt);
    });
  }

  $('hours-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var hours = [];
    for (var d = 1; d <= 7; d++) {
      if (document.querySelector('[data-day="' + d + '"]').checked) {
        hours.push({
          day: d,
          from: document.querySelector('[data-from="' + d + '"]').value,
          to: document.querySelector('[data-to="' + d + '"]').value,
        });
      }
    }
    var err = $('hours-error');
    err.hidden = true;
    api('/hours', { method: 'PUT', body: { hours: hours, timezone: $('hours-tz').value } })
      .then(function (data) {
        me.hours = data.hours;
        me.timezone = $('hours-tz').value;
        $('hours-saved').hidden = false;
        setTimeout(function () { $('hours-saved').hidden = true; }, 2000);
      })
      .catch(function (x) { err.textContent = x.message; err.hidden = false; });
  });

  /* --------------------------------------------------------------- tabs */

  ['voicemail', 'calls', 'hours'].forEach(function (name) {
    $('tab-' + name).addEventListener('click', function () {
      ['voicemail', 'calls', 'hours'].forEach(function (other) {
        $('tab-' + other).setAttribute('aria-selected', String(other === name));
        $('panel-' + other).hidden = other !== name;
      });
      if (name === 'calls') loadCalls();
      if (name === 'voicemail') loadVoicemail();
    });
  });

  /* -------------------------------------------------------------- start */

  paintWords();

  // Tokens arrive in the fragment, which never reaches a server log, and are
  // wiped from the address bar before anything else happens.
  var hash = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, '', location.pathname);

  if (hash.get('handoff')) {
    api('/handoff', { method: 'POST', body: { token: hash.get('handoff') } })
      .then(load)
      .catch(function (x) { showLogin(x.message); });
  } else if (hash.get('invite')) {
    inviteToken = hash.get('invite');
    api('/invite?token=' + encodeURIComponent(inviteToken))
      .then(function (inv) {
        show('view-invite');
        $('invite-title').textContent = t('inviteTitle', { name: inv.name });
        $('invite-note').textContent = t('inviteNote', { venues: inv.venues || '' });
        $('invite-email').value = inv.email;
      })
      .catch(function (x) { showLogin(x.message); });
  } else {
    load().catch(function () { if (!me) showLogin(); });
  }

  // Every minute, quietly: a voicemail left while the page sat open.
  setInterval(function () { if (me && document.visibilityState === 'visible') loadVoicemail(); }, 60000);
})();
