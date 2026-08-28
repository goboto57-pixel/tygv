self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', e => {
  // offline cache for static assets only, not API
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    caches.open('codeforge-v1').then(c => c.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok) c.put(e.request, res.clone());
      return res;
    })))
  );
});
