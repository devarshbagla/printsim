// Tiny persistence layer. The file + running print live in IndexedDB so
// closing the tab (or iOS killing it) doesn't lose the session.
// Preferences and per-printer calibration live in localStorage.

const DB = 'printsim';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => { db.close(); resolve(r && r.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export async function idbGet(key) {
  try { return await tx('readonly', s => s.get(key)); } catch (e) { return undefined; }
}
export async function idbSet(key, value) {
  try { await tx('readwrite', s => s.put(value, key)); } catch (e) { console.warn('save failed', e); }
}
export async function idbDel(key) {
  try { await tx('readwrite', s => s.delete(key)); } catch (e) { /* ignore */ }
}

export function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

// ---- calibration: learned ratio actual/predicted motion time per printer
export function getCalibration(printerId) {
  return lsGet(`printsim.calib.${printerId}`, { factor: 1, n: 0 });
}
/** measured = the factor that would have made this print's prediction exact */
export function addCalibration(printerId, measured) {
  const c = getCalibration(printerId);
  const m = Math.min(1.6, Math.max(0.6, measured));
  const w = Math.min(c.n, 4); // recent prints matter most
  const factor = c.n === 0 ? m : (c.factor * w + m) / (w + 1);
  const out = { factor, n: c.n + 1 };
  lsSet(`printsim.calib.${printerId}`, out);
  return out;
}
export function resetCalibration(printerId) {
  lsSet(`printsim.calib.${printerId}`, { factor: 1, n: 0 });
}
