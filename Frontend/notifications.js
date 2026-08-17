/* ─────────────────────────────────────────────────────────────
   Push notification bell + popup (Firebase Cloud Messaging)
   ─────────────────────────────────────────────────────────────
   Expected header button (added to index.html / journal.html /
   post.html):

     <button class="notif-toggle" id="notif-btn" aria-label="Notifications">
       <svg …bell icon…></svg>
     </button>

   Flow: click bell → popup opens (NO permission prompt) →
   click "Enable Notifications" → browser permission prompt →
   FCM registers this browser → token sent to Node → stored in
   MongoDB. No login/signup required — any visitor can subscribe
   their device. If a user happens to be signed in, their device
   is also linked to their account.
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const bell = document.getElementById('notif-btn');
  if (!bell) return;

  // Self-hosted FCM SDK (Frontend/vendor/). Loading from Google's CDN
  // (www.gstatic.com) gets blocked by browser tracking prevention (e.g.
  // Microsoft Edge) and some privacy browsers, which breaks push registration.
  // Same-origin files are immune to that and also load faster.
  const FIREBASE_BASE = '/vendor/';
  const FCM_APP_NAME = 'anubhav-notifications';
  const TOKEN_STORAGE_KEY = 'fcmToken';

  let config = null;
  let popup = null;
  let actionBtn = null;
  let noteEl = null;
  let currentState = 'default'; // default | enabled | denied | not-configured

  /* ── helpers ── */

  function idToken() {
    return localStorage.getItem('firebaseAuthToken') || '';
  }

  /* ── device / browser support detection ── */

  function isIOS() {
    return (
      /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      // iPadOS 13+ reports as Mac, but has touch points
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  // Returns e.g. 16.4 for iOS/iPadOS 16.4, or 0 when it can't be determined.
  function iosVersion() {
    const m = (navigator.userAgent || '').match(/OS (\d+)[_.](\d+)/);
    return m ? parseFloat(m[1] + '.' + m[2]) : 0;
  }

  function isStandalonePwa() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function isInAppBrowser() {
    const ua = navigator.userAgent;
    return /FBAN|FBAV|Instagram|WhatsApp|Line\/|Snapchat|Twitter\/|MicroMessenger|WebView|wv\./i.test(ua);
  }

  function isSecure() {
    return window.isSecureContext === true;
  }

  // Returns { supported: true } or { supported: false, title, message } with
  // actionable guidance for the device/browser that can't do push.
  function notificationSupport() {
    if (isInAppBrowser()) {
      return {
        supported: false,
        title: 'Open in a real browser',
        message:
          "You're using an in-app browser (Instagram, WhatsApp, Facebook…), which can't show push notifications. Tap ⋯ (or Share) → Open in Chrome/Safari, then try again.",
      };
    }
    if (!isSecure()) {
      return {
        supported: false,
        title: 'HTTPS required',
        message:
          'Notifications only work on a secure (https://) connection. Open the site via https or the deployed URL, then try again.',
      };
    }
    // iOS: web push only works on iOS/iPadOS 16.4+ AND when the site is installed
    // as a PWA (added to Home Screen) — Apple does not allow push from Safari
    // itself. Guide the user to install rather than showing a confusing flow.
    if (isIOS() && !isStandalonePwa()) {
      const ver = iosVersion();
      if (ver && ver < 16.4) {
        return {
          supported: false,
          title: 'Update iOS first',
          message:
            'Web notifications on iPhone/iPad require iOS 16.4 or later. Go to Settings → General → Software Update, update, then try again.',
        };
      }
      return {
        supported: false,
        title: 'Add to Home Screen first',
        message:
          'On iPhone/iPad, web notifications only work after installing this site as an app: tap the Share button (⬆️) → Add to Home Screen → open it from your Home Screen, then enable notifications. Requires iOS 16.4+.',
      };
    }
    // Firefox: FCM (Firebase push) is not supported — messaging.getToken() fails there.
    if (/Firefox\//i.test(navigator.userAgent)) {
      return {
        supported: false,
        title: 'Firefox not supported',
        message:
          'Firebase push notifications are not available in Firefox. Use Chrome, Edge, or Opera to enable notifications.',
      };
    }
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      if (isIOS()) {
        return {
          supported: false,
          title: 'Update iOS',
          message:
            'Push notifications on iPhone/iPad require iOS 16.4 or later. Update iOS, then try again.',
        };
      }
      return {
        supported: false,
        title: 'Browser not supported',
        message:
          'This browser does not support push notifications. Try the latest Chrome, Edge, Firefox, or Safari.',
      };
    }
    return { supported: true };
  }

  async function fetchConfig() {
    if (config) return config;
    try {
      const res = await fetch('/api/notifications/config');
      config = await res.json();
      if (!config || !config.projectId) throw new Error('bad config');
    } catch (err) {
      // Fallback: values already public in the site's frontend.
      config = {
        apiKey: 'AIzaSyDNdgYedYk2yI3VsH58Ao3HF1A1UWMamD0',
        authDomain:
          location.hostname === 'localhost' || location.hostname === '127.0.0.1'
            ? location.hostname
            : 'sanity-blog-auth.firebaseapp.com',
        projectId: 'sanity-blog-auth',
        messagingSenderId: '',
        appId: '',
        vapidKey: '',
        configured: false,
      };
    }
    return config;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  let firebaseReady = null;
  function ensureFirebase() {
    if (!firebaseReady) {
      firebaseReady = loadScript(FIREBASE_BASE + 'firebase-app-compat.js')
        .then(() => loadScript(FIREBASE_BASE + 'firebase-messaging-compat.js'))
        .then(() => true)
        .catch((err) => {
          firebaseReady = null;
          throw err;
        });
    }
    return firebaseReady;
  }

  /* ── popup rendering ── */

  /* Red dot = this device has notifications enabled (token saved locally).
     Shown in every state for users who enabled, only removed on disable. */
  function syncBellDot() {
    bell.classList.toggle('has-notifications', Boolean(localStorage.getItem(TOKEN_STORAGE_KEY)));
  }

  function renderState(state, note, titleOverride) {
    currentState = state;
    const titleEl = document.getElementById('notif-title');
    const textEl = document.getElementById('notif-text');

    if (state === 'enabled') {
      titleEl.textContent = '✓ Notifications enabled';
      textEl.textContent = "We'll notify you when a new blog is published.";
      actionBtn.textContent = 'Disable Notifications';
      syncBellDot();
    } else if (state === 'denied') {
      titleEl.textContent = 'Notifications blocked';
      textEl.textContent =
        'You blocked notifications in your browser. Allow notifications for this site in your browser settings, then try again.';
      actionBtn.textContent = 'Enable Notifications';
      syncBellDot();
    } else if (state === 'not-configured') {
      titleEl.textContent = 'Notifications';
      textEl.textContent = 'Never miss a new article. Get notified when we publish something new.';
      actionBtn.textContent = 'Enable Notifications';
      actionBtn.disabled = true;
      syncBellDot();
    } else {
      // default — keep the red dot for anyone who has enabled notifications,
      // even if a transient status check fails. It's only truly removed when
      // the user disables (token cleared before renderState('default') is called).
      titleEl.textContent = 'Notifications';
      textEl.textContent = 'Never miss a new article. Get notified when we publish something new.';
      actionBtn.textContent = 'Enable Notifications';
      actionBtn.disabled = false;
      syncBellDot();
    }

    if (note) {
      noteEl.textContent = note;
      noteEl.style.display = 'block';
    } else {
      noteEl.textContent = '';
      noteEl.style.display = 'none';
    }

    if (titleOverride) titleEl.textContent = titleOverride;
  }

  function openPopup() {
    popup.classList.remove('notif-hidden');
    fetchConfig(); // warm the config cache so Enable doesn't need a network round-trip
    ensureFirebase().catch(() => {}); // pre-load the FCM SDK so Enable is fast
    refreshStatus();
  }

  function closePopup() {
    popup.classList.add('notif-hidden');
  }

  /* ── server status ── */

  async function refreshStatus() {
    // No login needed — check whether THIS device's saved FCM token is subscribed.
    const deviceToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!deviceToken) {
      renderState('default');
      return;
    }
    try {
      const res = await fetch('/api/notifications/status?token=' + encodeURIComponent(deviceToken));
      if (res.status === 503) {
        renderState('not-configured', 'Push notifications are not set up on the server yet.');
        return;
      }
      if (!res.ok) {
        renderState('default');
        return;
      }
      const data = await res.json();
      renderState(data.enabled ? 'enabled' : 'default');
    } catch (err) {
      renderState('default');
    }
  }

  /* ── enable / disable ── */

  /* True for the push-service registration failures Chrome throws as AbortError
     ("Registration failed - push service not available"). */
  function isPushServiceError(err) {
    return (
      (err && err.name === 'AbortError') ||
      /push service not available|registration failed|token-subscribe-failed/i.test(
        String((err && err.message) || err)
      )
    );
  }

  /* A page can only have one service worker per scope. Older installs may still
     run sw.js — return a registration whose active worker is
     firebase-messaging-sw.js, replacing it if not. */
  async function ensureFcmRegistration() {
    let reg = await navigator.serviceWorker.getRegistration();
    if (reg && reg.active) {
      const scriptUrl = reg.active.scriptURL || '';
      if (!scriptUrl.endsWith('firebase-messaging-sw.js')) {
        await reg.unregister().catch(() => {});
        reg = null;
      }
    }
    if (!reg) {
      reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { updateViaCache: 'none' });
    }
    return reg;
  }

  /* Ask FCM for a registration token. Browsers sometimes fail with
     "Registration failed - push service error" when a broken/stale push
     subscription is still attached to the service worker (e.g. from an earlier
     attempt with a different VAPID key). Recovery ladder:
       1. drop the stale subscription and retry once;
       2. if that still fails, re-register the service worker (resets all push
          state for the origin) and retry a final time. */
  async function getFcmToken(messaging, registration, vapidKey) {
    const opts = { vapidKey, serviceWorkerRegistration: registration };
    try {
      return await messaging.getToken(opts);
    } catch (err) {
      // Only recover for a real push-service failure — never destroy a working
      // subscription because of a transient network error.
      if (!isPushServiceError(err)) throw err;
      const existing = await registration.pushManager.getSubscription().catch(() => null);
      if (existing) {
        console.warn('getToken failed — removing stale push subscription and retrying:', err);
        await existing.unsubscribe().catch(() => {});
        // Give the push service a moment to forget the old subscription.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      try {
        return await messaging.getToken(opts);
      } catch (err2) {
        if (!isPushServiceError(err2)) throw err2;
        // Second attempt failed too — some browsers (Edge, Brave) keep broken
        // push state attached to the worker. Re-registering resets it fully.
        console.warn('getToken failed again — re-registering the service worker:', err2);
        try {
          await registration.unregister().catch(() => {});
          const fresh = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { updateViaCache: 'none' });
          await navigator.serviceWorker.ready;
          return await messaging.getToken({ vapidKey, serviceWorkerRegistration: fresh });
        } catch (recoverErr) {
          // Keep the original push-service error if the recovery itself fails.
          console.warn('Service-worker re-registration recovery failed:', recoverErr);
          throw err2;
        }
      }
    }
  }

  /* Turn raw push-registration errors into guidance the user can act on. */
  function describePushError(err) {
    const code = (err && err.code) || '';
    const raw = String((err && err.message) || err);
    if (isPushServiceError(err)) {
      const braveNote = /Brave/i.test(navigator.userAgent)
        ? 'Brave blocks Google\'s push service by default — open brave://settings/?search=push and turn ON "Use Google services for push notifications", then try again.\n'
        : '';
      return (
        braveNote +
        'Your browser could not register with the push service (FCM). If the backend .env matches your Firebase console, this is almost always a browser-side block. Try, in order:\n' +
        '1) Open the site in an Incognito window (Ctrl+Shift+N) and Enable again — works there? Then an extension, profile state, or setting is blocking push.\n' +
        '2) In Microsoft Edge/Chrome: DevTools (F12) → Application → Storage → "Clear site data" (also clears local sign-in), reload, then retry — stale push state from earlier attempts is the usual culprit.\n' +
        '3) Disable ad-blocker / privacy / VPN extensions, then retry.\n' +
        '4) Check chrome://push-internals/ (or edge://push-internals/) for the exact push-service error.\n' +
        'Details: ' +
        (code ? code + ' — ' : '') +
        raw
      );
    }
    return raw || 'Something went wrong while enabling notifications. Please try again.';
  }

  async function enableNotifications() {
    noteEl.textContent = '';
    noteEl.style.display = 'none';

    const support = notificationSupport();
    if (!support.supported) {
      renderState('default', support.message, support.title);
      return;
    }

    const cfg = await fetchConfig();
    if (!cfg.configured) {
      renderState('not-configured', 'Push notifications are not configured yet. Check the backend .env settings.');
      return;
    }

    // No sign-in required — any visitor can enable notifications on this device.
    actionBtn.disabled = true;
    actionBtn.textContent = 'Requesting permission…';

    try {
      const permission = await Notification.requestPermission();

      if (permission !== 'granted') {
        if (permission === 'denied') {
          renderState('denied');
        } else {
          renderState('default', 'Permission prompt was dismissed. Tap Enable Notifications to try again.');
        }
        return;
      }

      actionBtn.textContent = 'Connecting to the push service…';
      await ensureFirebase();

      // A page can only have one service worker per scope. If an older install
      // still runs sw.js, replace it with firebase-messaging-sw.js.
      let registration = await ensureFcmRegistration();
      // Make sure the FCM service worker is active before asking for a token
      await navigator.serviceWorker.ready;
      // Re-check now that an active worker exists, so a stale sw.js can never
      // be handed to getToken()
      registration = await ensureFcmRegistration();
      if (registration && !registration.active) {
        // Guard: the re-check may have just re-registered the SW (installing) —
        // wait for it to activate before subscribing.
        await navigator.serviceWorker.ready;
        registration = await ensureFcmRegistration();
      }

      let app = firebase.apps.find((a) => a.name === FCM_APP_NAME);
      if (!app) app = firebase.initializeApp(cfg, FCM_APP_NAME);
      const messaging = firebase.messaging(app);
      registerForegroundHandler(messaging);

      actionBtn.textContent = 'Saving…';
      const token = await getFcmToken(messaging, registration, cfg.vapidKey);

      const headers = { 'Content-Type': 'application/json' };
      const authToken = idToken();
      if (authToken) headers.Authorization = 'Bearer ' + authToken; // optional — links device to account
      const res = await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers,
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        renderState('default', data.error || 'Could not enable notifications. Please try again.');
        return;
      }

      localStorage.setItem(TOKEN_STORAGE_KEY, token);
      renderState('enabled');
    } catch (err) {
      console.error('Enable notifications error:', err);
      renderState('default', describePushError(err), 'Notifications');
    } finally {
      actionBtn.disabled = false;
    }
  }

  async function disableNotifications() {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (token) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        const authToken = idToken();
        if (authToken) headers.Authorization = 'Bearer ' + authToken;
        await fetch('/api/notifications/unsubscribe', {
          method: 'POST',
          headers,
          body: JSON.stringify({ token }),
        });
      } catch (err) {
        /* ignore — we still clear local state */
      }
    }
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    renderState('default', "You're unsubscribed. We won't send you new-post notifications anymore.");
  }

  function handleAction() {
    if (currentState === 'enabled') {
      disableNotifications();
    } else {
      enableNotifications();
    }
  }

  /* ── UI building ── */

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .notif-toggle {
        background: var(--toggle-bg);
        border: 1px solid var(--border);
        border-radius: 50%;
        width: 36px;
        height: 36px;
        cursor: pointer;
        color: var(--toggle-color);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        flex-shrink: 0;
        padding: 0;
        position: relative;
      }
      .notif-toggle:hover { border-color: var(--card-hover-border); }
      .notif-toggle svg { display: block; }
      .notif-toggle.has-notifications::after {
        content: '';
        position: absolute;
        top: 5px;
        right: 5px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ef4444; /* red dot — active while notifications are enabled */
        border: 2px solid var(--surface);
      }
      .notif-popup {
        position: fixed;
        top: 76px;
        right: 24px;
        width: min(92vw, 340px);
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 14px;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.18);
        z-index: 300;
        overflow: hidden;
        animation: notif-in 0.18s ease;
      }
      .notif-popup.notif-hidden { display: none; }
      @keyframes notif-in {
        from { opacity: 0; transform: translateY(-6px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .notif-popup-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-bottom: 1px solid var(--border);
        font-weight: 700;
        font-size: 0.95rem;
        color: var(--text);
      }
      .notif-popup-close {
        background: none;
        border: none;
        color: var(--text-faint);
        font-size: 0.85rem;
        cursor: pointer;
        padding: 4px;
        border-radius: 50%;
        line-height: 1;
      }
      .notif-popup-close:hover { color: var(--text); background: var(--tag-hover-bg); }
      .notif-popup-body {
        padding: 16px;
        max-height: calc(100vh - 170px);
        overflow-y: auto;
      }
      .notif-popup-body p {
        font-size: 0.88rem;
        color: var(--text-muted);
        line-height: 1.55;
        margin: 0 0 14px;
      }
      .notif-popup-btn {
        width: 100%;
        border: 1px solid #111;
        border-radius: 10px;
        background: #111;
        color: #fff;
        padding: 10px 12px;
        font-weight: 600;
        font-size: 0.9rem;
        cursor: pointer;
        transition: background 0.15s, opacity 0.15s;
      }
      .notif-popup-btn:hover { background: #262626; border-color: #262626; }
      .notif-popup-btn:disabled { opacity: 0.6; cursor: not-allowed; }
      [data-theme='dark'] .notif-popup-btn {
        background: #fff;
        color: #111;
        border-color: #fff;
      }
      [data-theme='dark'] .notif-popup-btn:hover { background: #e8e8e8; }
      .notif-popup-note {
        margin-top: 12px !important;
        margin-bottom: 0 !important;
        font-size: 0.8rem !important;
        line-height: 1.5 !important;
        white-space: pre-line;
        color: #dc2626 !important;
      }
      @media (max-width: 640px) {
        .notif-popup { top: 64px; right: 12px; }
      }
    `;
    document.head.appendChild(style);
  }

  function buildPopup() {
    const div = document.createElement('div');
    div.className = 'notif-popup notif-hidden';
    div.id = 'notif-popup';
    div.setAttribute('role', 'dialog');
    div.setAttribute('aria-label', 'Notifications');
    div.innerHTML =
      '<div class="notif-popup-header">' +
      '<span id="notif-title">Notifications</span>' +
      '<button class="notif-popup-close" id="notif-close" aria-label="Close notifications">✕</button>' +
      '</div>' +
      '<div class="notif-popup-body">' +
      '<p id="notif-text">Never miss a new article. Get notified when we publish something new.</p>' +
      '<button class="notif-popup-btn" id="notif-action">Enable Notifications</button>' +
      '<p class="notif-popup-note" id="notif-note"></p>' +
      '</div>';
    document.body.appendChild(div);

    popup = div;
    actionBtn = document.getElementById('notif-action');
    noteEl = document.getElementById('notif-note');
    document.getElementById('notif-close').addEventListener('click', closePopup);
    actionBtn.addEventListener('click', handleAction);
  }

  /* ── foreground messages (site tab open) ── */

  let foregroundRegistered = false;

  /* Without this, FCM messages are only shown by the service worker while the
     site is CLOSED — an open, focused tab swallows the push. This displays the
     notification in the foreground too. */
  function registerForegroundHandler(messaging) {
    if (foregroundRegistered) return;
    foregroundRegistered = true;
    messaging.onMessage((payload) => {
      const notif = (payload && payload.notification) || {};
      const title = notif.title || 'New Blog Published';
      const body = notif.body || '';
      const icon = notif.icon || '/favicon.png';
      const url = (payload.data && payload.data.url) || '/';
      try {
        const n = new Notification(title, { body, icon });
        n.onclick = () => {
          n.close();
          window.focus();
          if (url) window.location.href = url;
        };
      } catch (err) {
        /* Notification API unavailable in this context */
      }
    });
  }

  /* For users who already enabled notifications: register the foreground
     handler on page load, without needing to open the bell. */
  function initForegroundMessaging() {
    fetchConfig()
      .then((cfg) => {
        if (!cfg || !cfg.configured) return;
        return ensureFirebase().then(() => {
          let app = firebase.apps.find((a) => a.name === FCM_APP_NAME);
          if (!app) app = firebase.initializeApp(cfg, FCM_APP_NAME);
          registerForegroundHandler(firebase.messaging(app));
        });
      })
      .catch(() => {});
  }

  /* ── wiring ── */

  bell.addEventListener('click', (event) => {
    event.stopPropagation();
    if (popup.classList.contains('notif-hidden')) {
      openPopup();
    } else {
      closePopup();
    }
  });

  document.addEventListener('click', (event) => {
    if (
      !popup.classList.contains('notif-hidden') &&
      !popup.contains(event.target) &&
      event.target !== bell
    ) {
      closePopup();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePopup();
  });

  injectStyles();
  buildPopup();
  renderState('default');
  initForegroundMessaging();
})();
