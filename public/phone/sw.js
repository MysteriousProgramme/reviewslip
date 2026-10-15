/*
 * A phone's service worker: on a phone with the page closed or in the
 * background, the notification is the ring. A tap opens the phone on the
 * still-ringing call; a second push closes it once someone answers or the
 * caller gives up.
 *
 * Shared by both phones: /phone/reviewslip/sw.js loads this one. Each is
 * registered at its own scope, so each has its own push subscription, and a
 * tap opens the phone that rang — never the other one.
 */

var SCOPE = new URL(self.registration.scope).pathname;

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    return;
  }
  var tag = 'call-' + data.callId;

  if (data.t === 'settled') {
    event.waitUntil(
      self.registration.getNotifications({ tag: tag }).then(function (list) {
        list.forEach(function (n) { n.close(); });
      })
    );
    return;
  }

  if (data.t === 'ring') {
    event.waitUntil(
      self.registration.showNotification('Incoming call · ' + (data.title || 'Reviewslip'), {
        body: data.caller || 'Someone is calling',
        tag: tag,
        renotify: true,
        requireInteraction: true,
        vibrate: [500, 250, 500, 250, 500, 250, 500],
        icon: '/phone/icon.svg',
        badge: '/phone/icon.svg',
        data: { url: data.url || SCOPE },
      })
    );
  }
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || SCOPE;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (new URL(list[i].url).pathname === SCOPE && 'focus' in list[i]) return list[i].focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
