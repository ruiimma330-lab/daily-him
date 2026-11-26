/* Daily Him shell. Bump VERSION when the precache list changes.
   Code (html/js/css/json) is network-first and only read from THIS version's cache, so an old
   worker or old cache can never pair a stale script with a newer page (the empty-picker bug). */
const VERSION = 'dh-pwa-29';
const SHELL = `dh-shell-${VERSION}`;
const MEDIA = `dh-media-${VERSION}`;

const PRECACHE = [
  '/',
  '/offline.html',
  '/pwa.css',
  '/pwa.js',
  '/mobile-lock.css',
  '/mobile-lock.js',
  '/style.css',
  '/moments.css',
  '/me/me.css',
  '/me/me.js',
  '/brand/brand.css',
  '/brand/brand.js',
  '/brand/wordmark-italic.woff2',
  '/brand/mark.svg',
  '/account-cache.js',
  '/playback.js',
  '/friends-list.js',
  '/app.js',
  '/memory.js',
  '/moments.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/starlight.svg',
  '/login',
  '/shell/cover.html',
  '/shell/starlight.html',
  '/shell/install.html',
  '/shell/install.css',
  '/shell/install.js',
  '/shell/shell.css',
  '/shell/shell.js',
  '/shell/copy.json',
  '/shell/picker.css',
  '/shell/picker-groups.js',
  '/shell/carousel-dots.js',
  '/shell/portrait-loader.js',
  '/shell/picker.js',
  '/shell/pick.html',
  '/sw-heal.js',
];

// Precache best-effort. Never store a redirect (e.g. /login served for a signed-in-only file
// while logged out) under another file's URL. Activate right away instead of waiting for every
// tab/PWA window to close, which on a home-screen app is effectively never.
async function precache() {
  const cache = await caches.open(SHELL);
  await Promise.all(PRECACHE.map(async (path) => {
    try {
      const response = await fetch(new Request(path, { cache: 'reload', credentials: 'same-origin' }));
      if (response && response.ok && !response.redirected) await cache.put(path, response);
    } catch (_) { /* offline copy is optional */ }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
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

// Network first; on failure use this version's cache only (never another version's cache).
async function networkFirst(request, cacheName, fallbackPath) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok && !response.redirected && response.type === 'basic') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (_) {
    const cached = await cache.match(request, { ignoreSearch: true })
      || (fallbackPath ? await cache.match(fallbackPath) : null);
    return cached || new Response('', { status: 504 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fresh = fetch(request).then((response) => {
    if (response && response.ok && !response.redirected) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);
  return cached || fresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Large signed binaries and release metadata must always come from the network.
  if (url.pathname.startsWith('/downloads/') || url.pathname === '/.well-known/assetlinks.json') return;

  // Account data (/api/history, /api/me, /api/profile, and the rest) is never cached.
  // Only the public character list is.
  if (isApi(url)) {
    if (!isCharacterConfig(request, url)) return;
    // The roster changes with deploys (who is open); never show last deploy's list first.
    event.respondWith(networkFirst(request, MEDIA));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (_) {
        const cache = await caches.open(SHELL);
        return (await cache.match(request, { ignoreSearch: true })) || (await cache.match('/offline.html'))
          || new Response('', { status: 504 });
      }
    })());
    return;
  }

  if (isImage(request, url)) {
    event.respondWith(staleWhileRevalidate(request, MEDIA));
    return;
  }

  // Scripts, styles, copy.json, fonts: network first, this version's cache when offline.
  event.respondWith(networkFirst(request, SHELL));
});
