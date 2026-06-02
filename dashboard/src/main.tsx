import React from 'react'
import ReactDOM from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import App from './App'
import './index.css'

const PWA_UPDATE_AVAILABLE_EVENT = 'qmessage:pwa-update-available';
const CHUNK_ERROR_RELOAD_KEY = 'qmessage:chunk-error-reload:v1';
const SERVICE_WORKER_URL = `/sw.js?build=${encodeURIComponent(__QMESSAGE_BUILD_ID__)}`;

const isChunkLoadError = (value: unknown): boolean => {
    const text = String(value ?? '').toLowerCase();
    return (
        text.includes('failed to fetch dynamically imported module')
        || text.includes('importing a module script failed')
        || text.includes('loading chunk')
        || text.includes('chunkloaderror')
        || text.includes('node cannot be found in the current page')
        || text.includes('node cannot be found')
    );
};

const attemptOneTimeChunkRecoveryReload = () => {
    try {
        if (window.sessionStorage.getItem(CHUNK_ERROR_RELOAD_KEY) === '1') return;
        window.sessionStorage.setItem(CHUNK_ERROR_RELOAD_KEY, '1');
    } catch {
        // ignore storage errors
    }
    window.location.reload();
};

window.addEventListener('error', (event) => {
    if (!isChunkLoadError(event?.message) && !isChunkLoadError((event as ErrorEvent)?.error)) return;
    attemptOneTimeChunkRecoveryReload();
});

window.addEventListener('unhandledrejection', (event) => {
    if (!isChunkLoadError((event as PromiseRejectionEvent)?.reason)) return;
    attemptOneTimeChunkRecoveryReload();
});

const dispatchPwaUpdateAvailable = (registration: ServiceWorkerRegistration) => {
    if (!registration.waiting) return;
    window.dispatchEvent(
        new CustomEvent<ServiceWorkerRegistration>(PWA_UPDATE_AVAILABLE_EVENT, {
            detail: registration
        })
    );
};

if ('serviceWorker' in navigator && import.meta.env.PROD && !Capacitor.isNativePlatform()) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register(SERVICE_WORKER_URL)
            .then((registration) => {
                dispatchPwaUpdateAvailable(registration);

                registration.addEventListener('updatefound', () => {
                    const installingWorker = registration.installing;
                    if (!installingWorker) return;

                    installingWorker.addEventListener('statechange', () => {
                        if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            dispatchPwaUpdateAvailable(registration);
                        }
                    });
                });
            })
            .catch((error) => {
                console.warn('Service worker registration failed:', error);
            });
    });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
)
