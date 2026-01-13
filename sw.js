/* Offline caching for Oʻahu Walking Guide
   Target: narration + UI + routes (and scripts/audio if present).
   Note: Map tiles (OpenStreetMap) are not cached here.
*/
const CACHE_NAME = "oahu-guide-v1-cf9afdad0f";
const PRECACHE_URLS = [
  "./",
  "./app.js",
  "./audio/packs.json",
  "./audio/sample-pack/alii-beach.wav",
  "./audio/sample-pack/aliiolani.wav",
  "./audio/sample-pack/anahulu-bridge.wav",
  "./audio/sample-pack/duke.wav",
  "./audio/sample-pack/haleiwa-town.wav",
  "./audio/sample-pack/iolani.wav",
  "./audio/sample-pack/kailua-beach.wav",
  "./audio/sample-pack/kailua-town.wav",
  "./audio/sample-pack/kapiolani.wav",
  "./audio/sample-pack/kawaiahao.wav",
  "./audio/sample-pack/lanikai-beach.wav",
  "./audio/sample-pack/leahi.wav",
  "./audio/sample-pack/ph-arizona.wav",
  "./audio/sample-pack/ph-lunch.wav",
  "./audio/sample-pack/ph-visitor.wav",
  "./audio/sample-pack/pillboxes.wav",
  "./audio/sample-pack/sunset-beach.wav",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./index.html",
  "./routes.json",
  "./scripts/alii-beach.txt",
  "./scripts/aliiolani.txt",
  "./scripts/anahulu-bridge.txt",
  "./scripts/duke.txt",
  "./scripts/haleiwa-town.txt",
  "./scripts/iolani.txt",
  "./scripts/kailua-beach.txt",
  "./scripts/kailua-town.txt",
  "./scripts/kapiolani.txt",
  "./scripts/kawaiahao.txt",
  "./scripts/lanikai-beach.txt",
  "./scripts/leahi.txt",
  "./scripts/ph-arizona.txt",
  "./scripts/ph-lunch.txt",
  "./scripts/ph-visitor.txt",
  "./scripts/pillboxes.txt",
  "./scripts/sunset-beach.txt"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(async () => {
        // Notify clients that offline cache is ready
        const clients = await self.clients.matchAll({includeUncontrolled:true});
        for (const c of clients) c.postMessage({type:"OFFLINE_READY"});
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k !== CACHE_NAME) ? caches.delete(k) : Promise.resolve()))).then(() => self.clients.claim())
  );
});

// Stale-while-revalidate for same-origin requests.
// If offline, serve from cache; if not in cache, fail gracefully.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, {ignoreSearch:true});

    const fetchPromise = fetch(req).then((res) => {
      // Cache successful GET responses
      if (req.method === "GET" && res && res.ok) {
        cache.put(req, res.clone());
      }
      return res;
    }).catch(() => null);

    // Prefer cached response, update in background
    if (cached) {
      event.waitUntil(fetchPromise);
      return cached;
    }

    // No cache: try network
    const net = await fetchPromise;
    if (net) return net;

    // Fallback for navigation
    if (req.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }

    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  })());
});
