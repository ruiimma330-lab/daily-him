/* Daily Him shell. Bump VERSION when the precache list changes. */
const VERSION = 'dh-pwa-1';
const SHELL = `dh-shell-${VERSION}`;
const MEDIA = `dh-media-${VERSION}`;

const PRECACHE = [
  '/offline.html',
  '/pwa.css',
  '/pwa.js',
  '/style.css',
  '/moments.css',
  '/me/me.css',
  '/me/me.js',
  '/brand/brand.css',
  '/brand/brand.js',
  '/brand/wordmark-italic.woff2',
  '/brand/mark.svg',
  '/app.js',
  '/memory.js',
  '/moments.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/login',
  '/shell/cover.html',
  '/shell/shell.css',
  '/shell/shell.js',
  '/shell/copy.json',
  '/shell/picker.css',
  '/shell/picker.js',
  '/shell/pick.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== SHELL && key !== MEDIA).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isApi(url) {
  return url.origin === self.location.origin && url.pathname.startsWith('/api/');
}

function isCharacterConfig(request, url) {
  return request.method === 'GET' && url.pathname === '/api/characters';
}

function isImage(request, url) {
  if (request.method !== 'GET') return false;
  if (request.destination === 'image') return true;
  return url.pathname.startsWith('/characters/') || url.pathname.startsWith('/icons/');
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fresh = fetch(request).then((response) => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);
  return cached || fresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isApi(url)) {
    if (!isCharacterConfig(request, url)) return;
    event.respondWith(staleWhileRevalidate(request, MEDIA));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        return response;
      } catch (_) {
        const cached = await caches.match(request) || await caches.match('/offline.html');
        return cached;
      }
    })());
    return;
  }

  if (isImage(request, url)) {
    event.respondWith(staleWhileRevalidate(request, MEDIA));
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (_) {
      return cached || new Response('', { status: 504 });
    }
  })());
});
