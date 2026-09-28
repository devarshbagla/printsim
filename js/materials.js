// Filament behaviour for the support/physics check.
//
// overhang: steepest printable overhang (degrees from vertical) with the part
//           fan at 100% and with it off. Converted to how far (mm) a strand may
//           sit past the one below it: layerHeight * tan(angle).
// bridge:   longest reliable bridge (mm), fan full / fan off.
// cantilever: unsupported mm a strand gets away with before it droops off.
// sag:      bridge droop coefficient (mm of sag ~ sag * span^2 / 10).
// curl:     how wild fallen strands get (stringy/floppy materials curl more).
// hotPenalty: per °C above `hotAbove`, overhang/bridge performance drops.
//
// PLA gets the most attention: it's what most people print, and its overhang
// and bridge quality is dominated by part cooling, so the per-strand fan speed
// from the G-code (M106/M107) feeds straight into its limits.

export const MATERIALS = {
  PLA: {
    name: 'PLA', overhang: [69, 52], bridge: [40, 12], cantilever: [1.8, 0.8],
    sag: [0.0035, 0.012], curl: 1.0, hotAbove: 220, hotPenalty: 0.012,
    note: 'PLA loves cooling: overhangs and bridges are judged against the part-fan speed in your file.',
  },
  PETG: {
    name: 'PETG', overhang: [62, 52], bridge: [22, 10], cantilever: [1.2, 0.7],
    sag: [0.009, 0.016], curl: 1.35, hotAbove: 250, hotPenalty: 0.008,
    note: 'PETG sags and strings more than PLA, so bridges get shorter limits.',
  },
  ABS: {
    name: 'ABS', overhang: [60, 55], bridge: [20, 14], cantilever: [1.2, 0.9],
    sag: [0.008, 0.011], curl: 1.1, hotAbove: 260, hotPenalty: 0.006,
    note: 'ABS usually prints with little cooling, so overhangs are judged conservatively.',
  },
  ASA: {
    name: 'ASA', overhang: [60, 55], bridge: [20, 14], cantilever: [1.2, 0.9],
    sag: [0.008, 0.011], curl: 1.1, hotAbove: 265, hotPenalty: 0.006,
    note: 'ASA behaves like ABS: modest cooling, moderate overhangs.',
  },
  PC: {
    name: 'PC', overhang: [58, 52], bridge: [16, 10], cantilever: [1.0, 0.7],
    sag: [0.01, 0.014], curl: 1.05, hotAbove: 285, hotPenalty: 0.005,
    note: 'Polycarbonate runs hot with little cooling, so overhangs are limited.',
  },
  PA: {
    name: 'Nylon (PA)', overhang: [57, 50], bridge: [16, 10], cantilever: [1.0, 0.7],
    sag: [0.011, 0.016], curl: 1.25, hotAbove: 275, hotPenalty: 0.005,
    note: 'Nylon is soft when hot and sags on long spans.',
  },
  TPU: {
    name: 'TPU / flex', overhang: [52, 45], bridge: [8, 5], cantilever: [0.6, 0.4],
    sag: [0.03, 0.045], curl: 1.9, hotAbove: 235, hotPenalty: 0.01,
    note: 'Flexible filament barely bridges and droops easily.',
  },
  PVA: {
    name: 'PVA / support', overhang: [55, 50], bridge: [12, 8], cantilever: [0.8, 0.6],
    sag: [0.012, 0.018], curl: 1.2, hotAbove: 225, hotPenalty: 0.01,
    note: 'Soluble support material: weak overhangs.',
  },
  GENERIC: {
    name: 'Other', overhang: [60, 50], bridge: [20, 10], cantilever: [1.2, 0.7],
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
export function limitsFor(mat, fan01, temp) {
  const f = Math.max(0, Math.min(1, fan01));
  const lerp = (a) => a[1] + (a[0] - a[1]) * f;
  let hot = 1;
  if (temp && temp > mat.hotAbove) hot = Math.max(0.6, 1 - (temp - mat.hotAbove) * mat.hotPenalty);
  const angle = 45 + (lerp(mat.overhang) - 45) * hot;
  return {
    angle,
    tan: Math.tan((angle * Math.PI) / 180),
    bridge: lerp(mat.bridge) * hot,
    cantilever: lerp(mat.cantilever),
    sag: lerp(mat.sag) / hot,
  };
}
