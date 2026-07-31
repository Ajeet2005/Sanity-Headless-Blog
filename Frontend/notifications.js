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

  const FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/10.12.0/';
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
      firebaseReady = loadScript(FIREBASE_CDN + 'firebase-app-compat.js')
        .then(() => loadScript(FIREBASE_CDN + 'firebase-messaging-compat.js'))
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

  function renderState(state, note) {
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
  }

  function openPopup() {
    popup.classList.remove('notif-hidden');
    fetchConfig(); // warm the config cache so Enable doesn't need a network round-trip
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

  async function enableNotifications() {
    noteEl.textContent = '';
    noteEl.style.display = 'none';

    if (!('Notification' in window)) {
      renderState('default', 'This browser does not support notifications.');
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

      await ensureFirebase();

      let registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        registration = await navigator.serviceWorker.register('firebase-messaging-sw.js');
      }
      // Make sure the FCM service worker is active before asking for a token
      await navigator.serviceWorker.ready;

      let app = firebase.apps.find((a) => a.name === FCM_APP_NAME);
      if (!app) app = firebase.initializeApp(cfg, FCM_APP_NAME);
      const messaging = firebase.messaging(app);

      const token = await messaging.getToken({
        vapidKey: cfg.vapidKey,
        serviceWorkerRegistration: registration,
      });

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
      renderState('default', 'Something went wrong while enabling notifications. Please try again.');
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
      .notif-popup-body { padding: 16px; }
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
})();
