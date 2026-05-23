/**
 * sw.js — CH Geladas PDV
 * Service Worker com cache estratégico para PWA offline.
 *
 * Estratégia:
 *   - Shell da app (HTML/CSS/JS locais) → Cache First
 *   - Firebase SDK + APIs externas     → Network First (sem cache)
 *   - Fallback offline: serve do cache se rede falhar
 */

const CACHE_NAME = 'ch-geladas-v1';

// Recursos locais que devem funcionar offline
const SHELL_URLS = [
  '/',
  '/index.html',
  '/core.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/services/firebaseService.js',
  '/services/storeService.js',
  '/services/syncService.js',
  '/services/vendasService.js',
  '/services/estoqueService.js',
  '/services/financeiroService.js',
  '/services/auditService.js',
  '/services/aprovacaoService.js',
  '/services/permissoesService.js',
  '/services/userService.js',
  '/services/backupService.js',
];

// Domínios externos — nunca cachear (Firebase, APIs)
const BYPASS_ORIGINS = [
  'firebaseio.com',
  'googleapis.com',
  'gstatic.com',
  'firebasestorage.app',
  'firebaseapp.com',
  'api.telegram.org',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Deixa APIs externas e Firebase sempre passarem pela rede
  if (BYPASS_ORIGINS.some(origin => url.hostname.includes(origin))) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Para recursos locais: Cache First → fallback rede → fallback cache antigo
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Só cacheia respostas válidas de GET
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline e sem cache: retorna index.html para SPAs
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
