'use strict';

/**
 * The guest app's offline shell.
 *
 * Network first, always: a venue that changes its colours or the page itself
 * gets the change on the next open. The cache is only what answers when there
 * is no network — a guest opening the app from the home screen in a room with
 * no signal sees it rather than the browser's error page. The links come from
 * the app's own storage, not from here, and nothing under /api is touched.
 *
 * Registered with scope /welcome, so the review page at / is never served
 * from this cache.
 */

const CACHE = 'rs-welcome-v1';
const SHELL = ['/welcome', '/welcome.js', '/i18n.js', '/styles.css', '/theme.css', '/fonts.css', '/logo'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // One at a time and forgiving: a venue with no logo answers /logo with a
      // 404, and that must not stop the rest being kept.
      .then((cache) => Promise.all(SHELL.map((path) => cache.add(path).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || Response.error()))
  );
});
