// Several prints on one device. The lab has a row of MINI+ printers, so one
// person can have two or three jobs going at once. Each print is a "slot":
//   - its own file + session in IndexedDB (print 1 keeps the original keys, so
//     a print that was already running before this existed is untouched)
//   - its own URL (?print=2), so tabs and split-view panes are just pages
//   - a one-line summary in localStorage, so any page can list every print
//     with its time left without loading the other files
import { lsGet, lsSet } from './store.js';

const REG = 'printsim.prints';
const MAX_ID = 99;

/** The print this page shows: ?print=N, default 1. */
export function currentId(search = (typeof location !== 'undefined' ? location.search : '')) {
  const v = new URLSearchParams(search).get('print') || '';
  return /^[1-9]\d?$/.test(v) ? v : '1';
}
export const fileKey = (id) => (String(id) === '1' ? 'file' : `file:${id}`);
export const sessionKey = (id) => (String(id) === '1' ? 'session' : `session:${id}`);

/** URL for a print. Keeps the page path; embed is for split-view panes. */
export function printUrl(id, { embed = false, base = '' } = {}) {
  const q = new URLSearchParams();
  if (String(id) !== '1' || embed) q.set('print', String(id));
  if (embed) q.set('embed', '1');
  const s = q.toString();
  return `${base}${s ? `?${s}` : (base ? '' : '?')}`;
}
export function splitUrl(ids, base = '') { return `${base}?split=${ids.join(',')}`; }
/** ?split=1,3 -> ['1','3'] (2 or 3 valid, distinct ids), or null. */
export function parseSplit(search = (typeof location !== 'undefined' ? location.search : '')) {
  const v = new URLSearchParams(search).get('split');
  if (v == null) return null;
  const ids = [...new Set(v.split(',').filter((x) => /^[1-9]\d?$/.test(x)))].slice(0, 3);
  while (ids.length < 2) ids.push(nextId(ids));
  return ids;
}

// ---- registry ---------------------------------------------------------------
export function listPrints(store = lsGet) {
  const all = store(REG, []);
  return (Array.isArray(all) ? all : [])
    .filter((p) => p && /^[1-9]\d?$/.test(String(p.id)))
    .sort((a, b) => Number(a.id) - Number(b.id));
}
export function putPrint(entry, store = lsGet, save = lsSet) {
  const rest = listPrints(store).filter((p) => String(p.id) !== String(entry.id));
  save(REG, [...rest, entry].sort((a, b) => Number(a.id) - Number(b.id)));
}
export function dropPrint(id, store = lsGet, save = lsSet) {
  save(REG, listPrints(store).filter((p) => String(p.id) !== String(id)));
}
/** Smallest free id. */
export function nextId(ids) {
  const used = new Set(ids.map(String));
  for (let i = 1; i <= MAX_ID; i++) if (!used.has(String(i))) return String(i);
  return String(MAX_ID);
}

/** Ids for an n-pane split: the current print first, then the others, then new slots. */
export function splitIds(current, ids, n) {
  const out = [String(current)];
  for (const id of ids.map(String)) if (out.length < n && !out.includes(id)) out.push(id);
  while (out.length < n) out.push(nextId(out.concat(ids.map(String))));
  return out;
}

/** What a page stores about its print, so other pages can show it. */
export function summary({ id, mode, fileName, unitName, color, run, total }) {
  const e = { id: String(id), mode: mode || 'empty', file: fileName || '', unit: unitName || '', color: color || '', updated: Date.now() };
  if (mode === 'run' && run && total > 0) {
    e.total = total;
    e.running = !!run.running;
    e.anchorWall = run.anchorWall;
    e.anchorSim = run.anchorSim;
  }
  return e;
}

/** Live status of a print from its summary. */
export function statusOf(e, now = Date.now()) {
  if (!e || !e.file || e.mode === 'empty') return { state: 'empty', frac: 0, left: null, eta: null };
  if (e.mode === 'setup') return { state: 'setup', frac: 0, left: null, eta: null };
  if (e.mode === 'done') return { state: 'done', frac: 1, left: 0, eta: null };
  if (e.mode !== 'run' || !(e.total > 0)) return { state: 'setup', frac: 0, left: null, eta: null };
  const sim = e.running ? e.anchorSim + (now - e.anchorWall) / 1000 : e.anchorSim;
  const left = Math.max(0, e.total - sim);
  const frac = Math.min(1, Math.max(0, sim / e.total));
  if (!e.running) return { state: 'paused', frac, left, eta: null };
  return { state: left > 0 ? 'run' : 'over', frac, left, eta: now + left * 1000 };
}

/** Short name: the printer's name if it has one, else "Print N". */
export function labelOf(e, id) {
  return (e && e.unit) || `Print ${id}`;
}
