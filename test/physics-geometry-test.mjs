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
{
  // layer 1: 10x10 mm pad of lines at y 0..10; layers 2 & 3: one line from x=0 to x=33 at y=5
  const W = 0.45, segs = { start: [], end: [], meta: [], fan: [], move: [] }, layerZ = [], layerSeg = [];
  let m = 0;
  const line = (x0, y0, x1, y1, z, feat) => {
    segs.start.push(x0, y0, z); segs.end.push(x1, y1, z); segs.meta.push(feat * 4 + W); segs.fan.push(255); segs.move.push(m++);
  };
  layerZ.push(0.2); layerSeg.push(0);
  for (let y = 0.2; y < 10; y += W) line(0, y, 10, y, 0.2, 5);
  for (const z of [0.4, 0.6]) { layerZ.push(z); layerSeg.push(segs.meta.length); line(0, 5, 33, 5, z, 2); }
  const S = {
    start: Float32Array.from(segs.start), end: Float32Array.from(segs.end), meta: Float32Array.from(segs.meta),
    fan: Uint8Array.from(segs.fan), move: Uint32Array.from(segs.move),
  };
  const layers = { z: Float32Array.from(layerZ), seg: Uint32Array.from(layerSeg) };
  const res = analyzeSupport(S, layers, { material: 'PLA', temp: 215 });
  const l2 = layerSamples(S, layers, res, 1);
  const held = l2.filter((q) => q.drop === 0), fell = l2.filter((q) => q.drop > 0);
  const edge = Math.max(...held.map((q) => q.x));
  check('line: part over the pad holds', l2.filter((q) => q.x < 9.5).every((q) => q.drop === 0));
  check('line: hinge ~cantilever length past the pad edge', edge > 10.2 && edge < 13, `held to x=${edge.toFixed(2)}`);
  check('line: the rest falls to the bed', fell.length > 0 && fell.every((q) => q.x > edge && q.drop > 0), `${fell.length} samples fall, first at x=${Math.min(...fell.map((q) => q.x)).toFixed(2)}`);
  const l3 = layerSamples(S, layers, res, 2);
  check('line: next layer holds over the held part', l3.filter((q) => q.x < edge - 0.6).every((q) => q.drop === 0));
  check('line: next layer falls over the gap', l3.filter((q) => q.x > edge + 3).every((q) => q.drop > 0));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
