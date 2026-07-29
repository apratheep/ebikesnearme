// Service worker for background push notifications.
//
// This file must be served from the SAME origin/scope as the app (e.g.
// alongside index.html), over HTTPS. It has two jobs:
//   1. Receive a push message from the backend and turn it into a visible
//      OS/lock-screen notification (the 'push' handler).
//   2. Focus or open the app when the user taps that notification (the
//      'notificationclick' handler).
// It does NOT poll the bike-share API itself — that's done server-side in
// /server, since iOS suspends this worker between push events and won't
// run background timers for us.

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function(event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'E-bike update', body: event.data ? event.data.text() : '' };
  }

  var title = payload.title || 'E-bike update';
  var options = {
    body: payload.body || '',
    tag: payload.tag || 'ebike-update',
    icon: payload.icon || './icon-192.png',
    badge: payload.badge || './icon-192.png',
    // Replaces any existing notification with the same tag instead of
    // stacking, but still vibrates/re-alerts so it isn't missed.
    renotify: true,
    data: { url: payload.url || './' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
