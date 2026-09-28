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
    // estimates (see header): first-order heater model
    nozzle: { max: 320, k: 0.0105, c: 0.012, settle: 1 },   // TEMP_RESIDENCY_TIME 1 s
    bedHeat: { max: 125, k: 0.0036, c: 0.0022, settle: 5 }, // TEMP_BED_RESIDENCY_TIME 5 s
    // G28: X/Y at HOMING_FEEDRATE_XY 50 mm/s from the park corner, travel to the
    // Z safe-homing point (147.4, 21.1), lift Z_HOMING_HEIGHT 4 mm, probe Z down at
    // 6 mm/s (~40 mm assumed) and re-bump 2 mm at 1.5 mm/s.
    homeSeconds: 20,
    // UBL mesh: GRID_MAX_POINTS 6x6 over MESH_MIN (-41,-48) .. MESH_MAX (195,226),
    // MULTIPLE_PROBING 2, XY_PROBE_SPEED 5000 mm/min, Z fast 6 mm/s / slow 2 mm/s,
    // Z_CLEARANCE_BETWEEN_PROBES 1 mm, Z_CLEARANCE_MULTI_PROBE 0.5 mm.
    probe: {
      grid: [6, 6], min: [-41, -48], max: [195, 226], samples: 2,
      xySpeed: 5000 / 60, accel: 1250, zFast: 6, zSlow: 2, clearance: 1, multiClearance: 0.5,
      startClearance: 5, overhead: 0.2,
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
      grid: [5, 5], min: [0, 0], max: [220, 220], samples: 1,
      xySpeed: 100, accel: 1500, zFast: 8, zSlow: 3, clearance: 2, multiClearance: 1,
      startClearance: 5, overhead: 0.3,
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

/** Seconds for a UBL probe run over an area (w x h mm), or the full grid. */
export function probeSeconds(printer, area) {
  const pr = printer.probe;
  const sx = (pr.max[0] - pr.min[0]) / (pr.grid[0] - 1), sy = (pr.max[1] - pr.min[1]) / (pr.grid[1] - 1);
  let nx = pr.grid[0], ny = pr.grid[1];
  if (area && area.w > 0 && area.h > 0) {
    nx = Math.min(pr.grid[0], Math.ceil(area.w / sx) + 1);
    ny = Math.min(pr.grid[1], Math.ceil(area.h / sy) + 1);
  }
  const pts = nx * ny;
  const hop = (d) => { const v = pr.xySpeed, a = pr.accel; return d > v * v / a ? d / v + v / a : 2 * Math.sqrt(d / a); };
  const travel = ((nx - 1) * ny * hop(sx) + (ny - 1) * hop(sy)) + hop(60); // snake + approach
  const zPer = pr.clearance / pr.zFast + (pr.clearance + 0.3) / pr.zFast
    + (pr.samples - 1) * (pr.multiClearance / pr.zFast + (pr.multiClearance + 0.1) / pr.zSlow);
  return travel + pts * (zPer + pr.overhead) + pr.startClearance / pr.zFast;
}

export const AMBIENT = 22;

export function guessPrinter(config) {
  const model = (config.printer_model || '').trim().toUpperCase();
  for (const p of Object.values(PRINTERS)) if (p.models.includes(model)) return p.id;
  return model ? 'generic' : 'prusa-mini';
}
