// "Will this print in mid-air?" analysis.
//
// The G-code only says where the nozzle goes, not what's underneath it, so we
// rebuild that: walk the layers bottom-up keeping a height map of every strand
// that actually stayed put, and check each new strand for material right below.
//
//  - Unsupported stretch anchored on both ends and roughly straight -> bridge, OK.
//  - Short unsupported stretch (<= CANTILEVER_OK) -> normal overhang, OK.
//  - Anything else (cantilevered, U-turning, floating islands) -> falls.
//
// Fallen strands never enter the height map, so whatever gets printed on top of
// them fails too. That's how real "spaghetti" failures cascade.
//
// Output: drop[i] = how far segment i falls (0 = it stays), plus a summary.

const CELL = 0.4;          // height-map resolution (mm)
const MAX_BRIDGE = 30;     // mm, longest span we believe bridges OK
const CANTILEVER_OK = 1.5; // mm of unsupported strand we let slide
const SAMPLE = 0.4;        // mm between support samples along a strand

export function analyzeSupport(parsed) {
  const { start, end, meta } = parsed.segs;
  const S = meta.length;
  const drop = new Float32Array(S);
  const layerSeg = parsed.layers.seg, layerZ = parsed.layers.z;
  const NL = layerZ.length;
  const summary = { failedSegments: 0, failedLength: 0, totalLength: 0, firstLayer: -1, lastLayer: -1, layersAffected: 0 };
  if (!S || !NL) return { drop, summary };

  // grid bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < S; i++) {
    const a = start[i * 3], b = start[i * 3 + 1], c = end[i * 3], d = end[i * 3 + 1];
    if (a < minX) minX = a; if (c < minX) minX = c; if (a > maxX) maxX = a; if (c > maxX) maxX = c;
    if (b < minY) minY = b; if (d < minY) minY = d; if (b > maxY) maxY = b; if (d > maxY) maxY = d;
  }
  minX -= 2; minY -= 2; maxX += 2; maxY += 2;
  const W = Math.max(1, Math.ceil((maxX - minX) / CELL)), H = Math.max(1, Math.ceil((maxY - minY) / CELL));
  const top = new Float32Array(W * H).fill(-1);

  const cellOf = (x, y) => {
    const cx = Math.floor((x - minX) / CELL), cy = Math.floor((y - minY) / CELL);
    return [cx < 0 ? 0 : cx >= W ? W - 1 : cx, cy < 0 ? 0 : cy >= H ? H - 1 : cy];
  };
  const localTop = (x, y) => {
    const [cx, cy] = cellOf(x, y);
    let m = -1;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = cy + dy; if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx; if (xx < 0 || xx >= W) continue;
        const v = top[yy * W + xx]; if (v > m) m = v;
      }
    }
    return m;
  };
  const stamp = (i, z) => {
    const x0 = start[i * 3], y0 = start[i * 3 + 1], x1 = end[i * 3], y1 = end[i * 3 + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / (CELL * 0.5)));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const [cx, cy] = cellOf(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      const j = cy * W + cx;
      if (top[j] < z) top[j] = z;
    }
  };

  const firstZ = layerZ[0];
  // per-sample scratch
  let sSeg = new Int32Array(4096), sOk = new Uint8Array(4096), sX = new Float32Array(4096), sY = new Float32Array(4096), sLen = new Float32Array(4096);
  const segFailSamples = new Uint16Array(S);
  const segSamples = new Uint16Array(S);

  let rng = 12345;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

  for (let L = 0; L < NL; L++) {
    const s0 = layerSeg[L], s1 = L + 1 < NL ? layerSeg[L + 1] : S;
    const z = layerZ[L];
    const prevZ = L > 0 ? layerZ[L - 1] : 0;
    const h = Math.max(z - prevZ, 0.05);
    const need = z - h * 1.6 - 0.01;
    const onBed = z <= firstZ + 0.05;

    if (!onBed) {
      // walk continuous paths
      let p = s0;
      while (p < s1) {
        let q = p + 1;
        while (q < s1 &&
          Math.abs(start[q * 3] - end[(q - 1) * 3]) < 1e-3 &&
          Math.abs(start[q * 3 + 1] - end[(q - 1) * 3 + 1]) < 1e-3) q++;
        // samples for path [p, q)
        let n = 0;
        for (let i = p; i < q; i++) {
          const x0 = start[i * 3], y0 = start[i * 3 + 1], x1 = end[i * 3], y1 = end[i * 3 + 1];
          const len = Math.hypot(x1 - x0, y1 - y0);
          const k = Math.max(1, Math.ceil(len / SAMPLE));
          segSamples[i] = k;
          if (n + k >= sSeg.length) {
            const g = (A, T) => { const B = new T(A.length * 2); B.set(A); return B; };
            sSeg = g(sSeg, Int32Array); sOk = g(sOk, Uint8Array); sX = g(sX, Float32Array); sY = g(sY, Float32Array); sLen = g(sLen, Float32Array);
          }
          for (let j = 0; j < k; j++) {
            const t = (j + 0.5) / k;
            const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
            sSeg[n] = i; sX[n] = x; sY[n] = y; sLen[n] = len / k;
            sOk[n] = localTop(x, y) >= need ? 1 : 0;
            n++;
          }
        }
        // closed loop? rotate so we start on a supported sample
        const closed = q - p > 2 && Math.hypot(end[(q - 1) * 3] - start[p * 3], end[(q - 1) * 3 + 1] - start[p * 3 + 1]) < 0.05;
        let off = 0;
        let anyOk = false;
        for (let j = 0; j < n; j++) if (sOk[j]) { anyOk = true; if (closed) { off = j; } break; }
        if (!anyOk) {
          for (let j = 0; j < n; j++) segFailSamples[sSeg[j]]++;
        } else {
          let j = 0;
          while (j < n) {
            const a = (j + off) % n;
            if (sOk[a]) { j++; continue; }
            // unsupported run
            let r = j, runLen = 0;
            while (r < n && !sOk[(r + off) % n]) { runLen += sLen[(r + off) % n]; r++; }
            const startAnch = closed || j > 0;
            const endAnch = closed || r < n;
            let ok = runLen <= CANTILEVER_OK;
            if (!ok && startAnch && endAnch && runLen <= MAX_BRIDGE) {
              const aPrev = (j - 1 + off + n) % n, aNext = (r + off) % n;
              const span = Math.hypot(sX[aNext] - sX[aPrev], sY[aNext] - sY[aPrev]);
              ok = span >= 0.6 * runLen; // straight-ish span, not a U-turn
            }
            if (!ok) for (let k = j; k < r; k++) segFailSamples[sSeg[(k + off) % n]]++;
            j = r;
          }
        }
        p = q;
      }
    }

    // decide + update height map
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
  summary.failedFraction = summary.totalLength > 0 ? summary.failedLength / summary.totalLength : 0;
  return { drop, summary };
}

/**
 * Chop falling strands into short pieces so they can curl as they drop.
 * Pieces keep their parent's move index; segs.frac records how far through
 * that move each piece ends (1 for untouched segments).
 */
export function splitFallingSegments(parsed, drop, maxLen = 1.5) {
  const { start, end, meta, move } = parsed.segs;
  const S = meta.length;
  let extra = 0;
  const pieces = new Uint16Array(S);
  for (let i = 0; i < S; i++) {
    let n = 1;
    if (drop[i] > 0) {
      const len = Math.hypot(end[i * 3] - start[i * 3], end[i * 3 + 1] - start[i * 3 + 1], end[i * 3 + 2] - start[i * 3 + 2]);
      n = Math.min(400, Math.max(1, Math.ceil(len / maxLen)));
    }
    pieces[i] = n;
    extra += n - 1;
  }
  const N = S + extra;
  const nStart = new Float32Array(N * 3), nEnd = new Float32Array(N * 3), nMeta = new Float32Array(N),
    nMove = new Uint32Array(N), nDrop = new Float32Array(N), nFrac = new Float32Array(N);
  const remap = new Uint32Array(S + 1);
  let o = 0;
  for (let i = 0; i < S; i++) {
    remap[i] = o;
    const n = pieces[i];
    const x0 = start[i * 3], y0 = start[i * 3 + 1], z0 = start[i * 3 + 2];
    const dx = end[i * 3] - x0, dy = end[i * 3 + 1] - y0, dz = end[i * 3 + 2] - z0;
    for (let k = 0; k < n; k++) {
      const a = k / n, b = (k + 1) / n;
      nStart[o * 3] = x0 + dx * a; nStart[o * 3 + 1] = y0 + dy * a; nStart[o * 3 + 2] = z0 + dz * a;
      nEnd[o * 3] = x0 + dx * b; nEnd[o * 3 + 1] = y0 + dy * b; nEnd[o * 3 + 2] = z0 + dz * b;
      nMeta[o] = meta[i]; nMove[o] = move[i]; nDrop[o] = drop[i]; nFrac[o] = b;
      o++;
    }
  }
  remap[S] = o;
  const ls = parsed.layers.seg;
  for (let L = 0; L < ls.length; L++) ls[L] = remap[ls[L]];
  parsed.segs = { start: nStart, end: nEnd, meta: nMeta, move: nMove, drop: nDrop, frac: nFrac };
}
