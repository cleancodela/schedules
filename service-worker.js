/**
 * service-worker.js — GMCLA Schedule PWA
 *
 * Strategy:
 *   gmcla-schedule-data.json  → stale-while-revalidate
 *     Serve cached copy instantly; revalidate from network in background.
 *     If the JSON has changed, update the cache and notify open pages to
 *     re-render via postMessage({ type: 'DATA_UPDATED' }).
 *
 *   gmcla-pride.html          → network-first, cache fallback (offline support)
 *   Everything else           → pass-through (no caching)
 */

const CACHE_NAME  = 'gmcla-v1';
const DATA_FILE   = 'gmcla-schedule-data.json';
const HTML_FILE   = 'gmcla-pride.html';

/* ─── Install: pre-cache the two files we manage ─────────────────── */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([`./${HTML_FILE}`, `./${DATA_FILE}`]).catch(() => {
        // If prefetch fails (e.g. data file doesn't exist yet) continue anyway
      })
    )
  );
  // Take control immediately without waiting for old SW to be released
  self.skipWaiting();
});

/* ─── Activate: remove stale caches ──────────────────────────────── */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ─── Fetch handler ───────────────────────────────────────────────── */

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const file = url.pathname.split('/').pop();

  if (file === DATA_FILE) {
    event.respondWith(handleDataFile(event.request));
  } else if (file === HTML_FILE || url.pathname.endsWith('/')) {
    event.respondWith(handleHTML(event.request));
  }
  // All other requests (images, fonts, etc.) pass through unmodified
});

/* ─── Stale-while-revalidate for the JSON data file ──────────────── */

async function handleDataFile(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Background revalidation — don't await
  revalidate(request, cached, cache);

  // Serve cached copy immediately, or wait for network if not yet cached
  if (cached) return cached;

  try {
    const netRes = await fetch(request);
    if (netRes.ok) await cache.put(request, netRes.clone());
    return netRes;
  } catch (_) {
    // Offline and nothing cached — return empty schedule so page doesn't crash
    return new Response(JSON.stringify({ syncedAt: null, schedule: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Fetch data file from network.  If it differs from the cached version,
 * update the cache and notify all open page clients to re-render.
 */
async function revalidate(request, cached, cache) {
  try {
    const netRes = await fetch(request);
    if (!netRes.ok) return;

    const netText = await netRes.text();

    if (cached) {
      const cachedText = await cached.text();
      if (cachedText === netText) return; // no change — nothing to do
      // Data changed: update cache then notify clients
      await cache.put(request, new Response(netText, {
        headers: { 'Content-Type': 'application/json' },
      }));
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach((c) => c.postMessage({ type: 'DATA_UPDATED' }));
    } else {
      // First network response — just cache it
      await cache.put(request, new Response(netText, {
        headers: { 'Content-Type': 'application/json' },
      }));
    }
  } catch (_) {
    // Offline — nothing to do
  }
}

/* ─── Network-first with cache fallback for the HTML page ────────── */

async function handleHTML(request) {
  try {
    const netRes = await fetch(request);
    if (netRes.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, netRes.clone());
    }
    return netRes;
  } catch (_) {
    // Offline — serve from cache
    const cached = await caches.match(request);
    return cached || new Response('Offline — schedule not cached yet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
