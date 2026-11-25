const prefix = 'hikari-study-shell-';
const cacheName = prefix + BUILD_VERSION;
const scope = new URL(self.registration.scope);
const assets = new Set(SHELL_PATHS);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    try {
      await cache.addAll([...assets].map(path => new Request(new URL(path, scope), { cache: 'reload' })));
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const old = await caches.keys();
    await Promise.all(old.filter(name => name.startsWith(prefix) && name !== cacheName).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== scope.origin) return;
  const path = event.request.mode === 'navigate' && url.pathname === scope.pathname ? scope.pathname : url.pathname;
  if (!assets.has(path)) return;
  event.respondWith((async () => {
    const cached = await caches.match(new URL(path, scope), { cacheName });
    return cached ?? fetch(event.request);
  })());
});
