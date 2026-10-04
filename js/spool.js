// Students start prints on half-used spools. The MINI+ has a filament sensor:
// when the spool runs dry it pauses and unloads, and the print sits there until
// someone loads a new one. printsim knows exactly how much filament the file
// uses and when, so it can warn before you start and auto-pause at the runout
// moment, the same way it already does for M600 filament changes.

import { statedGrams, gramsPerMm } from './report.js';

/**
 * Running total of grams extruded up to and including each move.
 * Net E (retractions cancel); the running sum never goes below 0.
 * After each move we keep the high-water mark so the series is
 * non-decreasing (needed for binary search) even through retracts.
 * When the file states a gram count, the final total equals that number.
 */
export function cumulativeGrams(parsed, material) {
  const E = parsed.moves.e;
  const cum = new Float64Array(E.length);
  let sum = 0;
  for (let i = 0; i < E.length; i++) {
    sum = Math.max(0, sum + E[i]);
    // high-water: unretracts climb back; retracts must not make cum fall
    cum[i] = i > 0 ? Math.max(cum[i - 1], sum) : sum;
  }
  const totalE = cum.length ? cum[cum.length - 1] : 0;
  const stated = statedGrams(parsed.meta.config);
  if (stated != null && totalE > 0) {
    const scale = stated / totalE;
    for (let i = 0; i < cum.length; i++) cum[i] *= scale;
  } else {
    const gpm = gramsPerMm(parsed.meta.config, material);
    for (let i = 0; i < cum.length; i++) cum[i] *= gpm;
  }
  return cum;
}

/** Index of the first move where cum >= gramsLeft, or -1 if the spool covers it. */
export function runoutMove(cum, gramsLeft) {
  if (!(gramsLeft > 0) || !cum || !cum.length) return -1;
  if (cum[cum.length - 1] < gramsLeft) return -1;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] >= gramsLeft) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * @returns {{ need: number, left: number, move: number, tight: boolean }}
 * tight: no runout, but the leftover is under max(5 g, 10% of need).
 */
export function spoolCheck(cum, gramsLeft) {
  const need = cum && cum.length ? cum[cum.length - 1] : 0;
  const left = gramsLeft;
  const move = runoutMove(cum, gramsLeft);
  const tight = move < 0 && left > 0 && (left - need) < Math.max(5, 0.1 * need);
  return { need, left, move, tight };
}
