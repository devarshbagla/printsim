import { PrintView, FEATURE_COLORS } from './renderer.js';
import { buildTimeline, stateAt, timeForPercent } from './timeline.js';
import { FeatureNames, Feature } from './gcode.js';
import { PRINTERS, AMBIENT, guessPrinter } from './printers.js';
import { MATERIALS } from './materials.js';
import { simulatePhysics } from './physics.js';
import { idbGet, idbSet, idbDel, lsGet, lsSet, getCalibration, addCalibration } from './store.js';

const $ = (id) => document.getElementById(id);

const SWATCHES = [
  ['Orange', '#ff7a1a'], ['White', '#f2f2ee'], ['Black', '#2a2b30'], ['Grey', '#8a8f96'],
  ['Silver', '#b9bec6'], ['Red', '#d62839'], ['Yellow', '#f5c518'], ['Green', '#2ba84a'],
  ['Blue', '#1f6feb'], ['Purple', '#7b3fe4'], ['Pink', '#ff6fae'], ['Lavender', '#b9a3f5'],
];

const prefs = Object.assign({ color: null, ghost: true, colorMode: 'filament', printerId: null, speed: 200, layerMode: false, physics: true, printerView: true }, lsGet('printsim.prefs', {}));
const savePrefs = () => lsSet('printsim.prefs', prefs);

// ---------------------------------------------------------------- state
let view;
let mode = 'empty'; // empty | setup | run | done
let parsed = null;
let tl = null;
let file = null; // { name, bytes }
let setup = { printerId: 'prusa-mini', nozzle: AMBIENT, bed: AMBIENT, color: '#ff7a1a' };
let run = null;
let lastUi = 0;
let thumbUrl = null;

// ---------------------------------------------------------------- utils
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m >= 10) return `${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.add('hidden'), ms);
}
function show(el, on) { (typeof el === 'string' ? $(el) : el).classList.toggle('hidden', !on); }

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return '#' + [16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('');
}
function setAccent(hex) {
  let acc = hex;
  const L = luminance(hex);
  if (L < 0.06) acc = mixHex(hex, '#ffffff', 0.55);
  else if (L < 0.12) acc = mixHex(hex, '#ffffff', 0.3);
  const La = luminance(acc);
  const contrastDark = (La + 0.05) / (0.012 + 0.05);
  const contrastLight = 1.05 / (La + 0.05);
  document.documentElement.style.setProperty('--accent', acc);
  document.documentElement.style.setProperty('--accent-ink', contrastDark >= contrastLight ? '#121212' : '#ffffff');
  document.querySelector('meta[name=theme-color]').setAttribute('content', '#0f1114');
}

// ---------------------------------------------------------------- persistence
function saveSession() {
  idbSet('session', { mode, setup, run, doneText: mode === 'done' ? $('done-text').textContent : undefined, savedAt: Date.now() });
}

// Ask the browser not to evict our storage under disk pressure. Chrome grants
// this silently for engaged / installed sites; Safari grants it for home-screen apps.
async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (e) { /* not supported: storage is best-effort */ }
}

// ---------------------------------------------------------------- parsing
let worker = null;
function parseBytes(bytes) {
  if (!worker) worker = new Worker(new URL('./parser.worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const id = Math.random();
    const onMsg = (ev) => {
      const d = ev.data;
      if (d.id !== id) return;
      if (d.type === 'progress') {
        $('loading-stage').textContent = d.stage;
        $('loading-bar').style.width = `${Math.round(d.value * 100)}%`;
      } else {
        worker.removeEventListener('message', onMsg);
        if (d.type === 'done') resolve(d.result);
        else reject(new Error(d.message));
      }
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', (e) => reject(new Error(e.message || 'Parser crashed')), { once: true });
    // keep our own copy (it gets saved to IndexedDB), send the worker a clone
    worker.postMessage({ id, bytes: bytes.slice(0) });
  });
}

async function openFile(name, bytes, restore = null) {
  show('loading', true);
  $('loading-stage').textContent = 'Reading file';
  $('loading-bar').style.width = '0%';
  try {
    const result = await parseBytes(bytes);
    if (!result.segs.move.length) throw new Error("Couldn't find any extrusion moves in this file.");
    parsed = result;
    file = { name, bytes };
    onParsed(restore);
    if (!restore) {
      await idbSet('file', { name, bytes });
      requestPersistence();
    }
  } catch (err) {
    console.error(err);
    toast(`Couldn't read that file: ${err.message}`, 5000);
    if (!parsed) setMode('empty');
  } finally {
    show('loading', false);
  }
}

function onParsed(restore) {
  const cfg = parsed.meta.config;
  if (restore && restore.setup) {
    setup = { ...setup, ...restore.setup };
  } else {
    setup.printerId = PRINTERS[prefs.printerId] && !cfg.printer_model ? prefs.printerId : guessPrinter(cfg);
    const fileColour = (cfg.filament_colour || cfg.extruder_colour || '').replace(/"/g, '').split(';')[0];
    setup.color = prefs.color || (/^#[0-9a-f]{6}$/i.test(fileColour) ? fileColour.toLowerCase() : '#ff7a1a');
    setup.nozzle = AMBIENT;
    setup.bed = AMBIENT;
  }
  if (!restore || !restore.setup || !MATERIALS[setup.material]) setup.material = parsed.material || 'PLA';
  if (setup.material !== parsed.material) simulatePhysics(parsed, setup.material, parsed.nozzleTemp);
  parsed.activeMaterial = setup.material;
  view.setCurl(MATERIALS[setup.material].curl);
  const printer = PRINTERS[setup.printerId] || PRINTERS['prusa-mini'];
  view.setBed(printer.bed.w, printer.bed.d);
  view.setData(parsed.segs, parsed.bbox);
  view.setColor(setup.color);
  setAccent(setup.color);
  renderSwatches();
  fillSetupForm();

  // thumbnail
  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  thumbUrl = null;
  const th = parsed.thumbs.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (th) {
    thumbUrl = URL.createObjectURL(new Blob([th.data], { type: th.format === 'jpg' ? 'image/jpeg' : 'image/png' }));
    $('thumb').src = thumbUrl;
    show('thumb-wrap', true);
  } else show('thumb-wrap', false);

  $('file-name').textContent = file.name;
  const bits = [];
  if (parsed.meta.slicerEstimate) bits.push(`${fmtDur(parsed.meta.slicerEstimate)} print`);
  bits.push(`${parsed.layers.z.length} layers`);
  const ft = cfg.filament_type ? cfg.filament_type.split(';')[0] : '';
  const g = cfg['filament used [g]'] || cfg['total filament used [g]'];
  if (ft || g) bits.push([ft, g ? `${parseFloat(g).toFixed(g < 10 ? 1 : 0)} g` : ''].filter(Boolean).join(' '));
  if (parsed.filamentChanges) bits.push(`${parsed.filamentChanges} colour change${parsed.filamentChanges > 1 ? 's' : ''}`);
  $('file-meta').textContent = bits.join(' · ');
  renderSupportWarning();

  if (restore && restore.run) {
    run = restore.run;
    rebuildTimeline(run.factor);
    setMode(restore.mode === 'done' ? 'done' : 'run');
    if (restore.mode === 'done') renderDone(restore.doneText);
  } else {
    run = null;
    rebuildTimeline();
    setMode('setup');
    saveSession();
  }
}

function rebuildTimeline(factorOverride) {
  const printer = PRINTERS[setup.printerId] || PRINTERS['prusa-mini'];
  const factor = factorOverride || getCalibration(printer.id).factor;
  tl = buildTimeline(parsed, printer, { nozzleNow: setup.nozzle, bedNow: setup.bed, factor });
  const sm = parsed.segs.move, times = new Float32Array(sm.length);
  const fr = parsed.segs.frac;
  for (let i = 0; i < sm.length; i++) {
    const k = sm[i];
    times[i] = fr && fr[i] < 1 ? tl.tStart(k) + tl.dur[k] * fr[i] : tl.tEnd[k];
  }
  view.setSegTimes(times);
  updateSetupEstimate();
  updateSpeedNote();
}

// ---------------------------------------------------------------- modes
function setMode(m) {
  mode = m;
  document.body.dataset.mode = m;
  show('landing', m === 'empty');
  show('sheet', m !== 'empty');
  show('viewctl', m !== 'empty');
  show('btn-new', m !== 'empty');
  show('panel-setup', m === 'setup');
  show('panel-run', m === 'run');
  show('panel-done', m === 'done');
  view.controls.autoRotate = m === 'empty' || m === 'done';
  view.controls.autoRotateSpeed = 0.7;
  updateLegend();
  if (m !== 'setup') setPlaying(false);
  if (m === 'setup') applyScrub();
  if (m === 'run') { view.setWarnTint(0); view.setPhysics(prefs.physics); }
  if (m === 'done') { view.setHead(parsed.segs.move.length, null, false, false); view.setSimTime(1e9); view.setWarnTint(0); view.setScreen({ title: 'finished', big: '100%', line1: 'Print done', line2: '', progress: 1, accent: accentHex() }); }
  if (m === 'empty') document.title = 'printsim';
  lastUi = 0;
}

// ---------------------------------------------------------------- setup panel
function fillSetupForm() {
  const sel = $('printer');
  sel.innerHTML = '';
  for (const p of Object.values(PRINTERS)) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.value = setup.printerId;
  const ms = $('material');
  ms.innerHTML = '';
  for (const [k, m] of Object.entries(MATERIALS)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = k === parsed.material ? `${m.name} (from file)` : m.name;
    ms.appendChild(o);
  }
  ms.value = setup.material;
  updateMaterialNote();
  $('t-noz').value = Math.round(setup.nozzle);
  $('t-bed').value = Math.round(setup.bed);
  $('scrub').value = 1000;
}

function updateMaterialNote() {
  if (!parsed) return;
  const m = MATERIALS[setup.material] || MATERIALS.PLA;
  const fan = parsed.rawSegs && parsed.rawSegs.fan;
  let fanTxt = '';
  if (fan && fan.length) {
    let max = 0, on = 0;
    for (let i = 0; i < fan.length; i++) { if (fan[i] > max) max = fan[i]; if (fan[i] > 0) on++; }
    const maxPct = Math.round(max / 2.55);
    fanTxt = max === 0 ? ' Part fan: off the whole print.'
      : ` Part fan: up to ${maxPct}%${on / fan.length < 0.95 ? `, off for ${Math.round((1 - on / fan.length) * 100)}% of the print` : ''}.`;
  }
  const sp = parsed.support;
  let sag = '';
  if (sp && sp.bridges && sp.maxSag >= 0.15) sag = ` ${sp.bridges} bridge${sp.bridges > 1 ? 's' : ''} will droop, up to ${sp.maxSag.toFixed(1)} mm.`;
  $('material-note').textContent = m.note + fanTxt + sag;
}

function applyMaterial(key) {
  setup.material = key;
  simulatePhysics(parsed, key, parsed.nozzleTemp);
  parsed.activeMaterial = key;
  view.setCurl(MATERIALS[key].curl);
  view.setData(parsed.segs, parsed.bbox);
  rebuildTimeline();
  renderSupportWarning();
  updateMaterialNote();
  applyScrub();
  saveSession();
}

function accentHex() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff7a1a';
}

function updateSetupEstimate() {
  if (!tl) return;
  const cal = getCalibration(setup.printerId);
  let txt = `About ${fmtDur(tl.total)} total, including ~${fmtDur(tl.startupEnd)} of warm-up and bed leveling.`;
  if (cal.n > 0) txt += ` Calibrated from ${cal.n} print${cal.n > 1 ? 's' : ''} (×${cal.factor.toFixed(2)}).`;
  let el = $('setup-est');
  if (!el) {
    el = document.createElement('p');
    el.id = 'setup-est';
    el.className = 'hint';
    $('btn-start').before(el);
  }
  el.textContent = txt;
}

// ---------------------------------------------------------------- timelapse preview
const preview = { t: null, playing: false, lastWall: 0 };
const printSpan = () => Math.max(tl.total - tl.startupEnd, 1);

function applyScrub() {
  if (!parsed || !tl) return;
  const v = +$('scrub').value;
  preview.t = v >= 1000 ? null : tl.startupEnd + printSpan() * (v / 1000);
  renderPreview();
}

function renderPreview() {
  if (!parsed || !tl) return;
  const S = parsed.segs.move.length;
  if (preview.t == null) {
    // full model, as sliced; strands that will fall are tinted red
    view.setHead(S, null, false, false);
    view.setSimTime(-1e9);
    view.setWarnTint(prefs.physics ? 1 : 0);
    $('scrub-label').textContent = 'Full model';
    view.setScreen({ title: 'ready', big: fmtDur(tl.total), line1: file ? file.name.replace(/\.b?gcode$/i, '').slice(0, 18) : '', line2: `${parsed.layers.z.length} layers`, progress: 0, accent: accentHex() });
    return;
  }
  const st = stateAt(parsed, tl, preview.t);
  const speed = preview.playing ? prefs.speed : 1;
  view.setWarnTint(0);
  view.setSimTime(preview.t, Math.max(0.8, 0.8 * speed));
  if (prefs.layerMode) {
    // like a printer timelapse: one frame per finished layer, nozzle parked
    view.setHead(parsed.layers.seg[st.layer] ?? S, null, false, false);
  } else {
    view.setHead(st.segHead, st.head, true, true);
  }
  $('scrub-label').textContent = `Layer ${st.layer + 1}/${st.layerCount} · ${Math.floor(st.percent)}% · ${fmtDur(preview.t - tl.startupEnd)} in`;
  view.setScreen({ title: 'preview', big: `${Math.floor(st.percent)}%`, line1: `${prefs.speed}× timelapse`, line2: `Layer ${st.layer + 1}/${st.layerCount}`, progress: st.percent / 100, accent: accentHex() });
}

function setPlaying(on) {
  if (on && (preview.t == null || preview.t >= tl.total - 0.5)) preview.t = tl.startupEnd;
  preview.playing = on;
  preview.lastWall = performance.now();
  $('btn-play').classList.toggle('playing', on);
  $('btn-play').setAttribute('aria-label', on ? 'Pause timelapse' : 'Play timelapse');
  if (on) renderPreview();
}

function tickPreview() {
  if (!preview.playing || mode !== 'setup') return;
  const w = performance.now();
  const dt = Math.min((w - preview.lastWall) / 1000, 0.25);
  preview.lastWall = w;
  preview.t += dt * prefs.speed;
  if (preview.t >= tl.total) {
    preview.t = tl.total;
    setPlaying(false);
  }
  $('scrub').value = Math.min(999, Math.round(((preview.t - tl.startupEnd) / printSpan()) * 1000));
  renderPreview();
}

function updateSpeedNote() {
  for (const b of document.querySelectorAll('#speeds [data-speed]')) b.setAttribute('aria-checked', +b.dataset.speed === prefs.speed);
  $('btn-layermode').setAttribute('aria-pressed', !!prefs.layerMode);
  if (!tl) return;
  $('speed-note').textContent = `Whole print plays in ${fmtDur(printSpan() / prefs.speed)} at ${prefs.speed}×`;
}

function renderSupportWarning() {
  const box = $('support-warn');
  const sp = parsed.support;
  if (!sp || sp.failedFraction < 0.002 || sp.failedSegments < 20) { show(box, false); return; }
  const pct = sp.failedFraction * 100;
  const noSupports = String(parsed.meta.config.support_material ?? '').trim() === '0';
  box.innerHTML = `<b>Heads up: this looks like it'll turn into spaghetti</b>
    From layer ${sp.firstLayer + 1}, about ${pct < 1 ? pct.toFixed(1) : Math.round(pct)}% of the print has nothing underneath it${noSupports ? ' (supports are off in the slicer)' : ''}. Those strands will droop or fall. Add supports in your slicer, or hit play to watch it happen.
    <label class="toggle"><input type="checkbox" id="physics" ${prefs.physics ? 'checked' : ''}> Simulate falling filament</label>`;
  show(box, true);
  $('physics').onchange = (e) => {
    prefs.physics = e.target.checked;
    savePrefs();
    view.setPhysics(prefs.physics);
    renderPreview();
  };
}

function renderSwatches() {
  for (const box of document.querySelectorAll('[data-swatches]')) {
    box.innerHTML = '';
    box.setAttribute('role', 'radiogroup');
    let matched = false;
    for (const [name, hex] of SWATCHES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.background = hex;
      b.title = name;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', name);
      const on = hex.toLowerCase() === setup.color.toLowerCase();
      matched ||= on;
      b.setAttribute('aria-checked', on);
      b.onclick = () => pickColor(hex);
      box.appendChild(b);
    }
    const c = document.createElement('label');
    c.className = 'swatch custom';
    c.title = 'Custom colour';
    c.setAttribute('aria-checked', !matched);
    if (!matched) c.style.background = setup.color;
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = setup.color;
    inp.setAttribute('aria-label', 'Custom colour');
    inp.oninput = () => pickColor(inp.value, true);
    c.appendChild(inp);
    box.appendChild(c);
  }
}

function pickColor(hex, live) {
  setup.color = hex;
  prefs.color = hex;
  savePrefs();
  view.setColor(hex);
  setAccent(hex);
  if (!live) renderSwatches();
  else for (const el of document.querySelectorAll('.swatch.custom')) el.style.background = hex;
  saveSession();
}

// ---------------------------------------------------------------- run control
const now = () => Date.now();
function simNow(t = now()) {
  if (!run) return 0;
  return run.running ? run.anchorSim + (t - run.anchorWall) / 1000 : run.anchorSim;
}
function endPause(t) {
  if (run && !run.running && run.pauseStartWall != null) {
    run.pausedMs += Math.max(0, t - run.pauseStartWall);
    run.pauseStartWall = null;
  }
}

function startPrint() {
  const t = now();
  rebuildTimeline();
  run = {
    anchorWall: t, anchorSim: 0, running: true,
    startedWall: t, pausedMs: 0, pauseStartWall: null, pauseReason: null,
    extrudeWall: null, pausedAtExtrude: 0,
    factor: tl.factor, overtime: false,
  };
  prefs.printerId = setup.printerId;
  savePrefs();
  setMode('run');
  saveSession();
  toast('Started. Tap "It\'s extruding now" when the purge line starts for a tighter sync.', 4200);
}

function togglePause() {
  const t = now();
  if (run.running) {
    run.anchorSim = simNow(t);
    run.running = false;
    run.pauseStartWall = t;
    run.pauseReason = 'manual';
  } else {
    endPause(t);
    if (run.pauseReason && run.pauseReason !== 'manual') run.anchorSim += 0.001; // step past the pause point
    run.anchorWall = t;
    run.running = true;
    run.pauseReason = null;
  }
  saveSession();
  lastUi = 0;
}

function syncTo(simTime) {
  const t = now();
  endPause(t);
  run.anchorSim = simTime;
  run.anchorWall = t;
  run.running = true;
  run.pauseReason = null;
  run.overtime = false;
  saveSession();
  lastUi = 0;
}

function extrudingNow() {
  const t = now();
  syncTo(tl.startupEnd);
  run.extrudeWall = t;
  run.pausedAtExtrude = run.pausedMs;
  saveSession();
  toast('Locked in. Warm-up time measured.');
}

function checkAutoPause(t) {
  if (!run || !run.running) return;
  const s = simNow(t);
  for (const p of tl.pauses) {
    if (p.t > run.anchorSim + 1e-6 && p.t <= s) {
      run.anchorSim = p.t;
      run.running = false;
      run.pauseStartWall = t - (s - p.t) * 1000;
      run.pauseReason = p.type;
      saveSession();
      if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
      return;
    }
  }
}

function printerFinished() {
  const t = now();
  endPause(t);
  let actualMotion;
  if (run.extrudeWall) actualMotion = (t - run.extrudeWall - (run.pausedMs - run.pausedAtExtrude)) / 1000;
  else actualMotion = (t - run.startedWall - run.pausedMs) / 1000 - tl.startupEnd;
  const predictedMotion = tl.total - tl.startupEnd;
  const ratio = actualMotion / Math.max(predictedMotion, 1);
  const actualTotal = (t - run.startedWall - run.pausedMs) / 1000;
  const printer = PRINTERS[setup.printerId];
  let text = `Took ${fmtDur(actualTotal)} (sim predicted ${fmtDur(tl.total)}).`;
  if (ratio > 0.6 && ratio < 1.6 && predictedMotion > 120) {
    const cal = addCalibration(printer.id, run.factor * ratio);
    text += ` Future estimates for the ${printer.name} are now calibrated from ${cal.n} print${cal.n > 1 ? 's' : ''} (×${cal.factor.toFixed(2)}).`;
  } else {
    text += ' That was too far off to learn from (forgot to hit start on time?), so calibration was left alone.';
  }
  run.running = false;
  run.anchorSim = tl.total;
  renderDone(text);
  setMode('done');
  idbSet('session', { mode: 'done', setup, run, doneText: text });
}

function renderDone(text) { $('done-text').textContent = text || ''; }

// ---------------------------------------------------------------- run UI
function updateRunUI(t) {
  const s = simNow(t);
  const st = stateAt(parsed, tl, s);
  view.setHead(st.segHead, st.head, true, st.extruding && run.running);
  view.setSimTime(s, 0.8);
  if (t - lastUi < 200) return;
  lastUi = t;

  const pct = Math.min(100, Math.floor(st.percent));
  $('pct').textContent = pct;
  view.setScreen({
    title: st.startup ? 'preparing' : run.running ? 'printing' : 'paused',
    big: st.startup ? '0%' : `${pct}%`,
    line1: st.startup ? (st.phase || 'Preparing') : `${fmtDur(Math.max(0, tl.total - s))} left`,
    line2: `Layer ${st.layer + 1}/${st.layerCount}`,
    progress: st.percent / 100, accent: accentHex(),
  });
  $('bar').style.width = `${st.percent.toFixed(2)}%`;
  $('bar').parentElement.classList.toggle('startup', st.startup);
  document.title = `${pct}% · printsim`;

  const remaining = Math.max(0, tl.total - s);
  const ended = s >= tl.total - 0.5;
  const futureSwaps = tl.pauses.filter(p => p.t > s + 0.01).length;
  if (!run.running) {
    $('remain').textContent = `${fmtDur(remaining)} left`;
    $('eta').textContent = 'Clock paused';
  } else if (ended) {
    const over = (t - run.anchorWall) / 1000 - (tl.total - run.anchorSim);
    $('remain').textContent = run.overtime ? `+${fmtDur(over)} over` : 'Done?';
    $('eta').textContent = `Expected at ${clock(t - over * 1000)}`;
  } else {
    $('remain').textContent = `${fmtDur(remaining)} left`;
    $('eta').textContent = `Done around ${clock(t + remaining * 1000)}${futureSwaps ? ' + filament swap' + (futureSwaps > 1 ? 's' : '') : ''}`;
  }

  $('st-layer').textContent = `${st.layer + 1} / ${st.layerCount}`;
  $('st-z').textContent = st.startup ? '—' : `${st.z.toFixed(2)} mm`;
  let now_ = st.phase;
  if (!now_) {
    now_ = st.feature === Feature.Custom ? 'Purge line' : FeatureNames[st.feature];
    if (!st.extruding && !ended) now_ = `Travel · ${now_}`;
    const si = Math.min(Math.floor(st.segHead), parsed.segs.move.length - 1);
    if (prefs.physics && parsed.segs.drop && parsed.segs.drop[si] > 0 && !ended) now_ = `${now_} · in mid-air!`;
    if (ended) now_ = 'Finished';
  }
  $('st-phase').textContent = now_;

  // buttons
  show('btn-extruding', !run.extrudeWall && s < tl.startupEnd + 300);
  const pb = $('btn-pause');
  pb.textContent = run.running ? 'Pause' : 'Resume';
  pb.classList.toggle('primary', !run.running);

  // banner
  const banner = $('banner');
  let html = '';
  if (!run.running && run.pauseReason === 'filament') html = '<b>Filament change</b>Swap the filament, then tap Resume the moment the printer carries on.';
  else if (!run.running && run.pauseReason === 'pause') html = '<b>The file pauses here</b>Tap Resume when the printer continues.';
  else if (!run.running) html = '<b>Paused</b>Tap Resume when the printer is going again.';
  else if (ended && !run.overtime) html = '<b>Should be done about now</b><span class="banner-actions"><button class="btn primary" data-act="finished" type="button">Yep, it\'s done</button><button class="btn" data-act="overtime" type="button">Still going</button></span>';
  if (banner.dataset.html !== html) {
    banner.innerHTML = html;
    banner.dataset.html = html;
    show(banner, !!html);
  }
  $('calib-note').textContent = run.extrudeWall
    ? 'Tap "Printer finished" when it actually ends to teach printsim how fast this printer really is.'
    : 'Tip: tap "Printer finished" when it ends and future estimates get calibrated to this printer.';
}

// ---------------------------------------------------------------- legend / view controls
function updateLegend() {
  const on = prefs.colorMode === 'feature' && mode !== 'empty' && parsed;
  $('vc-mode').setAttribute('aria-pressed', prefs.colorMode === 'feature');
  $('vc-ghost').setAttribute('aria-pressed', !!prefs.ghost);
  show('legend', !!on);
  if (!on) return;
  $('legend').innerHTML = parsed.features
    .map(f => `<span><i style="background:${FEATURE_COLORS[f]}"></i>${f === Feature.Custom ? 'Purge / custom' : FeatureNames[f]}</span>`)
    .join('');
}

// ---------------------------------------------------------------- wake lock
let wakeLock = null;
async function setWake(on) {
  try {
    if (on && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) {
    $('wake').checked = false;
    toast("This browser won't keep the screen on.");
  }
}

// ---------------------------------------------------------------- dialogs
function confirmBox(title, text, okLabel = 'OK') {
  return new Promise((resolve) => {
    const d = $('dlg-confirm');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = okLabel;
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok');
    d.showModal();
  });
}

// ---------------------------------------------------------------- wiring
function wire() {
  const fileInput = $('file');
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (f) await handleFile(f);
    fileInput.value = '';
  });
  const drop = $('drop');
  window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) await handleFile(f);
  });

  for (const btn of document.querySelectorAll('[data-sample]')) {
    btn.onclick = async () => {
      const name = btn.dataset.sample;
      show('loading', true);
      $('loading-stage').textContent = 'Downloading sample';
      try {
        const res = await fetch(`samples/${name}`);
        if (!res.ok) throw new Error(res.statusText);
        const bytes = new Uint8Array(await res.arrayBuffer());
        await openFile(name, bytes);
      } catch (e) {
        show('loading', false);
        toast(`Couldn't load the sample: ${e.message}`);
      }
    };
  }
  $('btn-new').onclick = newFile;
  $('btn-new2').onclick = newFile;
  $('btn-again').onclick = () => { run = null; rebuildTimeline(); setMode('setup'); saveSession(); };

  $('printer').onchange = (e) => {
    setup.printerId = e.target.value;
    const p = PRINTERS[setup.printerId];
    view.setBed(p.bed.w, p.bed.d);
    view.setData(parsed.segs, parsed.bbox);
    rebuildTimeline();
    applyScrub();
    saveSession();
  };
  $('material').onchange = (e) => applyMaterial(e.target.value);
  const tempChange = () => {
    const n = parseFloat($('t-noz').value), b = parseFloat($('t-bed').value);
    setup.nozzle = isFinite(n) ? Math.min(Math.max(n, 0), 350) : AMBIENT;
    setup.bed = isFinite(b) ? Math.min(Math.max(b, 0), 150) : AMBIENT;
    rebuildTimeline();
    saveSession();
  };
  $('t-noz').addEventListener('input', tempChange);
  $('t-bed').addEventListener('input', tempChange);
  $('scrub').addEventListener('input', () => { if (preview.playing) setPlaying(false); applyScrub(); });
  $('btn-play').onclick = () => setPlaying(!preview.playing);
  for (const b of document.querySelectorAll('#speeds [data-speed]')) {
    b.setAttribute('role', 'radio');
    b.onclick = () => { prefs.speed = +b.dataset.speed; savePrefs(); updateSpeedNote(); };
  }
  $('btn-layermode').onclick = () => { prefs.layerMode = !prefs.layerMode; savePrefs(); updateSpeedNote(); renderPreview(); };
  $('btn-start').onclick = startPrint;

  $('btn-pause').onclick = togglePause;
  $('btn-extruding').onclick = extrudingNow;
  $('btn-resync').onclick = () => {
    const d = $('dlg-resync');
    const cur = Math.floor(stateAt(parsed, tl, simNow()).percent);
    $('resync-val').value = cur > 0 ? cur : '';
    d.returnValue = '';
    d.onclose = () => {
      if (d.returnValue !== 'ok') return;
      const v = parseFloat($('resync-val').value);
      if (!(v >= 0 && v <= 100)) return;
      syncTo(timeForPercent(tl, v));
      toast(`Synced to ${v}%`);
    };
    d.showModal();
    setTimeout(() => $('resync-val').select(), 50);
  };
  $('btn-more').onclick = () => {
    const open = $('more').classList.contains('hidden');
    show('more', open);
    $('btn-more').setAttribute('aria-expanded', open);
  };
  $('btn-finished').onclick = printerFinished;
  $('btn-stop').onclick = async () => {
    if (await confirmBox('End this print?', 'The sim stops and you go back to setup. The file stays loaded.', 'End print')) {
      run = null;
      setWake(false); $('wake').checked = false;
      rebuildTimeline();
      setMode('setup');
      saveSession();
    }
  };
  $('banner').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'finished') printerFinished();
    if (act === 'overtime') { run.overtime = true; saveSession(); lastUi = 0; }
  });
  $('wake').onchange = (e) => setWake(e.target.checked);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && parsed && mode !== 'empty') saveSession();
    if (document.visibilityState === 'visible') {
      lastUi = 0;
      if ($('wake').checked) setWake(true);
    }
  });

  $('grabber').onclick = () => $('sheet').classList.toggle('collapsed');
  $('vc-fit').onclick = () => view.fit();
  $('vc-printer').onclick = () => {
    prefs.printerView = !prefs.printerView;
    savePrefs();
    view.setPrinterView(prefs.printerView);
    $('vc-printer').setAttribute('aria-pressed', prefs.printerView);
  };
  $('vc-mode').onclick = () => {
    prefs.colorMode = prefs.colorMode === 'feature' ? 'filament' : 'feature';
    savePrefs();
    view.setColorMode(prefs.colorMode);
    updateLegend();
  };
  $('vc-ghost').onclick = () => {
    prefs.ghost = !prefs.ghost;
    savePrefs();
    view.setGhost(prefs.ghost);
    updateLegend();
  };
}

async function handleFile(f) {
  if (mode === 'run' && !(await confirmBox('Replace the running print?', 'The current sim will stop.', 'Replace'))) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  run = null;
  await openFile(f.name, bytes);
}

async function newFile() {
  if (mode === 'run' && !(await confirmBox('Close this print?', 'The running sim will stop and the file is unloaded.', 'Close'))) return;
  run = null; parsed = null; tl = null; file = null;
  await idbDel('file');
  await idbDel('session');
  view.setData({ start: new Float32Array(0), end: new Float32Array(0), meta: new Float32Array(0), move: new Uint32Array(0) }, null);
  view.setHead(0, null, false, false);
  setMode('empty');
}

let lastInsetCheck = 0;
let insetsFitted = '';
function trackInsets() {
  const t = performance.now();
  if (t - lastInsetCheck < 250) return;
  lastInsetCheck = t;
  const sheet = $('sheet');
  let left = 0, bottom = 0;
  if (!sheet.classList.contains('hidden')) {
    const r = sheet.getBoundingClientRect();
    if (window.innerWidth >= 900) left = r.right; else bottom = window.innerHeight - r.top;
  }
  view.setInsets(left, bottom);
  // refit once per layout (mode / file / big resize)
  const key = `${mode}|${file && file.name}|${Math.round(left / 40)}|${Math.round(bottom / 40)}|${window.innerWidth > window.innerHeight}`;
  if (key !== insetsFitted && mode !== 'empty') { insetsFitted = key; view.fit(); }
}

function frame() {
  trackInsets();
  tickPreview();
  if (mode !== 'run' || !run || !tl) return;
  const t = now();
  checkAutoPause(t);
  updateRunUI(t);
}

async function init() {
  view = new PrintView($('view'));
  view.onFrame = frame;
  view.setColorMode(prefs.colorMode);
  view.setGhost(prefs.ghost);
  view.setPhysics(prefs.physics);
  view.setPrinterView(prefs.printerView);
  $('vc-printer').setAttribute('aria-pressed', prefs.printerView);
  setAccent(prefs.color || '#ff7a1a');
  wire();
  updateSpeedNote();
  setMode('empty');

  const saved = await idbGet('file');
  if (saved && saved.bytes) {
    const session = await idbGet('session');
    await openFile(saved.name, saved.bytes instanceof Uint8Array ? saved.bytes : new Uint8Array(saved.bytes), session || { setup: null });
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// Handy for debugging from the console: __printsim.skip(600) jumps 10 min ahead.
window.__printsim = {
  skip(sec) { if (run) { run.anchorWall -= sec * 1000; if (run.startedWall) run.startedWall -= sec * 1000; if (run.extrudeWall) run.extrudeWall -= sec * 1000; lastUi = 0; } },
  get timeline() { return tl; },
  get run() { return run; },
};

init();
