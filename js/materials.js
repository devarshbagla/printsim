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
// setC:      temperature (C) below which a strand holds its shape: about the
//            glass transition (PLA ~60, PETG ~80, ABS/ASA ~100, PC ~145); PA and
//            TPU use their heat-deflection / softening point instead
// stick:     how readily loose hot strands grab the nozzle (0..1): PETG is
//            notorious for it, PLA barely does it
// temp:      nozzle temperature of the Prusa MINI profile, used when the file
//            doesn't say

export const MATERIALS = {
  PLA: {
    name: 'PLA', refFan: 1.0, overhang: [68, 55], bridge: [35, 10], cantilever: [1.8, 0.8],
    sag: [0.0035, 0.012], curl: 1.0, hotAbove: 225, hotPenalty: 0.012,
    setC: 60, stick: 0.3, temp: 215,
    note: 'PLA loves cooling: overhangs and bridges are judged against the part-fan speed on every strand.',
  },
  PETG: {
    name: 'PETG', refFan: 0.5, overhang: [60, 52], bridge: [20, 10], cantilever: [1.2, 0.7],
    sag: [0.009, 0.016], curl: 1.35, hotAbove: 255, hotPenalty: 0.008,
    setC: 80, stick: 0.8, temp: 240,
    note: 'PETG bridges and overhangs worse than PLA and sags more; judged against its usual ~50% fan.',
  },
  ABS: {
    name: 'ABS', refFan: 0.15, overhang: [57, 54], bridge: [15, 12], cantilever: [1.1, 0.9],
    sag: [0.008, 0.011], curl: 1.1, hotAbove: 260, hotPenalty: 0.006,
    setC: 100, stick: 0.4, temp: 255,
    note: 'ABS prints with little cooling (~15% fan), so overhangs are judged conservatively.',
  },
  ASA: {
    name: 'ASA', refFan: 0.2, overhang: [57, 54], bridge: [15, 12], cantilever: [1.1, 0.9],
    sag: [0.008, 0.011], curl: 1.1, hotAbove: 265, hotPenalty: 0.006,
    setC: 100, stick: 0.4, temp: 260,
    note: 'ASA behaves like ABS: ~20% fan, moderate overhangs.',
  },
  PC: {
    name: 'PC', refFan: 0.2, overhang: [56, 52], bridge: [14, 10], cantilever: [1.0, 0.7],
    sag: [0.01, 0.014], curl: 1.05, hotAbove: 280, hotPenalty: 0.005,
    setC: 145, stick: 0.5, temp: 275,
    note: 'Polycarbonate runs hot with ~20% fan, so overhangs are limited.',
  },
  PA: {
    name: 'Nylon (PA)', refFan: 0.2, overhang: [55, 50], bridge: [14, 9], cantilever: [1.0, 0.7],
    sag: [0.011, 0.016], curl: 1.25, hotAbove: 290, hotPenalty: 0.005,
    setC: 70, stick: 0.55, temp: 285,
    note: 'Nylon is soft when hot and sags on long spans.',
  },
  TPU: {
    name: 'TPU / flex', refFan: 0.5, overhang: [52, 48], bridge: [8, 5], cantilever: [0.6, 0.4],
    sag: [0.03, 0.045], curl: 1.9, hotAbove: 245, hotPenalty: 0.01,
    setC: 80, stick: 0.7, temp: 240,
    note: 'Flexible filament barely bridges and droops easily.',
  },
  PVA: {
    name: 'PVA / support', refFan: 1.0, overhang: [55, 50], bridge: [12, 8], cantilever: [0.8, 0.6],
    sag: [0.012, 0.018], curl: 1.2, hotAbove: 225, hotPenalty: 0.01,
    setC: 75, stick: 0.5, temp: 215,
    note: 'Soluble support material: weak overhangs.',
  },
  GENERIC: {
    name: 'Other', refFan: 0.5, overhang: [60, 52], bridge: [18, 10], cantilever: [1.2, 0.7],
    sag: [0.008, 0.014], curl: 1.2, hotAbove: 250, hotPenalty: 0.008,
    setC: 75, stick: 0.45, temp: 230,
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

// How long a freshly laid strand stays soft (seconds), from Newton cooling of a
// thin round strand with the same cross-section (w x h):
//   t = rho*c * r / (2*h) * ln((T_nozzle - T_air) / (T_set - T_air))
// rho*c ~2.0 MJ/(m3 K) for the common filaments (PLA 1.24 g/cm3 x 1.8 J/gK),
// T_air 35 C (air over a heated bed). The heat transfer coefficient h goes from
// ~50 W/m2K in still air (natural convection + radiation around a 0.4 mm strand)
// to ~400 W/m2K in the part fan's jet at 100% (forced convection over a thin
// cylinder, Hilpert correlation at ~5 m/s). PLA at 100% fan: ~1 s. Fan off: ~7 s.
const RHO_C = 2.0e6, T_AIR = 35, H_STILL = 50, H_FAN = 400;
export function softSeconds(mat, fan01, temp, w = 0.45, h = 0.2) {
  const Tn = temp || mat.temp || 215, Ts = mat.setC || 70;
  if (Tn <= Ts + 1) return 0.1;
  const r = Math.sqrt((w * h) / Math.PI) * 1e-3;            // m
  const hc = H_STILL + (H_FAN - H_STILL) * Math.max(0, Math.min(1, fan01));
  const tau = (RHO_C * r) / (2 * hc);
  return Math.max(0.1, Math.min(20, tau * Math.log((Tn - T_AIR) / (Ts - T_AIR))));
}
/** the renderer's 0..1 heat value: soft seconds over this */
export const HEAT_SPAN = 8;

// How the plastic looks (roughness 0..1, metal 0..1). Base look per material,
// then the filament's profile name: silk filaments are glossy with coloured,
// metal-like highlights; matte ones scatter everything.
const SURFACE = { PLA: 0.42, PETG: 0.22, ABS: 0.5, ASA: 0.58, PC: 0.26, PA: 0.52, TPU: 0.46, PVA: 0.6, GENERIC: 0.42 };
export function surfaceFor(key, config = {}) {
  const name = String(config.filament_settings_id || config.filament_type || '').toLowerCase();
  if (/silk/.test(name)) return { rough: 0.2, metal: 0.55 };
  if (/matte|matt\b/.test(name)) return { rough: 0.78, metal: 0 };
  if (/galaxy|glitter|sparkle/.test(name)) return { rough: 0.3, metal: 0.15 };
  return { rough: SURFACE[key] ?? 0.42, metal: 0 };
}
