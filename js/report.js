// Turns the support check into something a person can act on: when the print
// goes wrong, and how much plastic that costs.
//
// Filament comes from the extruder moves themselves (signed E, so retractions
// cancel out), which matches PrusaSlicer's own "filament used" within half a
// percent on Prusa's reference files. When the file states a gram count, that
// number is the total and our E ratios split it.

// g/cm³, used only when the file doesn't say (Prusa profiles set filament_density)
export const DENSITY = { PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, PC: 1.22, PA: 1.12, TPU: 1.21, PVA: 1.23, GENERIC: 1.24 };

const first = (v) => parseFloat(String(v ?? '').split(/[;,]/)[0]);

/** grams per mm of filament for this file */
export function gramsPerMm(cfg = {}, material = 'PLA') {
  const d = first(cfg.filament_diameter) > 0 ? first(cfg.filament_diameter) : 1.75;
  const rho = first(cfg.filament_density) > 0 ? first(cfg.filament_density) : (DENSITY[material] ?? DENSITY.GENERIC);
  return Math.PI * (d / 2) ** 2 * rho / 1000;
}

/** the file's own gram count, if it has one */
export function statedGrams(cfg = {}) {
  const g = first(cfg['total filament used [g]'] ?? cfg['filament used [g]']);
  return g > 0 ? g : null;
}

/**
 * @param {object} parsed  parser result after simulatePhysics (split segs with drop/frac)
 * @param {(move:number)=>number} tOf  sim time at which the nozzle starts a move
 * @param {number} startupEnd  sim time printing starts (after warm-up/leveling)
 * @param {number} total       sim time the print ends
 * @returns {null | {tFail, pctFail, layer, spaghettiG, afterG, totalG, severe}}
 */
export function spaghettiReport(parsed, tOf, startupEnd, total, material = 'PLA') {
  const sp = parsed.support, segs = parsed.segs, E = parsed.moves && parsed.moves.e;
  if (!sp || !segs.drop || !E) return null;
  const N = segs.move.length, drop = segs.drop, f0 = segs.frac0, f1 = segs.frac;

  let totalE = 0;
  for (let k = 0; k < E.length; k++) totalE += E[k];
  if (!(totalE > 0)) return null;

  // filament in pieces that fall (a piece with only one dropping end is a
  // tapered joint next to a falling piece: counts half)
  let spagE = 0, firstPiece = -1;
  for (let i = 0; i < N; i++) {
    const a = drop[i * 2] > 0, b = drop[i * 2 + 1] > 0;
    if (!a && !b) continue;
    const e = E[segs.move[i]];
    if (e > 0) spagE += e * (f1[i] - f0[i]) * ((a + b) / 2);
    if (a && b && firstPiece < 0) firstPiece = i;
  }
  if (firstPiece < 0) return null;

  // everything extruded from the first falling piece on
  const m0 = segs.move[firstPiece];
  let afterE = E[m0] > 0 ? E[m0] * (1 - f0[firstPiece]) : 0;
  for (let k = m0 + 1; k < E.length; k++) afterE += E[k];

  const g = statedGrams(parsed.meta.config);
  const toG = g ? (e) => g * e / totalE : (e) => e * gramsPerMm(parsed.meta.config, material);
  const tFail = tOf(m0);
  let layer = 0;
  const ls = parsed.layers.seg;
  while (layer + 1 < ls.length && ls[layer + 1] <= firstPiece) layer++;
  return {
    tFail: Math.max(0, tFail - startupEnd),
    pctFail: Math.min(100, Math.max(0, (100 * (tFail - startupEnd)) / Math.max(total - startupEnd, 1))),
    layer,
    spaghettiG: toG(spagE),
    afterG: toG(Math.max(0, afterE)),
    totalG: toG(totalE),
    severe: sp.failedFraction >= 0.05,
  };
}

export function fmtGrams(g) {
  return g < 10 ? `${g.toFixed(1)} g` : `${Math.round(g)} g`;
}
