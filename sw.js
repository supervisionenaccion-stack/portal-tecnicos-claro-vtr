const CACHE_NAME = "portal-claro-vtr-v1";
const STATIC_ASSETS = ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "logo-cobra.png", "manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first para la pagina principal: los indicadores cambian cada dia,
// asi que nunca hay que servir una version vieja mientras haya conexion.
// Solo se usa el cache si el dispositivo esta sin internet.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const isNavigacion = req.mode === "navigate" || req.url.endsWith("index.html") || req.url.endsWith("/");

  if (isNavigacion) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copia = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
