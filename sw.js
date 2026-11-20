'use strict';
// Cache only this app's files. Never store diary data or clear localStorage here.
const PREFIX = 'ann-diary-pwa:' + self.registration.scope + ':';
const CACHE = PREFIX + 'v2-record-feedback';
const appURL = name => new URL(name, self.registration.scope).href;
const FILES = ['./', './index.html', './family-journal.html', './pwa.js',
  './manifest.webmanifest', './app-icon.svg', './icon-192.png', './icon-512.png',
  './icon-maskable-512.png', './apple-touch-icon.png'];
const FILE_URLS = new Set(FILES.map(appURL));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES.map(file => new Request(appURL(file), {cache: 'reload'})));
  })());
  // Future updates wait for existing windows to close, protecting unsaved input.
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function navigation(request) {
  const cache = await caches.open(CACHE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(request, {signal: controller.signal});
    if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) {
      // Keep each entry URL current without replacing other entry points.
      const key = new URL(request.url); key.search = ''; key.hash = '';
      await cache.put(key.href, response.clone());
      return response;
    }
    return (await cache.match(appURL('./index.html'))) || response;
  } catch (error) {
    const cached = await cache.match(appURL('./index.html'));
    if (cached) return cached;
    return new Response('尚未完成離線準備，請連上網路後再開啟小日子。', {
      status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}
    });
  } finally {clearTimeout(timer);}
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const clean = new URL(url); clean.search = ''; clean.hash = '';
  if (!FILE_URLS.has(clean.href)) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request)); return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Assets are versioned with the worker to avoid mixing incompatible releases.
    const cached = await cache.match(clean.href);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(clean.href, response.clone());
    return response;
  })());
});
