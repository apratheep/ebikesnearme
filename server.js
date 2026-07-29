// E-bike availability push backend
// --------------------------------
// Polls the Bike Share Toronto GBFS feed on a server-side timer (so it keeps
// running even when every user's phone is locked/backgrounded), detects
// e-bike-availability transitions at each station, and sends a Web Push
// notification to any subscribed device whose nearest stations were
// affected.
//
// Setup:
//   cd server
//   npm install
//   npx web-push generate-vapid-keys        # copy the two keys out
//   cp .env.example .env                    # then fill in the keys + your email
//   npm start
//
// See ../README-push-setup.md for full deployment + iOS instructions.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const STATION_INFO_URL = 'https://tor.publicbikesystem.net/ube/gbfs/v1/en/station_information';
const STATION_STATUS_URL = 'https://tor.publicbikesystem.net/ube/gbfs/v1/en/station_status';
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. Run `npx web-push generate-vapid-keys` and set them in .env');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ---------------------------------------------------------------------
// Very small file-backed subscription store. Fine for a personal-scale
// deployment; swap for a real database (Postgres/SQLite/etc.) if this
// grows beyond a handful of users.
// ---------------------------------------------------------------------
/** @type {Record<string, {subscription: object, lat: number, lon: number, watchCount: number, expiresAt: number}>} */
let subscriptions = {};

function loadSubscriptions() {
  try {
    subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch (e) {
    subscriptions = {};
  }
}

function saveSubscriptions() {
  fs.writeFile(SUBS_FILE, JSON.stringify(subscriptions, null, 2), function(err) {
    if (err) console.error('Failed to persist subscriptions:', err.message);
  });
}

loadSubscriptions();

// ---------------------------------------------------------------------
// GBFS polling + transition detection
// ---------------------------------------------------------------------
/** @type {Record<string, {id:string, name:string, lat:number, lon:number}>} */
let stationInfo = {};
/** @type {Record<string, number>} station_id -> previous e-bike count */
let prevEbikes = {};
let stationInfoLoadedAt = 0;

async function loadStationInfo() {
  const resp = await fetch(STATION_INFO_URL);
  const data = await resp.json();
  const next = {};
  for (const s of data.data.stations) {
    next[s.station_id] = { id: s.station_id, name: s.name, lat: s.lat, lon: s.lon };
  }
  stationInfo = next;
  stationInfoLoadedAt = Date.now();
  console.log('Loaded station_information:', Object.keys(stationInfo).length, 'stations');
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestStationIds(lat, lon, count) {
  return Object.values(stationInfo)
    .map(function(s) { return { id: s.id, d: distanceKm(lat, lon, s.lat, s.lon) }; })
    .sort(function(a, b) { return a.d - b.d; })
    .slice(0, count)
    .map(function(x) { return x.id; });
}

async function pollOnce() {
  // Refresh station_information roughly hourly — it almost never changes.
  if (Date.now() - stationInfoLoadedAt > 60 * 60 * 1000) {
    await loadStationInfo().catch(function(e) { console.error('station_information fetch failed:', e.message); });
  }

  const resp = await fetch(STATION_STATUS_URL);
  const data = await resp.json();
  const list = data.data.stations;

  /** @type {Array<{id:string, name:string, type:'available'|'empty', ebikes:number}>} */
  const flips = [];

  for (const s of list) {
    const id = s.station_id;
    const types = s.num_bikes_available_types || {};
    const ebikes = typeof types.ebike === 'number' ? types.ebike : 0;
    const prev = Object.prototype.hasOwnProperty.call(prevEbikes, id) ? prevEbikes[id] : null;

    if (prev === 0 && ebikes > 0) {
      flips.push({ id: id, name: (stationInfo[id] || {}).name || 'A station', type: 'available', ebikes: ebikes });
    } else if (prev !== null && prev > 0 && ebikes === 0) {
      flips.push({ id: id, name: (stationInfo[id] || {}).name || 'A station', type: 'empty', ebikes: 0 });
    }
    prevEbikes[id] = ebikes;
  }

  if (flips.length === 0) return;
  await notifySubscribers(flips);
}

async function notifySubscribers(flips) {
  const now = Date.now();
  let dirty = false;

  for (const endpoint of Object.keys(subscriptions)) {
    const sub = subscriptions[endpoint];

    if (sub.expiresAt && now >= sub.expiresAt) {
      delete subscriptions[endpoint];
      dirty = true;
      continue;
    }

    const watchIds = nearestStationIds(sub.lat, sub.lon, sub.watchCount || 4);
    const relevant = flips.filter(function(f) { return watchIds.indexOf(f.id) !== -1; });
    if (relevant.length === 0) continue;

    for (const flip of relevant) {
      const payload = flip.type === 'available'
        ? { title: 'E-bike available', body: flip.name + ' now has ' + flip.ebikes + ' e-bike' + (flip.ebikes === 1 ? '' : 's') + ' available.', tag: 'ebike-available-' + flip.id }
        : { title: 'E-bikes gone', body: flip.name + ' is out of e-bikes.', tag: 'ebike-empty-' + flip.id };

      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
      } catch (err) {
        // 404/410 means the subscription is no longer valid on the browser's end.
        if (err.statusCode === 404 || err.statusCode === 410) {
          delete subscriptions[endpoint];
          dirty = true;
        } else {
          console.error('Push failed for', endpoint.slice(-12), err.statusCode, err.body);
        }
      }
    }
  }

  if (dirty) saveSubscriptions();
}

function startPolling() {
  pollOnce().catch(function(e) { console.error('Initial poll failed:', e.message); });
  setInterval(function() {
    pollOnce().catch(function(e) { console.error('Poll failed:', e.message); });
  }, POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/vapid-public-key', function(req, res) {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', function(req, res) {
  const { subscription, lat, lon, watchCount, expiresAt } = req.body || {};
  if (!subscription || !subscription.endpoint || typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'subscription, lat, and lon are required' });
  }
  subscriptions[subscription.endpoint] = {
    subscription: subscription,
    lat: lat,
    lon: lon,
    watchCount: watchCount || 4,
    expiresAt: typeof expiresAt === 'number' ? expiresAt : (Date.now() + 15 * 60000)
  };
  saveSubscriptions();
  res.json({ ok: true });
});

app.post('/api/unsubscribe', function(req, res) {
  const { endpoint } = req.body || {};
  if (endpoint && subscriptions[endpoint]) {
    delete subscriptions[endpoint];
    saveSubscriptions();
  }
  res.json({ ok: true });
});

app.get('/api/health', function(req, res) {
  res.json({
    ok: true,
    stations: Object.keys(stationInfo).length,
    activeSubscriptions: Object.keys(subscriptions).length
  });
});

loadStationInfo()
  .then(startPolling)
  .catch(function(e) {
    console.error('Failed to load station_information at startup:', e.message);
    startPolling(); // still start; it'll retry inside pollOnce()
  });

app.listen(PORT, function() {
  console.log('E-bike push server listening on port ' + PORT);
});
