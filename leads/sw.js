/* Casa Mancini leads — service worker.
 * The app shell works offline (network first, cache fallback); the API is
 * never cached, so lead data and status changes always hit the server. */
const CACHE = 'casa-leads-v1';
const SHELL = [
  '/leads',
  '/leads/app.css',
  '/leads/app.js',
  '/leads/manifest.webmanifest',
  '/leads/icons/icon-192.png',
  '/leads/icons/apple-touch-icon.png',
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
  if (!(url.pathname === '/leads' || url.pathname.startsWith('/leads/'))) return;

  const key = req.mode === 'navigate' ? '/leads' : req;
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
      icon: '/leads/icons/icon-192.png',
      badge: '/leads/icons/badge-96.png',
      tag: data.tag,
      renotify: Boolean(data.tag),
      lang: 'he',
      dir: 'rtl',
      data: { url: data.url || '/leads' },
    });
    // Let an open app refresh its list.
    for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'lead' });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/leads', location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = windows.find((c) => new URL(c.url).pathname.startsWith('/leads'));
    if (app) {
      await app.focus();
      app.postMessage({ type: 'open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
