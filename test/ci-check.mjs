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

// ---- fallen plastic: drawn with the same volume the nozzle extruded ----
{
  const { parsed } = await load(`${here}samples/mushroom-no-supports.gcode`);
  parsed.rawSegs = parsed.segs; parsed.rawLayerSeg = parsed.layers.seg.slice();
  simulatePhysics(parsed, 'PLA', 215);
  const s = parsed.segs, NL = parsed.layers.z.length, N = s.meta.length;
  const lh = new Float32Array(N);
  for (let L = 0; L < NL; L++) lh.fill(L ? parsed.layers.z[L] - parsed.layers.z[L - 1] : parsed.layers.z[0], parsed.layers.seg[L], L + 1 < NL ? parsed.layers.seg[L + 1] : N);
  let ext = 0, drawn = 0;
  for (let i = 0; i < N; i++) {
    const d0 = s.drop[i * 2], d1 = s.drop[i * 2 + 1];
    if (!(d0 > 0 && d1 > 0) || s.blob[i]) continue; // blob pieces are checked below
    const w = s.meta[i] - Math.floor(s.meta[i] / 4 + 1e-3) * 4, h = lh[i];
    const dx = s.end[i * 3] - s.start[i * 3], dy = s.end[i * 3 + 1] - s.start[i * 3 + 1], dz = (s.end[i * 3 + 2] - d1) - (s.start[i * 3 + 2] - d0);
    const L0 = Math.hypot(dx, dy), L = Math.hypot(dx, dy, dz);
    ext += w * h * L0;
    // same thickness rule as the renderer's vertex shader (round, same area, thinned when stretched)
    const r = Math.sqrt((w * h) / Math.PI) * Math.sqrt(Math.min(1, Math.max(0.25, L0 / Math.max(L, 1e-4))));
    drawn += L * Math.PI * r * r;
  }
  check('fallen plastic is drawn with the volume that was extruded', ext > 100 && Math.abs(drawn / ext - 1) < 0.1, `${(drawn / ext).toFixed(2)}x of ${ext.toFixed(0)} mm3`);
  // the rule above must be the one the shader actually uses
  const shader = readFileSync(`${here}js/renderer.js`, 'utf8').replace(/\s+/g, ' ');
  check('renderer draws fallen strands with that same thickness rule',
    shader.includes('sqrt(width * lh / 3.14159) * sqrt(clamp(L0 / max(L, 1e-4), 0.25, 1.0))'));

  // plastic that balls up on the nozzle: all of it lands somewhere, in a ball of its own volume
  const B = s.blobPiece.length;
  let stuck = 0;
  const perBlob = new Float64Array(B);
  for (let i = 0; i < N; i++) if (s.blob[i]) {
    const w = s.meta[i] - Math.floor(s.meta[i] / 4 + 1e-3) * 4, h = lh[i];
    const v = w * h * Math.hypot(s.end[i * 3] - s.start[i * 3], s.end[i * 3 + 1] - s.start[i * 3 + 1]);
    stuck += v; perBlob[s.blob[i] - 1] += v;
  }
  const blobsOk = B > 0 && s.blob.every((b) => b <= B) && Array.from(s.blobPiece).every((k) => k < N);
  check('mushroom: some spaghetti balls up on the nozzle (PLA, a minority of it)', blobsOk && stuck > 0.03 * ext && stuck < 0.4 * (ext + stuck),
    `${B} blobs, ${stuck.toFixed(0)} of ${(ext + stuck).toFixed(0)} mm3`);
  let rOk = true;
  for (let b = 0; b < B; b++) {
    const R = s.blobPos[b * 4 + 3], want = Math.max(0.6, Math.cbrt((3 * perBlob[b]) / (4 * Math.PI * 0.55)));
    if (Math.abs(R - want) > 0.02 * want + 0.05) rOk = false;
  }
  check('each blob is drawn as big as the plastic in it (55% packed tangle)', rOk);
  // a blob comes off where the nozzle is when it happens: after the plastic in it was laid
  let orderOk = true;
  for (let i = 0; i < N; i++) if (s.blob[i] && s.blobPiece[s.blob[i] - 1] < i) { orderOk = false; break; }
  check('blobs come off the nozzle after they were picked up', orderOk);
  check('every strand has a heat value', s.heat && s.heat.length === N && s.heat.some((v) => v > 0));
}

// ---- cooling: soft seconds come from the fan and the filament ----
{
  const { MATERIALS, softSeconds } = await import('../js/materials.js');
  const pla0 = softSeconds(MATERIALS.PLA, 0, 215), pla1 = softSeconds(MATERIALS.PLA, 1, 215);
  check('PLA stays soft much longer with the part fan off', pla1 > 0.4 && pla1 < 2 && pla0 > 4 * pla1, `${pla1.toFixed(2)} s at 100% fan, ${pla0.toFixed(2)} s at 0%`);
  check('hotter nozzle, softer strand', softSeconds(MATERIALS.PLA, 1, 240) > pla1);
}

// ---- service worker: every module is precached, or the app won't boot offline ----
{
  const { readdirSync, existsSync } = await import('node:fs');
  const sw = readFileSync(`${here}sw.js`, 'utf8');
  const core = [...sw.match(/const CORE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const need = [...readdirSync(`${here}js`).map(f => `js/${f}`), ...readdirSync(`${here}vendor`).filter(f => f.endsWith('.js')).map(f => `vendor/${f}`)];
  const missing = need.filter(f => !core.includes(f));
  check('service worker precaches every js/ and vendor/ module', !missing.length, missing.join(', '));
  const dead = core.filter(f => f !== './' && !existsSync(`${here}${f}`));
  check('service worker precache list has no missing files', !dead.length, dead.join(', '));
}

// ---- calendar reminders (js/ics.js) ----
{
  const { planEvents, buildIcs, googleCalendarUrl, foldLine, icsText } = await import('../js/ics.js');
  const nowMs = Date.UTC(2026, 8, 29, 4, 0, 0);
  const ev = planEvents({ nowMs, simNow: 600, total: 4200, pauses: [{ t: 300, type: 'filament' }, { t: 1800, type: 'filament' }, { t: 3000, type: 'pause' }], name: 'cube, v2; final.bgcode', printer: 'Prusa MINI+' });
  check('ics: past stops skipped, future stops + finish kept, in order', ev.map(e => e.kind).join() === 'filament,pause,finish');
  check('ics: times are wall clock from now', ev[0].start === nowMs + 1200e3 && ev[2].start === nowMs + 3600e3);
  check('ics: file extension dropped from titles', ev[2].title === 'Print done: cube, v2; final');
  const ics = buildIcs(ev, { nowMs, uidSeed: 'x' });
  const lines = ics.split('\r\n');
  check('ics: CRLF line endings only', !/[^\r]\n/.test(ics) && ics.endsWith('\r\n'));
  check('ics: every line is 75 octets or less', lines.every(l => new TextEncoder().encode(l).length <= 75));
  check('ics: 3 events, 6 alarms, balanced blocks',
    (ics.match(/BEGIN:VEVENT/g) || []).length === 3 && (ics.match(/BEGIN:VALARM/g) || []).length === 6 && (ics.match(/END:VALARM/g) || []).length === 6);
  check('ics: UTC start time', ics.includes('DTSTART:20260929T050000Z'));
  check('ics: commas and semicolons escaped', ics.includes('SUMMARY:Print done: cube\\, v2\\; final'));
  check('ics: finish alarms 10 min before and on time', /TRIGGER:-PT10M[\s\S]*TRIGGER:PT0M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR/.test(ics));
  const unfolded = ics.replace(/\r\n /g, '');
  check('ics: folding round-trips', unfolded.includes(`DESCRIPTION:${icsText(ev[2].description)}`));
  const multi = foldLine('X:' + 'é'.repeat(100));
  check('ics: folding never splits a UTF-8 character', !multi.includes('�') && multi.replace(/\r\n /g, '') === 'X:' + 'é'.repeat(100));
  const g = new URL(googleCalendarUrl(ev[2]));
  check('ics: Google link carries title and UTC dates',
    g.hostname === 'calendar.google.com' && g.searchParams.get('action') === 'TEMPLATE' &&
    g.searchParams.get('dates') === '20260929T050000Z/20260929T051500Z' && g.searchParams.get('text') === ev[2].title);
}

// ---- spaghetti report (js/report.js): when it goes wrong, grams at stake ----
{
  const { spaghettiReport, gramsPerMm, statedGrams } = await import('../js/report.js');
  const prep = async (path, mat) => {
    const { parsed } = await load(path);
    const m = mat || detectMaterial(parsed.meta.config);
    parsed.rawSegs = parsed.segs; parsed.rawLayerSeg = parsed.layers.seg.slice();
    simulatePhysics(parsed, m, nozzleTemp(parsed.meta.config));
    const tl = buildTimeline(parsed, PRINTERS['prusa-mini'], { nozzleNow: 22, bedNow: 22 });
    return { parsed, m, r: spaghettiReport(parsed, (k) => tl.tStart(k), tl.startupEnd, tl.total, m) };
  };
  const { r } = await prep(`${here}samples/mushroom-no-supports.gcode`);
  check('report: mushroom goes wrong on layer 61', r && r.layer + 1 === 61, r && `layer ${r.layer + 1}`);
  check('report: mushroom goes wrong 3 to 6 min in (~28%)', r && r.tFail > 180 && r.tFail < 360 && r.pctFail > 20 && r.pctFail < 35, r && `${(r.tFail / 60).toFixed(1)} min, ${r.pctFail.toFixed(0)}%`);
  check('report: spaghetti grams <= grams at risk <= total', r && r.spaghettiG > 1 && r.spaghettiG <= r.afterG && r.afterG <= r.totalG, r && `${r.spaghettiG.toFixed(2)} / ${r.afterG.toFixed(2)} / ${r.totalG.toFixed(2)} g`);
  check('report: mushroom counts as severe', r && r.severe);
  check('report: nothing to report for the vase', (await prep(`${here}samples/twisted-vase.gcode`)).r === null);
  // net extruder travel reproduces PrusaSlicer's own filament weight
  for (const f of ['mini_cube_b.bgcode', 'mini_cube_ps2.8.1.bgcode']) {
    const { parsed, m } = await prep(`${dir}/${f}`);
    let net = 0; for (const v of parsed.moves.e) net += v;
    const g = net * gramsPerMm(parsed.meta.config, m), want = statedGrams(parsed.meta.config);
    check(`report: ${f} filament from E within 1% of the slicer's grams`, Math.abs(g / want - 1) < 0.01, `${g.toFixed(3)} vs ${want} g`);
  }
}

// ---- resync by the time left on the printer screen (M73 R) ----
{
  const { timeForRemaining } = await import('../js/timeline.js');
  const { parsed, meta } = await load(`${dir}/mini_cube_b.bgcode`);
  parsed.meta.slicerEstimate = parseDuration(meta.print['estimated printing time (normal mode)']);
  for (const sp of [100, 50]) {
    const tl = buildTimeline(parsed, PRINTERS['prusa-mini'], { nozzleNow: 170, bedNow: 85, speedPct: sp });
    let worst = 0, mono = true, prev = -1;
    for (const m of [25, 15, 8, 3]) {
      const shown = m * 100 / sp;            // the MINI shows R scaled by 100 / speed %
      const t = timeForRemaining(tl, shown);
      if (t <= prev) mono = false; prev = t;
      worst = Math.max(worst, Math.abs((tl.total - t) / 60 - shown));
    }
    check(`resync by time left lands within ~1 min of it (${sp}% speed)`, mono && worst < 1.5 * 100 / sp, `worst ${worst.toFixed(2)} min (one R step = ${100 / sp} min on screen)`);
  }
  const noR = buildTimeline({ ...parsed, anchors: parsed.anchors.map((a) => ({ ...a, r: NaN })) }, PRINTERS['prusa-mini'], {});
  check('resync by time left: no R marks -> null (falls back to %)', timeForRemaining(noR, 10) === null);
}

// ---- "when did it finish?" (js/finish.js) ----
{
  const { clockToWall, wallToClock, expectedEndWall, measureRun } = await import('../js/finish.js');
  const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();
  const nowMs = at(2026, 9, 5, 1, 30), start = at(2026, 9, 4, 18, 0);
  check('finish clock: earlier today', clockToWall('00:45', nowMs, start) === at(2026, 9, 5, 0, 45));
  check('finish clock: later than now means yesterday (ran past midnight)', clockToWall('23:10', nowMs, start) === at(2026, 9, 4, 23, 10));
  check('finish clock: before the print started -> null', clockToWall('17:00', nowMs, start) === null);
  check('finish clock: garbage -> null', clockToWall('', nowMs, start) === null && clockToWall('25:00', nowMs, start) === null);
  check('finish clock round-trips', clockToWall(wallToClock(at(2026, 9, 5, 0, 7)), nowMs, start) === at(2026, 9, 5, 0, 7));
  const run = { running: true, anchorWall: start, anchorSim: 0, startedWall: start, pausedMs: 0, pauseStartWall: null, extrudeWall: start + 300e3, pausedAtExtrude: 0 };
  check('expected end = start + sim total', expectedEndWall(run, 3600) === start + 3600e3);
  check('expected end unknown while paused', expectedEndWall({ ...run, running: false }, 3600) === null);
  // checked back 3 h late but said when it really finished: measured from that, not from now
  const m = measureRun(run, start + 3600e3, 300);
  check('measure: from the stated finish, motion from first extrusion', m.total === 3600 && m.motion === 3300, JSON.stringify(m));
  const p = measureRun({ ...run, running: false, pauseStartWall: start + 3000e3 }, start + 3600e3, 300);
  check('measure: an open pause counts only up to the finish', p.total === 3000 && p.motion === 2700, JSON.stringify(p));
  const { planEvents } = await import('../js/ics.js');
  const ev = planEvents({ nowMs, simNow: 0, total: 600, name: 'a.gcode', url: 'https://x/p/', finishUrl: 'https://x/p/?done=1' });
  check('calendar finish alert links to the finish prompt', ev[0].description.includes('https://x/p/?done=1'));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
