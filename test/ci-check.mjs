// CI gate: the other test scripts print numbers for humans; this one asserts
// the invariants and exits nonzero if any break. Run it with the libbgcode
// test data folder as the only argument:
//   node test/ci-check.mjs /tmp/libbgcode/tests/data
import { readFileSync } from 'node:fs';
import { decodeBgcode, isBgcode } from '../js/bgcode.js';
import { parseGcode, parseDuration } from '../js/gcode.js';
import { buildTimeline, stateAt, timeForPercent } from '../js/timeline.js';
import { PRINTERS } from '../js/printers.js';
import { simulatePhysics } from '../js/physics.js';
import { detectMaterial, nozzleTemp } from '../js/materials.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: node test/ci-check.mjs <libbgcode tests/data>'); process.exit(2); }
const here = new URL('..', import.meta.url).pathname;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

async function load(path) {
  let bytes = new Uint8Array(readFileSync(path)), meta = null, cfg = {};
  if (isBgcode(bytes)) {
    const d = await decodeBgcode(bytes);
    bytes = d.gcode; meta = d.metadata; cfg = { ...d.metadata.slicer, ...d.metadata.printer };
  }
  const parsed = parseGcode(bytes);
  Object.assign(parsed.meta.config, cfg);
  return { parsed, meta };
}

// ---- decode: byte-identical to Prusa's reference text ----
const norm = s => s.split('\n').map(l => l.trimEnd()).filter(l => l !== ';' && l !== '').join('\n');
for (const [name, strict] of [['mini_cube_b', true], ['mini_cube_ps2.8.1', false]]) {
  const { gcode } = await decodeBgcode(new Uint8Array(readFileSync(`${dir}/${name}.bgcode`)));
  let mine = new TextDecoder().decode(gcode), ref = readFileSync(`${dir}/${name}_ref.gcode`, 'utf8');
  // PS 2.8.1 differs from the reference only on bare ";" lines (known, harmless)
  if (!strict) { mine = norm(mine); ref = norm(ref); }
  const i = ref.indexOf(mine.slice(0, 300));
  check(`decode ${name} matches Prusa's reference${strict ? ' byte for byte' : ' (bare ; lines ignored)'}`,
    i >= 0 && ref.slice(i, i + mine.length) === mine);
}

// ---- parse: firmware planner time within 1% of PrusaSlicer's estimate ----
for (const f of ['mini_cube_a.gcode', 'mini_cube_b.bgcode', 'mini_cube_ps2.8.1.bgcode']) {
  const { parsed, meta } = await load(`${dir}/${f}`);
  let raw = 0; for (const v of parsed.moves.raw) raw += v;
  const est = parseDuration(meta ? meta.print['estimated printing time (normal mode)'] : parsed.meta.config['estimated printing time (normal mode)']);
  const err = (raw - est) / est;
  check(`parse ${f} time within 1% of slicer`, Math.abs(err) < 0.01, `${(err * 100).toFixed(2)}%`);
  check(`parse ${f} has layers and M73 anchors`, parsed.layers.z.length > 10 && parsed.anchors.length > 10);
}

// ---- timeline: warm-up added on top, resync lands where asked ----
{
  const { parsed, meta } = await load(`${dir}/mini_cube_b.bgcode`);
  parsed.meta.slicerEstimate = parseDuration(meta.print['estimated printing time (normal mode)']);
  const cold = buildTimeline(parsed, PRINTERS['prusa-mini'], { nozzleNow: 22, bedNow: 22 });
  const warm = buildTimeline(parsed, PRINTERS['prusa-mini'], { nozzleNow: 170, bedNow: 85 });
  check('timeline cold start takes longer than warm start', cold.total > warm.total, `${cold.total.toFixed(0)}s vs ${warm.total.toFixed(0)}s`);
  check('timeline total exceeds slicer estimate (heating, homing, probing added)', warm.total > warm.slicerTotal);
  const half = buildTimeline(parsed, PRINTERS['prusa-mini'], { nozzleNow: 170, bedNow: 85, speedPct: 50 });
  check('timeline 50% print speed roughly doubles motion time',
    Math.abs(half.motionTotal / warm.motionTotal - 2) < 0.05, `x${(half.motionTotal / warm.motionTotal).toFixed(3)}`);
  let prev = -1, mono = true, worst = 0;
  for (const pct of [1, 10, 25, 50, 75, 99]) {
    const t = timeForPercent(warm, pct);
    if (t <= prev) mono = false;
    prev = t;
    worst = Math.max(worst, Math.abs(stateAt(parsed, warm, t + 0.01).percent - pct));
  }
  check('timeline resync times increase with %', mono);
  check('timeline resync lands within 0.5% of the requested %', worst < 0.5, `worst ${worst.toFixed(2)}`);
  const end = stateAt(parsed, warm, warm.total - 0.01);
  check('timeline ends on the last layer', end.layer + 1 === end.layerCount);
}

// ---- physics: no false alarms on real prints, the mushroom still fails ----
async function support(path, mat) {
  const { parsed } = await load(path);
  const m = mat || detectMaterial(parsed.meta.config);
  const r = { ...parsed, layers: { ...parsed.layers }, rawSegs: parsed.segs, rawLayerSeg: parsed.layers.seg.slice() };
  simulatePhysics(r, m, nozzleTemp(parsed.meta.config));
  return r.support;
}
const WARN = 0.002; // warning box threshold in the app
for (const f of [`${here}samples/twisted-vase.gcode`, `${here}test/bridge.gcode`, `${dir}/mini_cube_b.bgcode`, `${dir}/mini_cube_ps2.8.1.bgcode`]) {
  const s = await support(f);
  check(`physics ${f.split('/').pop()} (${s.material}) raises no alarm`, s.failedFraction < WARN, `${(s.failedFraction * 100).toFixed(2)}%`);
}
{
  const s = await support(`${here}samples/mushroom-no-supports.gcode`);
  check('physics mushroom (PLA) fails hard', s.failedFraction > 0.4, `${(s.failedFraction * 100).toFixed(2)}%`);
  check('physics mushroom fails from the cap (layer 61)', s.firstLayer + 1 === 61, `layer ${s.firstLayer + 1}`);
  for (const m of ['PETG', 'ABS']) {
    const b = await support(`${here}test/bridge.gcode`, m);
    check(`physics bridge in ${m} fails long spans`, b.failedFraction > 0.05, `${(b.failedFraction * 100).toFixed(2)}%`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
