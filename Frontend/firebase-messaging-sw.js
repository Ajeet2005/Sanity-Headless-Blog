/* ─────────────────────────────────────────────────────────────
   Firebase Cloud Messaging service worker
   ─────────────────────────────────────────────────────────────
   This is the site's SINGLE service worker. A page can only have
   one service worker per scope, so this file combines:
     1. PWA app-shell caching (carried over from sw.js)
     2. FCM background notifications + click handling

   The public Firebase config is fetched from the backend at
   install time (/api/notifications/config) so it only lives in
   one place: the backend .env file.
   ───────────────────────────────────────────────────────────── */

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

const CACHE_NAME = 'anubhav-v1';
const urlsToCache = [
  'index.html',
  'journal.html',
  'login.html',
  'post.html',
  'favicon.png',
  'manifest.json',
];

// Fallback config — the real values are loaded from the backend at install time.
const FALLBACK_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDNdgYedYk2yI3VsH58Ao3HF1A1UWMamD0',
  authDomain: 'sanity-blog-auth.firebaseapp.com',
  projectId: 'sanity-blog-auth',
  messagingSenderId: '', // ← filled from /api/notifications/config
  appId: '',             // ← filled from /api/notifications/config
};

const FCM_APP_NAME = 'anubhav-notifications';
let firebaseConfig = FALLBACK_FIREBASE_CONFIG;

/* Install: fetch the public Firebase config + pre-cache the app shell */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch('/api/notifications/config', { cache: 'no-store' });
        const cfg = await res.json();
        if (cfg && cfg.projectId && cfg.messagingSenderId) {
          firebaseConfig = cfg;
        }
      } catch (err) {
        /* keep fallback */
      }
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(urlsToCache);
      return self.skipWaiting();
    })()
  );
});

/* Activate: init FCM, claim pages, clean old caches */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        let app = firebase.apps.find((a) => a.name === FCM_APP_NAME);
        if (!app) {
          app = firebase.initializeApp(firebaseConfig, FCM_APP_NAME);
        }
        const messaging = firebase.messaging(app);

        // Display background notifications received while the tab is closed
        messaging.onBackgroundMessage((payload) => {
          const title =
            (payload.notification && payload.notification.title) || 'New Blog Published';
          const body = (payload.notification && payload.notification.body) || '';
          const url = (payload.data && payload.data.url) || '/';
          self.registration.showNotification(title, {
            body,
            icon: '/favicon.png',
            badge: '/favicon.png',
            data: { url },
          });
        });
      } catch (err) {
        console.error('FCM init failed:', err);
      }

      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      return self.clients.claim();
    })()
  );
});

/* Open the correct blog post when a notification is clicked */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        if (client.url.startsWith(self.location.origin)) {
          await client.navigate(target);
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })()
  );
});

/* Network-first fetch with cache fallback (PWA offline support).
   API requests are never cached. */
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 200 && !event.request.url.includes('/api/')) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match('post.html');
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});
