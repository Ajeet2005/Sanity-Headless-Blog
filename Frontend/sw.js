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
        // Cache successful GET responses (POST/PUT/etc. are never cached)
        if (response.status === 200 && event.request.method === 'GET') {
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
          if (event.request.mode === 'navigate') {
            // Serve the correct app shell for the URL being navigated to.
            // Never fall back to post.html for the homepage/journal — post.html
            // without a slug renders an empty "Post not found." page.
            const url = new URL(event.request.url);
            const path = url.pathname;
            let shell = 'post.html';
            if (path === '/' || path === '/index.html' || path === '/blog') shell = 'index.html';
            else if (path === '/journal.html' || path === '/journal') shell = 'journal.html';
            else if (path === '/login.html') shell = 'login.html';
            return caches.match(shell).then(shellResponse => {
              return shellResponse || new Response('Offline', { status: 503 });
            });
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});
