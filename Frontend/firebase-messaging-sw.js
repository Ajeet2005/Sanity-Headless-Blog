/* ─────────────────────────────────────────────────────────────
   Firebase Cloud Messaging service worker
   ─────────────────────────────────────────────────────────────
   This is the site's SINGLE service worker. A page can only have
   one service worker per scope, so this file combines:
     1. PWA app-shell caching (carried over from sw.js)
     2. FCM background notifications + click handling

   IMPORTANT: Firebase Messaging MUST be initialized at the TOP
   LEVEL of this script. Browsers only allow the 'push',
   'notificationclick', 'pushsubscriptionchange' and
   'notificationclose' listeners to be registered during the
   initial evaluation of the worker script — initializing inside
   install/activate triggers "Event handler of 'push' event must
   be added on the initial evaluation of worker script" and
   background notifications can break.
   ───────────────────────────────────────────────────────────── */

// Self-hosted FCM SDK (Frontend/vendor/) — the gstatic CDN is blocked by
// browser tracking prevention (Edge/Brave), which breaks push registration.
importScripts('./vendor/firebase-app-compat.js');
importScripts('./vendor/firebase-messaging-compat.js');

<<<<<<< HEAD
const CACHE_NAME = 'anubhav-v5'; // bumped when cached payload changes (vendor SDK files)
=======
const CACHE_NAME = 'anubhav-v5'; // bump this on every deploy so browsers refresh cached pages
>>>>>>> 295d4ba4cafec1b495e653a9a73019b1249814d3
const urlsToCache = [
  '/',
  'index.html',
  'journal.html',
  'login.html',
  'post.html',
  'favicon.png',
  'manifest.json',
  'vendor/firebase-app-compat.js',
  'vendor/firebase-messaging-compat.js',
  'vendor/firebase-app.js',
  'vendor/firebase-auth.js',
];

// Public Firebase web config. These are PUBLIC values (safe to ship in the
// browser) and must match the FIREBASE_* values in Backend/.env — the same
// ones the backend exposes at /api/notifications/config.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDNdgYedYk2yI3VsH58Ao3HF1A1UWMamD0',
  authDomain: 'sanity-blog-auth.firebaseapp.com',
  projectId: 'sanity-blog-auth',
  messagingSenderId: '552042411059',
  appId: '1:552042411059:web:14265a745e929b19659f46',
};

const FCM_APP_NAME = 'anubhav-notifications';

/* ── Initialize Firebase Messaging at the TOP LEVEL ──
   Registers the push/notificationclick/etc. listeners during the initial
   evaluation of the worker script, as browsers require. */
const app = firebase.initializeApp(FIREBASE_CONFIG, FCM_APP_NAME);
const messaging = firebase.messaging(app);

// Display background notifications received while the tab is closed.
//
// IMPORTANT — single-display rule: FCM automatically displays any message that
// carries a `notification` payload (the SDK calls showNotification itself, and
// its own notificationclick handler opens webpush.fcmOptions.link). If this
// handler ALSO called showNotification() for those messages, every subscriber
// would see the notification TWICE (one from the SDK, one from us).
//
// So: messages WITH a `notification` payload are left to the SDK's built-in
// display (we just return early), and only DATA-ONLY messages are displayed
// manually here.
messaging.onBackgroundMessage((payload) => {
  const notif = (payload && payload.notification) || {};

  if (Object.keys(notif).length > 0) {
    // Notification payload present → the SDK already displayed it once.
    // Tapping it is handled by the SDK (opens fcmOptions.link).
    return;
  }

  // Data-only message → show it ourselves.
  const title = notif.title || 'New Blog Published';
  const body = notif.body || '';
  const url = (payload.data && payload.data.url) || '/';
  const icon = notif.icon || '/favicon.png';
  self.registration.showNotification(title, {
    body,
    icon,
    image: notif.image || icon, // big cover image (Chrome/Edge/Android); ignored elsewhere
    badge: notif.badge || '/favicon.png',
    data: { url },
  });
});

/* Install: pre-cache the app shell */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

/* Activate: claim pages, clean old caches */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
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

/* Open the correct blog post when a notification is clicked.
   Notifications auto-displayed by the FCM SDK (notification-payload messages)
   carry an internal data key instead of our `url` — the SDK's own click
   handler opens webpush.fcmOptions.link for those. So only handle clicks for
   notifications WE displayed (data-only messages, which carry data.url); this
   keeps click handling independent of listener registration order. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url;
  if (!target) return;
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
   Only successful GET requests are cached — never POST/PUT/etc. and
   never /api/ calls. */
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response.status === 200 &&
          event.request.method === 'GET' &&
          !event.request.url.includes('/api/') &&
          !event.request.url.includes('api.sanity.io')
        ) {
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
            // Serve the correct app shell for the URL being navigated to.
            // NEVER fall back to post.html for the homepage/journal — post.html
            // without a slug renders an empty "Post not found." page, which
            // looks like the blog is broken.
            const url = new URL(event.request.url);
            const path = url.pathname;
            let shell = 'post.html';
            if (path === '/' || path === '/index.html') shell = 'index.html';
            else if (path === '/journal.html') shell = 'journal.html';
            else if (path === '/login.html') shell = 'login.html';
            return caches.match(shell).then((shellResponse) => {
              return shellResponse || new Response('Offline', { status: 503 });
            });
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});
