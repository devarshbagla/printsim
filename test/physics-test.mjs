// Support analysis: no false alarms on real prints, catches the mushroom.
import { readFileSync, existsSync } from 'node:fs';
import { decodeBgcode, isBgcode } from '../js/bgcode.js';
import { parseGcode } from '../js/gcode.js';
import { analyzeSupport } from '../js/physics.js';
const files = process.argv.slice(2);
for (const f of files) {
  if (!existsSync(f)) continue;
  let bytes = new Uint8Array(readFileSync(f));
  if (isBgcode(bytes)) bytes = (await decodeBgcode(bytes)).gcode;
  const r = parseGcode(bytes);
  const t0 = performance.now();
  const { drop, summary: s } = analyzeSupport(r);
  const ms = performance.now() - t0;
  console.log(`${f.split('/').pop().slice(0, 50).padEnd(50)} ${ms.toFixed(0).padStart(5)}ms  fails ${(s.failedFraction * 100).toFixed(2)}% of length, ${s.failedSegments} segs, layers ${s.firstLayer + 1}-${s.lastLayer + 1} (${s.layersAffected} affected of ${r.layers.z.length})`);
}
