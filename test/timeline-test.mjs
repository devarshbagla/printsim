import { readFileSync } from 'node:fs';
import { decodeBgcode } from '../js/bgcode.js';
import { parseGcode, parseDuration } from '../js/gcode.js';
import { buildTimeline, stateAt, timeForPercent } from '../js/timeline.js';
import { PRINTERS } from '../js/printers.js';
const dir = process.argv[2];
const d = await decodeBgcode(new Uint8Array(readFileSync(`${dir}/mini_cube_b.bgcode`)));
const r = parseGcode(d.gcode);
r.meta.slicerEstimate = parseDuration(d.metadata.print['estimated printing time (normal mode)']);
const fmt = s => `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
for (const temps of [[22, 22], [170, 85]]) {
  const tl = buildTimeline(r, PRINTERS['prusa-mini'], { nozzleNow: temps[0], bedNow: temps[1] });
  console.log(`start temps ${temps}: total ${fmt(tl.total)} startup ${fmt(tl.startupEnd)} motion ${fmt(tl.motionTotal)} slicer ${fmt(tl.slicerTotal)}`);
  console.log('  phases', tl.phases.map(p => `${p.label}@${fmt(tl.tStart(p.move))} (${Math.round(tl.dur[p.move])}s)`).join(' | '));
  for (const pct of [0, 1, 25, 50, 99, 100]) {
    const t = timeForPercent(tl, pct); const st = stateAt(r, tl, t + 0.01);
    console.log(`  resync ${pct}% -> t=${fmt(t)} state%=${st.percent.toFixed(1)} layer ${st.layer + 1}/${st.layerCount} seg ${st.segHead.toFixed(1)} phase ${st.phase}`);
  }
  for (const t of [30, 200, tl.startupEnd - 1, tl.startupEnd + 5, tl.total / 2, tl.total - 1]) {
    const st = stateAt(r, tl, t);
    console.log(`  t=${fmt(t)} ${st.percent.toFixed(1)}% phase=${st.phase} head=${st.head.map(v => v.toFixed(1))} z=${st.z.toFixed(2)}`);
  }
}
