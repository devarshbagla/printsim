// "Will this print in mid-air?" analysis.
//
// The G-code only says where the nozzle goes, not what's underneath it, so we
// rebuild that: walk the layers bottom-up keeping a height map of every strand
// that actually stayed put, and check each new strand for material right below.
//
//  - A strand may sit up to layerHeight * tan(overhang angle) past the one
//    below it. The angle depends on the filament and, for PLA especially, on
//    the part-cooling fan speed at that moment (M106/M107 in the file).
//  - Unsupported stretch anchored on both ends and roughly straight -> bridge.
//    It prints, but sags a little (more for PETG/TPU, more with the fan off).
//  - Short unsupported stretch (<= cantilever limit) -> fine.
//  - Anything else (cantilevered, U-turning, floating islands) -> falls.
//
// Fallen strands never enter the height map, so whatever gets printed on top of
// them fails too. That's how real "spaghetti" failures cascade.

import { MATERIALS, limitsFor } from './materials.js';

const CELL = 0.25;   // height-map resolution (mm)
const SAMPLE = 0.4;  // mm between support samples along a strand
const SAG_MIN = 0.06; // mm; smaller sag isn't worth drawing

export function analyzeSupport(segs, layers, opts = {}) {
  const mat = MATERIALS[opts.material] || MATERIALS.PLA;
  const temp = opts.temp || null;
  // slicers pull the first layer's outline in (elephant-foot compensation) and
  // print it wider, so layer 2's outer wall legitimately sits further out
  const layer2Bonus = (opts.elephantFoot || 0) + Math.max(0, ((opts.firstLayerWidth || 0.45) - 0.45) / 2);
  const { start, end, meta } = segs;
  const fan = segs.fan;
  const S = segs.meta.length;
  const drop = new Float32Array(S);
  const layerSeg = layers.seg, layerZ = layers.z;
  const NL = layerZ.length;
  const summary = {
    failedSegments: 0, failedLength: 0, totalLength: 0, firstLayer: -1, lastLayer: -1, layersAffected: 0,
    bridges: 0, maxSag: 0, material: opts.material || 'PLA',
  };
  const segSampleStart = new Uint32Array(S + 1);
  let sampleSag = new Float32Array(1 << 16);
  let sampleCount = 0;
  if (!S || !NL) { summary.failedFraction = 0; return { drop, segSampleStart, sampleSag, summary }; }

  // grid bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < S; i++) {
    const a = start[i * 3], b = start[i * 3 + 1], c = end[i * 3], d = end[i * 3 + 1];
    if (a < minX) minX = a; if (c < minX) minX = c; if (a > maxX) maxX = a; if (c > maxX) maxX = c;
    if (b < minY) minY = b; if (d < minY) minY = d; if (b > maxY) maxY = b; if (d > maxY) maxY = d;
  }
  minX -= 3; minY -= 3; maxX += 3; maxY += 3;
  const W = Math.max(1, Math.ceil((maxX - minX) / CELL)), H = Math.max(1, Math.ceil((maxY - minY) / CELL));
  const top = new Float32Array(W * H).fill(-1);
  // same-layer contact map: cells covered by strands of this layer that are
  // supported from below. A strand pressed against one of those is bonded
  // sideways (one hop only, so overhangs can't creep outward row by row).
  const side = new Uint32Array(W * H);

  // neighbour offsets sorted by distance, so lookups can stop early
  const MAXR = 2.0;
  const rc = Math.ceil(MAXR / CELL) + 1;
  const offs = [];
  for (let dy = -rc; dy <= rc; dy++) for (let dx = -rc; dx <= rc; dx++) offs.push([dx, dy, Math.hypot(dx, dy) * CELL]);
  offs.sort((a, b) => a[2] - b[2]);
  const offDX = Int32Array.from(offs, o => o[0]), offDY = Int32Array.from(offs, o => o[1]), offD = Float32Array.from(offs, o => o[2]);

  const cx = (x) => { const c = Math.floor((x - minX) / CELL); return c < 0 ? 0 : c >= W ? W - 1 : c; };
  const cy = (y) => { const c = Math.floor((y - minY) / CELL); return c < 0 ? 0 : c >= H ? H - 1 : c; };
  // is there material at height >= need within radius r of (x,y)?
  const supportedAt = (x, y, r, need) => {
    const X = cx(x), Y = cy(y);
    const lim = r + CELL * 0.71;
    for (let k = 0; k < offD.length; k++) {
      if (offD[k] > lim) return false;
      const xx = X + offDX[k], yy = Y + offDY[k];
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (top[yy * W + xx] >= need) return true;
    }
    return false;
  };
  const touchesSide = (x, y, r, tag) => {
    const X = cx(x), Y = cy(y);
    const lim = r + CELL * 0.71;
    for (let k = 0; k < offD.length; k++) {
      if (offD[k] > lim) return false;
      const xx = X + offDX[k], yy = Y + offDY[k];
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (side[yy * W + xx] === tag) return true;
    }
    return false;
  };
  const localTop = (x, y) => {
    const X = cx(x), Y = cy(y);
    let m = -1;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = X + dx, yy = Y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const v = top[yy * W + xx]; if (v > m) m = v;
    }
    return m;
  };
  const stamp = (i, z) => {
    const x0 = start[i * 3], y0 = start[i * 3 + 1], x1 = end[i * 3], y1 = end[i * 3 + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / (CELL * 0.5)));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const j = cy(y0 + (y1 - y0) * t) * W + cx(x0 + (x1 - x0) * t);
      if (top[j] < z) top[j] = z;
    }
  };

  const firstZ = layerZ[0];
  let sSeg = new Int32Array(4096), sOk = new Uint8Array(4096), sX = new Float32Array(4096), sY = new Float32Array(4096), sLen = new Float32Array(4096), sIdx = new Int32Array(4096);
  const segFailSamples = new Uint16Array(S);
  const segSamples = new Uint16Array(S);
  const limCache = new Map();
  const lim = (i) => {
    const f = fan ? fan[i] : 255;
    let v = limCache.get(f);
    if (!v) { v = limitsFor(mat, f / 255, temp); limCache.set(f, v); }
    return v;
  };

  let rng = 12345;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

  for (let L = 0; L < NL; L++) {
    const s0 = layerSeg[L], s1 = L + 1 < NL ? layerSeg[L + 1] : S;
    const z = layerZ[L];
    const prevZ = L > 0 ? layerZ[L - 1] : 0;
    const h = Math.max(z - prevZ, 0.05);
    const need = z - h * 1.6 - 0.01;
    const onBed = z <= firstZ + 0.05;

    // reserve per-sample sag storage for this layer
    for (let i = s0; i < s1; i++) segSampleStart[i] = sampleCount;

    if (!onBed) {
      let p = s0;
      while (p < s1) {
        let q = p + 1;
        while (q < s1 &&
          Math.abs(start[q * 3] - end[(q - 1) * 3]) < 1e-3 &&
          Math.abs(start[q * 3 + 1] - end[(q - 1) * 3 + 1]) < 1e-3) q++;
        let n = 0;
        for (let i = p; i < q; i++) {
          const x0 = start[i * 3], y0 = start[i * 3 + 1], x1 = end[i * 3], y1 = end[i * 3 + 1];
          const len = Math.hypot(x1 - x0, y1 - y0);
          const k = Math.max(1, Math.ceil(len / SAMPLE));
          segSamples[i] = k;
          segSampleStart[i] = sampleCount;
          if (sampleCount + k >= sampleSag.length) { const B = new Float32Array(sampleSag.length * 2); B.set(sampleSag); sampleSag = B; }
          if (n + k >= sSeg.length) {
            const g = (A, T) => { const B = new T(A.length * 2); B.set(A); return B; };
            sSeg = g(sSeg, Int32Array); sOk = g(sOk, Uint8Array); sX = g(sX, Float32Array); sY = g(sY, Float32Array); sLen = g(sLen, Float32Array); sIdx = g(sIdx, Int32Array);
          }
          const w = meta[i] - Math.floor(meta[i] / 4 + 1e-3) * 4;
          // a strand can always hang half its width past the one below
          let r = Math.max(h * lim(i).tan, w * 0.5 + 0.05);
          if (L === 1) r += layer2Bonus;
          for (let j = 0; j < k; j++) {
            const t = (j + 0.5) / k;
            const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
            sSeg[n] = i; sX[n] = x; sY[n] = y; sLen[n] = len / k; sIdx[n] = sampleCount;
            sampleSag[sampleCount++] = 0;
            sOk[n] = supportedAt(x, y, r, need) ? 1 : touchesSide(x, y, w * 1.05, L + 1) ? 2 : 0;
            n++;
          }
        }
        const closed = q - p > 2 && Math.hypot(end[(q - 1) * 3] - start[p * 3], end[(q - 1) * 3 + 1] - start[p * 3 + 1]) < 0.05;
        let off = 0, anyOk = false;
        for (let j = 0; j < n; j++) if (sOk[j]) { anyOk = true; if (closed) off = j; break; }
        if (!anyOk) {
          for (let j = 0; j < n; j++) segFailSamples[sSeg[j]]++;
        } else {
          let j = 0;
          while (j < n) {
            const a = (j + off) % n;
            if (sOk[a]) { j++; continue; }
            let r = j, runLen = 0;
            while (r < n && !sOk[(r + off) % n]) { runLen += sLen[(r + off) % n]; r++; }
            let lm = lim(sSeg[a]);
            // sparse infill is hidden and forgiving: gyroid & co. wiggle across
            // the lines below them, so only require anchors, not a straight span
            const sparse = Math.floor(meta[sSeg[a]] / 4 + 1e-3) === 4;
            if (sparse) lm = { ...lm, cantilever: lm.cantilever * 3, bridge: lm.bridge * 1.5 };
            const startAnch = closed || j > 0;
            const endAnch = closed || r < n;
            let ok = runLen <= lm.cantilever;
            let bridged = false;
            if (!ok && startAnch && endAnch && runLen <= lm.bridge) {
              const aPrev = (j - 1 + off + n) % n, aNext = (r + off) % n;
              const span = Math.hypot(sX[aNext] - sX[aPrev], sY[aNext] - sY[aPrev]);
              ok = bridged = sparse || span >= 0.6 * runLen; // straight-ish span, not a U-turn
            }
            if (!ok) {
              if (opts.debug && opts.debug(L, { runLen, startAnch, endAnch, sparse, closed, lm, x: sX[a], y: sY[a], n, j, r }));
              for (let k = j; k < r; k++) segFailSamples[sSeg[(k + off) % n]]++;
            } else if (bridged || (startAnch && endAnch && runLen > 2)) {
              // it holds, but droops a bit in the middle
              const maxSag = Math.min(4, lm.sag * runLen * runLen / 10);
              if (maxSag >= SAG_MIN) {
                summary.bridges++;
                if (maxSag > summary.maxSag) summary.maxSag = maxSag;
                let acc = 0;
                for (let k = j; k < r; k++) {
                  const aa = (k + off) % n;
                  const u = (acc + sLen[aa] / 2) / runLen;
                  acc += sLen[aa];
                  sampleSag[sIdx[aa]] = maxSag * 4 * u * (1 - u);
                }
              }
            }
            j = r;
          }
        }
        for (let j = 0; j < n; j++) if (sOk[j] === 1) side[cy(sY[j]) * W + cx(sX[j])] = L + 1;
        p = q;
      }
    }

    let affected = false;
    for (let i = s0; i < s1; i++) {
      const len = Math.hypot(end[i * 3] - start[i * 3], end[i * 3 + 1] - start[i * 3 + 1]);
      summary.totalLength += len;
      const fails = !onBed && segSamples[i] > 0 && segFailSamples[i] * 2 >= segSamples[i];
      if (fails) {
        const mx = (start[i * 3] + end[i * 3]) / 2, my = (start[i * 3 + 1] + end[i * 3 + 1]) / 2;
        const land = Math.max(0, localTop(mx, my)) + 0.25 + rand() * 0.6;
        drop[i] = Math.max(0.05, z - Math.min(land, z));
        summary.failedSegments++;
        summary.failedLength += len;
        affected = true;
      } else {
        stamp(i, z);
      }
    }
    if (affected) {
      summary.layersAffected++;
      if (summary.firstLayer < 0) summary.firstLayer = L;
      summary.lastLayer = L;
    }
  }
  segSampleStart[S] = sampleCount;
  summary.failedFraction = summary.totalLength > 0 ? summary.failedLength / summary.totalLength : 0;
  return { drop, segSampleStart, segSamples, sampleSag: sampleSag.subarray(0, sampleCount), summary };
}

/**
 * Chop falling and sagging strands into short pieces so they can curl / bend.
 * Pieces keep their parent's move index; segs.frac records how far through
 * that move each piece ends (1 for untouched segments). segs.sag holds the
 * droop at each piece's start and end.
 */
export function splitSegments(raw, rawLayerSeg, res, maxLen = 1.5) {
  const { start, end, meta, move, fan } = raw;
  const { drop, segSampleStart, segSamples, sampleSag } = res;
  const S = meta.length;
  const pieces = new Uint16Array(S);
  const sagAt = (i, t) => {
    const k = segSamples[i];
    if (!k) return 0;
    const base = segSampleStart[i];
    const pos = t * k - 0.5;
    if (pos <= 0) return sampleSag[base];
    if (pos >= k - 1) return sampleSag[base + k - 1];
    const a = Math.floor(pos), f = pos - a;
    return sampleSag[base + a] * (1 - f) + sampleSag[base + a + 1] * f;
  };
  let N = 0;
  const hasSag = new Uint8Array(S);
  for (let i = 0; i < S; i++) {
    let sag = false;
    const k = segSamples[i], b = segSampleStart[i];
    for (let j = 0; j < k; j++) if (sampleSag[b + j] >= SAG_MIN) { sag = true; break; }
    hasSag[i] = sag ? 1 : 0;
    let n = 1;
    if (drop[i] > 0 || sag) {
      const len = Math.hypot(end[i * 3] - start[i * 3], end[i * 3 + 1] - start[i * 3 + 1], end[i * 3 + 2] - start[i * 3 + 2]);
      n = Math.min(400, Math.max(1, Math.ceil(len / maxLen)));
    }
    pieces[i] = n;
    N += n;
  }
  const out = {
    start: new Float32Array(N * 3), end: new Float32Array(N * 3), meta: new Float32Array(N),
    move: new Uint32Array(N), fan: new Uint8Array(N), drop: new Float32Array(N), frac: new Float32Array(N),
    sag: new Float32Array(N * 2),
  };
  const remap = new Uint32Array(S + 1);
  let o = 0;
  for (let i = 0; i < S; i++) {
    remap[i] = o;
    const n = pieces[i];
    const x0 = start[i * 3], y0 = start[i * 3 + 1], z0 = start[i * 3 + 2];
    const dx = end[i * 3] - x0, dy = end[i * 3 + 1] - y0, dz = end[i * 3 + 2] - z0;
    for (let k = 0; k < n; k++) {
      const a = k / n, b = (k + 1) / n;
      out.start[o * 3] = x0 + dx * a; out.start[o * 3 + 1] = y0 + dy * a; out.start[o * 3 + 2] = z0 + dz * a;
      out.end[o * 3] = x0 + dx * b; out.end[o * 3 + 1] = y0 + dy * b; out.end[o * 3 + 2] = z0 + dz * b;
      out.meta[o] = meta[i]; out.move[o] = move[i]; out.fan[o] = fan ? fan[i] : 255;
      out.drop[o] = drop[i]; out.frac[o] = b;
      if (hasSag[i]) { out.sag[o * 2] = sagAt(i, a); out.sag[o * 2 + 1] = sagAt(i, b); }
      o++;
    }
  }
  remap[S] = o;
  const layerSeg = new Uint32Array(rawLayerSeg.length);
  for (let L = 0; L < rawLayerSeg.length; L++) layerSeg[L] = remap[rawLayerSeg[L]];
  return { segs: out, layerSeg };
}

/** Run the whole physics pass: sets parsed.segs, parsed.layers.seg, parsed.support. */
export function simulatePhysics(parsed, material, temp) {
  const raw = parsed.rawSegs;
  const cfg = parsed.meta.config || {};
  const num = (v) => { const n = parseFloat(String(v ?? '').split(/[;,]/)[0]); return isFinite(n) ? n : 0; };
  const res = analyzeSupport(raw, { z: parsed.layers.z, seg: parsed.rawLayerSeg }, {
    material, temp,
    elephantFoot: num(cfg.elefant_foot_compensation ?? cfg.elephant_foot_compensation),
    firstLayerWidth: num(cfg.first_layer_extrusion_width) || 0.45,
  });
  const { segs, layerSeg } = splitSegments(raw, parsed.rawLayerSeg, res);
  parsed.segs = segs;
  parsed.layers.seg = layerSeg;
  parsed.support = res.summary;
  return parsed;
}
