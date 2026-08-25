# Sanity-Headless-Blog

A headless blog: **Sanity** is the source of truth for content, an **Express + MongoDB** backend handles payments / reviews / push notifications, and a plain **HTML/JS** frontend renders everything (PWA-enabled).

## Project structure

```
Frontend/          → static site (index.html, journal.html, post.html, login.html)
Backend/           → Express server (Khalti payments, reviews, subscriptions, push notifications)
Sanity-Backend/    → Sanity Studio (authoring content for the blog)
```

## Getting started

### 1. Backend

```bash
cd Backend
npm install
cp .env.example .env   # then fill in your real values
npm start              # serves the API + the Frontend at http://localhost:5000
```

> ⚠️ **Never commit `.env`** — it contains secrets (MongoDB URI, Khalti keys, Firebase service-account private key). `.env.example` holds a placeholder template.

### 2. Sanity Studio

```bash
cd Sanity-Backend
npm install
npm run dev            # starts the Studio on localhost:3333
```

## SEO: static post links

Blog post links used to exist only after client-side JS ran, so crawlers that
don't execute JS (Googlebot included) saw an empty post grid — posts showed up
as "Discovered, currently not indexed".

Two layers now put real `<a href="/slug">Title</a>` links into the
homepage's raw HTML before any JavaScript runs:

1. **Dynamic (primary)** — `Backend/server.js` injects the links whenever `/`
   or `/index.html` is served: it queries Sanity for every published post
   (`*[_type == "post"]{title, slug, publishedAt}`), builds the same `.card`
   markup the client-side renderer uses, and drops it between the
   `SEO_STATIC_POST_LINKS_START` / `SEO_STATIC_POST_LINKS_END` markers in
   `index.html`. The result is cached for 1 hour (like the sitemap), so new
   posts appear in the raw HTML within an hour of publishing — **no rebuilds
   or webhooks needed**. If Sanity is unreachable, the previously cached block
   (or the static file) is served, so the homepage never breaks.
2. **Build-time fallback** — `Backend/build.js` regenerates the committed
   `Frontend/index.html` at deploy time, so the static file always contains
   links too (covers static hosts and direct file access).

In the browser, the existing client-side JS still fetches fresh data and
replaces the static links with the full post cards — search, filtering, and
categories work exactly as before.

### Run the build locally (fallback refresh)

```bash
cd Backend
npm install
npm run build        # fetches posts from Sanity and rewrites ../Frontend/index.html
```

Re-running is safe (idempotent).

### Render

- **Root Directory**: `Backend`
- **Start Command**: `npm start` (as before)
- **Build Command** (optional but recommended): `npm install && npm run build`

No Sanity webhook or Render deploy hook is required — homepage links refresh
themselves within the server's 1-hour cache window. If you already created a
Sanity webhook → Render deploy hook for this, you can delete it; it's redundant
now. (Keep `Backend/package-lock.json` committed so installs are reproducible.)

## Environment variables (Backend/.env)

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 5000) |
| `MONGODB_URI` | MongoDB connection string |
| `KHALTI_SECRET_KEY` / `KHALTI_PUBLIC_KEY` | Khalti payment keys |
| `BASE_URL` | Public URL of the backend (used for callbacks + notification links) |
| `FIREBASE_API_KEY` | Firebase web API key (public) |
| `FIREBASE_AUTH_DOMAIN` | Firebase auth domain (public) |
| `FIREBASE_PROJECT_ID` | Firebase project id (public) |
| `FIREBASE_MESSAGING_SENDER_ID` | Firebase sender id — **Cloud Messaging** tab (public) |
| `FIREBASE_APP_ID` | Firebase web app id (public) |
| `FIREBASE_CLIENT_EMAIL` | Service-account client email (**private**) |
| `FIREBASE_PRIVATE_KEY` | Service-account private key (**private**, wrap in double quotes) |
| `VAPID_PUBLIC_KEY` | VAPID key from Firebase → Project settings → Cloud Messaging → Web Push certificates (public) |
| `SANITY_WEBHOOK_SECRET` | Secret that Sanity sends with its webhook so the server can verify it |

## Push notifications (FCM)

### How it works

```
Sanity (new post published)
  → webhook → Node (POST /api/notifications/send, signature verified)
  → MongoDB subscribers → Firebase FCM → browser notification

Bell 🔔 → popup → “Enable Notifications” → browser permission
  → FCM registers the browser → token sent to Node (Firebase ID token verified)
  → userId + token stored in MongoDB (multiple devices supported)
```

### Files

- `Frontend/notifications.js` — bell + popup UI, permission flow, sends the FCM token to Node.
- `Frontend/firebase-messaging-sw.js` — **the single service worker** (a page can only have one SW per scope), so it keeps the PWA caching from `sw.js` *and* handles background notifications + click-through to the post.
- `Backend/server.js` — Firebase Admin SDK init + subscribe / unsubscribe / status / config / send endpoints.

### Backend endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/notifications/config` | public | Non-secret Firebase config for the browser |
| `POST` | `/api/notifications/subscribe` | Firebase ID token (Bearer) | Save this browser's FCM token |
| `POST` | `/api/notifications/unsubscribe` | Firebase ID token (Bearer) | Remove this browser's FCM token |
| `GET` | `/api/notifications/status` | Firebase ID token (Bearer) | Is this user subscribed? |
| `POST` | `/api/notifications/send` | Sanity webhook signature | Broadcast “New Blog Published” |

> 🔒 The user is **always** identified from the verified Firebase ID token (`admin.auth().verifyIdToken`). A client-sent userId is never trusted. The service-account **private key stays on the server** — it is never placed in HTML, frontend JS, `public/`, or GitHub.

### 1. Fill in the Firebase env vars

From the Firebase Console → Project settings:

- **General tab**: `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`
- **Cloud Messaging tab**: `FIREBASE_MESSAGING_SENDER_ID`, `VAPID_PUBLIC_KEY` (Web Push certificates → Key pair)
- **Service accounts tab** → *Generate new private key*: use the JSON to fill `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`.

  In `.env`, keep the private key in double quotes so the `\n` sequences become real newlines:

  ```
  FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQ…\n-----END PRIVATE KEY-----\n"
  ```

### 2. Create the Sanity webhook

> ⚠️ **This is the most common reason notifications never arrive.** The webhook
> must actually exist in the Sanity dashboard with the same secret as
> `SANITY_WEBHOOK_SECRET` on the server. The blog still updates on the website
> without it (the frontend reads Sanity's CDN directly), so this fails silently.

1. Sanity project → **API** → **Webhooks** → *Create webhook*.
2. **URL**: `https://<your-backend-url>/api/notifications/send`
3. **HTTP method**: `POST`
4. **Trigger**: `Create` (document.create) — publishing a post creates the
   published document and fires exactly one notification. Draft saves are
   skipped automatically by the server (see below).
5. **Filter**: `*[_type == "post"]`
6. **Secret**: paste **the same value** as `SANITY_WEBHOOK_SECRET` in `Backend/.env`.

Sanity signs every request with an HMAC-SHA256 signature
(`sanity-webhook-signature: t=<timestamp>,v1=<hmac>` header) that the server
verifies before sending anything. The signature check is strict: no header, no
secret, or a mismatched secret all result in `401 Invalid webhook signature`
(logged with the exact reason). Draft documents (`_id` starting with
`drafts.`) are ignored server-side so saving a draft never notifies subscribers.

### 3. Test it manually

Without Sanity, you can trigger a broadcast with a properly signed request
(run from the `Backend` folder — it reads `SANITY_WEBHOOK_SECRET` from `.env`):

```bash
node -e "
const crypto = require('crypto');
const secret = require('dotenv').config().parsed.SANITY_WEBHOOK_SECRET;
const body = JSON.stringify({ _type: 'post', title: 'My new post', slug: { current: 'my-new-post' } });
const timestamp = Date.now();
// Sanity signs with the digest base64url-encoded (no padding) — not hex.
const signature = crypto.createHmac('sha256', secret)
  .update(timestamp + '.' + body)
  .digest('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
fetch('http://localhost:5000/api/notifications/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'sanity-webhook-signature': 't=' + timestamp + ',v1=' + signature },
  body
}).then(r => r.json()).then(console.log);
"
```

Expected: `{ success: true, sent: N, failed: 0, removed: 0 }`.

### Notes

- **HTTPS or localhost is required** — browsers only allow notifications (and service workers) on secure origins.
- **Every** published post triggers a notification (blog, premium, journal, private — all categories).
- Clicking a notification opens `/slug` for that post.

### Troubleshooting

**Error: `Registration failed - push service not available` (AbortError) when enabling notifications**

This is thrown by the browser (Chrome/Edge) when its push registration with the
FCM push service fails. Since `getToken()` runs only after the backend config
was loaded, this is **not** a “server not configured” issue. Check, in order:

1. **Enable the FCM Registration API** — In the Google Cloud console, make sure
   the **Firebase Cloud Messaging API** is enabled for the project (Firebase →
   Project settings → top-right *Usage and billing*, or
   console.cloud.google.com/apis → search “Firebase Cloud Messaging API” →
   Enable). FCM web requires this for the SDK version used here.
2. **VAPID key must belong to the project** — `VAPID_PUBLIC_KEY` in `Backend/.env`
   must be the public key shown in Firebase → Project settings → **Cloud
   Messaging** tab → *Web Push certificates*. If you generated keys elsewhere
   (e.g. `npx web-push generate-vapid-keys`), import that key pair into the
   Firebase console (*Web Push certificates* → *Import a key pair*) so the
   project and key match.
3. **Sender ID** — `FIREBASE_MESSAGING_SENDER_ID` must be the numeric sender ID
   from the same **Cloud Messaging** tab (not the project ID).
4. **Stale browser subscription** — push subscriptions live **per browser, per
   origin** (they are not shared across PCs or phones). If you tried enabling
   notifications while the env/keys were still being set up, Chrome may hold a
   broken subscription that blocks re-registration. The app now auto-clears it
   and retries, but the guaranteed fix is: DevTools (F12) → **Application** →
   **Storage** → **Clear site data** (note: this also wipes local sign-in and the
   saved theme), reload, then enable again. A leftover
   `sw.js` registration (from older installs) is also auto-replaced now —
   hard-refresh (Ctrl+Shift+R) once after deploying.

Other notes:

- **Firefox** is not supported by FCM web push — the app shows a clear message.
  Use Chrome, Edge, or Opera.
- The site must be served over **HTTPS** (or `http://localhost`).

## Khalti payments

Premium subscription flow:

1. `POST /api/payment/initiate` creates a Khalti payment (10 NPR test) and stores a pending record.
2. Khalti redirects to `GET /api/payment/callback?pidx=…`, the server verifies with Khalti's lookup API.
3. On success the subscription becomes active and the user is redirected back to the post with `?payment=success`.

## Reviews / feedback

`POST/GET/PUT /api/reviews`, `GET /api/reviews/history` — rating + feedback per post slug, with version history.

## PWA

- `Frontend/manifest.json` + `Frontend/firebase-messaging-sw.js` (app-shell caching, network-first) make the site installable and offline-capable.
- Dark/light mode is saved in `localStorage` (`theme`).
