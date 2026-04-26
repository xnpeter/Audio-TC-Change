const CACHE_NAME = "bwf-timecode-batch-v1";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./bwf-timecode.webmanifest",
  "./bwf-timecode-icon.svg",
  "./bwf-timecode-icon-192.png",
  "./bwf-timecode-icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        const shouldCache = response.ok && new URL(event.request.url).origin === self.location.origin;
        if (shouldCache) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
