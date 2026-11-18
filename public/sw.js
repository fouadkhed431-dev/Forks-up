const CACHE_PREFIX = 'forks-up-';
const CACHE_VERSION = 'shell-v4';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/forks-up.svg',
  '/forks-up-192.png',
  '/forks-up-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map(async path => {
      try {
        const response = await fetch(path, { cache: 'reload' });
        if (response.ok) await cache.put(path, response);
      } catch {
        // An optional asset must not prevent the app shell from installing.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put('/index.html', response.clone());
    return response;
  } catch {
    const fallback = await cache.match('/index.html') || await cache.match('/');
    return fallback || new Response('Forks Up يحتاج إلى اتصال بالإنترنت لأول تشغيل.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // Vite production bundles are content-hashed and safe to cache by URL.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Only same-origin app resources are cached. Supabase and other external
  // services are intentionally excluded; live/private data is never cached here.
  event.respondWith(cacheFirstAsset(request).catch(async () => {
    const cached = await caches.match(request);
    return cached || new Response('', { status: 503 });
  }));
});
