// Fast byte-level G-code parser. Works on plain .gcode and on decoded .bgcode
// (which may have spaces stripped, e.g. "G1X10Y20E.5").
//
// Produces:
//  - a "move" timeline: every command that moves the head or takes time
//    (heating waits, homing, bed probing, dwells, filament changes)
//  - extrusion segments for rendering
//  - layer table, M73 progress anchors, metadata, thumbnail

import { hwLimitsFor } from './printers.js';

export const Feature = {
  Other: 0, ExternalPerimeter: 1, Perimeter: 2, OverhangPerimeter: 3,
  InternalInfill: 4, SolidInfill: 5, TopSolidInfill: 6, BridgeInfill: 7,
  GapFill: 8, SkirtBrim: 9, Support: 10, SupportInterface: 11,
  WipeTower: 12, Ironing: 13, Custom: 14,
};
export const FeatureNames = [
  'Other', 'External perimeter', 'Perimeter', 'Overhang perimeter',
  'Internal infill', 'Solid infill', 'Top solid infill', 'Bridge infill',
  'Gap fill', 'Skirt / brim', 'Support', 'Support interface',
  'Wipe tower', 'Ironing', 'Custom (purge, etc.)',
];

// Event kinds on the move timeline (0 = plain motion).
export const Ev = {
  None: 0,
  SetNozzle: 1, SetBed: 2,
  WaitNozzle: 3, WaitNozzleAny: 4, WaitBed: 5, WaitBedAny: 6,
  Home: 7, ProbeFull: 8, ProbeArea: 9, ProbeSmall: 10,
  Dwell: 11, FilamentChange: 12, Pause: 13,
};

function featureFromText(t) {
  const s = t.toLowerCase();
  if (s.includes('external') || s.includes('outer') || s === 'wall-outer') return Feature.ExternalPerimeter;
  if (s.includes('overhang')) return Feature.OverhangPerimeter;
  if (s.includes('perimeter') || s.includes('wall')) return Feature.Perimeter;
  if (s.includes('top')) return Feature.TopSolidInfill;
  if (s.includes('bridge')) return Feature.BridgeInfill;
  if (s.includes('solid') || s.includes('skin') || s.includes('bottom')) return Feature.SolidInfill;
  if (s.includes('gap')) return Feature.GapFill;
  if (s.includes('ironing')) return Feature.Ironing;
  if (s.includes('interface')) return Feature.SupportInterface;
  if (s.includes('support')) return Feature.Support;
  if (s.includes('skirt') || s.includes('brim')) return Feature.SkirtBrim;
  if (s.includes('wipe') || s.includes('prime')) return Feature.WipeTower;
  if (s.includes('infill') || s.includes('fill')) return Feature.InternalInfill;
  if (s.includes('custom')) return Feature.Custom;
  return Feature.Other;
}

class GrowF32 {
  constructor(n = 1 << 16) { this.a = new Float32Array(n); this.n = 0; }
  push(v) { if (this.n >= this.a.length) this.grow(); this.a[this.n++] = v; }
  push3(x, y, z) {
    if (this.n + 3 > this.a.length) this.grow();
    const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; a[n + 2] = z; this.n = n + 3;
  }
  grow() { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
  done() { return this.a.slice(0, this.n); }
}
class GrowU32 extends GrowF32 {
  constructor(n = 1 << 16) { super(1); this.a = new Uint32Array(n); }
  grow() { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
}
class GrowU8 extends GrowF32 {
  constructor(n = 1 << 16) { super(1); this.a = new Uint8Array(n); }
  grow() { const b = new Uint8Array(this.a.length * 2); b.set(this.a); this.a = b; }
}

export function parseDuration(str) {
  if (!str) return null;
  let t = 0, found = false;
  const re = /(\d+(?:\.\d+)?)\s*([dhms])/g;
  let m;
  while ((m = re.exec(str))) {
    found = true;
    const v = parseFloat(m[1]);
    t += m[2] === 'd' ? v * 86400 : m[2] === 'h' ? v * 3600 : m[2] === 'm' ? v * 60 : v;
  }
  if (!found && /^\s*\d+(\.\d+)?\s*$/.test(str)) return parseFloat(str);
  return found ? t : null;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Marlin arc settings used by Prusa Buddy firmware (Configuration_MINI_adv.h)
const ARC = { min: 0.1, max: 2.0, perSec: 50, deviation: 0.02 };

const DEFAULTS = {
  accel: 1250, travelAccel: 1250, retractAccel: 1250,
  maxFeed: [180, 180, 12, 80], // mm/s X Y Z E
  maxAccel: [2500, 2500, 400, 5000],
  jerk: 8,
};

/**
 * @param {Uint8Array} src gcode bytes
 * @param {object} opts { onProgress(fraction) }
 */
export function parseGcode(src, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const len = src.length;

  // --- motion state
  let x = 0, y = 0, z = 0, e = 0;          // logical
  let ox = 0, oy = 0, oz = 0;              // G92 offsets (physical = logical + offset)
  let px = 0, py = 0, pz = 0;              // physical
  let feed = 1500 / 60;                    // mm/s
  let absXYZ = true, absE = true;
  let accelPrint = DEFAULTS.accel, accelTravel = DEFAULTS.travelAccel, accelRetract = DEFAULTS.retractAccel;
  const maxFeed = DEFAULTS.maxFeed.slice();
  const maxAccel = DEFAULTS.maxAccel.slice();
  const jerkXYZ = [DEFAULTS.jerk, DEFAULTS.jerk, 0.4];
  let feature = Feature.Other;
  let width = 0.45;
  let layerHeight = 0.2;

  // --- outputs
  const mPos = new GrowF32(1 << 18);  // physical end position per move (x,y,z)
  const mFeed = new GrowF32(1 << 16); // target speed mm/s (or event param)
  const mAccel = new GrowF32(1 << 16);
  const mLen = new GrowF32(1 << 16);  // path length (mm); for E-only moves = |dE|
  const mKind = new GrowU8(1 << 16);  // 0 travel, 1 extrude, 2 E-only, 3 event
  const mEvent = new GrowU8(1 << 16);
  const mParam = new GrowF32(1 << 16);

  const sStart = new GrowF32(1 << 18);
  const sEnd = new GrowF32(1 << 18);
  const sMeta = new GrowF32(1 << 16); // feature*4 + width
  const sMove = new GrowU32(1 << 16);
  const sFan = new GrowU8(1 << 16);   // part-cooling fan 0-255 while extruding
  let fan = 0;

  const layerZ = [];
  const layerSeg = [];
  let curLayerZ = -Infinity;

  const anchors = []; // {move, p, r}
  const silentAnchors = []; // stealth mode M73 Q/S
  const probes = [];
  let printArea = null;
  const hw_ = () => opts.hwLimits || hwLimitsFor(opts.printerModel || config.printer_model);
  const config = {};
  const featuresSeen = new Set();
  let firstExtrudeMove = -1;
  let bbMin = [Infinity, Infinity, Infinity], bbMax = [-Infinity, -Infinity, -Infinity];
  const obMin = [Infinity, Infinity, Infinity], obMax = [-Infinity, -Infinity, -Infinity];
  let filamentChanges = 0;
  let lineCount = 0;

  // thumbnails in comments
  let thumbCollect = null; // {fmt, w, h, parts: []}
  const thumbs = [];

  // params for current line
  const pv = new Float64Array(26);
  const ph = new Uint8Array(26);
  const touched = [];

  function pushMove(kind, lengthMm, speed, accel, ev = 0, param = 0) {
    mPos.push3(px, py, pz);
    mKind.push(kind);
    mLen.push(lengthMm);
    mFeed.push(speed);
    mAccel.push(accel);
    mEvent.push(ev);
    mParam.push(param);
    return mKind.n - 1;
  }
  function pushEvent(ev, param = 0) { return pushMove(3, 0, 0, 0, ev, param); }

  function linearMove(nx, ny, nz, de) {
    const dx = nx - px, dy = ny - py, dz = nz - pz;
    const xyLen2 = dx * dx + dy * dy;
    const len3 = Math.sqrt(xyLen2 + dz * dz);
    if (len3 < 1e-6) {
      if (Math.abs(de) > 1e-6) {
        // retract / unretract
        const sp = Math.min(feed, maxFeed[3]);
        pushMove(2, Math.abs(de), sp, accelRetract);
      }
      return;
    }
    // speed limited per axis
    let v = feed;
    if (dx !== 0) v = Math.min(v, maxFeed[0] * len3 / Math.abs(dx));
    if (dy !== 0) v = Math.min(v, maxFeed[1] * len3 / Math.abs(dy));
    if (dz !== 0) v = Math.min(v, maxFeed[2] * len3 / Math.abs(dz));
    const extruding = de > 1e-6 && xyLen2 > 1e-8;
    let a = extruding ? accelPrint : accelTravel;
    if (dx !== 0) a = Math.min(a, maxAccel[0] * len3 / Math.abs(dx));
    if (dy !== 0) a = Math.min(a, maxAccel[1] * len3 / Math.abs(dy));
    if (dz !== 0) a = Math.min(a, maxAccel[2] * len3 / Math.abs(dz));

    const sx = px, sy = py, sz = pz;
    px = nx; py = ny; pz = nz;
    const mi = pushMove(extruding ? 1 : 0, len3, v, a);

    if (extruding) {
      if (firstExtrudeMove < 0) firstExtrudeMove = mi;
      // layer detection by extrusion height
      if (nz > curLayerZ + 0.009) {
        curLayerZ = nz;
        layerZ.push(nz);
        layerSeg.push(sMove.n);
      } else if (nz < curLayerZ - 0.5) {
        // big drop (rare: e.g. sequential printing) -> new layer
        curLayerZ = nz;
        layerZ.push(nz);
        layerSeg.push(sMove.n);
      }
      sStart.push3(sx, sy, sz);
      sEnd.push3(nx, ny, nz);
      sMeta.push(feature * 4 + Math.min(Math.max(width, 0.05), 3.9));
      sMove.push(mi);
      sFan.push(fan);
      featuresSeen.add(feature);
      if (nx < bbMin[0]) bbMin[0] = nx; if (nx > bbMax[0]) bbMax[0] = nx;
      if (ny < bbMin[1]) bbMin[1] = ny; if (ny > bbMax[1]) bbMax[1] = ny;
      if (nz < bbMin[2]) bbMin[2] = nz; if (nz > bbMax[2]) bbMax[2] = nz;
      if (sx < bbMin[0]) bbMin[0] = sx; if (sx > bbMax[0]) bbMax[0] = sx;
      if (sy < bbMin[1]) bbMin[1] = sy; if (sy > bbMax[1]) bbMax[1] = sy;
      if (feature !== Feature.Custom) {
        for (const [vx, vy, vz] of [[sx, sy, nz], [nx, ny, nz]]) {
          if (vx < obMin[0]) obMin[0] = vx; if (vx > obMax[0]) obMax[0] = vx;
          if (vy < obMin[1]) obMin[1] = vy; if (vy > obMax[1]) obMax[1] = vy;
          if (vz < obMin[2]) obMin[2] = vz; if (vz > obMax[2]) obMax[2] = vz;
        }
      }
    }
  }

  function has(c) { return ph[c.charCodeAt(0) - 65] === 1; }
  function val(c) { return pv[c.charCodeAt(0) - 65]; }

  function handleMotion(code) {
    if (has('F')) { const f = val('F') / 60; if (f > 0) feed = f; }
    let nx = x, ny = y, nz = z, ne = e;
    if (has('X')) nx = absXYZ ? val('X') : x + val('X');
    if (has('Y')) ny = absXYZ ? val('Y') : y + val('Y');
    if (has('Z')) nz = absXYZ ? val('Z') : z + val('Z');
    let de = 0;
    if (has('E')) { if (absE) { de = val('E') - e; ne = val('E'); } else { de = val('E'); ne = e + de; } }

    if (code === 2 || code === 3) {
      // arc: I,J are offsets from start (logical)
      const cx = x + (has('I') ? val('I') : 0);
      const cy = y + (has('J') ? val('J') : 0);
      let a0 = Math.atan2(y - cy, x - cx);
      let a1 = Math.atan2(ny - cy, nx - cx);
      const r = Math.hypot(x - cx, y - cy);
      let sweep = a1 - a0;
      if (code === 2) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; }
      else { if (sweep <= 1e-9) sweep += 2 * Math.PI; }
      const arcLen = Math.abs(sweep) * r;
      // Same segmentation as the printer's firmware (Marlin G2_G3.cpp, Prusa Buddy):
      // segment = clamp(min(sqrt(8 r MAX_ARC_DEVIATION), F / MIN_ARC_SEGMENTS_PER_SEC), MIN, MAX)
      const segMm = Math.min(ARC.max, Math.max(ARC.min, Math.min(Math.sqrt(8 * r * ARC.deviation), feed / ARC.perSec)));
      const n = Math.max(1, Math.min(2000, Math.floor(arcLen / segMm + 0.8)));
      const zs = z, es = de;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const ang = a0 + sweep * t;
        const lx = i === n ? nx : cx + r * Math.cos(ang);
        const ly = i === n ? ny : cy + r * Math.sin(ang);
        const lz = zs + (nz - zs) * t;
        linearMove(lx + ox, ly + oy, lz + oz, es / n);
      }
    } else {
      linearMove(nx + ox, ny + oy, nz + oz, de);
    }
    x = nx; y = ny; z = nz; e = ne;
  }

  function handleCommand(letter, code, sub) {
    if (letter === 71) { // G
      switch (code) {
        case 0: case 1: case 2: case 3: handleMotion(code); break;
        case 4: {
          const secs = has('S') ? val('S') : has('P') ? val('P') / 1000 : 0;
          if (secs > 0) pushEvent(Ev.Dwell, secs);
          break;
        }
        case 28: pushEvent(Ev.Home); x = y = z = 0; px = ox; py = oy; pz = oz; break;
        case 29: {
          // param = index into probes[] (area to probe; null = whole mesh)
          const hasArea = has('W') || has('H');
          const area = hasArea ? { w: has('W') ? val('W') : 0, h: has('H') ? val('H') : 0 } : null;
          if (!has('P') && !has('A')) { probes.push(null); pushEvent(Ev.ProbeFull, probes.length - 1); }
          else if (has('P')) {
            const p = val('P');
            if (p === 1 || p === 9) {
              probes.push(area || printArea);
              pushEvent(hasArea || p === 9 ? Ev.ProbeSmall : Ev.ProbeArea, probes.length - 1);
            }
          }
          break;
        }
        case 90: absXYZ = true; break;
        case 91: absXYZ = false; break;
        case 92: {
          if (has('X')) { ox = px - val('X'); x = val('X'); }
          if (has('Y')) { oy = py - val('Y'); y = val('Y'); }
          if (has('Z')) { oz = pz - val('Z'); z = val('Z'); }
          if (has('E')) e = val('E');
          if (!has('X') && !has('Y') && !has('Z') && !has('E')) { ox = px; oy = py; oz = pz; x = y = z = 0; e = 0; }
          break;
        }
      }
    } else if (letter === 77) { // M
      switch (code) {
        case 82: absE = true; break;
        case 83: absE = false; break;
        case 104: if (has('S')) pushEvent(Ev.SetNozzle, val('S')); break;
        case 140: if (has('S')) pushEvent(Ev.SetBed, val('S')); break;
        case 109:
          if (has('R')) pushEvent(Ev.WaitNozzleAny, val('R'));
          else if (has('S')) pushEvent(Ev.WaitNozzle, val('S'));
          break;
        case 190:
          if (has('R')) pushEvent(Ev.WaitBedAny, val('R'));
          else if (has('S')) pushEvent(Ev.WaitBed, val('S'));
          break;
        case 106: fan = has('S') ? Math.max(0, Math.min(255, Math.round(val('S')))) : 255; break;
        case 107: fan = 0; break;
        case 600: pushEvent(Ev.FilamentChange); filamentChanges++; break;
        case 601: case 0: case 1: case 25: pushEvent(Ev.Pause); break;
        case 73: {
          // P/R = normal mode, Q/S = stealth (silent) mode
          const p = has('P') ? val('P') : NaN, r = has('R') ? val('R') : NaN;
          const q = has('Q') ? val('Q') : NaN, sm = has('S') ? val('S') : NaN;
          if (!isNaN(p) || !isNaN(r)) anchors.push({ move: mKind.n, p, r });
          if (!isNaN(q) || !isNaN(sm)) silentAnchors.push({ move: mKind.n, p: q, r: sm });
          break;
        }
        // The printer clamps these to its hardware limits (Planner::apply_settings)
        case 201: {
          const hw = hw_();
          const L = (i, v) => (hw ? Math.min(v, hw.accel[i]) : v);
          if (has('X')) maxAccel[0] = L(0, val('X')); if (has('Y')) maxAccel[1] = L(1, val('Y'));
          if (has('Z')) maxAccel[2] = L(2, val('Z')); if (has('E')) maxAccel[3] = L(3, val('E'));
          break;
        }
        case 203: {
          const hw = hw_();
          const L = (i, v) => (hw ? Math.min(v, hw.feed[i]) : v);
          if (has('X')) maxFeed[0] = L(0, val('X')); if (has('Y')) maxFeed[1] = L(1, val('Y'));
          if (has('Z')) maxFeed[2] = L(2, val('Z')); if (has('E')) maxFeed[3] = L(3, val('E'));
          break;
        }
        case 205: {
          const hw = hw_();
          const L = (i, v) => (hw ? Math.min(v, hw.jerk[i]) : v);
          if (has('X')) jerkXYZ[0] = L(0, val('X')); if (has('Y')) jerkXYZ[1] = L(1, val('Y')); if (has('Z')) jerkXYZ[2] = L(2, val('Z'));
          break;
        }
        case 555: // print area hint, used by "G29 P1" to probe just that area
          printArea = { x: has('X') ? val('X') : 0, y: has('Y') ? val('Y') : 0, w: has('W') ? val('W') : 0, h: has('H') ? val('H') : 0 };
          break;
        case 204:
          if (has('S')) { accelPrint = accelTravel = val('S'); }
          if (has('P')) accelPrint = val('P');
          if (has('T')) accelTravel = val('T');
          if (has('R')) accelRetract = val('R');
          break;
      }
    }
  }

  function handleComment(s) {
    // s: text after ';' (not trimmed)
    const t = s.trimStart();
    if (thumbCollect) {
      if (/^thumbnail(_\w+)? end/.test(t)) {
        const b64 = thumbCollect.parts.join('');
        if (thumbCollect.fmt !== 'qoi') {
          try { thumbs.push({ format: thumbCollect.fmt, width: thumbCollect.w, height: thumbCollect.h, data: b64ToBytes(b64) }); } catch (_) { /* ignore */ }
        }
        thumbCollect = null;
      } else thumbCollect.parts.push(t.trim());
      return;
    }
    if (t.startsWith('TYPE:')) { feature = featureFromText(t.slice(5).trim()); return; }
    if (t.startsWith('FEATURE:')) { feature = featureFromText(t.slice(8).trim()); return; }
    if (t.startsWith('WIDTH:')) { const w = parseFloat(t.slice(6)); if (w > 0) width = w; return; }
    if (t.startsWith('LINE_WIDTH:')) { const w = parseFloat(t.slice(11)); if (w > 0) width = w; return; }
    if (t.startsWith('HEIGHT:')) { const h = parseFloat(t.slice(7)); if (h > 0) layerHeight = h; return; }
    if (t.startsWith('TIME:')) { config['__cura_time'] = t.slice(5).trim(); return; }
    const tm = /^thumbnail(?:_(\w+))? begin (\d+)x(\d+)/.exec(t);
    if (tm) {
      const fmt = (tm[1] || 'png').toLowerCase();
      thumbCollect = { fmt: fmt === 'jpg' || fmt === 'jpeg' ? 'jpg' : fmt, w: +tm[2], h: +tm[3], parts: [] };
      return;
    }
    const eq = t.indexOf(' = ');
    if (eq > 0 && eq < 80) {
      config[t.slice(0, eq).trim()] = t.slice(eq + 3).trim();
    }
  }

  // --- main loop over bytes
  const td = new TextDecoder();
  let i = 0;
  let nextReport = 1 << 20;
  while (i < len) {
    // find line end
    let end = i;
    while (end < len && src[end] !== 10) end++;
    lineCount++;
    // skip leading whitespace
    let p = i;
    while (p < end && (src[p] === 32 || src[p] === 9)) p++;
    if (p < end) {
      const c0 = src[p];
      if (c0 === 59) { // ';'
        handleComment(td.decode(src.subarray(p + 1, end)).replace(/\r$/, ''));
      } else {
        const letter = c0 & 0xdf;
        if (letter === 71 || letter === 77) {
          // command number
          p++;
          let code = 0, digits = 0;
          while (p < end && src[p] >= 48 && src[p] <= 57) { code = code * 10 + (src[p] - 48); p++; digits++; }
          let sub = -1;
          if (p < end && src[p] === 46) { p++; sub = 0; while (p < end && src[p] >= 48 && src[p] <= 57) { sub = sub * 10 + (src[p] - 48); p++; } }
          if (digits > 0) {
            // params
            for (let k = 0; k < touched.length; k++) ph[touched[k]] = 0;
            touched.length = 0;
            // M117/M118 carry free text; skip their params
            const isText = letter === 77 && (code === 117 || code === 118);
            while (p < end && !isText) {
              const ch = src[p];
              if (ch === 59) break; // comment
              const L = ch & 0xdf;
              if (L >= 65 && L <= 90) {
                p++;
                // parse number
                let neg = false;
                if (p < end && (src[p] === 45 || src[p] === 43)) { neg = src[p] === 45; p++; }
                let intPart = 0, frac = 0, scale = 1, any = false;
                while (p < end && src[p] >= 48 && src[p] <= 57) { intPart = intPart * 10 + (src[p] - 48); p++; any = true; }
                if (p < end && src[p] === 46) {
                  p++;
                  while (p < end && src[p] >= 48 && src[p] <= 57) { frac = frac * 10 + (src[p] - 48); scale *= 10; p++; any = true; }
                }
                const idx = L - 65;
                pv[idx] = any ? (neg ? -(intPart + frac / scale) : intPart + frac / scale) : 0;
                if (!ph[idx]) { ph[idx] = 1; touched.push(idx); }
              } else p++;
            }
            handleCommand(letter, code, sub);
          }
        }
        // T commands and others ignored
      }
    }
    i = end + 1;
    if (i > nextReport) { onProgress(i / len); nextReport += 1 << 20; }
  }
  if (thumbCollect) thumbCollect = null;

  // ---- kinematic duration per move (trapezoid with simple junction model)
  const M = mKind.n;
  const pos = mPos.a, kind = mKind.a, L = mLen.a, V = mFeed.a, A = mAccel.a;
  const raw = new Float32Array(M);
  function dir(k, out) {
    const bx = k > 0 ? pos[(k - 1) * 3] : 0, by = k > 0 ? pos[(k - 1) * 3 + 1] : 0, bz = k > 0 ? pos[(k - 1) * 3 + 2] : 0;
    const l = L[k] || 1;
    out[0] = (pos[k * 3] - bx) / l; out[1] = (pos[k * 3 + 1] - by) / l; out[2] = (pos[k * 3 + 2] - bz) / l;
  }
  const da = [0, 0, 0], db = [0, 0, 0];
  // Classic jerk exactly as Marlin's planner does it (Prusa Buddy has
  // CLASSIC_JERK enabled): take the lower of the two nominal speeds, then scale
  // it until no axis changes speed by more than its jerk limit. An axis that
  // reverses direction counts the larger of the two speeds, not their sum.
  function junction(a, b) {
    if (a < 0 || b >= M) return 0;
    const va = V[a] || 0, vb = V[b] || 0;
    if (kind[a] > 1 || kind[b] > 1) return safeSpeed(kind[a] > 1 ? b : a);
    dir(a, da); dir(b, db);
    const vj = Math.min(va, vb);
    let f = 1;
    for (let ax = 0; ax < 3; ax++) {
      const vx = da[ax] * vj * f, vn = db[ax] * vj * f;
      let j;
      if (vx > vn) j = (vn > 0 || vx < 0) ? vx - vn : Math.max(vx, -vn);
      else j = (vn < 0 || vx > 0) ? vn - vx : Math.max(-vx, vn);
      if (j > jerkXYZ[ax]) f *= jerkXYZ[ax] / j;
    }
    return vj * f;
  }
  // entry speed from standstill: each axis may jump straight to its jerk speed
  function safeSpeed(k) {
    if (k < 0 || k >= M || kind[k] > 1) return 0;
    dir(k, da);
    let v = V[k] || 0;
    for (let ax = 0; ax < 3; ax++) { const c = Math.abs(da[ax]) * v; if (c > jerkXYZ[ax]) v *= jerkXYZ[ax] / c; }
    return v;
  }
  // Look-ahead planning like Marlin: junction limits, then a backward pass
  // (can we still brake in time?) and a forward pass (can we accelerate that
  // much?), then a trapezoid per move. Temperature-set / fan / progress
  // commands don't stop motion; waits, dwells, homing and probing do.
  const ev = mEvent.a;
  const transparent = (k) => kind[k] === 3 && (ev[k] === Ev.SetNozzle || ev[k] === Ev.SetBed);
  const entry = new Float32Array(M);   // max entry speed
  const exitCap = new Float32Array(M); // exit speed if the next thing is a stop
  const next = new Int32Array(M).fill(-1);
  let prevMotion = -1;
  for (let k = 0; k < M; k++) {
    if (transparent(k)) continue;
    const kd = kind[k];
    if (kd === 0 || kd === 1) {
      if (prevMotion >= 0) { next[prevMotion] = k; entry[k] = junction(prevMotion, k); }
      else entry[k] = safeSpeed(k);
      exitCap[k] = safeSpeed(k);
      prevMotion = k;
    } else {
      prevMotion = -1; // retraction, wait, homing... the head stops
    }
  }
  // backward pass
  for (let k = M - 1; k >= 0; k--) {
    if (kind[k] > 1) continue;
    const n = next[k];
    const vExit = n >= 0 ? entry[n] : exitCap[k];
    const a = Math.max(A[k], 50);
    const lim = Math.sqrt(vExit * vExit + 2 * a * L[k]);
    if (entry[k] > lim) entry[k] = lim;
  }
  // forward pass
  for (let k = 0; k < M; k++) {
    if (kind[k] > 1) continue;
    const n = next[k];
    if (n < 0) continue;
    const a = Math.max(A[k], 50);
    const lim = Math.sqrt(entry[k] * entry[k] + 2 * a * L[k]);
    if (entry[n] > lim) entry[n] = lim;
  }
  for (let k = 0; k < M; k++) {
    const kd = kind[k];
    if (kd === 3) { raw[k] = 0; continue; }
    const l = L[k], v = Math.max(V[k], 0.1), a = Math.max(A[k], 50);
    if (kd === 2) { raw[k] = l / v + v / a; continue; }
    const n = next[k];
    const vi = Math.min(entry[k], v), vo = Math.min(n >= 0 ? entry[n] : exitCap[k], v);
    const dAcc = (v * v - vi * vi) / (2 * a);
    const dDec = (v * v - vo * vo) / (2 * a);
    let t;
    if (dAcc + dDec <= l) {
      t = (v - vi) / a + (v - vo) / a + (l - dAcc - dDec) / v;
    } else {
      const vp = Math.sqrt(Math.max((2 * a * l + vi * vi + vo * vo) / 2, 0));
      t = (Math.max(vp, vi) - vi) / a + (Math.max(vp, vo) - vo) / a;
      if (!(t > 0)) t = 2 * l / Math.max(vi + vo, 0.1);
    }
    raw[k] = t;
  }

  // ---- metadata summary
  const meta = { config };
  const estStr = config['estimated printing time (normal mode)'] || config['estimated printing time'] || config['total estimated time'];
  meta.slicerEstimate = parseDuration(estStr);
  meta.silentEstimate = parseDuration(config['estimated printing time (silent mode)']);
  if (meta.slicerEstimate == null && config['__cura_time']) meta.slicerEstimate = parseFloat(config['__cura_time']) || null;

  return {
    moves: {
      pos: mPos.done(), kind: mKind.done(), raw, event: mEvent.done(), param: mParam.done(),
    },
    segs: { start: sStart.done(), end: sEnd.done(), meta: sMeta.done(), move: sMove.done(), fan: sFan.done() },
    layers: { z: Float32Array.from(layerZ), seg: Uint32Array.from(layerSeg) },
    anchors,
    silentAnchors,
    probes,
    firstExtrudeMove,
    bbox: isFinite(obMin[0]) ? { min: obMin, max: obMax } : { min: bbMin, max: bbMax },
    features: [...featuresSeen].sort((a, b) => a - b),
    filamentChanges,
    lineCount,
    meta,
    thumbs,
    layerHeight,
  };
}

export function transferList(result) {
  const m = result.moves, s = result.segs;
  return [m.pos.buffer, m.kind.buffer, m.raw.buffer, m.event.buffer, m.param.buffer,
    s.start.buffer, s.end.buffer, s.meta.buffer, s.move.buffer, s.fan.buffer,
    result.layers.z.buffer, result.layers.seg.buffer,
    ...result.thumbs.map(t => t.data.buffer)];
}
