
/* Service Worker — Mes paiements */

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: 'Mes paiements',
      body: event.data ? event.data.text() : 'Tu as un rappel.'
    };
  }

  const title = data.title || 'Mes paiements';
  const options = {
    body: data.body || data.message || 'Tu as un rappel.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: {
      url: data.url || './'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || './',
    self.location.origin
  ).href;

  event.waitUntil(
    self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(clientList => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.navigate(targetUrl).then(() => client.focus());
        }
      }

      return self.clients.openWindow(targetUrl);
    })
  );
});

