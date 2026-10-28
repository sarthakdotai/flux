// Service worker: shows push notifications from the Flux server, even with no tab open.
self.addEventListener('push', (event) => {
  const note = event.data ? event.data.json() : { title: 'New mail', body: '' };
  event.waitUntil(self.registration.showNotification(note.title, {
    body: note.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: `${note.account}:${note.folder}:${note.uid}`,
    requireInteraction: note.kind === 'otp',
    data: note,
  }));
});

// Clicking a notification focuses Flux (or opens it) at that message.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { account, folder, uid } = event.notification.data || {};
  const target = account ? `/#open=${account}/${encodeURIComponent(folder)}/${uid}` : '/';
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((t) => new URL(t.url).origin === self.location.origin);
    if (tab) {
      await tab.focus();
      return tab.navigate(target);
    }
    return self.clients.openWindow(target);
  })());
});
