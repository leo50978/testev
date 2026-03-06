const CACHE_VERSION = "domino-static-v1";
const PAGE_CACHE = `${CACHE_VERSION}-pages`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;
const MEDIA_CACHE = `${CACHE_VERSION}-media`;

const CORE_PRECACHE = [
  "/",
  "/index.html",
  "/auth.html",
  "/site.webmanifest",
  "/favicon.ico",
  "/favicon.svg",
  "/favicon-96x96.png",
  "/apple-touch-icon.png",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
  "/hero.jpg",
  "/logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(ASSET_CACHE).then((cache) => cache.addAll(CORE_PRECACHE)).catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => ![PAGE_CACHE, ASSET_CACHE, MEDIA_CACHE].includes(key))
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

function isSameOrigin(requestUrl) {
  return new URL(requestUrl).origin === self.location.origin;
}

function shouldBypassRequest(request) {
  if (request.method !== "GET") return true;
  if (!isSameOrigin(request.url)) return true;

  const url = new URL(request.url);
  if (url.pathname.startsWith("/__/")) return true;
  if (url.pathname.startsWith("/api/")) return true;

  return false;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (_) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw _;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  return cached || fetchPromise;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (shouldBypassRequest(request)) return;

  const destination = request.destination || "";

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, PAGE_CACHE));
    return;
  }

  if (destination === "script" || destination === "style" || destination === "worker") {
    event.respondWith(networkFirst(request, ASSET_CACHE));
    return;
  }

  if (destination === "image" || destination === "font") {
    event.respondWith(staleWhileRevalidate(request, MEDIA_CACHE));
    return;
  }

  event.respondWith(networkFirst(request, ASSET_CACHE));
});
