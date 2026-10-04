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

// ---- your printers: each physical MINI learns its own speed ----------------
// Two MINIs of the same model don't run the same: worn belts, a different
// firmware, a slower heater. So the lab's printers can be named, and each one
// gets its own calibration (key printsim.calib.unit.<id>). Every finished print
// also teaches the model-wide pool, which a newly named printer uses until it
// has a print of its own.
const UNITS = 'printsim.units';
export function listUnits(model) {
  const all = lsGet(UNITS, []);
  return Array.isArray(all) ? all.filter((u) => u && u.id && (!model || u.model === model)) : [];
}
export function getUnit(id) { return id ? listUnits().find((u) => u.id === id) || null : null; }
export function addUnit(model, name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!clean) return null;
  const units = listUnits();
  const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  units.push({ id, model, name: clean });
  lsSet(UNITS, units);
  return id;
}
export function removeUnit(id) {
  lsSet(UNITS, listUnits().filter((u) => u.id !== id));
  try { localStorage.removeItem(`printsim.calib.unit.${id}`); } catch (e) { /* ignore */ }
}
/** The calibration a prediction uses: this printer's own once it has one, else the model's. */
export function effectiveCalibration(printerId, unitId) {
  const model = getCalibration(printerId);
  const unit = unitId && getUnit(unitId) ? getCalibration(`unit.${unitId}`) : null;
  if (unit && unit.n > 0) return { factor: unit.factor, n: unit.n, scope: 'unit', model };
  return { factor: model.factor, n: model.n, scope: 'model', model, unit };
}
/** A finished print teaches its own printer (if named) and the model-wide pool. */
export function learnCalibration(printerId, unitId, measured) {
  const model = addCalibration(printerId, measured);
  const unit = unitId && getUnit(unitId) ? addCalibration(`unit.${unitId}`, measured) : null;
  return { model, unit };
}
