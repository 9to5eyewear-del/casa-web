/* Retired: the leads app moved from /leads to /leadlive.
 * Browsers that installed the old app keep checking this file for updates;
 * this version clears the old cache, unregisters itself and sends any open
 * window to /leadlive, so no old copy keeps running. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await caches.delete('casa-leads-v1');
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (new URL(client.url).pathname.startsWith('/leads')) client.navigate('/leadlive').catch(() => {});
    }
  })());
});
