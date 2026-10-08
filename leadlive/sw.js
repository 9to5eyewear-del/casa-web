/* Casa Mancini leads (/leadlive) — service worker.
 * The app shell works offline (network first, cache fallback); the API is
 * never cached, so lead data and status changes always hit the server. */
const CACHE = 'casa-leadlive-v13';
const SHELL = [
  '/leadlive',
  '/leadlive/app.css',
  '/leadlive/app.js',
  '/leadlive/manifest.webmanifest',
  '/leadlive/icons/icon-192.png',
  '/leadlive/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (!(url.pathname === '/leadlive' || url.pathname.startsWith('/leadlive/'))) return;

  const key = req.mode === 'navigate' ? '/leadlive' : req;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(key, res.clone());
      return res;
    } catch (err) {
      const cached = await caches.match(key, { ignoreSearch: true });
      if (cached) return cached;
      throw err;
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || 'Casa Mancini';
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/leadlive/icons/icon-192.png',
      badge: '/leadlive/icons/badge-96.png',
      tag: data.tag,
      renotify: Boolean(data.tag),
      lang: 'he',
      dir: 'rtl',
      data: { url: data.url || '/leadlive' },
    });
    // Red number on the app icon (iPhone home screen, installed desktop app).
    if (typeof data.unread === 'number' && self.navigator.setAppBadge) {
      await (data.unread > 0 ? self.navigator.setAppBadge(data.unread) : self.navigator.clearAppBadge()).catch(() => {});
    }
    // Let an open app refresh its list.
    for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'lead' });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/leadlive', location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = windows.find((c) => new URL(c.url).pathname.startsWith('/leadlive'));
    if (app) {
      // Message first: if the browser refuses focus(), the lead still opens.
      app.postMessage({ type: 'open', url });
      await app.focus().catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
