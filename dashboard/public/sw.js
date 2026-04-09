const CACHE_VERSION = 'qmessage-pwa-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const OFFLINE_URL = '/offline.html';

const SHELL_ASSETS = [
    '/manifest.webmanifest',
    '/qmessage-logo.jpg',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/apple-touch-icon.png',
    OFFLINE_URL
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
                .map((key) => caches.delete(key))
        );
        await self.clients.claim();
    })());
});

const networkFirstForNavigation = async (request) => {
    try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch {
        return caches.match(OFFLINE_URL);
    }
};

const staleWhileRevalidate = async (request) => {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request);
    const networkFetch = fetch(request)
        .then((response) => {
            if (response && response.ok) {
                cache.put(request, response.clone());
            }
            return response;
        })
        .catch(() => null);
    if (cached) return cached;
    const networkResponse = await networkFetch;
    return networkResponse || new Response('', { status: 504, statusText: 'Offline' });
};

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const requestUrl = new URL(request.url);
    const isSameOrigin = requestUrl.origin === self.location.origin;

    if (request.mode === 'navigate') {
        event.respondWith(networkFirstForNavigation(request));
        return;
    }

    if (!isSameOrigin) return;
    if (request.destination === 'script' || request.destination === 'style' || request.destination === 'image' || request.destination === 'font') {
        event.respondWith(staleWhileRevalidate(request));
    }
});

self.addEventListener('push', (event) => {
    if (!event.data) return;
    let payload = {};
    try {
        payload = event.data.json();
    } catch {
        payload = { body: event.data.text() };
    }

    const title = payload.title || 'QMessage';
    const options = {
        body: payload.body || 'New WhatsApp update available.',
        icon: payload.icon || '/icons/icon-192.png',
        badge: payload.badge || '/icons/icon-192.png',
        tag: payload.tag || 'qmessage-chat',
        data: {
            url: payload.url || '/'
        }
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const urlToOpen = event.notification.data?.url || '/';
    event.waitUntil((async () => {
        const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientsList) {
            if (client.url.includes(self.location.origin)) {
                client.focus();
                client.postMessage({ type: 'notification-click', url: urlToOpen });
                return;
            }
        }
        self.clients.openWindow(urlToOpen);
    })());
});

self.addEventListener('message', (event) => {
    if (event?.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
