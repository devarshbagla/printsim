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
    out.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, drop: res.sampleDrop[base + j], sag: res.sampleSag[base + j] });
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
  check('line: the rest falls to the bed', fell.length > 0 && fell.every((q) => q.x > edge && q.drop > 1.5), `${fell.length} samples fall, first at x=${Math.min(...fell.map((q) => q.x)).toFixed(2)}`);
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

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
