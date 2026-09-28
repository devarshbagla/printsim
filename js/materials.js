// Filament behaviour for the support/physics check.
//
// These are FAILURE limits (where strands collapse into spaghetti), which sit
// above the usual QUALITY limits (where supports are recommended). Quality
// references: PLA 55-60 deg, PETG 45-50, ABS 40-45 (3dmag.com overhang table);
// Bambu rates PLA at 55 deg / 30 mm bridge on its own, strongly cooled printers.
// Prusa's PETG guide: "bridging- and overhang-behavior is usually worse" than PLA.
//
// Each material is judged against ITS OWN normal cooling, taken from Prusa's
// PrusaSlicer filament profiles for the MINI (max_fan_speed): PLA 100 %,
// PETG 50 %, ASA 20 %, ABS 15 %, PC 20 %, PA 20 %, FLEX 50 %. A PETG print at
// 50 % fan is "fully cooled" for PETG; fan off is the second value of each pair.
//
// overhang:  steepest overhang (deg from vertical) before strands fall off,
//            at reference cooling / with the fan off
// bridge:    longest straight span (mm) that holds, reference / fan off
// cantilever: unsupported mm a strand can stick out before drooping off
// sag:       bridge droop coefficient (mm of sag ~ sag * span^2 / 10)
// curl:      how wild fallen strands get (stringy/floppy materials curl more)
// hotAbove / hotPenalty: printing hotter than the Prusa profile temperature
//            (+~5 C margin) costs overhang/bridge performance per degree

export const MATERIALS = {
  PLA: {
    name: 'PLA', refFan: 1.0, overhang: [68, 55], bridge: [35, 10], cantilever: [1.8, 0.8],
    sag: [0.0035, 0.012], curl: 1.0, hotAbove: 225, hotPenalty: 0.012,
    note: 'PLA loves cooling: overhangs and bridges are judged against the part-fan speed on every strand.',
  },
  PETG: {
    name: 'PETG', refFan: 0.5, overhang: [60, 52], bridge: [20, 10], cantilever: [1.2, 0.7],
    sag: [0.009, 0.016], curl: 1.35, hotAbove: 255, hotPenalty: 0.008,
    note: 'PETG bridges and overhangs worse than PLA and sags more; judged against its usual ~50% fan.',
  },
  ABS: {
    name: 'ABS', refFan: 0.15, overhang: [57, 54], bridge: [15, 12], cantilever: [1.1, 0.9],
    sag: [0.008, 0.011], curl: 1.1, hotAbove: 260, hotPenalty: 0.006,
    note: 'ABS prints with little cooling (~15% fan), so overhangs are judged conservatively.',
  },
  ASA: {
    name: 'ASA', refFan: 0.2, overhang: [57, 54], bridge: [15, 12], cantilever: [1.1, 0.9],
    sag: [0.008, 0.011], curl: 1.1, hotAbove: 265, hotPenalty: 0.006,
    note: 'ASA behaves like ABS: ~20% fan, moderate overhangs.',
  },
  PC: {
    name: 'PC', refFan: 0.2, overhang: [56, 52], bridge: [14, 10], cantilever: [1.0, 0.7],
    sag: [0.01, 0.014], curl: 1.05, hotAbove: 280, hotPenalty: 0.005,
    note: 'Polycarbonate runs hot with ~20% fan, so overhangs are limited.',
  },
  PA: {
    name: 'Nylon (PA)', refFan: 0.2, overhang: [55, 50], bridge: [14, 9], cantilever: [1.0, 0.7],
    sag: [0.011, 0.016], curl: 1.25, hotAbove: 290, hotPenalty: 0.005,
    note: 'Nylon is soft when hot and sags on long spans.',
  },
  TPU: {
    name: 'TPU / flex', refFan: 0.5, overhang: [52, 48], bridge: [8, 5], cantilever: [0.6, 0.4],
    sag: [0.03, 0.045], curl: 1.9, hotAbove: 245, hotPenalty: 0.01,
    note: 'Flexible filament barely bridges and droops easily.',
  },
  PVA: {
    name: 'PVA / support', refFan: 1.0, overhang: [55, 50], bridge: [12, 8], cantilever: [0.8, 0.6],
    sag: [0.012, 0.018], curl: 1.2, hotAbove: 225, hotPenalty: 0.01,
    note: 'Soluble support material: weak overhangs.',
  },
  GENERIC: {
    name: 'Other', refFan: 0.5, overhang: [60, 52], bridge: [18, 10], cantilever: [1.2, 0.7],
    sag: [0.008, 0.014], curl: 1.2, hotAbove: 250, hotPenalty: 0.008,
    note: 'Unknown filament: using middle-of-the-road limits.',
  },
};

export function detectMaterial(config) {
  const raw = String(config.filament_type || config.filament_settings_id || '').split(';')[0].toUpperCase();
  if (!raw) return 'PLA';
  if (/TPU|TPE|FLEX/.test(raw)) return 'TPU';
  if (/PETG|PET|PCTG|CPE/.test(raw)) return 'PETG';
  if (/ASA/.test(raw)) return 'ASA';
  if (/ABS|HIPS/.test(raw)) return 'ABS';
  if (/^PC|POLYCARB/.test(raw)) return 'PC';
  if (/PA|NYLON/.test(raw)) return 'PA';
  if (/PVA|BVOH/.test(raw)) return 'PVA';
  if (/PLA|PHA/.test(raw)) return 'PLA';
  return 'GENERIC';
}

export function nozzleTemp(config) {
  const t = parseFloat(String(config.temperature || '').split(/[;,]/)[0]);
  return isFinite(t) ? t : null;
}

/** Limits for one strand given fan (0..1) and nozzle temp. */
/**
 * Limits for one strand.
 * fan01: part fan 0..1 on this strand; temp: nozzle temp; cool: 0.5..1 penalty
 * for short layers (the plastic below had less time to set).
 */
export function limitsFor(mat, fan01, temp, cool = 1) {
  // cooling relative to this material's normal fan (more than normal doesn't help much)
  const f = Math.max(0, Math.min(1, fan01 / (mat.refFan || 1)));
  const lerp = (a) => a[1] + (a[0] - a[1]) * f;
  let hot = 1;
  if (temp && temp > mat.hotAbove) hot = Math.max(0.45, 1 - (temp - mat.hotAbove) * mat.hotPenalty);
  const q = hot * cool; // everything that makes plastic softer when the next layer lands
  // overheated/uncooled plastic slumps toward a 45 deg-or-worse overhang, clamped to sane range
  const angle = Math.max(35, Math.min(75, 45 + (lerp(mat.overhang) - 45) * q - (1 - q) * 10));
  return {
    angle,
    tan: Math.tan((angle * Math.PI) / 180),
    bridge: lerp(mat.bridge) * q,
    cantilever: lerp(mat.cantilever) * q,
    sag: lerp(mat.sag) / q,
  };
}
