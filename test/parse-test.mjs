import { readFileSync } from 'node:fs';
import { decodeBgcode } from '../js/bgcode.js';
import { parseGcode, FeatureNames } from '../js/gcode.js';
const dir = process.argv[2];
for (const f of ['mini_cube_b.bgcode', 'mini_cube_a.gcode', 'mini_cube_ps2.8.1.bgcode']) {
  let bytes = new Uint8Array(readFileSync(`${dir}/${f}`));
  let meta = null;
  if (f.endsWith('.bgcode')) { const d = await decodeBgcode(bytes); bytes = d.gcode; meta = d.metadata; }
  const t0 = performance.now();
  const r = parseGcode(bytes);
  const ms = (performance.now() - t0).toFixed(0);
  let rawSum = 0; for (const v of r.moves.raw) rawSum += v;
  const est = meta ? meta.print['estimated printing time (normal mode)'] : r.meta.config['estimated printing time (normal mode)'];
  const ev = {}; r.moves.event.forEach(e => { if (e) ev[e] = (ev[e] || 0) + 1; });
  console.log(`${f}: ${ms}ms moves=${r.moves.kind.length} segs=${r.segs.move.length} layers=${r.layers.z.length} anchors=${r.anchors.length} firstExtrude=${r.firstExtrudeMove}`);
  console.log(`   kinematic total=${(rawSum/60).toFixed(2)} min, slicer says ${est}; events`, JSON.stringify(ev), 'thumbs', r.thumbs.length);
  console.log('   bbox', r.bbox.min.map(v=>v.toFixed(1)), r.bbox.max.map(v=>v.toFixed(1)), 'features', r.features.map(i=>FeatureNames[i]).join(', '));
  console.log('   layers first', Array.from(r.layers.z.slice(0,4)), 'last', r.layers.z[r.layers.z.length-1], 'anchors[0..2]', JSON.stringify(r.anchors.slice(0,3)));
}
