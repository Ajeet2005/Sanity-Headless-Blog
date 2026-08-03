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

1. Sanity project → **API** → **Webhooks** → *Create webhook*.
2. **URL**: `https://<your-backend-url>/api/notifications/send`
3. **HTTP method**: `POST`
4. **Trigger**: `Create` (document.create)
5. **Filter** (optional): `*[_type == "post"]`
6. **Secret**: paste the same value as `SANITY_WEBHOOK_SECRET` in `.env`.

Sanity signs every request with an HMAC-SHA256 signature (`sanity-webhook-signature` header) that the server verifies before sending anything.

### 3. Test it manually

Without Sanity, you can trigger a broadcast with:

```bash
curl -X POST http://localhost:5000/api/notifications/send \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: <your SANITY_WEBHOOK_SECRET>" \
  -d '{"_type":"post","title":"My new post","slug":{"current":"my-new-post"}}'
```

### Notes

- **HTTPS or localhost is required** — browsers only allow notifications (and service workers) on secure origins.
- **Every** published post triggers a notification (blog, premium, journal, private — all categories).
- Clicking a notification opens `post.html?slug=…` for that post.

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
