# Vendored Firebase JS SDK (FCM)

These files are the official Firebase JS SDK **10.12.0** (Apache-2.0), downloaded
from the Firebase CDN:

- `https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js` (used by notifications)
- `https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js` (used by notifications)
- `https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js` (modular, used by login.html)
- `https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js` (modular, used by login.html)

They are served **same-origin** on purpose: browsers with tracking prevention
(e.g. Microsoft Edge) or privacy shields (e.g. Brave) block the `www.gstatic.com`
third-party CDN, which breaks FCM push registration when loaded from there.

> ⚠️ `firebase-auth.js` is patched after download: its internal ES-module import
> of `firebase-app.js` pointed back at the gstatic CDN, which would still be
> blocked by tracking prevention. It is replaced with a relative import:
>
> ```bash
> sed -i 's|https://www.gstatic.com/firebasejs/<VERSION>/firebase-app.js|./firebase-app.js|g' firebase-auth.js
> ```

To upgrade the SDK:

```bash
cd Frontend/vendor
curl -o firebase-app-compat.js https://www.gstatic.com/firebasejs/<VERSION>/firebase-app-compat.js
curl -o firebase-messaging-compat.js https://www.gstatic.com/firebasejs/<VERSION>/firebase-messaging-compat.js
curl -o firebase-app.js https://www.gstatic.com/firebasejs/<VERSION>/firebase-app.js
curl -o firebase-auth.js https://www.gstatic.com/firebasejs/<VERSION>/firebase-auth.js
# then re-apply the firebase-auth.js import patch above
```

Then update the version note above. No other code changes are needed — the page
and service worker both load these exact filenames from `vendor/`.
