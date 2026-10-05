// Printer profiles. Only affects things the G-code can't tell us:
// bed size for the scene, how fast heaters warm up, and how long
// homing / mesh bed probing take. Motion timing comes from the file itself.
//
// Heating uses a first-order model: dT/dt = k * (Tmax - T) while heating,
// dT/dt = -c * (T - ambient) while cooling. Tune k/c if your printer is
// consistently early/late during warm-up.

// Sources (Prusa-Firmware-Buddy @ 1ce23f33, Aug 2026, include/marlin/Configuration_MINI*.h;
// PrusaSlicer-settings-prusa-fff PrusaResearch/2.5.10.ini). Heater warm-up rates
// are NOT published anywhere, so those stay estimates and get corrected by the
// "It's extruding now" button + per-printer calibration.
export const PRINTERS = {
  'prusa-mini': {
    id: 'prusa-mini',
    name: 'Prusa MINI / MINI+',
    models: ['MINI', 'MINIIS'],
    bed: { w: 180, d: 180 },
    // firmware caps whatever M201/M203/M205 in the file asks for (Planner::apply_settings)
    hw: {
      normal: { feed: [400, 400, 12, 80], accel: [7000, 7000, 400, 5000], jerk: [10, 10, 2, 10] },
      stealth: { feed: [180, 180, 12, 80], accel: [2500, 2500, 400, 5000], jerk: [8, 8, 2, 10] },
    },
    // Heaters: first-order model, sized from real hardware (not published as times):
    //  hotend 24 V 40 W cartridge (Prusa part listing; KB #12202: 12.3-15.1 ohm -> ~42 W)
    //    into a small MINI heater block + nozzle (~11 J/K) -> ~70 s to 215 C, ~50 s to 170 C,
    //    ~40 s to cool 215 -> 170 without the part fan
    //  heatbed 24 V, KB #12201: 4.5-6.5 ohm -> ~105 W into bed + steel sheet (~350 J/K)
    //    -> ~2.2 min to 60 C, ~4.4 min to 85 C
    // Residency after reaching the window: TEMP_RESIDENCY_TIME 1 s, TEMP_BED_RESIDENCY_TIME 5 s.
    nozzle: { max: 400, k: 0.0102, c: 0.007, settle: 1 },
    bedHeat: { max: 125, k: 0.0036, c: 0.0022, settle: 5 },
    // G28: X/Y at HOMING_FEEDRATE_XY 50 mm/s from the park corner, travel to the
    // Z safe-homing point (147.4, 21.1), lift Z_HOMING_HEIGHT 4 mm, probe Z down at
    // 6 mm/s (~40 mm assumed) and re-bump 2 mm at 1.5 mm/s.
    homeSeconds: 20,
    // UBL mesh (ubl_G29.cpp probe_major_points): GRID_MAX_POINTS 6x6 over
    // MESH_MIN (-41,-48)..MESH_MAX (195,226) with GRID_BORDER 1, so only the inner
    // 4x4 points are ever probed; points must be reachable by the probe
    // (NOZZLE_TO_PROBE_OFFSET -29,-3, MIN_PROBE_EDGE 5, X -2..180, Y -3..180).
    // "G29 P1" probes points inside the M555 print area grown by one grid step
    // (or inside an explicit X/Y/W/H rect); "C" skips points already probed.
    // Bare "G29" = "G29 P1 X0 Y0" + interpolation (backward compatibility).
    // Per point: MULTIPLE_PROBING 2 = fast probe at 6 mm/s, lift 0.5 mm, slow
    // probe at 2 mm/s; Z_CLEARANCE_BETWEEN_PROBES 1 mm; travel XY_PROBE_SPEED
    // 5000 mm/min at the current travel acceleration.
    probe: {
      grid: [6, 6], border: 1, min: [-41, -48], max: [195, 226], samples: 2,
      offset: [-29, -3], edge: 5, axisMin: [-2, -3], axisMax: [180, 180],
      xySpeed: 5000 / 60, accel: 1250, zFast: 6, zSlow: 2, clearance: 1, multiClearance: 0.5,
      // overhead: per-point settle. 0.45 s is an empirical correction from one
      // lab observation (2 Oct 2026, Brandeis), not a firmware number. It
      // includes the owner's tap latency. See docs/VERIFICATION.md.
      startClearance: 5, overhead: 0.45, start: [147.4, 21.1],
    },
  },
  generic: {
    id: 'generic',
    name: 'Other / generic printer',
    models: [],
    bed: { w: 220, d: 220 },
    hw: null,
    nozzle: { max: 320, k: 0.012, c: 0.012, settle: 5 },
    bedHeat: { max: 130, k: 0.004, c: 0.002, settle: 5 },
    homeSeconds: 20,
    probe: {
      grid: [5, 5], border: 0, min: [10, 10], max: [210, 210], samples: 1,
      offset: [0, 0], edge: 5, axisMin: [0, 0], axisMax: [220, 220],
      xySpeed: 100, accel: 1500, zFast: 8, zSlow: 3, clearance: 2, multiClearance: 1,
      startClearance: 5, overhead: 0.3, start: [110, 110],
    },
  },
};

export function hwLimitsFor(model, stealth = false) {
  const m = String(model || '').trim().toUpperCase();
  for (const p of Object.values(PRINTERS)) {
    if (p.hw && p.models.includes(m)) return stealth ? p.hw.stealth : p.hw.normal;
  }
  return null;
}

/**
 * Replay of the firmware's mesh probing for one G29 command.
 * rec: { rect: {x0,y0,x1,y1} | null (whole bed), extend: bool, accel }
 * state: { probed: Set, pos: [x,y] }  (carried across G29 calls)
 * Returns { seconds, points, schedule, from, dwell, accel, xySpeed }.
 * schedule[i] is {x, y, t0, t1}: nozzle position over point i, seconds from
 * the start of this G29. The slots partition [0, seconds], so the sum of
 * (t1 - t0) equals seconds exactly. Travel to the point, then the probe
 * dwell, sit inside the slot (dwell is the tail, length `dwell`).
 */
export function probeRun(printer, rec, state) {
  const pr = printer.probe;
  const [gx, gy] = pr.grid, b = pr.border;
  const dx = (pr.max[0] - pr.min[0]) / (gx - 1), dy = (pr.max[1] - pr.min[1]) / (gy - 1);
  const minPX = Math.max(pr.edge, pr.axisMin[0] + pr.offset[0]), maxPX = Math.min(pr.axisMax[0] - pr.edge, pr.axisMax[0] + pr.offset[0]);
  const minPY = Math.max(pr.edge, pr.axisMin[1] + pr.offset[1]), maxPY = Math.min(pr.axisMax[1] - pr.edge, pr.axisMax[1] + pr.offset[1]);
  let rect = rec && rec.rect;
  if (rec && rec.grow && rect) rect = { x0: rect.x0 - dx, y0: rect.y0 - dy, x1: rect.x1 + dx, y1: rect.y1 + dy };
  if (!rec || !rec.extend) state.probed.clear();
  const pts = [];
  for (let y = gy - b - 1, row = 0; y >= b; y--, row++) {
    const odd = row % 2 === 1;
    for (let k = 0; k < gx - 2 * b; k++) {
      const x = odd ? b + k : gx - 1 - b - k;
      const px = pr.min[0] + x * dx, py = pr.min[1] + y * dy;
      if (px < minPX || px > maxPX || py < minPY || py > maxPY) continue;
      if (rect && (px < rect.x0 || px > rect.x1 || py < rect.y0 || py > rect.y1)) continue;
      const key = x * 100 + y;
      if (state.probed.has(key)) continue;
      state.probed.add(key);
      pts.push([px - pr.offset[0], py - pr.offset[1]]); // nozzle position over the point
    }
  }
  const a = (rec && rec.accel) || pr.accel, v = pr.xySpeed;
  const from = state.pos ? [state.pos[0], state.pos[1]] : [pr.start[0], pr.start[1]];
  if (!pts.length) return { seconds: 0, points: 0, schedule: [], from, dwell: 0, accel: a, xySpeed: v };
  const hop = (d) => (d > v * v / a ? d / v + v / a : 2 * Math.sqrt(d / a));
  const hops = [];
  let cur = from;
  let hopSum = 0;
  for (const p of pts) {
    const h = hop(Math.hypot(p[0] - cur[0], p[1] - cur[1]));
    hops.push(h);
    hopSum += h;
    cur = p;
  }
  state.pos = cur;
  const zPer = pr.clearance / pr.zFast + (pr.clearance + 0.2) / pr.zFast
    + (pr.samples - 1) * (pr.multiClearance / pr.zFast + (pr.multiClearance + 0.05) / pr.zSlow);
  const dwell = zPer + pr.overhead;
  const startZ = pr.startClearance / pr.zFast;
  // same terms as the previous single sum, so seconds does not drift
  const seconds = startZ + hopSum + pts.length * dwell;
  const schedule = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const t0 = acc;
    acc += (i === 0 ? startZ : 0) + hops[i] + dwell;
    schedule.push({ x: pts[i][0], y: pts[i][1], t0, t1: acc });
  }
  schedule[schedule.length - 1].t1 = seconds;
  return { seconds, points: pts.length, schedule, from, dwell, accel: a, xySpeed: v };
}

export const AMBIENT = 22;

export function guessPrinter(config) {
  const model = (config.printer_model || '').trim().toUpperCase();
  for (const p of Object.values(PRINTERS)) if (p.models.includes(model)) return p.id;
  return model ? 'generic' : 'prusa-mini';
}
