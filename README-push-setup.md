# Background push notifications — setup guide

This adds real background/lock-screen notifications on top of the existing
foreground-only alerts. Three pieces work together:

| Piece | File | Runs where |
|---|---|---|
| App | `ebike-board-38.html` | User's phone, in the browser/PWA |
| Service worker | `sw.js` | User's phone, in the background |
| Push backend | `server/server.js` | Your own server, 24/7 |

The backend polls the GBFS feed itself, so notifications keep arriving even
when nobody has the app open — the phone doesn't do any polling anymore,
it just waits to receive a push.

Foreground behaviour is unchanged: the existing 25-second in-page poll and
`maybeNotifyStation` still fire immediately while the tab is open. Push is
purely additive for when it isn't.

---

## 1. Generate VAPID keys

Web Push requires a VAPID keypair that identifies your server to the push
services (Apple's, Google's, etc.).

```bash
cd server
npm install
npx web-push generate-vapid-keys
```

This prints a public and private key. Keep the private key secret.

## 2. Configure the backend

```bash
cp .env.example .env
```

Edit `.env`:

```
VAPID_PUBLIC_KEY=<paste the public key>
VAPID_PRIVATE_KEY=<paste the private key>
VAPID_SUBJECT=mailto:you@example.com
POLL_INTERVAL_MS=30000
PORT=3000
```

Run it locally to confirm it starts:

```bash
npm start
# → "E-bike push server listening on port 3000"
```

Check `http://localhost:3000/api/health` — it should report the station
count it loaded and `activeSubscriptions: 0`.

## 3. Deploy the backend somewhere that stays running

This needs a host that keeps a Node process alive continuously (not a
serverless/edge function that sleeps between requests, since the poll loop
needs to run every 30s regardless of traffic). Reasonable options:

- Render, Railway, or Fly.io — free/cheap tiers, easiest to set up
- A small VPS (DigitalOcean, etc.) running it under `pm2` or `systemd`

Whatever you choose, it must be served over **HTTPS** — browsers refuse to
send push subscriptions to (or register service workers from) an insecure
origin. All of the above give you HTTPS by default.

Set the same environment variables from `.env` in your host's dashboard/
secrets manager.

Note: `subscriptions.json` is a flat file next to `server.js`. That's fine
for personal use, but most hosts wipe the filesystem on redeploy — if that
matters to you, swap `loadSubscriptions`/`saveSubscriptions` in
`server.js` for a real datastore (Postgres, Redis, etc.); the rest of the
code doesn't need to change.

## 4. Point the client at your backend

In `ebike-board-38.html`, find:

```js
var PUSH_SERVER_URL = '';
var VAPID_PUBLIC_KEY = '';
```

Fill both in:

```js
var PUSH_SERVER_URL = 'https://your-app.onrender.com';
var VAPID_PUBLIC_KEY = '<the same public key from step 1>';
```

Until both are set, the app silently skips push and behaves exactly like
before (foreground-only).

## 5. Host the app itself over HTTPS too

`sw.js` must be served from the same origin as the HTML page, at a path
the page can reach with `./sw.js` (i.e., same folder). Anywhere with static
HTTPS hosting works — GitHub Pages, Netlify, Vercel, Cloudflare Pages, S3 +
CloudFront, etc. Keep `manifest.json`, the icons, `sw.js`, and the HTML
file all in the same folder as they are now.

---

## iPhone-specific requirements

This is the part that trips people up, so it's worth being explicit:

1. **iOS 16.4 or later.** Web Push on iOS didn't exist before this.
2. **The app must be added to the Home Screen first.** Safari tabs —
   even pinned ones — cannot receive Web Push on iOS. The user has to:
   Share icon → **Add to Home Screen** → open the app from that icon
   (not from Safari). The app's own "Add to Home Screen" prompt already
   in this project is exactly what gets them there.
3. **Notification permission must be requested from a real tap**, not
   automatically on load. The existing flow (tapping the bell icon → "Start
   watching") already satisfies this — don't call
   `Notification.requestPermission()` on page load or it will silently fail
   on iOS.
4. The **first** time this runs after adding to Home Screen, iOS shows its
   own native "Allow Notifications" prompt — this is separate from, and in
   addition to, the in-app permission prompt.

If someone grants location but never adds the app to their Home Screen,
they'll keep getting foreground-only notifications (the old behaviour) —
there's no way around that on iOS; it's an OS-level restriction, not
something fixable in this code.

## Testing it end to end

1. Deploy the backend, confirm `/api/health` responds.
2. Update and host the HTML with the real `PUSH_SERVER_URL` /
   `VAPID_PUBLIC_KEY`.
3. On an iPhone: add to Home Screen, open from the icon, tap the bell icon,
   pick a duration, tap "Start watching," allow notifications when iOS
   prompts.
4. Check the backend logs / `/api/health` — `activeSubscriptions` should
   go to 1.
5. Lock the phone (or background the app) and wait for a real transition,
   or temporarily lower `POLL_INTERVAL_MS` and watch the console log a
   flip when you'd expect one.

## What still runs client-side vs. server-side

- **Client:** foreground polling/notifying (unchanged), requesting
  notification permission, creating/renewing the push subscription,
  telling the server where you are and how long to watch.
- **Server:** all GBFS polling for push purposes, all transition
  detection for push purposes, nearest-station calculation per
  subscriber, actually sending the push.

The two detection paths (client's `maybeNotifyStation` and the server's
`pollOnce`) are independent and can briefly disagree by a few seconds —
that's expected and harmless; whichever notices first is the one the user
sees.
