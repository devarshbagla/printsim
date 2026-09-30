// Geometric checks for the support physics (not just "what % failed").
//   node test/physics-geometry-test.mjs
import { readFileSync } from 'node:fs';
import { parseGcode } from '../js/gcode.js';
import { analyzeSupport, simulatePhysics } from '../js/physics.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
};

// sample positions exactly as analyzeSupport lays them out
function samplesOf(segs, res, i) {
  const k = res.segSamples[i], base = res.segSampleStart[i], out = [];
  const x0 = segs.start[i * 3], y0 = segs.start[i * 3 + 1], x1 = segs.end[i * 3], y1 = segs.end[i * 3 + 1];
  for (let j = 0; j < k; j++) {
    const t = (j + 0.5) / k;
    out.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, drop: res.sampleDrop[base + j], sag: res.sampleSag[base + j],
      blob: res.sampleBlob ? res.sampleBlob[base + j] : 0, len: Math.hypot(x1 - x0, y1 - y0) / k });
  }
  return out;
}
function layerSamples(segs, layers, res, L) {
  const a = layers.seg[L], b = L + 1 < layers.seg.length ? layers.seg[L + 1] : segs.meta.length, out = [];
  for (let i = a; i < b; i++) out.push(...samplesOf(segs, res, i));
  return out;
}

// ---------------------------------------------------------------- 1. bridge
{
  const r = parseGcode(new Uint8Array(readFileSync(new URL('./bridge.gcode', import.meta.url))));
  const p = { ...r, layers: { ...r.layers }, rawSegs: r.segs, rawLayerSeg: r.layers.seg.slice() };
  simulatePhysics(p, 'PLA', 215);
  check('bridge: 26 mm PLA span holds', p.support.failedFraction === 0, `${(p.support.failedFraction * 100).toFixed(2)}% fails`);
  check('bridge: sags a few tenths of a mm', p.support.maxSag > 0.1 && p.support.maxSag < 0.8, `max sag ${p.support.maxSag.toFixed(2)} mm`);
}

// ---------------------------------------------------------------- 2. mushroom
{
  const r = parseGcode(new Uint8Array(readFileSync(new URL('../samples/mushroom-no-supports.gcode', import.meta.url))));
  const res = analyzeSupport(r.segs, r.layers, { material: 'PLA', temp: 215 });
  const L = r.layers.z.findIndex((z) => z > 12.1);
  const zc = r.layers.z[L];
  const s = layerSamples(r.segs, r.layers, res, L);
  const rOf = (q) => Math.hypot(q.x - 90, q.y - 90);
  const overStem = s.filter((q) => rOf(q) < 5.5);
  const rim = s.filter((q) => rOf(q) > 20);
  check('mushroom: cap over the stem holds', overStem.length > 0 && overStem.every((q) => q.drop === 0), `${overStem.filter((q) => q.drop > 0).length}/${overStem.length} over stem fall`);
  const rimDrop = rim.reduce((a, q) => a + q.drop, 0) / rim.length;
  check('mushroom: rim falls to the bed', rim.every((q) => q.drop > 0) && rimDrop > zc - 1.2, `avg rim drop ${rimDrop.toFixed(2)} mm from z ${zc.toFixed(2)}`);
  // stem 7 mm + overhang allowance + a 1.8 mm hinge ~ 10.3 mm; everything beyond must fall
  const s2 = layerSamples(r.segs, r.layers, res, L + 1).filter((q) => rOf(q) > 10.6);
  check('mushroom: next cap layer cascades', s2.length > 0 && s2.every((q) => q.drop > 0), `${s2.filter((q) => q.drop === 0).length}/${s2.length} outer samples held`);
}

// ---------------------------------------------------------------- 3. line 30% on a pad
// synthetic layers: `build(layers)` where each layer is a list of [x0,y0,x1,y1,feature]
function build(layerList) {
  const W = 0.45, segs = { start: [], end: [], meta: [], fan: [], move: [] }, layerZ = [], layerSeg = [];
  let m = 0;
  for (const [z, lines] of layerList) {
    layerZ.push(z); layerSeg.push(segs.meta.length);
    for (const [x0, y0, x1, y1, feat] of lines) {
      segs.start.push(x0, y0, z); segs.end.push(x1, y1, z); segs.meta.push(feat * 4 + W); segs.fan.push(255); segs.move.push(m++);
    }
  }
  const S = {
    start: Float32Array.from(segs.start), end: Float32Array.from(segs.end), meta: Float32Array.from(segs.meta),
    fan: Uint8Array.from(segs.fan), move: Uint32Array.from(segs.move),
  };
  return { S, layers: { z: Float32Array.from(layerZ), seg: Uint32Array.from(layerSeg) } };
}
const pad = () => { const out = []; for (let y = 0.2; y < 10; y += 0.45) out.push([0, y, 10, y, 5]); return out; };
const far = [[60, 60, 70, 60, 5]]; // keeps an otherwise empty layer from being empty
{
  // a 2 mm tall 10x10 pad, then one line from x=0 to x=33 at y=5 (2 layers)
  const L = [];
  for (let i = 1; i <= 10; i++) L.push([+(i * 0.2).toFixed(2), pad()]);
  L.push([2.2, [[0, 5, 33, 5, 2]]], [2.4, [[0, 5, 33, 5, 2]]]);
  const { S, layers } = build(L);
  const res = analyzeSupport(S, layers, { material: 'PLA', temp: 215 });
  const l2 = layerSamples(S, layers, res, 10);
  const held = l2.filter((q) => q.drop === 0), fell = l2.filter((q) => q.drop > 0);
  const edge = Math.max(...held.map((q) => q.x));
  check('line: part over the pad holds', l2.filter((q) => q.x < 9.5).every((q) => q.drop === 0));
  check('line: hinge ~cantilever length past the pad edge', edge > 10.2 && edge < 13, `held to x=${edge.toFixed(2)}`);
  check('line: the rest falls to the bed', fell.length > 0 && fell.filter((q) => q.x > edge + 3).every((q) => q.drop > 1.5), `${fell.length} samples fall, first at x=${Math.min(...fell.map((q) => q.x)).toFixed(2)}`);
  // tied to the hinge, plastic can't stretch: it hangs no lower than the strand between it and the hinge
  const worst = Math.max(...fell.map((q) => q.drop - (q.x - edge)));
  check('line: next to the hinge it hangs, it can\'t stretch', fell.every((q) => q.drop <= (q.x - edge) + 0.3), `max overshoot ${worst.toFixed(2)} mm`);
  const l3 = layerSamples(S, layers, res, 11);
  check('line: next layer holds over the held part', l3.filter((q) => q.x < edge - 0.6).every((q) => q.drop === 0));
  check('line: next layer falls over the gap', l3.filter((q) => q.x > edge + 3).every((q) => q.drop > 0));
}

// ---------------------------------------------------------------- 4. print-in-place gap
{
  // pad up to z 2.0, nothing at 2.1-2.4, a floating square at 2.5 and 2.6 (0.5 mm clearance,
  // like a hinge knuckle over the part below), and one 3 mm up (too far: falls)
  const L = [];
  for (let i = 1; i <= 10; i++) L.push([+(i * 0.2).toFixed(2), pad()]);
  const sq = (a) => [[a, a, 10 - a, a, 1], [10 - a, a, 10 - a, 10 - a, 1], [10 - a, 10 - a, a, 10 - a, 1], [a, 10 - a, a, a, 1]];
  for (const z of [2.1, 2.2, 2.3, 2.4]) L.push([z, far]);
  L.push([2.5, sq(2)], [2.6, sq(2)]);
  for (let z = 2.7; z < 4.95; z += 0.1) L.push([+z.toFixed(2), far]);
  L.push([5.0, [[20, 0, 30, 0, 1], [30, 0, 30, 10, 1], [30, 10, 20, 10, 1], [20, 10, 20, 0, 1]]]);
  const { S, layers } = build(L);
  const res = analyzeSupport(S, layers, { material: 'PLA', temp: 215 });
  const zi = (z) => Array.from(layers.z).findIndex((v) => Math.abs(v - z) < 1e-3);
  const a = layerSamples(S, layers, res, zi(2.5)), b = layerSamples(S, layers, res, zi(2.6));
  check('gap: island 0.5 mm over the part lands on it and holds', a.every((q) => q.drop === 0) && a.some((q) => q.sag > 0.2), `sag ${Math.max(...a.map((q) => q.sag)).toFixed(2)} mm`);
  check('gap: the layer on top of it holds', b.every((q) => q.drop === 0 && q.sag === 0));
  const c = layerSamples(S, layers, res, zi(5.0));
  check('gap: island 5 mm over the bed still falls', c.every((q) => q.drop > 4));
}

// ---------------------------------------------------------------- 5. parts starting in mid-air
{
  // a pillar from the bed, plus a "drip": a small square that first appears 5 mm up,
  // 15 mm from the pillar, and keeps being printed for 20 layers (like the melting
  // stand's drips); and a shelf growing straight out of the pillar (not a floating part)
  const sq = (x, y, a) => [[x - a, y - a, x + a, y - a, 1], [x + a, y - a, x + a, y + a, 1], [x + a, y + a, x - a, y + a, 1], [x - a, y + a, x - a, y - a, 1]];
  const L = [];
  for (let z = 0.2; z < 9.05; z += 0.2) {
    const lines = sq(5, 5, 3);
    if (z > 4.95 && z < 9.05) lines.push(...sq(20, 5, 1.5));                               // drip, from z 5
    if (z > 7.95) for (let y = 2.2; y < 8; y += 0.45) lines.push([8.2, y, 14, y, 2]);          // shelf off the pillar at z 8
    L.push([+z.toFixed(2), lines]);
  }
  const { S, layers } = build(L);
  const res = analyzeSupport(S, layers, { material: 'PLA', temp: 215 });
  const sm = res.summary;
  check('mid-air: the drip counts as one floating part', sm.islands === 1, `${sm.islands} found`);
  check('mid-air: found on the layer it starts', sm.islandFirstLayer === Array.from(layers.z).findIndex((z) => z > 4.95), `layer ${sm.islandFirstLayer + 1}`);
  check('mid-air: the shelf off the pillar is not counted', sm.islandList.every((i) => Math.hypot(i.x - 20, i.y - 5) < 3));
}
// ---------------------------------------------------------------- 5b. where two parts join
{
  // two 4x4 mm pads with a 2 mm gap (like two hinge knuckles), then a layer that
  // joins them: its outline dips 1.2 mm into the gap as a short V, and a tiny
  // filler in the gap is printed BEFORE the V it touches (YAFIC infinity cube)
  const padAt = (x0) => { const out = []; for (let y = 2.2; y < 6; y += 0.45) out.push([x0, y, x0 + 4, y, 5]); return out; };
  const L = [];
  for (let i = 1; i <= 10; i++) L.push([+(i * 0.2).toFixed(2), [...padAt(0), ...padAt(6)]]);
  const tri = [[4.75, 1.3, 5.25, 1.3, 3], [5.25, 1.3, 5.0, 1.7, 3], [5.0, 1.7, 4.75, 1.3, 3]];
  const V = [[3.6, 3, 4.4, 1.0, 3], [4.4, 1.0, 5.6, 1.0, 3], [5.6, 1.0, 6.4, 3, 3]];
  L.push([2.1, [...tri, ...V, ...padAt(0), ...padAt(6)]]);
  const { S, layers } = build(L);
  const res = analyzeSupport(S, layers, { material: 'PLA', temp: 215 });
  const top = layerSamples(S, layers, res, 10);
  check('join: a short V between two parts holds (it just sags)', top.every((q) => q.drop === 0), `${top.filter((q) => q.drop > 0).length} samples fall`);
  check('join: nothing counted as a floating part', res.summary.islands === 0, `${res.summary.islands}`);
}

// ---------------------------------------------------------------- 6. fallen plastic keeps its volume
{
  // 10 solid layers (0.2 mm, 10 x 10 mm) printed 5 mm up with nothing under them all
  // fall onto the bed: the pile they make holds exactly their plastic, ~2 mm tall
  const fill = () => { const out = []; for (let y = 40; y <= 50; y += 0.45) out.push([40, y, 50, y, 5]); return out; };
  const L = [];
  for (let z = 0.2; z < 4.85; z += 0.2) L.push([+z.toFixed(2), far]);
  for (let k = 0; k < 10; k++) L.push([+(5 + k * 0.2).toFixed(2), fill()]);
  const { S, layers } = build(L);
  const res = analyzeSupport(S, layers, { material: 'PLA', temp: 215 });
  const zs = Array.from(layers.z), first = zs.findIndex((z) => z > 4.95), last = zs.length - 1;
  // (plastic that balled up on the nozzle rides away instead of landing here)
  const restOf = (Li) => { const zz = zs[Li]; return layerSamples(S, layers, res, Li).filter((q) => !q.blob).map((q) => zz - 0.1 - q.drop); };
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const r1 = avg(restOf(first)), rN = avg(restOf(last));
  const plastic = 10 * 0.2; // mm of solid plastic stacked
  check('fallen: everything floating falls', layerSamples(S, layers, res, first).every((q) => q.drop > 3 || q.blob));
  check('fallen: first layer lands on the bed', r1 > 0.05 && r1 < 0.35, `centre ${r1.toFixed(2)} mm up`);
  check('fallen: pile holds the plastic that fell, not 3x it', rN > plastic * 0.7 && rN < plastic * 1.35, `10 layers (${plastic} mm of plastic) pile to ${rN.toFixed(2)} mm`);

  // ---------------------------------------------------------------- 7. nozzle blobs
  // loose plastic that sticks to the nozzle ends up in a blob, all of it
  let stuck = 0;
  for (let Li = first; Li <= last; Li++) for (const q of layerSamples(S, layers, res, Li)) if (q.blob) stuck += q.len * 0.45 * 0.2;
  const inBlobs = res.blobs.reduce((a, b) => a + b.vol, 0);
  check('blobs: some loose PLA balls up on the nozzle', res.blobs.length > 0 && stuck > 0, `${res.blobs.length} blob(s), ${stuck.toFixed(1)} mm3`);
  check('blobs: every bit that stuck is in a blob (volume kept)', Math.abs(inBlobs - stuck) < 1e-3 * Math.max(1, stuck), `${inBlobs.toFixed(2)} vs ${stuck.toFixed(2)} mm3`);
  check('blobs: none much heavier than what drops off', res.blobs.every((b) => b.vol < 125), `max ${Math.max(0, ...res.blobs.map((b) => b.vol)).toFixed(1)} mm3`);
  const petg = analyzeSupport(S, layers, { material: 'PETG', temp: 240 });
  check('blobs: PETG sticks to the nozzle more than PLA', petg.summary.stuckLength > res.summary.stuckLength,
    `PETG ${petg.summary.stuckLength.toFixed(0)} mm vs PLA ${res.summary.stuckLength.toFixed(0)} mm`);
}
{
  const r = parseGcode(new Uint8Array(readFileSync(new URL('../samples/mushroom-no-supports.gcode', import.meta.url))));
  const res = analyzeSupport(r.segs, r.layers, { material: 'PLA', temp: 215 });
  check('mid-air: the mushroom cap is an overhang, not a floating part', res.summary.islands === 0, `${res.summary.islands} found`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
