// Network-first service worker: always tries fresh files (so updates land
// immediately) but falls back to cache so the app opens with no signal
// (like in a basement makerspace).
const CACHE = 'printsim-v12';
const CORE = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/renderer.js', 'js/timeline.js', 'js/gcode.js', 'js/bgcode.js',
  'js/printers.js', 'js/physics.js', 'js/materials.js', 'js/printer3d.js', 'js/store.js', 'js/parser.worker.js', 'js/ics.js', 'js/report.js', 'js/recorder.js',
  'vendor/three.module.min.js', 'vendor/OrbitControls.js', 'vendor/RoomEnvironment.js', 'vendor/RoundedBoxGeometry.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
