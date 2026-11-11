// Minimal service worker: caches the static app shell ONLY (same-origin, exact known files, no query strings).
// Never caches: Supabase/API calls (cross-origin, not intercepted), auth, approvals, publishing data, signed media URLs, or any URL with a query/hash.
const CACHE = "conlero-approvals-v2";
const SHELL = ["index.html", "styles.css", "app.js", "config.js", "vendor/supabase.min.js", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];
const SHELL_URLS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).href).concat(self.registration.scope));
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.search || !SHELL_URLS.has(u.href)) return; // everything else goes straight to the network
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request)));
});
