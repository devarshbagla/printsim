import { readFileSync } from 'node:fs';
import { decodeBgcode } from '../js/bgcode.js';
import { parseGcode, parseDuration, Ev } from '../js/gcode.js';
import { buildTimeline, stateAt, timeForPercent, tempsAt, remainingAt, MINI_STATUS } from '../js/timeline.js';
import { PRINTERS, probeRun } from '../js/printers.js';
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

// Real MINI prelude (lab start G-code, 2 Oct 2026) plus a short body.
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};
{
  const parsed = parseGcode(readFileSync(new URL('./fixtures/mini-prelude.gcode', import.meta.url)));
  const printer = PRINTERS['prusa-mini'];
  check('MINI probe overhead is the lab correction (0.45 s)', printer.probe.overhead === 0.45);
  const mesh = probeRun(printer, null, { probed: new Set(), pos: null });
  let sum = 0;
  for (const pt of mesh.schedule) sum += pt.t1 - pt.t0;
  let contig = mesh.schedule.length > 0 && mesh.schedule[0].t0 === 0 && mesh.schedule[mesh.schedule.length - 1].t1 === mesh.seconds;
  for (let i = 1; i < mesh.schedule.length; i++) if (mesh.schedule[i].t0 !== mesh.schedule[i - 1].t1) contig = false;
  check('probe schedule: 16 points, slots sum to seconds exactly', mesh.points === 16 && sum === mesh.seconds && contig, `${mesh.points} pts, ${sum} vs ${mesh.seconds}`);

  const tl = buildTimeline(parsed, printer, { nozzleNow: 22, bedNow: 22 });
  check('prelude phases: hotend, bed, homing, probe, hotend', tl.phases.map(p => p.kind).join(',') === 'hotend,bed,homing,probe,hotend', tl.phases.map(p => p.kind).join(','));
  const before = tempsAt(tl, -1);
  check('before the job, temps are what setup typed', before.nozzle === 22 && before.nozzleTarget === 22 && before.bed === 22 && before.bedTarget === 22);
  const bed = tl.phases.find(p => p.kind === 'bed');
  const tBed = tl.tStart(bed.move) + 0.2;
  const bedT = tempsAt(tl, tBed);
  const bedSt = stateAt(parsed, tl, tBed);
  check('bed wait: nozzle already hot, bed still climbing (heaters in parallel)', bedT.nozzle > 169 && bedT.nozzleTarget === 170 && bedT.bed > 30 && bedT.bed < 59 && bedT.bedTarget === 60, JSON.stringify(bedT));
  check('bed wait wording matches the MINI', bedSt.phase === `${MINI_STATUS.bed} ${MINI_STATUS.temp(bedT.bed, bedT.bedTarget)}` && bedSt.prep.line1 === MINI_STATUS.bed && bedSt.prep.line2.includes(' °C'));
  const home = tl.phases.find(p => p.kind === 'homing');
  const homeSt = stateAt(parsed, tl, tl.tStart(home.move) + 1);
  check('homing wording, Z not homed yet', homeSt.phase === MINI_STATUS.homing && homeSt.prep.line2 === '' && homeSt.homed === false);
  check('homed once G28 has finished', stateAt(parsed, tl, tl.homeDoneAt + 0.01).homed === true);

  const probe = tl.phases.find(p => p.kind === 'probe');
  const info = tl.probeByMove.get(probe.move);
  const t0 = tl.tStart(probe.move), dur = tl.dur[probe.move];
  let slotSum = 0;
  for (const pt of info.schedule) slotSum += pt.t1 - pt.t0;
  check('G29 slots sum to the move duration (float32 store)', Math.abs(slotSum - dur) < 1e-4 && info.schedule.length === 16, `${slotSum} vs ${dur}`);
  let prevN = 0, mono = true;
  const seen = new Set();
  let headMoved = false;
  let prevHead = null;
  for (let i = 0; i <= 200; i++) {
    const st = stateAt(parsed, tl, t0 + dur * (i / 200) * 0.999);
    const m = /^Probing (\d+)\/(\d+)$/.exec(st.phase || '');
    if (!m || m[2] !== '16') { mono = false; break; }
    const n = +m[1];
    if (n < prevN) mono = false;
    prevN = n;
    seen.add(n);
    if (prevHead && (Math.abs(st.head[0] - prevHead[0]) > 0.5 || Math.abs(st.head[1] - prevHead[1]) > 0.5)) headMoved = true;
    prevHead = st.head.slice();
  }
  const allN = [...Array(16)].every((_, i) => seen.has(i + 1));
  check('probe counter climbs 1 through 16 and never goes backwards', mono && allN && prevN === 16, `last ${prevN}, saw ${seen.size}`);
  check('head moves along the probe path', headMoved);
  // at the dwell of each point the nozzle is on that point
  let onPoint = true;
  for (let i = 0; i < info.schedule.length; i++) {
    const pt = info.schedule[i];
    const st = stateAt(parsed, tl, t0 + pt.t1 - info.dwell * 0.5);
    if (Math.hypot(st.head[0] - pt.x, st.head[1] - pt.y) > 0.2) onPoint = false;
    if (!/^Probing (\d+)\/16$/.test(st.phase) || +st.phase.match(/(\d+)/)[1] !== i + 1) onPoint = false;
  }
  check('during each probe dwell the head sits on that point', onPoint);
  const after = stateAt(parsed, tl, tl.tEnd[probe.move] + 0.15);
  check('after probing, travel to the intro line has no status text', after.startup && after.phase == null && after.prep == null);

  const hot = tl.phases.filter(p => p.kind === 'hotend');
  const endHot = tempsAt(tl, tl.tEnd[hot[1].move] + 0.05);
  check('first layer target is 230/60 once the second hotend wait ends', Math.abs(endHot.nozzle - 230) < 0.5 && endHot.nozzleTarget === 230 && Math.abs(endHot.bed - 60) < 0.5 && endHot.bedTarget === 60, JSON.stringify(endHot));
  let m104 = -1;
  for (let k = 0; k < parsed.moves.event.length; k++) if (parsed.moves.event[k] === Ev.SetNozzle && parsed.moves.param[k] === 220) m104 = k;
  const atSet = tempsAt(tl, tl.tEnd[m104]);
  const later = tempsAt(tl, tl.tEnd[m104] + 30);
  check('later M104 S220 becomes the nozzle target, and it cools there', atSet.nozzleTarget === 220 && later.nozzleTarget === 220 && later.nozzle < 220.5 && later.nozzle > 219.5, `${atSet.nozzle.toFixed(1)} -> ${later.nozzle.toFixed(1)}`);

  let prevR = Infinity, rMono = true;
  for (let i = 0; i <= 300; i++) {
    const v = remainingAt(tl, (tl.total * i) / 300);
    if (v > prevR + 1e-6) rMono = false;
    prevR = v;
  }
  check('remainingAt is 87 min before printing and never increases', rMono && remainingAt(tl, 0) === 87 && remainingAt(tl, tl.startupEnd - 0.5) === 87 && remainingAt(tl, tl.total) === 0, `start ${remainingAt(tl, 0)} end ${remainingAt(tl, tl.total)}`);
  // like the printer: hold the last M73 R passed until the next one arrives
  let stepOk = true;
  for (let i = 0; i + 1 < tl.rAnchors.length; i++) {
    const a = tl.rAnchors[i], b = tl.rAnchors[i + 1];
    if (b.t > a.t && remainingAt(tl, (a.t + b.t) / 2) !== a.r) stepOk = false;
  }
  check('remainingAt holds the last M73 R until the next mark (no interpolation)', stepOk);
  const half = buildTimeline(parsed, printer, { nozzleNow: 22, bedNow: 22, speedPct: 50 });
  check('remainingAt scales with print speed % (50% shows 174 min at the start)', remainingAt(half, 0) === 174, String(remainingAt(half, 0)));
  const noR = buildTimeline({ ...parsed, anchors: parsed.anchors.map(a => ({ ...a, r: NaN })) }, printer, { nozzleNow: 22, bedNow: 22 });
  const back = remainingAt(noR, 0);
  check('no R marks: remainingAt falls back to total - t', Math.abs(back - noR.total / 60) < 1e-6 && remainingAt(noR, noR.total) === 0, `${back} vs ${(noR.total / 60).toFixed(3)}`);
}
if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
