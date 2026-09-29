// "Will this print in mid-air?" analysis.
//
// The G-code only says where the nozzle goes, not what's underneath it, so we
// rebuild that: walk the layers bottom-up keeping a height map of every bit of
// strand that actually stayed put, and check each new strand for material
// right below. Decisions are made per 0.4 mm sample, not per G-code move, so a
// long line can be partly held and partly falling.
//
//  - A sample is supported if stamped material from the layer below lies within
//    layerHeight * tan(overhang angle) of it (never less than half a strand
//    width). The angle depends on the filament, the part fan on that strand,
//    nozzle temperature and how short the layer is (little time to cool).
//  - A strand pressed against a supported strand of the same layer is bonded
//    sideways (one hop only, so overhangs can't creep outward row by row).
//  - Unsupported stretch, anchored on both ends, straight enough and short
//    enough -> bridge: holds, sags (span^2).
//  - Short unsupported stretch (<= cantilever limit) -> holds.
//  - Anything else falls, except the first `cantilever` mm next to an anchor,
//    which stays put as a hinge, and anything printed within CATCH of held
//    plastic or the bed below (it just sags onto it: print-in-place gaps).
//
// Only held samples are stamped into the height map, so whatever gets printed
// on top of fallen plastic falls too (the spaghetti cascade). Fallen plastic
// piles up in a separate debris map: later strands land on the pile, but the
// pile never counts as support.

import { MATERIALS, limitsFor } from './materials.js';

const CELL = 0.15;     // height-map resolution (mm)
const SAMPLE = 0.4;    // mm between support samples along a strand
const SAG_MIN = 0.06;  // mm; smaller sag isn't worth drawing
const LINK_TOL = 0.05; // mm; consecutive moves closer than this form one strand
// A strand with held plastic (or the bed) at most this far below the nozzle
// lands on it instead of falling. Estimate: print-in-place gaps of 0.3-0.5 mm
// and support gaps of 0.1-0.3 mm print fine; ~1 mm starts getting stringy.
const CATCH = 0.8;

const featureOf = (m) => Math.floor(m / 4 + 1e-3);
const widthOf = (m) => m - featureOf(m) * 4;
const isPerimeter = (f) => f === 1 || f === 2 || f === 3;

export function analyzeSupport(segs, layers, opts = {}) {
  const mat = MATERIALS[opts.material] || MATERIALS.PLA;
  const temp = opts.temp || null;
  const layerSec = opts.layerSeconds || null;
  // slicers pull the first layer's outline in (elephant-foot compensation) and
  // print it wider, so layer 2's perimeters legitimately sit further out
  const layer2Bonus = (opts.elephantFoot || 0) + Math.max(0, ((opts.firstLayerWidth || 0.45) - 0.45) / 2);
  const { start, end, meta } = segs;
  const fan = segs.fan;
  const S = meta.length;
  const layerSeg = layers.seg, layerZ = layers.z;
  const NL = layerZ.length;
  const summary = {
    failedSegments: 0, failedLength: 0, totalLength: 0, firstLayer: -1, lastLayer: -1, layersAffected: 0,
    bridges: 0, maxSag: 0, caught: 0, material: opts.material || 'PLA',
    islands: 0, islandFirstLayer: -1,
  };
  // Parts that start printing in mid-air (a drip hanging off a ledge, a model
  // floating above the bed): a strand with nothing held anywhere near below it
  // that isn't just the next layer of an overhang collapsing. Consecutive layers
  // of the same floating part are merged, so each one counts once.
  const islands = []; // { x, y, lastL, len }
  const segSampleStart = new Uint32Array(S + 1);
  const segSamples = new Uint16Array(S);
  const pathId = new Uint32Array(S);
  let sampleSag = new Float32Array(1 << 16), sampleDrop = new Float32Array(1 << 16);
  let sampleCount = 0;
  const done = () => {
    segSampleStart[S] = sampleCount;
    summary.failedFraction = summary.totalLength > 0 ? summary.failedLength / summary.totalLength : 0;
    return { segSampleStart, segSamples, pathId, sampleSag: sampleSag.subarray(0, sampleCount), sampleDrop: sampleDrop.subarray(0, sampleCount), summary };
  };
  if (!S || !NL) return done();

  // grid bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < S; i++) {
    const a = start[i * 3], b = start[i * 3 + 1], c = end[i * 3], d = end[i * 3 + 1];
    if (a < minX) minX = a; if (c < minX) minX = c; if (a > maxX) maxX = a; if (c > maxX) maxX = c;
    if (b < minY) minY = b; if (d < minY) minY = d; if (b > maxY) maxY = b; if (d > maxY) maxY = d;
  }
  minX -= 3; minY -= 3; maxX += 3; maxY += 3;
  const W = Math.max(1, Math.ceil((maxX - minX) / CELL)), H = Math.max(1, Math.ceil((maxY - minY) / CELL));
  const top = new Float32Array(W * H).fill(-1);   // held plastic (supports things)
  const debris = new Float32Array(W * H);          // fallen plastic (only for landing)
  const side = new Uint32Array(W * H);             // same-layer supported cells, tagged by layer
  // 1 mm grid linking strands of the same layer that touch (for floating-part detection)
  const WC = Math.max(1, Math.ceil((maxX - minX))), HC = Math.max(1, Math.ceil((maxY - minY)));
  const cellL = new Uint32Array(WC * HC), cellOwner = new Int32Array(WC * HC);

  // neighbour offsets sorted by distance, so lookups can stop early
  const MAXR = 2.5;
  const rc = Math.ceil(MAXR / CELL) + 1;
  const offs = [];
  for (let dy = -rc; dy <= rc; dy++) for (let dx = -rc; dx <= rc; dx++) offs.push([dx, dy, Math.hypot(dx, dy) * CELL]);
  offs.sort((a, b) => a[2] - b[2]);
  const offDX = Int32Array.from(offs, o => o[0]), offDY = Int32Array.from(offs, o => o[1]), offD = Float32Array.from(offs, o => o[2]);

  const cx = (x) => { const c = Math.floor((x - minX) / CELL); return c < 0 ? 0 : c >= W ? W - 1 : c; };
  const cy = (y) => { const c = Math.floor((y - minY) / CELL); return c < 0 ? 0 : c >= H ? H - 1 : c; };
  const within = (x, y, r, test) => {
    const X = cx(x), Y = cy(y);
    const lim = r + CELL * 0.5;
    for (let k = 0; k < offD.length; k++) {
      if (offD[k] > lim) return false;
      const xx = X + offDX[k], yy = Y + offDY[k];
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (test(yy * W + xx)) return true;
    }
    return false;
  };
  // stamp a disc the width of the strand
  const stampDisk = (map, x, y, z, rad) => {
    const x0 = cx(x - rad), x1 = cx(x + rad), y0 = cy(y - rad), y1 = cy(y + rad);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const px = minX + (xx + 0.5) * CELL, py = minY + (yy + 0.5) * CELL;
      if ((px - x) * (px - x) + (py - y) * (py - y) <= rad * rad + CELL * CELL * 0.25) {
        const j = yy * W + xx;
        if (map[j] < z) map[j] = z;
      }
    }
  };
  // what a falling bit of strand lands on: the column right under it
  const groundAt = (x, y) => {
    const j = cy(y) * W + cx(x);
    return Math.max(0, top[j], debris[j]);
  };
  // fallen plastic piles up by exactly its own volume: spread a strand piece's
  // w x h x len over the patch it lands on (so 10 g of spaghetti looks like 10 g)
  const addDebris = (x, y, vol, rad) => {
    const x0 = cx(x - rad), x1 = cx(x + rad), y0 = cy(y - rad), y1 = cy(y + rad);
    let n = 0;
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const px = minX + (xx + 0.5) * CELL, py = minY + (yy + 0.5) * CELL;
      if ((px - x) * (px - x) + (py - y) * (py - y) <= rad * rad + CELL * CELL * 0.25) n++;
    }
    if (!n) return;
    const dh = vol / (n * CELL * CELL);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const px = minX + (xx + 0.5) * CELL, py = minY + (yy + 0.5) * CELL;
      if ((px - x) * (px - x) + (py - y) * (py - y) <= rad * rad + CELL * CELL * 0.25) {
        const j = yy * W + xx;
        debris[j] = Math.max(debris[j], top[j], 0) + dh;
      }
    }
  };

  // highest held plastic within r (lines side by side leave hairline gaps in the map)
  const topNear = (x, y, r) => {
    const X = cx(x), Y = cy(y), lim = r + CELL * 0.5;
    let best = -1;
    for (let k = 0; k < offD.length && offD[k] <= lim; k++) {
      const xx = X + offDX[k], yy = Y + offDY[k];
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const v = top[yy * W + xx]; if (v > best) best = v;
    }
    return best;
  };

  const firstZ = layerZ[0];
  let sSeg = new Int32Array(4096), sOk = new Uint8Array(4096), sX = new Float32Array(4096), sY = new Float32Array(4096),
    sLen = new Float32Array(4096), sIdx = new Int32Array(4096), sFall = new Uint8Array(4096), sRope = new Float32Array(4096);
  const limCache = new Map();
  const lim = (i, cool) => {
    const f = fan ? fan[i] : 255;
    const key = f * 1000 + Math.round(cool * 100);
    let v = limCache.get(key);
    if (!v) { v = limitsFor(mat, f / 255, temp, cool); limCache.set(key, v); }
    return v;
  };
  const grow = (A, T) => { const B = new T(A.length * 2); B.set(A); return B; };

  let rng = 12345;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  let path = 0;

  for (let L = 0; L < NL; L++) {
    const s0 = layerSeg[L], s1 = L + 1 < NL ? layerSeg[L + 1] : S;
    const z = layerZ[L];
    const prevZ = L > 0 ? layerZ[L - 1] : 0;
    const h = Math.max(z - prevZ, 0.05);
    const need = prevZ - Math.min(0.05, h * 0.25) - 1e-3; // plastic of the previous layer
    const onBed = z <= firstZ + 0.05 && z <= 1.0;
    // short layers don't get time to cool (8 s or more = no penalty)
    const cool = layerSec && layerSec[L] > 0 ? Math.max(0.5, Math.min(1, layerSec[L] / 8)) : 1;
    let affected = false;
    // union-find over this layer's strands: which blobs have anything that held
    const par = [], held = [], cands = [];
    const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) { par[b] = a; held[a] = held[a] || held[b]; } };

    let p = s0;
    while (p < s1) {
      let q = p + 1;
      while (q < s1 &&
        Math.abs(start[q * 3] - end[(q - 1) * 3]) < LINK_TOL &&
        Math.abs(start[q * 3 + 1] - end[(q - 1) * 3 + 1]) < LINK_TOL) q++;
      path++;
      // --- samples for this continuous strand
      let n = 0;
      for (let i = p; i < q; i++) {
        pathId[i] = path;
        const x0 = start[i * 3], y0 = start[i * 3 + 1], x1 = end[i * 3], y1 = end[i * 3 + 1];
        const len = Math.hypot(x1 - x0, y1 - y0);
        summary.totalLength += len;
        const k = Math.max(1, Math.ceil(len / SAMPLE));
        segSamples[i] = k;
        segSampleStart[i] = sampleCount;
        while (sampleCount + k >= sampleSag.length) { sampleSag = grow(sampleSag, Float32Array); sampleDrop = grow(sampleDrop, Float32Array); }
        while (n + k >= sSeg.length) {
          sSeg = grow(sSeg, Int32Array); sOk = grow(sOk, Uint8Array); sX = grow(sX, Float32Array); sY = grow(sY, Float32Array);
          sLen = grow(sLen, Float32Array); sIdx = grow(sIdx, Int32Array); sFall = grow(sFall, Uint8Array); sRope = grow(sRope, Float32Array);
        }
        const w = widthOf(meta[i]);
        let r = Math.max(h * lim(i, cool).tan, w * 0.5 + 0.05); // a strand can always hang half its width out
        if (L === 1 && isPerimeter(featureOf(meta[i]))) r += layer2Bonus;
        for (let j = 0; j < k; j++) {
          const t = (j + 0.5) / k;
          const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
          sSeg[n] = i; sX[n] = x; sY[n] = y; sLen[n] = len / k; sIdx[n] = sampleCount; sFall[n] = 0; sRope[n] = Infinity;
          sampleSag[sampleCount] = 0; sampleDrop[sampleCount] = 0; sampleCount++;
          if (onBed) sOk[n] = 1;
          else sOk[n] = within(x, y, r, (c) => top[c] >= need) ? 1 : within(x, y, w * 1.05, (c) => side[c] === L + 1) ? 2 : 0;
          n++;
        }
      }
      let floating = false;
      if (!onBed) {
        const closed = q - p > 2 && Math.hypot(end[(q - 1) * 3] - start[p * 3], end[(q - 1) * 3 + 1] - start[p * 3 + 1]) < LINK_TOL;
        let off = 0, anyOk = false;
        for (let j = 0; j < n; j++) if (sOk[j]) { anyOk = true; if (closed) off = j; break; }
        if (!anyOk) {
          for (let j = 0; j < n; j++) sFall[j] = 1; // floating island
          floating = true;
        } else {
          let j = 0;
          while (j < n) {
            const a = (j + off) % n;
            if (sOk[a]) { j++; continue; }
            let r = j, runLen = 0;
            // strictest limits over the run (fan/feature can change mid-run)
            let cant = Infinity, bridgeMax = Infinity, sag = 0, allSparse = true;
            while (r < n && !sOk[(r + off) % n]) {
              const ii = (r + off) % n, si = sSeg[ii];
              const lm = lim(si, cool);
              const sparse = featureOf(meta[si]) === 4;
              if (!sparse) allSparse = false;
              cant = Math.min(cant, lm.cantilever); bridgeMax = Math.min(bridgeMax, lm.bridge); sag = Math.max(sag, lm.sag);
              runLen += sLen[ii]; r++;
            }
            // sparse infill is hidden and forgiving: gyroid & co. wiggle across
            // the lines below them, so it gets longer limits and no straightness test
            if (allSparse) { cant *= 3; bridgeMax *= 1.5; }
            const startAnch = closed || j > 0;
            const endAnch = closed || r < n;
            let ok = runLen <= cant;
            let bridged = false;
            if (!ok && startAnch && endAnch && runLen <= bridgeMax) {
              ok = bridged = straightSpan(j, r, off, n, runLen, allSparse);
            }
            if (ok && !bridged && !(startAnch && endAnch)) {
              // a short stub sticking out: it stays, but droops and can't hold up the next layer
              for (let k = j; k < r; k++) sOk[(k + off) % n] = 4;
            }
            if (!ok) {
              // falls, except a hinge of `cant` mm next to each anchor
              let acc = 0;
              for (let k = j; k < r; k++) {
                const ii = (k + off) % n;
                const d0 = acc + sLen[ii] / 2, d1 = runLen - d0;
                acc += sLen[ii];
                const hinge = (startAnch && d0 <= cant) || (endAnch && d1 <= cant);
                if (hinge) sOk[ii] = 3;
                else {
                  sFall[ii] = 1;
                  // still tied to the part through the hinge: it can hang at most
                  // as far below as there is strand between it and the hinge
                  sRope[ii] = Math.min(startAnch ? d0 - cant : Infinity, endAnch ? d1 - cant : Infinity);
                }
              }
            } else if (bridged || (startAnch && endAnch && runLen > 2)) {
              // holds, but droops in the middle
              const maxSag = Math.min(4, sag * runLen * runLen / 10);
              if (maxSag >= SAG_MIN) {
                summary.bridges++;
                if (maxSag > summary.maxSag) summary.maxSag = maxSag;
                let acc = 0;
                for (let k = j; k < r; k++) {
                  const ii = (k + off) % n;
                  const u = (acc + sLen[ii] / 2) / runLen;
                  acc += sLen[ii];
                  sampleSag[sIdx[ii]] = maxSag * 4 * u * (1 - u);
                }
              }
            }
            j = r;
          }
        }
      }
      // --- caught: unsupported, but printed a hair above a surface (a print-in-place
      // clearance gap, a support gap). It sags onto that surface and printing
      // carries on, so it's held and the next layer can build on it.
      for (let j = 0; j < n; j++) if (sFall[j]) {
        const g = Math.max(0, topNear(sX[j], sY[j], widthOf(meta[sSeg[j]]) * 0.5 + CELL));
        if (z - g <= CATCH) {
          sFall[j] = 0; sOk[j] = 5;
          sampleSag[sIdx[j]] = Math.max(0, z - h - g);
          summary.caught += sLen[j];
        }
      }
      // --- connectivity: link this strand to the ones of this layer it touches
      if (!onBed) {
        const sid = par.length;
        let anyHeld = false;
        for (let j = 0; j < n; j++) if (!sFall[j]) { anyHeld = true; break; }
        par.push(sid); held.push(anyHeld);
        for (let j = 0; j < n; j++) {
          const X = Math.min(WC - 1, Math.max(0, Math.floor(sX[j] - minX))), Y = Math.min(HC - 1, Math.max(0, Math.floor(sY[j] - minY)));
          const c = Y * WC + X;
          if (cellL[c] === L + 1) union(cellOwner[c], sid); else { cellL[c] = L + 1; cellOwner[c] = sid; }
        }
        if (floating) {
          let cx_ = 0, cy_ = 0, len = 0;
          for (let j = 0; j < n; j++) { cx_ += sX[j]; cy_ += sY[j]; len += sLen[j]; }
          cands.push({ sid, x: cx_ / n, y: cy_ / n, len });
        }
      }
      // --- same-layer bonding map: vertically supported or caught samples
      for (let j = 0; j < n; j++) if (sOk[j] === 1 || sOk[j] === 5) {
        const c = cy(sY[j]) * W + cx(sX[j]);
        side[c] = L + 1;
      }
      // --- stamp what held, drop what fell
      let failedHere = false;
      for (let j = 0; j < n; j++) {
        const w = widthOf(meta[sSeg[j]]);
        if (!sFall[j]) {
          // hinges (3) and stubs (4) hang on but droop: stamped one layer low so they
          // don't count as support (or as a surface to catch on), otherwise overhangs
          // could creep out ~2 mm per layer
          const zz = (sOk[j] === 3 || sOk[j] === 4) ? z - h * 1.5 - CATCH : sOk[j] === 5 ? z : z - sampleSag[sIdx[j]];
          stampDisk(top, sX[j], sY[j], zz, w * 0.5);
        } else {
          // lands on whatever is under it as a round string of the same volume
          // (its centre one radius up, a little loft for the tangle)
          const g = groundAt(sX[j], sY[j]);
          const rr = Math.sqrt((w * h) / Math.PI);
          const rest = g + rr * (1 + 0.6 * rand());
          const full = z - h * 0.5 - rest; // from the strand's centre, half a layer under the nozzle
          sampleDrop[sIdx[j]] = Math.max(0.02, Math.min(full, sRope[j] * 0.9 + 0.05));
          if (full > sRope[j] * 0.9 + 0.05) sRope[j] = -1; // hanging, not on the pile
          summary.failedLength += sLen[j];
          failedHere = true;
        }
      }
      // fallen plastic piles up (after the whole strand fell, so it can't land on itself)
      for (let j = 0; j < n; j++) if (sFall[j] && sRope[j] !== -1) {
        const w = widthOf(meta[sSeg[j]]);
        addDebris(sX[j], sY[j], w * h * sLen[j], w);
      }
      if (failedHere) {
        affected = true;
        let lastSeg = -1;
        for (let j = 0; j < n; j++) if (sFall[j] && sSeg[j] !== lastSeg) { lastSeg = sSeg[j]; summary.failedSegments++; }
      }
      p = q;
    }
    // floating strands whose whole blob has nothing that held: part of something
    // being printed in mid-air
    for (const cd of cands) if (!held[find(cd.sid)]) noteIsland(L, cd.x, cd.y, cd.len, z);
    if (affected) {
      summary.layersAffected++;
      if (summary.firstLayer < 0) summary.firstLayer = L;
      summary.lastLayer = L;
    }
  }
  let counted = 0;
  summary.islandList = islands.filter(is => is.len >= 5).map(is => ({ x: is.x, y: is.y, layer: is.firstL, len: is.len }));
  for (const is of islands) if (is.len >= 5) { counted++; if (summary.islandFirstLayer < 0 || is.firstL < summary.islandFirstLayer) summary.islandFirstLayer = is.firstL; }
  summary.islands = counted;
  return done();

  // record a strand that has nothing under it at all
  function noteIsland(L, sx, sy, len, z) {
    // same floating part as one seen a little lower down: merge
    for (const is of islands) {
      if (z - is.lastZ <= 3 && Math.hypot(is.x - sx, is.y - sy) < 12) {
        is.lastZ = z; is.len += len;
        return;
      }
    }
    islands.push({ x: sx, y: sy, firstL: L, lastZ: z, len });
  }

  // A bridge has to be a real span: the path may not turn much between its
  // anchors, and must stay close to the straight line joining them. (A U-turn
  // has a chord/arc ratio of 2/pi = 0.64, so a ratio test lets it through.)
  // Sparse infill (gyroid etc.) wiggles by about a line spacing, so it skips the
  // turn test and gets more room, but a U-turn still strays ~half its length.
  function straightSpan(j, r, off, n, runLen, sparse) {
    const i0 = (j + off) % n, i1 = ((r - 1) + off) % n;
    const p0 = (j - 1 + off + n) % n, p1 = (r + off) % n;
    if (!sparse) {
      const d0x = sX[i0] - sX[p0], d0y = sY[i0] - sY[p0];
      const d1x = sX[p1] - sX[i1], d1y = sY[p1] - sY[i1];
      const turn = Math.abs(Math.atan2(d0x * d1y - d0y * d1x, d0x * d1x + d0y * d1y));
      if (turn > 0.6) return false; // ~35 degrees
    }
    const ax = sX[p0], ay = sY[p0], bx = sX[p1], by = sY[p1];
    const abx = bx - ax, aby = by - ay, ab2 = abx * abx + aby * aby || 1;
    let maxDev = 0;
    for (let k = j; k < r; k++) {
      const i = (k + off) % n;
      const t = ((sX[i] - ax) * abx + (sY[i] - ay) * aby) / ab2;
      maxDev = Math.max(maxDev, Math.hypot(sX[i] - (ax + abx * t), sY[i] - (ay + aby * t)));
    }
    return sparse ? maxDev < Math.max(1.5, 0.3 * runLen) : maxDev < Math.max(0.6, 0.15 * runLen);
  }
}

/**
 * Chop falling and sagging strands into short pieces so they can bend and fall.
 * Every piece carries values at BOTH ends (drop, sag, move fraction) and a
 * per-strand seed; neighbouring pieces share their end values, so a strand can
 * never tear apart while it falls.
 */
export function splitSegments(raw, rawLayerSeg, res, maxLen = 1.0) {
  const { start, end, meta, move, fan } = raw;
  const { segSampleStart, segSamples, sampleSag, sampleDrop, pathId } = res;
  const S = meta.length;
  // value of a per-sample quantity at fraction t along move i
  const at = (arr, i, t) => {
    const k = segSamples[i];
    if (!k) return 0;
    const base = segSampleStart[i];
    const pos = t * k - 0.5;
    if (pos <= 0) return arr[base];
    if (pos >= k - 1) return arr[base + k - 1];
    const a = Math.floor(pos), f = pos - a;
    return arr[base + a] * (1 - f) + arr[base + a + 1] * f;
  };
  // at a joint between two moves of the same strand, both sides use the average
  const endVal = (arr, i, t) => {
    const v = at(arr, i, t);
    if (t === 0 && i > 0 && pathId[i - 1] === pathId[i] && segSamples[i - 1]) return (v + at(arr, i - 1, 1)) / 2;
    if (t === 1 && i + 1 < S && pathId[i + 1] === pathId[i] && segSamples[i + 1]) return (v + at(arr, i + 1, 0)) / 2;
    return v;
  };
  const active = new Uint8Array(S);
  const pieces = new Uint16Array(S);
  let N = 0;
  for (let i = 0; i < S; i++) {
    const k = segSamples[i], b = segSampleStart[i];
    for (let j = 0; j < k; j++) if (sampleSag[b + j] >= SAG_MIN || sampleDrop[b + j] > 0) { active[i] = 1; break; }
    // neighbours of an active move carry non-zero end values too
    pieces[i] = 1;
  }
  for (let i = 0; i < S; i++) {
    if (!active[i]) continue;
    const len = Math.hypot(end[i * 3] - start[i * 3], end[i * 3 + 1] - start[i * 3 + 1], end[i * 3 + 2] - start[i * 3 + 2]);
    pieces[i] = Math.min(600, Math.max(1, Math.ceil(len / maxLen)));
  }
  for (let i = 0; i < S; i++) N += pieces[i];
  const out = {
    start: new Float32Array(N * 3), end: new Float32Array(N * 3), meta: new Float32Array(N),
    move: new Uint32Array(N), fan: new Uint8Array(N), frac: new Float32Array(N), frac0: new Float32Array(N),
    drop: new Float32Array(N * 2), sag: new Float32Array(N * 2), seed: new Float32Array(N),
  };
  const remap = new Uint32Array(S + 1);
  let o = 0;
  for (let i = 0; i < S; i++) {
    remap[i] = o;
    const n = pieces[i];
    const x0 = start[i * 3], y0 = start[i * 3 + 1], z0 = start[i * 3 + 2];
    const dx = end[i * 3] - x0, dy = end[i * 3 + 1] - y0, dz = end[i * 3 + 2] - z0;
    const touched = active[i] || (i > 0 && active[i - 1] && pathId[i - 1] === pathId[i]) || (i + 1 < S && active[i + 1] && pathId[i + 1] === pathId[i]);
    for (let k = 0; k < n; k++) {
      const a = k / n, b = (k + 1) / n;
      out.start[o * 3] = x0 + dx * a; out.start[o * 3 + 1] = y0 + dy * a; out.start[o * 3 + 2] = z0 + dz * a;
      out.end[o * 3] = x0 + dx * b; out.end[o * 3 + 1] = y0 + dy * b; out.end[o * 3 + 2] = z0 + dz * b;
      out.meta[o] = meta[i]; out.move[o] = move[i]; out.fan[o] = fan ? fan[i] : 255;
      out.frac0[o] = a; out.frac[o] = b;
      out.seed[o] = (pathId[i] % 997) / 997;
      if (touched) {
        out.drop[o * 2] = endVal(sampleDrop, i, a); out.drop[o * 2 + 1] = endVal(sampleDrop, i, b);
        out.sag[o * 2] = endVal(sampleSag, i, a); out.sag[o * 2 + 1] = endVal(sampleSag, i, b);
      }
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
  // seconds spent printing each layer (from the parser's move timing)
  const NL = parsed.layers.z.length;
  const layerSeconds = new Float32Array(NL);
  const rawT = parsed.moves && parsed.moves.raw;
  if (rawT) {
    const ls = parsed.rawLayerSeg;
    for (let L = 0; L < NL; L++) {
      const a = ls[L], b = L + 1 < NL ? ls[L + 1] : raw.move.length;
      if (b <= a) continue;
      const m0 = raw.move[a], m1 = raw.move[b - 1];
      let t = 0;
      for (let m = m0; m <= m1; m++) t += rawT[m];
      layerSeconds[L] = t;
    }
  }
  const res = analyzeSupport(raw, { z: parsed.layers.z, seg: parsed.rawLayerSeg }, {
    material, temp, layerSeconds,
    elephantFoot: num(cfg.elefant_foot_compensation ?? cfg.elephant_foot_compensation),
    firstLayerWidth: num(cfg.first_layer_extrusion_width) || 0.45,
  });
  const { segs, layerSeg } = splitSegments(raw, parsed.rawLayerSeg, res);
  parsed.segs = segs;
  parsed.layers.seg = layerSeg;
  parsed.support = res.summary;
  return parsed;
}
