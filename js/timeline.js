// Turns parsed moves into a wall-clock timeline.
//
//  1. Motion time: our own kinematic estimate per move, re-anchored piecewise
//     to the slicer's M73 progress markers (the same numbers the printer
//     shows on its screen), then scaled by the learned per-printer factor.
//  2. Startup time: heater waits (simulated from the temps the user typed),
//     homing and mesh bed probing from the printer profile.
//  3. Filament changes / pauses take zero sim time; the clock auto-pauses there.

import { Ev } from './gcode.js';
import { AMBIENT, probeRun } from './printers.js';

// Words the MINI screen uses during the prelude. One place, so a lab photo
// that disagrees (the probe counter especially) is a one-line change.
// Probe "Probing" + "n/N" is the owner's best guess from "1/16, 4/16".
export const MINI_STATUS = {
  hotend: 'Waiting for hotend',
  bed: 'Waiting for bed',
  homing: 'Homing',
  probing: 'Probing',
  temp(cur, target) { return `${Math.round(cur)}/${Math.round(target)} °C`; },
  count(n, total) { return `${n}/${total}`; },
};

// Nozzle height while travelling between probe points, and how far it dips
// at the point. Small on purpose: the mesh replay is about XY, not a Z cam.
const PROBE_CLEAR = 2;
const PROBE_DIP = 1.6;

function heatTime(T, target, h) {
  // seconds to heat from T to target with first-order model
  if (target <= T) return 0;
  const top = h.max - 0.5;
  const tgt = Math.min(target, top);
  return Math.log((h.max - T) / (h.max - tgt)) / h.k;
}
function coolTime(T, target, h) {
  if (target >= T) return 0;
  const floor = AMBIENT + 3;
  const tgt = Math.max(target, floor);
  if (T <= tgt) return 0;
  return Math.log((T - AMBIENT) / (tgt - AMBIENT)) / h.c;
}
function advance(T, target, dt, h) {
  if (dt <= 0) return T;
  if (T < target) {
    const n = h.max - (h.max - T) * Math.exp(-h.k * dt);
    return Math.min(n, target);
  }
  if (T > target) {
    const n = AMBIENT + (T - AMBIENT) * Math.exp(-h.c * dt);
    return Math.max(n, target);
  }
  return T;
}

/**
 * @param {object} parsed  result of parseGcode
 * @param {object} printer profile from printers.js
 * @param {object} opts { nozzleNow, bedNow, factor }
 */
export function buildTimeline(parsed, printer, opts = {}) {
  const { kind, raw, event, param } = parsed.moves;
  const M = kind.length;
  // Speed % set on the printer (Tune > Speed). Buddy scales its own time-to-end by
  // 100/speed (marlin_server.cpp) and the setting carries over between prints.
  const speedPct = opts.speedPct > 0 ? opts.speedPct : 100;
  const factor = (opts.factor || 1) * (100 / speedPct);
  // Stealth (silent) mode on the printer: PrusaSlicer writes a second set of
  // progress markers (M73 Q/S) timed for the printer's reduced limits.
  const stealth = !!opts.stealth && parsed.silentAnchors && parsed.silentAnchors.length > 1;
  const anchorsIn = stealth ? parsed.silentAnchors : parsed.anchors;

  // ---- slicer-domain time: motion + dwell (what the slicer's estimate covers)
  const sCum = new Float64Array(M + 1);
  for (let k = 0; k < M; k++) {
    let d = 0;
    // PrusaSlicer's estimator only times G0-G3 moves (not G4 dwells, heating,
    // homing or probing), so only motion belongs in the slicer-time domain
    if (kind[k] !== 3) d = raw[k];
    sCum[k + 1] = sCum[k] + d;
  }
  const sTotal = sCum[M];

  // ---- anchors from M73 P (percent of slicer time)
  let slicerTotal = stealth ? (parsed.meta.silentEstimate || null) : parsed.meta.slicerEstimate;
  const firstR = anchorsIn.find(a => !isNaN(a.r));
  if (!(slicerTotal > 0) && firstR) slicerTotal = firstR.r * 60;
  if (!(slicerTotal > 0)) slicerTotal = sTotal;

  const pts = [{ move: 0, t: 0 }];
  let lastP = -1;
  for (const a of anchorsIn) {
    if (isNaN(a.p) || a.p <= lastP || a.p >= 100) continue;
    lastP = a.p;
    const t = slicerTotal * a.p / 100;
    const prev = pts[pts.length - 1];
    if (a.move <= prev.move || t <= prev.t) continue;
    pts.push({ move: a.move, t });
  }
  pts.push({ move: M, t: slicerTotal });

  const scale = new Float32Array(M);
  const globalScale = sTotal > 0 ? slicerTotal / sTotal : 1;
  for (let j = 0; j < pts.length - 1; j++) {
    const a = pts[j], b = pts[j + 1];
    const ds = sCum[b.move] - sCum[a.move];
    let s = ds > 1e-6 ? (b.t - a.t) / ds : globalScale;
    if (!(s > 0.25 && s < 4)) s = globalScale;
    for (let k = a.move; k < b.move; k++) scale[k] = s;
  }

  // ---- final durations, with thermal simulation for waits
  const dur = new Float32Array(M);
  const tEnd = new Float64Array(M);
  let Tn = isFinite(opts.nozzleNow) ? opts.nozzleNow : AMBIENT;
  let Tb = isFinite(opts.bedNow) ? opts.bedNow : AMBIENT;
  let tgtN = Tn, tgtB = Tb; // assume the printer is holding whatever it's at
  const hn = printer.nozzle, hb = printer.bedHeat;
  const pauses = []; // sim times where the clock auto-pauses
  const probeState = { probed: new Set(), pos: null };
  const probeByMove = new Map(); // G29 move -> {schedule, from, dwell, accel, xySpeed}
  const phases = []; // {move, kind, label}
  const thermals = []; // {t, Tn, Tb, tgtN, tgtB} at temperature events and wait edges
  const startNozzle = Tn, startBed = Tb;
  let homeDoneAt = null; // sim time the first G28 finishes (null if the file never homes)
  let t = 0;
  let pending = 0; // motion time since last thermal update

  const thermalCatchUp = () => {
    if (pending > 0) { Tn = advance(Tn, tgtN, pending, hn); Tb = advance(Tb, tgtB, pending, hb); pending = 0; }
  };
  const pushThermal = (at) => { thermals.push({ t: at, Tn, Tb, tgtN, tgtB }); };
  pushThermal(0);

  for (let k = 0; k < M; k++) {
    let d = 0;
    if (kind[k] !== 3) {
      d = raw[k] * scale[k] * factor;
      pending += d;
    } else {
      const ev = event[k], p = param[k];
      switch (ev) {
        case Ev.SetNozzle: thermalCatchUp(); tgtN = p > 0 ? p : AMBIENT; pushThermal(t); break;
        case Ev.SetBed: thermalCatchUp(); tgtB = p > 0 ? p : AMBIENT; pushThermal(t); break;
        case Ev.WaitNozzle: case Ev.WaitNozzleAny: {
          thermalCatchUp();
          if (p > 0) tgtN = p;
          pushThermal(t);
          d = heatTime(Tn, tgtN, hn);
          if (ev === Ev.WaitNozzleAny) d = Math.max(d, coolTime(Tn, tgtN, hn));
          if (d > 0) d += hn.settle;
          Tb = advance(Tb, tgtB, d, hb);
          Tn = tgtN;
          pushThermal(t + d);
          if (d > 0) phases.push({ move: k, kind: 'hotend', label: MINI_STATUS.hotend });
          break;
        }
        case Ev.WaitBed: case Ev.WaitBedAny: {
          thermalCatchUp();
          if (p > 0) tgtB = p;
          pushThermal(t);
          d = heatTime(Tb, tgtB, hb);
          if (ev === Ev.WaitBedAny) d = Math.max(d, coolTime(Tb, tgtB, hb));
          if (d > 0) d += hb.settle;
          Tn = advance(Tn, tgtN, d, hn);
          Tb = tgtB;
          pushThermal(t + d);
          if (d > 0) phases.push({ move: k, kind: 'bed', label: MINI_STATUS.bed });
          break;
        }
        case Ev.Home:
          d = printer.homeSeconds;
          pending += d;
          if (homeDoneAt == null) homeDoneAt = t + d;
          if (d > 0) phases.push({ move: k, kind: 'homing', label: MINI_STATUS.homing });
          break;
        case Ev.ProbeFull: case Ev.ProbeArea: case Ev.ProbeSmall: {
          const rec = parsed.probes ? parsed.probes[p] : null;
          const run = probeRun(printer, rec, probeState);
          d = run.seconds;
          pending += d;
          probeByMove.set(k, { schedule: run.schedule, from: run.from, dwell: run.dwell, accel: run.accel, xySpeed: run.xySpeed });
          if (d > 0) phases.push({ move: k, kind: 'probe', label: MINI_STATUS.probing });
          break;
        }
        case Ev.Dwell: d = p; pending += d; break; // real time, not scaled
        case Ev.FilamentChange: pauses.push({ t, move: k, type: 'filament' }); break;
        case Ev.Pause: pauses.push({ t, move: k, type: 'pause' }); break;
      }
    }
    dur[k] = d;
    t += d;
    tEnd[k] = t;
  }

  const tStart = (k) => (k > 0 ? tEnd[k - 1] : 0);
  const first = parsed.firstExtrudeMove >= 0 ? parsed.firstExtrudeMove : 0;
  const startupEnd = tStart(first);

  // Printer-style progress anchors (move -> percent), used for display + resync
  const pAnchors = [];
  let lp = -1;
  for (const a of anchorsIn) {
    if (isNaN(a.p) || a.p <= lp) continue;
    lp = a.p;
    // the printer's % only starts moving once real printing starts
    pAnchors.push({ p: a.p, t: Math.max(tStart(a.move), a.p === 0 ? startupEnd : 0) });
  }

  // Remaining-time anchors (M73 R, or S in stealth): the "time left" the printer
  // shows. Whole minutes, so on long prints they're finer than the 1% steps.
  const rAnchors = [];
  let lr = Infinity;
  for (const a of anchorsIn) {
    if (isNaN(a.r) || a.r > lr) continue;
    lr = a.r;
    rAnchors.push({ r: a.r, t: Math.max(tStart(a.move), rAnchors.length ? 0 : startupEnd) });
  }

  const phaseByMove = new Map(phases.map(p => [p.move, p.label]));

  return {
    tEnd, dur, total: t, startupEnd, pauses, phases, phaseByMove, pAnchors, rAnchors,
    slicerTotal, motionTotal: t - startupEnd, factor, calFactor: opts.factor || 1, stealth, speedPct,
    tStart, thermals, heaters: { nozzle: hn, bed: hb }, startNozzle, startBed, probeByMove, homeDoneAt,
  };
}

// ---- lookups ---------------------------------------------------------------

export function moveAt(tl, t) {
  // first move whose end time is > t
  const a = tl.tEnd;
  let lo = 0, hi = a.length - 1;
  if (hi < 0) return 0;
  if (t >= a[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] > t) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export function lowerBoundU32(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}
export function upperBoundU32(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Full state of the print at sim time t. */
export function stateAt(parsed, tl, t) {
  const M = parsed.moves.kind.length;
  const S = parsed.segs.move.length;
  if (M === 0) return null;
  const tc = Math.max(0, Math.min(t, tl.total));
  const k = moveAt(tl, tc);
  const ts = tl.tStart(k);
  const d = tl.dur[k];
  const frac = d > 0 ? Math.min(1, Math.max(0, (tc - ts) / d)) : 1;
  const pos = parsed.moves.pos;
  const x0 = k > 0 ? pos[(k - 1) * 3] : pos[0], y0 = k > 0 ? pos[(k - 1) * 3 + 1] : pos[1], z0 = k > 0 ? pos[(k - 1) * 3 + 2] : pos[2];
  const head = [x0 + (pos[k * 3] - x0) * frac, y0 + (pos[k * 3 + 1] - y0) * frac, z0 + (pos[k * 3 + 2] - z0) * frac];

  const done = lowerBoundU32(parsed.segs.move, k); // segments fully before move k
  const kind = parsed.moves.kind[k];
  let segHead = done;
  if (kind === 1) {
    // a move may have been split into several pieces (falling strands)
    const pieces = Math.max(1, upperBoundU32(parsed.segs.move, k) - done);
    segHead = done + frac * pieces;
  }
  if (tc >= tl.total) segHead = S;

  const segIdx = Math.min(Math.floor(segHead), S - 1);
  const layer = Math.max(0, upperBoundU32(parsed.layers.seg, Math.max(segIdx, 0)) - 1);
  const feature = S > 0 && segIdx >= 0 ? Math.floor(parsed.segs.meta[segIdx] / 4) : 0;

  // printer-style percent (interpolated between M73 anchors)
  let percent = tl.total > 0 ? (tc / tl.total) * 100 : 0;
  const pa = tl.pAnchors;
  if (pa.length > 1) {
    if (tc < pa[0].t) percent = 0;
    else {
      let j = pa.length - 1;
      for (let lo = 0, hi = pa.length - 1; lo <= hi;) {
        const mid = (lo + hi) >> 1;
        if (pa[mid].t <= tc) { j = mid; lo = mid + 1; } else hi = mid - 1;
      }
      const a = pa[j], b = pa[j + 1];
      if (b && b.t > a.t) percent = a.p + (b.p - a.p) * (tc - a.t) / (b.t - a.t);
      else if (b) percent = a.p;
      else percent = a.p + (100 - a.p) * Math.min(1, (tc - a.t) / Math.max(tl.total - a.t, 1e-6));
    }
  }
  if (tc < tl.startupEnd) percent = pa.length ? pa[0].p : 0; // printer sits at 0% while warming up
  if (tc >= tl.total) percent = 100;

  // prelude status: only while a wait, home or probe is actually running.
  // Travel to the intro line (and anything else) has no status text.
  let prep = null;
  const startup = tc < tl.startupEnd;
  if (startup && kind === 3 && d > 0) {
    const ev = parsed.moves.event[k];
    if (ev === Ev.WaitNozzle || ev === Ev.WaitNozzleAny) {
      const tmp = tempsAt(tl, tc);
      prep = { kind: 'hotend', line1: MINI_STATUS.hotend, line2: MINI_STATUS.temp(tmp.nozzle, tmp.nozzleTarget) };
    } else if (ev === Ev.WaitBed || ev === Ev.WaitBedAny) {
      const tmp = tempsAt(tl, tc);
      prep = { kind: 'bed', line1: MINI_STATUS.bed, line2: MINI_STATUS.temp(tmp.bed, tmp.bedTarget) };
    } else if (ev === Ev.Home) {
      prep = { kind: 'homing', line1: MINI_STATUS.homing, line2: '' };
    } else if (ev === Ev.ProbeFull || ev === Ev.ProbeArea || ev === Ev.ProbeSmall) {
      const info = tl.probeByMove && tl.probeByMove.get(k);
      const pose = info && probePose(info, tc - ts);
      if (pose) {
        head[0] = pose.x; head[1] = pose.y; head[2] = pose.z;
        prep = { kind: 'probe', line1: MINI_STATUS.probing, line2: MINI_STATUS.count(pose.n, pose.N) };
      }
    }
  }
  const phase = prep ? (prep.line2 ? `${prep.line1} ${prep.line2}` : prep.line1) : null;
  // real MINI keeps Z at the parked height until the first home finishes
  const homed = tl.homeDoneAt == null || tc >= tl.homeDoneAt - 1e-9;

  return {
    t: tc, move: k, frac, head, segHead, layer, layerCount: parsed.layers.z.length,
    z: head[2], feature, percent, startup, phase, prep, homed, extruding: kind === 1,
  };
}

function hopTime(dist, a, v) {
  if (!(dist > 0)) return 0;
  return dist > (v * v) / a ? dist / v + v / a : 2 * Math.sqrt(dist / a);
}

/** Where the nozzle is during one G29, and which point (1-based) it's on. */
function probePose(info, localT) {
  const sch = info.schedule;
  const N = sch.length;
  if (!N) return null;
  const end = sch[N - 1].t1;
  const t = Math.min(Math.max(0, localT), end);
  let idx = N - 1;
  for (let i = 0; i < N; i++) {
    if (t < sch[i].t1 || i === N - 1) { idx = i; break; }
  }
  const pt = sch[idx];
  const prev = idx === 0 ? info.from : [sch[idx - 1].x, sch[idx - 1].y];
  const travel = hopTime(Math.hypot(pt.x - prev[0], pt.y - prev[1]), info.accel, info.xySpeed);
  const lead = Math.max(0, pt.t1 - pt.t0 - travel - info.dwell);
  const depart = pt.t0 + lead;
  const arrive = depart + travel;
  let x, y, z;
  if (t < depart) {
    x = prev[0]; y = prev[1]; z = PROBE_CLEAR;
  } else if (t < arrive) {
    const f = travel > 1e-9 ? (t - depart) / travel : 1;
    const u = Math.min(1, Math.max(0, f));
    x = prev[0] + (pt.x - prev[0]) * u;
    y = prev[1] + (pt.y - prev[1]) * u;
    z = PROBE_CLEAR;
  } else {
    x = pt.x; y = pt.y;
    const u = info.dwell > 1e-9 ? (t - arrive) / info.dwell : 1;
    z = PROBE_CLEAR - PROBE_DIP * Math.sin(Math.min(1, Math.max(0, u)) * Math.PI);
  }
  return { x, y, z, n: idx + 1, N };
}

/**
 * Nozzle and bed temperatures at sim time t.
 * Before the job (t < 0): the temps the user typed, held there.
 * Otherwise: last thermal keyframe at or before t, then both heaters keep
 * moving for the time since (so one wait doesn't freeze the other heater).
 */
export function tempsAt(tl, t) {
  if (!(t >= 0)) {
    return {
      nozzle: tl.startNozzle, nozzleTarget: tl.startNozzle,
      bed: tl.startBed, bedTarget: tl.startBed,
    };
  }
  const th = tl.thermals;
  if (!th || !th.length) {
    return {
      nozzle: tl.startNozzle, nozzleTarget: tl.startNozzle,
      bed: tl.startBed, bedTarget: tl.startBed,
    };
  }
  let lo = 0, hi = th.length - 1, i = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (th[mid].t <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const kf = th[i];
  const dt = t - kf.t;
  return {
    nozzle: advance(kf.Tn, kf.tgtN, dt, tl.heaters.nozzle),
    nozzleTarget: kf.tgtN,
    bed: advance(kf.Tb, kf.tgtB, dt, tl.heaters.bed),
    bedTarget: kf.tgtB,
  };
}

/**
 * "Time left" the MINI would show, in minutes.
 * The last M73 R mark already passed (rAnchors), scaled the same way
 * timeForRemaining undoes the speed % (shown = file R * 100 / speed%).
 * Before the first anchor (the whole prelude) this is the first R.
 * Files with no R marks fall back to (total - t) / 60.
 * Monotonic non-increasing.
 */
export function remainingAt(tl, t) {
  const ra = tl.rAnchors;
  const tc = Number.isFinite(t) ? t : 0;
  if (!ra || ra.length < 2) return Math.max(0, (tl.total - Math.max(0, tc)) / 60);
  const scale = 100 / (tl.speedPct || 100);
  // the MINI shows the last M73 R it received and steps down a whole minute at
  // each new mark (timeForRemaining assumes the same), so no interpolation
  let j = 0;
  for (let lo = 0, hi = ra.length - 1; lo <= hi;) {
    const mid = (lo + hi) >> 1;
    if (ra[mid].t <= tc) { j = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (tc >= tl.total) return 0;
  return Math.max(0, ra[j].r) * scale;
}

/**
 * Sim time where the printer's screen first shows this much time left (minutes).
 * The MINI scales the file's M73 R by the print speed %, so undo that first.
 * Returns null if the file has no remaining-time marks.
 */
export function timeForRemaining(tl, minutes) {
  const ra = tl.rAnchors;
  if (!ra || ra.length < 2 || !(minutes >= 0)) return null;
  const fileR = minutes * (tl.speedPct || 100) / 100;
  if (fileR >= ra[0].r) return ra[0].t;
  for (let i = 1; i < ra.length; i++) {
    if (ra[i].r <= fileR) {
      const a = ra[i - 1], b = ra[i];
      // R drops in whole minutes: land where the screen first shows this value
      const f = a.r > b.r ? (a.r - Math.max(fileR, b.r)) / (a.r - b.r) : 1;
      return a.t + (b.t - a.t) * Math.min(1, Math.max(0, f));
    }
  }
  return ra[ra.length - 1].t;
}

/** Sim time where the printer's display first shows >= percent. */
export function timeForPercent(tl, percent) {
  const pa = tl.pAnchors;
  if (pa.length > 1) {
    for (const a of pa) if (a.p >= percent) return a.t;
    return tl.total;
  }
  return tl.total * percent / 100;
}
