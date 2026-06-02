// Service Worker para VidaFarma PWA
// Cache básico para que la app sea instalable y cargue rápido

const CACHE_NAME = "vidafarma-v1";
const APP_SHELL = ["/", "/manifest.json"];

// Instalar: cachear el shell de la app
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

// Activar: limpiar cachés viejos
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first para API y navegación, cache-first para assets estáticos
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // No interceptar peticiones que no sean GET ni las del API/tRPC
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/trpc/")) return;

  // Network-first: intenta red, si falla usa caché (útil offline)
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cachear copia de respuestas exitosas de assets
        if (response.ok && (request.destination === "script" || request.destination === "style" || request.destination === "image" || request.destination === "document")) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
  );
});
