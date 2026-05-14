// Service Worker desativado temporariamente para testes
// Reativar após confirmar funcionamento

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Passa tudo direto para a rede — sem cache
self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request));
});
