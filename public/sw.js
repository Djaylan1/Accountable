self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'Herinnering', {
    body: d.body, tag: d.tag, renotify: true, icon: '/icon-192.png',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
