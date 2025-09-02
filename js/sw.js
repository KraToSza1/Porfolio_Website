/* sw.js — PRPL-oriented service worker (v4, 2025-08-19)
   Goals:
   - Fast first paint w/ navigation preload + shell fallback
   - Smart runtime caching (SWR) for CSS/JS/images; cache-first for fonts/planet art
   - Avoid blocking media/range, keep caches trimmed to avoid bloat
   - Clean versioned caches + opt-in skipWaiting via postMessage
*/

const VERSION  = "2025-08-19-v5";
const PRECACHE = `rvdw-precache-${VERSION}`;
const RUNTIME  = `rvdw-runtime-${VERSION}`;
const DEBUG    = false;

/* ---------- App shell (keep tiny!) ---------- */
const PRECACHE_URLS = [
  "/", "/index.html",
  "/css/style.css",
  "/js/main.js",
  "/js/ship3d.js",
  // Consider self-hosting this for lower TBT; CORS on unpkg allows caching:
  "/assets/fonts/starboba/starjedioutline.ttf",
  "/assets/images/profile.png",
  "/assets/images/station.png",
];

/* Tiny transparent PNG fallback for offline images */
const BLANK_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

/* Utils */
const log = (...a) => { if (DEBUG) console.log("[SW]", ...a); };
const warn = (...a) => { if (DEBUG) console.warn("[SW]", ...a); };

async function trimCache(prefix, maxEntries = 12) {
  const cache = await caches.open(RUNTIME);
  const keys  = await cache.keys();
  const group = keys.filter(req => {
    try { return new URL(req.url).pathname.startsWith(prefix); }
    catch { return false; }
  });
  const excess = group.length - maxEntries;
  if (excess > 0) {
    for (let i = 0; i < excess; i++) {
      await cache.delete(group[i]);
    }
  }
}

/* --------------------------- Install --------------------------- */
self.addEventListener("install", event => {
  log("install", VERSION);
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    // 'reload' ensures fresh copies on first install
    await cache.addAll(PRECACHE_URLS.map(u => new Request(u, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

/* --------------------------- Activate -------------------------- */
self.addEventListener("activate", event => {
  log("activate");
  event.waitUntil((async () => {
    if ("navigationPreload" in self.registration) {
      try { await self.registration.navigationPreload.enable(); } catch (e) { warn("nav preload enable failed", e); }
    }
    // Clean old versions
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === PRECACHE || k === RUNTIME) ? Promise.resolve() : caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Allow page to trigger instant activation */
self.addEventListener("message", (event) => {
  const data = event?.data;
  if (data === "SKIP_WAITING" || (data && typeof data === "object" && data.type === "SKIP_WAITING")) {
    self.skipWaiting();
  }
});

/* --------------------------- Fetch ----------------------------- */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // 1) Navigations (HTML): network-first (with preload), 3s timeout, fallback to shell
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;

        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 3000);
        try {
          const fresh = await fetch(req, { signal: controller.signal });
          clearTimeout(t);
          return fresh;
        } catch (err) {
          clearTimeout(t);
          const shell = await caches.match("/index.html", { ignoreSearch: true });
          if (shell) return shell;
          throw err;
        }
      } catch {
        // Minimal offline doc
        return new Response(
          "<!doctype html><meta charset=utf-8><title>Offline</title><h1>Offline</h1><p>Content isn’t cached yet.</p>",
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
    })());
    return;
  }

  // Skip caching streamed media & byte-range requests
  if (req.headers.has("range")) return;
  if (req.destination === "audio" || req.destination === "video") return;

  // 2) Same-origin strategies
  if (url.origin === location.origin) {
    // Fonts: cache-first
    if (req.destination === "font") {
      event.respondWith(cacheFirst(req));
      return;
    }

    // Large planet art: cache-first with LRU trim
    if (url.pathname.startsWith("/assets/planets/") && req.destination === "image") {
      event.respondWith((async () => {
        const response = await cacheFirst(req).catch(() => null);
        // async trim; don’t block response
        event.waitUntil(trimCache("/assets/planets/", 10));
        if (response) return response;
        // Inline data URL fallback (no extra fetch)
        return new Response(Uint8Array.from(atob(BLANK_PNG.split(",")[1]), c => c.charCodeAt(0)), {
          headers: { "Content-Type": "image/png" }
        });
      })());
      return;
    }

    // CSS/JS/Images (other): stale-while-revalidate
    if (["style", "script", "image"].includes(req.destination) || url.pathname.startsWith("/assets/")) {
      const p = staleWhileRevalidate(req);
      event.respondWith(p.response);
      event.waitUntil(p.update); // keep SW alive to finish cache update
      return;
    }
  }

  // 3) Third-party (e.g., unpkg): stale-while-revalidate
  {
    const p = staleWhileRevalidate(req);
    event.respondWith(p.response);
    event.waitUntil(p.update);
  }
});

/* ------------------------- Strategies -------------------------- */
async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreVary: false, ignoreSearch: false });
  if (cached) return cached;
  const resp = await fetch(request);
  if (okToCache(resp)) {
    const copy = resp.clone();
    const cache = await caches.open(RUNTIME);
    await cache.put(request, copy);
  }
  return resp;
}

function staleWhileRevalidate(request) {
  const doSWR = (async () => {
    const cache = await caches.open(RUNTIME);
    const cached = await cache.match(request, { ignoreVary: false, ignoreSearch: false });

    const network = (async () => {
      try {
        const resp = await fetch(request);
        if (okToCache(resp)) await cache.put(request, resp.clone());
        return resp;
      } catch (err) {
        log("SWR network fail", request.url);
        return cached || Promise.reject(err);
      }
    })();

    return { response: cached || network, update: network };
  })();

  // Return a pair: {response, update}
  return {
    response: doSWR.then(x => x.response),
    update:   doSWR.then(x => x.update).catch(() => {})
  };
}

function okToCache(resp) {
  // Cache basic/cors success and opaque third-party responses (e.g., CDN)
  return resp && (resp.status === 200 || resp.type === "opaque");
}
