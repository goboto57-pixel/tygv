// Bump this on every deploy. It's the only thing that invalidates the old
// cache — previously it was a hardcoded 'codeforge-v1' that NEVER changed,
// so once a browser cached the app once, it kept serving that exact JS/CSS
// forever, silently ignoring every future deploy. Any client-side fix could
// be shipped and the browser would never see it without the user manually
// clearing site data. Using the build's own script-tag hash isn't available
// here, so we use a timestamp baked in at build/edit time instead — change
// this string every time you ship.
const CACHE_VERSION = 'codeforge-v2-1756415000000';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) return;
  if (e.request.method !== 'GET') return;

  // Network-first: always try to get the latest version first, and only
  // fall back to the cache when actually offline. This is the inverse of
  // the old cache-first behavior, which is what caused fixed code to never
  // reach the browser — cache-first means "serve the old file if we have
  // any copy at all, network be damned". Network-first still gives full
  // offline support (via the cache fallback) without permanently freezing
  // the app on whatever was cached first.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.open(CACHE_VERSION).then((c) => c.match(e.request)))
  );
});
