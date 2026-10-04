// When a print really finished, from what the user tells printsim, and what
// that measures. Pure functions, so CI can test them without a browser.
//
// Why this exists: people check back hours after a print ends. Tapping
// "it's done" then records "now" as the finish, the measured time is hours too
// long, and calibration either learns garbage or throws the print away. So the
// app asks WHEN it finished, prefilled with when printsim expected it.

/**
 * "HH:MM" (an <input type="time"> value) -> the most recent wall time showing
 * that clock time, not later than now. A clock time later than now means
 * yesterday (a print that ran past midnight). null if unreadable or before the
 * print started.
 */
export function clockToWall(hhmm, nowMs, startMs) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  const d = new Date(nowMs);
  d.setHours(+m[1], +m[2], 0, 0);
  if (d.getTime() > nowMs + 60e3) {
    d.setDate(d.getDate() - 1); // setDate, not -86400e3: stays right across DST changes
    d.setHours(+m[1], +m[2], 0, 0);
  }
  const t = Math.min(d.getTime(), nowMs);
  return t < startMs ? null : t;
}

/** "HH:MM" for an <input type="time">, local time. */
export function wallToClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Wall time the running sim reaches the end of the print, or null if the clock is paused. */
export function expectedEndWall(run, total) {
  if (!run || !run.running) return null;
  return run.anchorWall + Math.max(0, total - run.anchorSim) * 1000;
}

/**
 * Real time a run took if it finished at finishWall (seconds): the whole print,
 * and the motion part (from the first extrusion) that calibration compares.
 * Pauses only count up to the finish.
 */
export function measureRun(run, finishWall, startupEnd) {
  let paused = run.pausedMs || 0;
  if (!run.running && run.pauseStartWall != null) paused += Math.max(0, finishWall - run.pauseStartWall);
  const total = (finishWall - run.startedWall - paused) / 1000;
  const motion = run.extrudeWall
    ? (finishWall - run.extrudeWall - (paused - (run.pausedAtExtrude || 0))) / 1000
    : total - startupEnd;
  return { total, motion };
}
