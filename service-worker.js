const CACHE_NAME = 'chat-app-v1';
const urlsToCache = [
  '/',
  '/index.html'
];

// Install SW
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(urlsToCache);
      })
  );
});

// Listen for requests
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then(() => {
        return fetch(event.request) 
          .catch(() => caches.match('index.html'));
      })
  );
});