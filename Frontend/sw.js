/* NOTE: This service worker is superseded by firebase-messaging-sw.js.
   All pages now register firebase-messaging-sw.js, which merges this
   app-shell caching with Firebase Cloud Messaging. This file is kept
   only as a fallback for older cached installs. */
const CACHE_NAME = 'anubhav-v1';
const urlsToCache = [
  'index.html',
  'journal.html',
  'login.html',
  'post.html',
  'favicon.png',
  'manifest.json'
];

// Install event - cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - network first, fallback to cache
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Offline: serve from cache
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          // If requesting a post page, fall back to the cached post.html
          if (event.request.mode === 'navigate') {
            return caches.match('post.html');
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});
