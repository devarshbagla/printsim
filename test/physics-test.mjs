// Support analysis: no false alarms on real prints, catches the mushroom,
// and material/fan changes move the needle in the right direction.
import { readFileSync, existsSync } from 'node:fs';
import { decodeBgcode, isBgcode } from '../js/bgcode.js';
import { parseGcode } from '../js/gcode.js';
import { simulatePhysics } from '../js/physics.js';
import { detectMaterial, nozzleTemp } from '../js/materials.js';
const mats = (process.env.MATS || '').split(',').filter(Boolean);
for (const f of process.argv.slice(2)) {
  if (!existsSync(f)) continue;
  let bytes = new Uint8Array(readFileSync(f)), cfg = {};
  if (isBgcode(bytes)) { const d = await decodeBgcode(bytes); bytes = d.gcode; cfg = { ...d.metadata.slicer, ...d.metadata.printer }; }
  const base = parseGcode(bytes);
  Object.assign(base.meta.config, cfg);
  const auto = detectMaterial(base.meta.config);
  for (const m of [auto, ...mats.filter(x => x !== auto)]) {
    const r = { ...base, layers: { ...base.layers }, rawSegs: base.segs, rawLayerSeg: base.layers.seg.slice() };
    const t0 = performance.now();
    simulatePhysics(r, m, nozzleTemp(base.meta.config));
    const s = r.support, ms = performance.now() - t0;
    console.log(`${f.split('/').pop().slice(0, 34).padEnd(34)} ${m.padEnd(5)}${m === auto ? '*' : ' '} ${ms.toFixed(0).padStart(5)}ms fails ${(s.failedFraction * 100).toFixed(2).padStart(6)}% from layer ${s.firstLayer + 1} | bridges ${s.bridges} max sag ${s.maxSag.toFixed(2)}mm | segs ${base.segs.meta.length}->${r.segs.meta.length}`);
  }
}
