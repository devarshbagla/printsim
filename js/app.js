import { PrintView, FEATURE_COLORS } from './renderer.js';
import { buildTimeline, stateAt, timeForPercent, timeForRemaining } from './timeline.js';
import { FeatureNames, Feature } from './gcode.js';
import { PRINTERS, AMBIENT, guessPrinter } from './printers.js';
import { MATERIALS, surfaceFor } from './materials.js';
import { idbGet, idbSet, idbDel, lsGet, lsSet, listUnits, getUnit, addUnit, removeUnit, effectiveCalibration, learnCalibration } from './store.js';
import { planEvents, buildIcs, googleCalendarUrl } from './ics.js';
import { clockToWall, wallToClock, expectedEndWall, measureRun } from './finish.js';
import { spaghettiReport, fmtGrams } from './report.js';
import { cumulativeGrams, runoutMove, spoolCheck } from './spool.js';
import { TimelapseRecorder, recordingType } from './recorder.js';

const $ = (id) => document.getElementById(id);

// How long a strand takes to fall, in PRINT time. Fixed, so at 10x playback a fall
// is 10x quicker on screen, just like everything else the printer does.
const FALL_SECONDS = 0.7;

const SWATCHES = [
  ['Orange', '#ff7a1a'], ['White', '#f2f2ee'], ['Black', '#2a2b30'], ['Grey', '#8a8f96'],
  ['Silver', '#b9bec6'], ['Red', '#d62839'], ['Yellow', '#f5c518'], ['Green', '#2ba84a'],
  ['Blue', '#1f6feb'], ['Purple', '#7b3fe4'], ['Pink', '#ff6fae'], ['Lavender', '#b9a3f5'],
];

const prefs = Object.assign({ color: null, ghost: true, ghostRun: false, colorMode: 'filament', printerId: null, speed: 200, layerMode: false, physics: true, printerView: true, spoolLeft: null, unitId: null }, lsGet('printsim.prefs', {}));
const savePrefs = () => lsSet('printsim.prefs', prefs);
// "what's left to print" overlay: on while previewing, off by default while a
// print runs (the live build reads better on its own); each remembered separately
const ghostKey = () => (mode === 'run' ? 'ghostRun' : 'ghost');
const ghostOn = () => !!prefs[ghostKey()];

// ---------------------------------------------------------------- state
let view;
let mode = 'empty'; // empty | setup | run | done
let parsed = null;
let spoolCum = null; // cumulativeGrams for the current file + material
let tl = null;
let file = null; // { name, bytes }
let setup = { printerId: 'prusa-mini', unitId: null, nozzle: AMBIENT, bed: AMBIENT, color: '#ff7a1a', spoolLeft: null };
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
function parseBytes(bytes, material) {
  return workerCall({ bytes: bytes.slice(0), material }, true);
}

// one request to the worker; parse requests report progress into the loading overlay
function workerCall(msg, progress = false) {
  if (!worker) worker = new Worker(new URL('./parser.worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const id = Math.random();
    const onMsg = (ev) => {
      const d = ev.data;
      if (d.id !== id) return;
      if (d.type === 'progress') {
        if (!progress) return;
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
    // (a parse gets a copy of the bytes: ours are kept for IndexedDB)
    worker.postMessage({ ...msg, id });
  });
}

async function openFile(name, bytes, restore = null) {
  show('loading', true);
  $('loading-stage').textContent = 'Reading file';
  $('loading-bar').style.width = '0%';
  try {
    const result = await parseBytes(bytes, restore && restore.setup ? restore.setup.material : undefined);
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
    setup.spoolLeft = prefs.spoolLeft > 0 ? prefs.spoolLeft : null;
    setup.unitId = getUnit(prefs.unitId) ? prefs.unitId : null;
  }
  // the worker already ran the support check for the remembered filament
  setup.material = MATERIALS[parsed.activeMaterial] ? parsed.activeMaterial : (parsed.material || 'PLA');
  parsed.activeMaterial = setup.material;
  refreshSpoolCum();
  view.setCurl(MATERIALS[setup.material].curl);
  view.setSurface(surfaceFor(setup.material, cfg));
  const printer = PRINTERS[setup.printerId] || PRINTERS['prusa-mini'];
  view.setBed(printer.bed.w, printer.bed.d);
  view.setData(parsed.segs, parsed.bbox, parsed.layers);
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

  if (restore && restore.run) {
    run = restore.run;
    rebuildTimeline(runCal(run));
    setMode(restore.mode === 'done' ? 'done' : 'run');
    if (restore.mode === 'done') renderDone(restore.doneText);
  } else {
    run = null;
    rebuildTimeline();
    setMode('setup');
    saveSession();
  }
}

// The calibration factor a run was predicted with. Older sessions only stored
// run.factor, which ALSO had the print-speed scaling (100 / speed %) folded in;
// feeding that back in applied the speed twice, and learning from it baked the
// speed into the calibration. Undo it for those.
function runCal(r) {
  if (r && r.calFactor > 0) return r.calFactor;
  if (r && r.factor > 0) return r.factor / (100 / (setup.speedPct || 100));
  return undefined;
}

function rebuildTimeline(factorOverride) {
  const printer = PRINTERS[setup.printerId] || PRINTERS['prusa-mini'];
  const factor = factorOverride || effectiveCalibration(printer.id, setup.unitId).factor;
  tl = buildTimeline(parsed, printer, { nozzleNow: setup.nozzle, bedNow: setup.bed, factor, stealth: !!setup.stealth, speedPct: setup.speedPct || 100 });
  // sim time at which the nozzle lays down each END of every piece
  const sm = parsed.segs.move, times = new Float32Array(sm.length * 2);
  const f0 = parsed.segs.frac0, f1 = parsed.segs.frac;
  for (let i = 0; i < sm.length; i++) {
    const k = sm[i], ts = tl.tStart(k), d = tl.dur[k];
    times[i * 2] = ts + d * (f0 ? f0[i] : 0);
    times[i * 2 + 1] = f1 ? ts + d * f1[i] : tl.tEnd[k];
  }
  view.setSegTimes(times);
  // spool runout: one auto-pause, like an M600 (assume the new spool is full)
  if (setup.spoolLeft > 0 && spoolCum) {
    const move = runoutMove(spoolCum, setup.spoolLeft);
    if (move >= 0) {
      tl.pauses.push({ t: tl.tStart(move), move, type: 'runout' });
      tl.pauses.sort((a, b) => a.t - b.t);
    }
  }
  updateSetupEstimate();
  updateSpeedNote();
  renderSupportWarning(); // says when it goes wrong, which moves with the timeline
  renderSpoolWarning();
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
  if (m !== 'setup') { cancelRecording(); setPlaying(false); }
  if (m === 'setup') applyScrub();
  view.setGhost(ghostOn());
  if (m === 'run') { view.setWarnTint(0); view.setPhysics(prefs.physics); scheduleGhostHint(); } else hideGhostHint();
  // a live print moves at real speed: 30 fps is smooth and keeps a phone that
  // sits on the page for hours cool (dragging the view still renders at full rate)
  view.maxFps = m === 'run' ? 30 : 0;
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
  fillUnits();
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
  $('spool-left').value = setup.spoolLeft > 0 ? setup.spoolLeft : '';
  const hasSilent = parsed.silentAnchors && parsed.silentAnchors.length > 1;
  show('stealth-row', hasSilent);
  $('stealth').checked = hasSilent && !!setup.stealth;
  $('speed-pct').value = setup.speedPct || 100;
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

// Re-run the support check for another filament in the worker (seconds on big
// prints). The overlay only shows if it takes long enough to notice.
let physicsToken = 0;
async function applyMaterial(key) {
  setup.material = key;
  saveSession();
  const token = ++physicsToken;
  const overlay = setTimeout(() => {
    if (token !== physicsToken) return;
    $('loading-stage').textContent = `Re-checking overhangs for ${MATERIALS[key].name}`;
    $('loading-bar').style.width = '100%';
    show('loading', true);
  }, 150);
  let r;
  try {
    r = await workerCall({
      type: 'physics', rawSegs: parsed.rawSegs, rawLayerSeg: parsed.rawLayerSeg, layerZ: parsed.layers.z,
      movesRaw: parsed.moves.raw, config: parsed.meta.config, material: key, temp: parsed.nozzleTemp,
    });
  } catch (err) {
    console.error(err);
    toast(`Couldn't re-check for ${MATERIALS[key].name}: ${err.message}`, 4200);
    return;
  } finally {
    clearTimeout(overlay);
    if (token === physicsToken) show('loading', false);
  }
  if (token !== physicsToken || !parsed || mode === 'empty') return; // superseded, or the file was closed
  parsed.segs = r.segs;
  parsed.layers.seg = r.layerSeg;
  parsed.support = r.support;
  parsed.activeMaterial = key;
  view.setCurl(MATERIALS[key].curl);
  view.setSurface(surfaceFor(key, parsed.meta.config));
  view.setData(parsed.segs, parsed.bbox, parsed.layers);
  refreshSpoolCum();
  rebuildTimeline(); // also re-renders the support / spool warnings
  updateMaterialNote();
  applyScrub();
  saveSession();
}

function refreshSpoolCum() {
  spoolCum = parsed ? cumulativeGrams(parsed, setup.material) : null;
}

function readSpoolLeft() {
  const v = parseFloat($('spool-left').value);
  setup.spoolLeft = isFinite(v) && v > 0 ? Math.min(Math.max(v, 0), 3000) : null;
  prefs.spoolLeft = setup.spoolLeft;
  savePrefs();
  renderSpoolWarning();
  saveSession();
}

function renderSpoolWarning() {
  const box = $('spool-warn');
  if (!parsed || !tl || !spoolCum || !(setup.spoolLeft > 0)) { show(box, false); return; }
  const chk = spoolCheck(spoolCum, setup.spoolLeft);
  if (chk.move < 0 && !chk.tight) { show(box, false); return; }
  box.textContent = '';
  const b = document.createElement('b');
  if (chk.move >= 0) {
    const tIn = Math.max(0, tl.tStart(chk.move) - tl.startupEnd);
    const st = stateAt(parsed, tl, tl.tStart(chk.move));
    b.textContent = `Runs out of filament about ${fmtDur(tIn)} in (${Math.floor(st.percent)}%, layer ${st.layer + 1})`;
    box.append(b, `This print needs about ${fmtGrams(chk.need)} and the spool has ${fmtGrams(chk.left)}. Load a fuller spool, or plan to be there to swap it.`);
  } else {
    b.textContent = 'Cutting it close on filament';
    box.append(b, `Needs about ${fmtGrams(chk.need)}, the spool has ${fmtGrams(chk.left)}. Spool weights are rough, so a fuller spool is safer.`);
  }
  show(box, true);
}

function accentHex() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff7a1a';
}

// "Which one?": the lab's physical printers of this model. Names are typed by
// the user, so they only ever go in via textContent.
function fillUnits() {
  const sel = $('unit');
  const units = listUnits(setup.printerId);
  if (setup.unitId && !units.some((u) => u.id === setup.unitId)) setup.unitId = null;
  sel.textContent = '';
  const opt = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; sel.appendChild(o); };
  opt('', 'Not sure');
  for (const u of units) opt(u.id, u.name);
  opt('__add', '+ Add a printer');
  sel.value = setup.unitId || '';
  show('unit-remove', !!setup.unitId);
}

function pickUnit(id) {
  setup.unitId = id || null;
  prefs.unitId = setup.unitId;
  savePrefs();
  fillUnits();
  rebuildTimeline();
  saveSession();
}

function addUnitDialog() {
  const d = $('dlg-unit');
  $('unit-name').value = '';
  d.returnValue = '';
  d.onclose = () => {
    const name = $('unit-name').value.trim();
    if (d.returnValue !== 'ok' || !name) { fillUnits(); return; }
    const id = addUnit(setup.printerId, name);
    pickUnit(id);
    toast(`Added "${name.slice(0, 40)}". It learns its own speed from each print you finish on it.`, 3600);
  };
  d.showModal();
  setTimeout(() => $('unit-name').focus(), 50);
}

function updateSetupEstimate() {
  if (!tl) return;
  const cal = effectiveCalibration(setup.printerId, setup.unitId);
  const unit = getUnit(setup.unitId);
  const prints = (n) => `${n} print${n > 1 ? 's' : ''}`;
  let txt = `About ${fmtDur(tl.total)} total, including ~${fmtDur(tl.startupEnd)} of warm-up and bed leveling.`;
  if (cal.scope === 'unit') txt += ` Calibrated for "${unit.name}" from ${prints(cal.n)} (×${cal.factor.toFixed(2)}).`;
  else if (unit && cal.n > 0) txt += ` Using all ${unit.model === 'prusa-mini' ? 'MINIs' : 'printers'} (${prints(cal.n)}, ×${cal.factor.toFixed(2)}) until "${unit.name}" has a print of its own.`;
  else if (unit) txt += ` "${unit.name}" learns its own speed after its first finished print.`;
  else if (cal.n > 0) txt += ` Calibrated from ${prints(cal.n)} (×${cal.factor.toFixed(2)}).`;
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
let rec = null; // timelapse video being recorded (see "timelapse video" below)
const playSpeed = () => (rec ? rec.speed : prefs.speed);
// Sped up, the drawn head trails the real one by this many wall seconds (a
// critically damped spring in the renderer) so it glides instead of teleporting:
// 10x 0.04 s, 50x 0.07 s, 200x 0.09 s, 1000x 0.12 s.
const motionTau = (speed) => (speed <= 1 ? 0 : Math.min(0.12, 0.012 * Math.log2(speed)));

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
  view.setWarnTint(0);
  view.setMotionSmoothing(motionTau(playSpeed()));
  view.setSimTime(preview.t, FALL_SECONDS);
  if (prefs.layerMode) {
    // like a printer timelapse: one frame per finished layer, nozzle parked
    view.setHead(parsed.layers.seg[st.layer] ?? S, null, false, false);
  } else {
    view.setHead(st.segHead, st.head, true, true);
  }
  $('scrub-label').textContent = `Layer ${st.layer + 1}/${st.layerCount} · ${Math.floor(st.percent)}% · ${fmtDur(preview.t - tl.startupEnd)} in`;
  view.setScreen({ title: 'preview', big: `${Math.floor(st.percent)}%`, line1: `${Math.round(playSpeed())}× timelapse`, line2: `Layer ${st.layer + 1}/${st.layerCount}`, progress: st.percent / 100, accent: accentHex() });
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
  preview.t += dt * playSpeed();
  if (preview.t >= tl.total) {
    preview.t = tl.total;
    // a recording holds on the finished model for a moment before it ends
    if (rec) { if (!rec.endAt) rec.endAt = w + REC_HOLD_MS; } else setPlaying(false);
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

// Why the slicer left it unsupported, from the file's own settings
function supportNote(p) {
  const cfg = p.meta.config;
  const on = String(cfg.support_material ?? '').trim();
  const hasSupports = p.features && (p.features.includes(Feature.Support) || p.features.includes(Feature.SupportInterface));
  if (on === '0') return ' (supports are off in the slicer)';
  if (on === '1' && !hasSupports) {
    return String(cfg.support_material_auto ?? '').trim() === '0'
      ? ' (supports are on, but only where painted, and nothing was painted)'
      : " (supports are on, but the slicer didn't put any here)";
  }
  return '';
}

function renderSupportWarning() {
  const box = $('support-warn');
  const sp = parsed.support;
  if (!sp || sp.failedFraction < 0.002 || sp.failedSegments < 20) { show(box, false); return; }
  const pct = sp.failedFraction * 100;
  const why = supportNote(parsed);
  const rep = tl ? spaghettiReport(parsed, (k) => tl.tStart(k), tl.startupEnd, tl.total, setup.material) : null;
  const n = sp.islands || 0;
  let head, body, fix = 'Add supports in your slicer';
  if (rep) {
    const when = rep.tFail < 60 ? 'right at the start' : `about ${fmtDur(rep.tFail)} in`;
    const at = `about ${Math.max(1, Math.round(rep.pctFail))}% through`;
    // loose strands that curl up onto the nozzle get dragged along and wiped off elsewhere
    const blobby = (sp.blobs || 0) >= 3 && (sp.stuckLength || 0) > 0.05 * sp.failedLength;
    const cost = `Roughly ${fmtGrams(rep.spaghettiG)} ends up as spaghetti${blobby ? ' (some of it balls up on the nozzle and gets dragged onto other parts of the print)' : ''}, and the ${fmtGrams(rep.afterG)} printed from then on is at risk.`;
    head = `Spaghetti alert: goes wrong ${when} (layer ${rep.layer + 1})`;
    if (n > 0) {
      body = `${n === 1 ? 'One part starts' : `${n} parts start`} printing in mid-air with nothing under ${n === 1 ? 'it' : 'them'}${why}, the first ${at}. ${cost}`;
      if (why.includes('painted')) fix = 'Turn on automatic supports (or paint them under those parts)';
    } else if (rep.severe) {
      body = `At ${at}, it starts laying plastic on thin air${why}. ${cost}`;
    } else {
      body = `At ${at}, a few spots have nothing underneath them${why}. About ${fmtGrams(rep.spaghettiG)} will droop or fall there, so expect some mess.`;
    }
  } else {
    head = "Heads up: this looks like it'll turn into spaghetti";
    body = `From layer ${sp.firstLayer + 1}, about ${pct < 1 ? pct.toFixed(1) : Math.round(pct)}% of the print has nothing underneath it${why}. Those strands will droop or fall.`;
  }
  box.textContent = '';
  const b = document.createElement('b');
  b.textContent = head;
  box.append(b, `${body} ${fix}, or hit play to watch it happen.`);
  const lab = document.createElement('label');
  lab.className = 'toggle';
  lab.innerHTML = `<input type="checkbox" id="physics" ${prefs.physics ? 'checked' : ''}> Simulate falling filament`;
  box.appendChild(lab);
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
    factor: tl.factor, calFactor: tl.calFactor, unitId: setup.unitId || null, overtime: false,
  };
  prefs.printerId = setup.printerId;
  prefs.unitId = setup.unitId || null;
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

// finishWall: when the printer really finished (the finish dialog asks; it can
// be well before now if the user checked back late)
function printerFinished(finishWall = now()) {
  const { total: actualTotal, motion: actualMotion } = measureRun(run, finishWall, tl.startupEnd);
  endPause(now());
  const predictedMotion = tl.total - tl.startupEnd;
  const ratio = actualMotion / Math.max(predictedMotion, 1);
  const printer = PRINTERS[setup.printerId];
  let text = `Took ${fmtDur(actualTotal)} (sim predicted ${fmtDur(tl.total)}).`;
  if (ratio > 0.6 && ratio < 1.6 && predictedMotion > 120) {
    const unit = getUnit(run.unitId);
    const learned = learnCalibration(printer.id, unit && unit.id, (runCal(run) || 1) * ratio);
    const cal = learned.unit || learned.model;
    const off = Math.round((ratio - 1) * 100);
    const how = Math.abs(off) < 1 ? 'right on time' : `${Math.abs(off)}% ${off > 0 ? 'slower' : 'faster'} than predicted`;
    const who = unit ? `"${unit.name}"` : `the ${printer.name}`;
    text += ` This one ran ${how}. Future estimates for ${who} are now calibrated from ${cal.n} print${cal.n > 1 ? 's' : ''} (×${cal.factor.toFixed(2)}).`;
    if (!unit && listUnits(printer.id).length === 0) text += ' Tip: name this printer in setup ("Which one?") so each printer learns its own speed.';
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

// ---------------------------------------------------------------- "when did it finish?"
// Calibration only learns if people report the finish, and report it right.
// So: the ETA banner, the calendar's finish alert (?done=1), "End print" near
// the end, and coming back after the ETA all lead here.
function openFinishDialog() {
  if (!run || !tl || mode !== 'run') return;
  const d = $('dlg-finish');
  if (d.open) return;
  const t = now();
  const exp = expectedEndWall(run, tl.total);
  const late = exp != null && t - exp > 10 * 60e3;
  $('fin-time').value = wallToClock(late ? exp : t);
  $(late ? 'fin-at' : 'fin-now').checked = true;
  $('fin-note').textContent = exp == null
    ? ''
    : exp <= t ? `printsim expected it around ${clock(exp)}.` : `printsim expects it around ${clock(exp)}.`;
  d.returnValue = '';
  d.onclose = () => {
    const v = d.returnValue;
    if (v === 'failed') return printFailed();
    if (v !== 'ok') { run.askedFor = exp != null ? Math.round(exp) : run.askedFor; saveSession(); lastUi = 0; return; }
    let at = now();
    if ($('fin-at').checked) {
      at = clockToWall($('fin-time').value, now(), run.startedWall);
      if (at == null) { toast("That's before the print started. Pick the time it finished."); setTimeout(openFinishDialog, 50); return; }
    }
    printerFinished(at);
  };
  d.showModal();
}

function printFailed() {
  run.running = false;
  run.anchorSim = Math.min(simNow(), tl.total);
  const text = 'Marked as failed. Calibration was left alone, since a failed print says nothing about how fast the printer is.';
  renderDone(text);
  setMode('done');
  idbSet('session', { mode: 'done', setup, run, doneText: text });
}

// Came back after the print should have ended and never said so: ask, once per ETA
function maybeAskFinish() {
  if (mode !== 'run' || !run || !tl) return;
  const exp = expectedEndWall(run, tl.total);
  if (exp == null || now() - exp < 5 * 60e3 || run.askedFor === Math.round(exp)) return;
  run.askedFor = Math.round(exp);
  saveSession();
  openFinishDialog();
}

// ---------------------------------------------------------------- run UI
function updateRunUI(t) {
  const s = simNow(t);
  const st = stateAt(parsed, tl, s);
  view.setMotionSmoothing(0); // real time: the head is drawn exactly where it is
  view.setHead(st.segHead, st.head, true, st.extruding && run.running);
  view.setSimTime(s, FALL_SECONDS);
  if (t - lastUi < 200) return;
  lastUi = t;

  const pct = Math.min(100, Math.floor(st.percent));
  $('pct').textContent = pct;
  view.setScreen({
    title: st.startup ? 'preparing' : run.running ? 'printing' : 'paused',
    big: st.startup ? '0%' : `${pct}%`,
    line1: st.startup ? (st.phase || '') : `${fmtDur(Math.max(0, tl.total - s))} left`,
    line2: `Layer ${st.layer + 1}/${st.layerCount}`,
    progress: st.percent / 100, accent: accentHex(),
  });
  $('bar').style.width = `${st.percent.toFixed(2)}%`;
  $('bar').parentElement.classList.toggle('startup', st.startup);
  $('bar').parentElement.classList.toggle('paused', !run.running); // freezes the warm-up stripes too
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
  show('btn-cal', !ended && remaining > 60);
  $('st-z').textContent = st.startup ? '-' : `${st.z.toFixed(2)} mm`;
  let now_ = st.phase;
  if (!now_) {
    if (st.startup) now_ = '';
    else {
      now_ = st.feature === Feature.Custom ? 'Purge line' : FeatureNames[st.feature];
      if (!st.extruding && !ended) now_ = `Travel · ${now_}`;
      const si = Math.min(Math.floor(st.segHead), parsed.segs.move.length - 1);
      if (prefs.physics && parsed.segs.drop && (parsed.segs.drop[si * 2] > 0 || parsed.segs.drop[si * 2 + 1] > 0) && !ended) now_ = `${now_} · in mid-air!`;
      if (ended) now_ = 'Finished';
    }
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
  else if (!run.running && run.pauseReason === 'runout') html = '<b>Filament ran out</b>The printer stopped to unload. Load a new spool, then tap Resume when it carries on.';
  else if (!run.running && run.pauseReason === 'pause') html = '<b>The file pauses here</b>Tap Resume when the printer continues.';
  else if (!run.running) html = '<b>Paused</b>Tap Resume when the printer is going again.';
  else if (ended && !run.overtime) html = '<b>Should be done about now</b><span class="banner-actions"><button class="btn primary" data-act="finished" type="button">It finished</button><button class="btn" data-act="overtime" type="button">Still going</button></span>';
  else if (ended) html = '<b>Running over</b>Tap when it\'s done so printsim learns how fast this printer really is.<span class="banner-actions"><button class="btn primary" data-act="finished" type="button">It finished</button></span>';
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
  $('vc-ghost').setAttribute('aria-pressed', ghostOn());
  show('legend', !!on);
  if (!on) return;
  $('legend').innerHTML = parsed.features
    .map(f => `<span><i style="background:${FEATURE_COLORS[f]}"></i>${f === Feature.Custom ? 'Purge / custom' : FeatureNames[f]}</span>`)
    .join('');
}

// ---------------------------------------------------------------- ghost hint (laptops only)
// A one-line nudge next to the overlay button, shown a few seconds into a live
// print, only on big screens with a mouse. It goes away by itself, and never
// comes back once the button was used or the hint closed (max 2 showings).
const HINT_KEY = 'printsim.ghostHint';
let hintTimer = 0;
function hintAllowed() {
  const h = lsGet(HINT_KEY, { shown: 0, done: false });
  return !h.done && h.shown < 2 && !ghostOn() &&
    matchMedia('(min-width: 900px) and (min-height: 560px) and (hover: hover) and (pointer: fine)').matches;
}
function scheduleGhostHint() {
  clearTimeout(hintTimer);
  if (!hintAllowed()) return;
  hintTimer = setTimeout(() => {
    if (mode !== 'run' || !hintAllowed()) return;
    const h = lsGet(HINT_KEY, { shown: 0, done: false });
    lsSet(HINT_KEY, { ...h, shown: h.shown + 1 });
    const el = $('ghost-hint');
    const b = $('vc-ghost').getBoundingClientRect();
    el.style.top = `${b.top + b.height / 2}px`;
    el.style.right = `${window.innerWidth - b.left + 12}px`;
    show(el, true);
    void el.offsetWidth; // start the fade from the hidden state
    el.classList.add('in');
    hintTimer = setTimeout(hideGhostHint, 12000);
  }, 6000);
}
function hideGhostHint() {
  clearTimeout(hintTimer);
  const el = $('ghost-hint');
  if (!el || el.classList.contains('hidden')) return;
  el.classList.remove('in');
  setTimeout(() => { if (!el.classList.contains('in')) show(el, false); }, 250);
}
function retireGhostHint() {
  lsSet(HINT_KEY, { shown: 2, done: true });
  hideGhostHint();
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

// ---------------------------------------------------------------- resync
// The MINI's screen shows % (1% steps, ~11 min each on a 19h print) and the time
// left (from the file's M73 R, whole minutes). Time left is finer, so it wins,
// unless it disagrees with the % typed alongside it (a typo, most likely).
function resyncTarget(pct, hStr, mStr) {
  const hasLeft = hStr.trim() !== '' || mStr.trim() !== '';
  const mins = (parseFloat(hStr) || 0) * 60 + (parseFloat(mStr) || 0);
  const hasPct = pct >= 1 && pct <= 100;
  const tLeft = hasLeft && mins >= 0 ? timeForRemaining(tl, mins) : null;
  if (tLeft != null) {
    const leftPct = stateAt(parsed, tl, tLeft + 0.01).percent;
    if (hasPct && Math.abs(leftPct - pct) > 3) {
      return { t: timeForPercent(tl, pct), msg: `Time left and % don't match (that time is ~${Math.round(leftPct)}%). Went with ${pct}%.`, warn: true };
    }
    return { t: tLeft, msg: `Synced to ${fmtDur(mins * 60)} left` };
  }
  if (hasPct) return { t: timeForPercent(tl, pct), msg: `Synced to ${pct}%` };
  return null;
}

// ---------------------------------------------------------------- calendar reminders
// The printers aren't networked and there's no server, so the phone's own
// calendar does the pinging. See js/ics.js for why each export gets new UIDs.
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const CAL_LABEL = { finish: 'Print done', filament: 'Filament swap', pause: 'Print pauses', runout: 'Filament runs out' };

function calendarEvents() {
  const t = now();
  const printer = PRINTERS[setup.printerId];
  return planEvents({
    nowMs: t, simNow: simNow(t), total: tl.total, pauses: tl.pauses,
    name: file.name, printer: printer ? printer.name : '', url: location.origin + location.pathname,
    finishUrl: `${location.origin}${location.pathname}?done=1`,
  });
}

function calClock(ms) {
  const d = new Date(ms), today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? clock(ms) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function openCalendar() {
  if (!run || !tl) return;
  const evs = calendarEvents();
  const list = $('cal-list');
  list.textContent = '';
  for (const e of evs) {
    const li = document.createElement('li');
    const b = document.createElement('b'), s = document.createElement('span');
    b.textContent = CAL_LABEL[e.kind] || 'Reminder';
    s.textContent = calClock(e.start);
    li.append(b, s);
    list.appendChild(li);
  }
  const notes = [];
  if (!run.running) notes.push('The clock is paused, so these times assume it resumes right now.');
  notes.push('Resync later? Add it again and delete the old events.');
  $('cal-note').textContent = notes.join(' ');
  const finish = evs[evs.length - 1], swap = evs.find(e => e.kind === 'filament' || e.kind === 'runout');
  $('cal-google').href = googleCalendarUrl(finish);
  show('cal-google-swap', !!swap);
  if (swap) $('cal-google-swap').href = googleCalendarUrl(swap);
  const d = $('dlg-cal');
  d.returnValue = '';
  d.showModal();
}

function downloadIcs() {
  const t = now();
  const text = buildIcs(calendarEvents(), { nowMs: t, uidSeed: `${run.startedWall}-${t}` });
  if (isIOS()) {
    // iOS only offers "Add to Calendar" for a direct navigation to text/calendar;
    // the Share Sheet and <a download> both end in a plain text preview.
    saveSession();
    location.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(text)}`;
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `printsim-${file.name.replace(/\.(b?gcode|gcode\.3mf)$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60)}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  $('dlg-cal').close();
  toast('Calendar file downloaded. Open it to add the reminders.', 3600);
}

// ---------------------------------------------------------------- timelapse video
// Plays the whole print as a ~12 s timelapse while recording the part of the
// screen the model is framed in, with a slow orbit, then offers the video to
// share or save. Everything stays on the device.
const REC_SECONDS = 12, REC_HOLD_MS = 1600;

function recordingCrop() {
  const c = $('view');
  const ratio = c.width / Math.max(c.clientWidth, 1);
  const x = Math.round(view.insets.left * ratio);
  const h = Math.round(c.height - view.insets.bottom * ratio);
  return { x, y: 0, w: c.width - x, h };
}

function startRecording() {
  if (rec || !tl || mode !== 'setup') return;
  const crop = recordingCrop();
  if (crop.w < 120 || crop.h < 120) { toast('Not enough of the 3D view is showing to record it.'); return; }
  let r;
  try {
    r = new TimelapseRecorder($('view'), crop, { title: file.name.replace(/\.(b?gcode|gcode\.3mf)$/i, ''), accent: accentHex() });
  } catch (e) {
    toast("This browser can't record video.");
    return;
  }
  rec = {
    r, speed: Math.min(Math.max(printSpan() / (window.__printsim.recSeconds || REC_SECONDS), 10), 50000), endAt: null,
    rotate: view.controls.autoRotate, rotateSpeed: view.controls.autoRotateSpeed,
  };
  view.controls.autoRotate = true;
  view.controls.autoRotateSpeed = 1.6;
  view.onRendered = () => {
    if (!rec) return;
    const st = stateAt(parsed, tl, preview.t ?? tl.total);
    rec.r.info = {
      pct: st.percent,
      line: `Layer ${st.layer + 1}/${st.layerCount} · ${fmtDur(Math.max(0, (preview.t ?? tl.total) - tl.startupEnd))} of ${fmtDur(printSpan())}`,
    };
    rec.r.draw();
  };
  setPlaying(false);
  preview.t = tl.startupEnd;
  $('scrub').value = 0;
  // the video's first frame (what share sheets show as its thumbnail) must be a
  // real one: render now and copy it in before the recorder starts, otherwise it
  // can grab the blank canvas first
  renderPreview();
  view.renderer.render(view.scene, view.camera);
  view.onRendered();
  try {
    rec.r.start();
  } catch (e) {
    endRecording();
    toast("This browser can't record video.");
    return;
  }
  setPlaying(true);
  const b = $('btn-rec');
  b.classList.add('recording');
  b.setAttribute('aria-pressed', 'true');
  $('btn-rec-label').textContent = 'Recording… tap to cancel';
}

// put the view back the way it was
function endRecording() {
  if (!rec) return null;
  const r = rec.r;
  view.onRendered = null;
  view.controls.autoRotate = rec.rotate;
  view.controls.autoRotateSpeed = rec.rotateSpeed;
  rec = null;
  const b = $('btn-rec');
  b.classList.remove('recording');
  b.setAttribute('aria-pressed', 'false');
  $('btn-rec-label').textContent = 'Save as video';
  return r;
}

// reset: go back to the full model (skip it when the user just grabbed the
// scrubber or play button, their own handler decides what shows next)
function cancelRecording({ reset = false, say = false } = {}) {
  const r = endRecording();
  if (!r) return;
  r.cancel();
  if (reset && mode === 'setup') { setPlaying(false); $('scrub').value = 1000; applyScrub(); }
  if (say) toast('Recording cancelled');
}

let videoUrl = null, videoFile = null;
async function finishRecording() {
  const r = endRecording();
  if (!r) return;
  setPlaying(false);
  $('scrub').value = 1000;
  applyScrub();
  try {
    const blob = await r.stop();
    const base = file ? file.name.replace(/\.(b?gcode|gcode\.3mf)$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) : 'print';
    videoFile = new File([blob], `printsim-${base}.${r.extension}`, { type: blob.type });
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(videoFile);
    const v = $('video-out');
    v.src = videoUrl;
    $('video-save').href = videoUrl;
    $('video-save').download = videoFile.name;
    $('video-meta').textContent = `${r.extension.toUpperCase()} · ${(blob.size / 1e6).toFixed(1)} MB · ${r.out.width}×${r.out.height}`;
    let canShare = false;
    try { canShare = !!(navigator.canShare && navigator.canShare({ files: [videoFile] })); } catch (e) { /* no */ }
    show('video-share', canShare);
    $('video-save').classList.toggle('primary', !canShare);
    $('dlg-video').showModal();
    v.play().catch(() => {});
  } catch (e) {
    toast(`Couldn't make the video: ${e.message}`, 4200);
  }
}

async function shareVideo() {
  if (!videoFile) return;
  try {
    await navigator.share({ files: [videoFile], title: 'printsim timelapse' });
  } catch (e) {
    if (e && e.name !== 'AbortError') toast("Sharing didn't work here. Use Save video instead.", 3600);
  }
}

function closeVideo() {
  const v = $('video-out');
  v.pause();
  v.removeAttribute('src');
  v.load();
  // keep the blob URL a moment in case a save is still in flight
  const u = videoUrl;
  videoUrl = null;
  if (u) setTimeout(() => URL.revokeObjectURL(u), 30000);
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
    fillUnits();
    const p = PRINTERS[setup.printerId];
    view.setBed(p.bed.w, p.bed.d);
    view.setData(parsed.segs, parsed.bbox, parsed.layers);
    rebuildTimeline();
    applyScrub();
    saveSession();
  };
  $('material').onchange = (e) => applyMaterial(e.target.value);
  $('unit').onchange = (e) => (e.target.value === '__add' ? addUnitDialog() : pickUnit(e.target.value));
  $('unit-remove').onclick = async () => {
    const u = getUnit(setup.unitId);
    if (!u) return;
    if (await confirmBox(`Forget "${u.name}"?`, 'Its learned speed is deleted. Other printers keep theirs, and its prints stay in the all-printers average.', 'Forget')) {
      removeUnit(u.id);
      pickUnit(null);
    }
  };
  $('spool-left').addEventListener('input', readSpoolLeft);
  $('spool-left').addEventListener('change', readSpoolLeft);
  $('stealth').onchange = (e) => { setup.stealth = e.target.checked; rebuildTimeline(); applyScrub(); saveSession(); };
  const readSpeed = (el) => { const v = parseFloat(el.value); return v >= 10 && v <= 999 ? v : 100; };
  $('speed-pct').addEventListener('change', (e) => { setup.speedPct = readSpeed(e.target); rebuildTimeline(); applyScrub(); saveSession(); });
  // mid-print speed change: keep the sim at the same spot in the file, re-time the rest
  $('run-speed').addEventListener('change', (e) => {
    if (!run) return;
    const t = now();
    const st = stateAt(parsed, tl, simNow(t));
    setup.speedPct = readSpeed(e.target);
    rebuildTimeline(runCal(run));
    const s2 = tl.tStart(st.move) + tl.dur[st.move] * st.frac;
    run.anchorSim = s2;
    run.anchorWall = t;
    saveSession();
    lastUi = 0;
    toast(`Printer speed ${setup.speedPct}%: remaining time updated`);
  });
  const tempChange = () => {
    const n = parseFloat($('t-noz').value), b = parseFloat($('t-bed').value);
    setup.nozzle = isFinite(n) ? Math.min(Math.max(n, 0), 350) : AMBIENT;
    setup.bed = isFinite(b) ? Math.min(Math.max(b, 0), 150) : AMBIENT;
    rebuildTimeline();
    saveSession();
  };
  $('t-noz').addEventListener('input', tempChange);
  $('t-bed').addEventListener('input', tempChange);
  $('scrub').addEventListener('input', () => { cancelRecording(); if (preview.playing) setPlaying(false); applyScrub(); });
  $('btn-play').onclick = () => { cancelRecording(); setPlaying(!preview.playing); };
  $('btn-rec').onclick = () => (rec ? cancelRecording({ reset: true, say: true }) : startRecording());
  $('video-share').onclick = shareVideo;
  $('dlg-video').addEventListener('close', closeVideo);
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
    $('resync-h').value = ''; $('resync-m').value = '';
    show('resync-left-row', tl.rAnchors && tl.rAnchors.length > 1);
    d.returnValue = '';
    d.onclose = () => {
      if (d.returnValue !== 'ok') return;
      const r = resyncTarget(parseFloat($('resync-val').value), $('resync-h').value, $('resync-m').value);
      if (!r) return;
      syncTo(r.t);
      toast(r.msg, r.warn ? 4200 : 2400);
    };
    d.showModal();
    setTimeout(() => $('resync-val').select(), 50);
  };
  $('btn-more').onclick = () => {
    const open = $('more').classList.contains('hidden');
    $('run-speed').value = setup.speedPct || 100;
    show('more', open);
    $('btn-more').setAttribute('aria-expanded', open);
    $('btn-more').setAttribute('aria-label', open ? 'Fewer options' : 'More options');
  };
  $('btn-finished').onclick = openFinishDialog;
  for (const ev of ['input', 'focus']) $('fin-time').addEventListener(ev, () => { $('fin-at').checked = true; });
  $('btn-cal').onclick = openCalendar;
  $('cal-ics').onclick = downloadIcs;
  $('cal-google').addEventListener('click', () => setTimeout(() => $('dlg-cal').close(), 100));
  $('btn-stop').onclick = async () => {
    if (run && tl && simNow() >= 0.9 * tl.total) { openFinishDialog(); return; } // most likely it finished
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
    if (act === 'finished') openFinishDialog();
    if (act === 'overtime') { run.overtime = true; const e = expectedEndWall(run, tl.total); if (e != null) run.askedFor = Math.round(e); saveSession(); lastUi = 0; }
  });
  $('wake').onchange = (e) => setWake(e.target.checked);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && parsed && mode !== 'empty') saveSession();
    if (document.visibilityState === 'hidden' && rec) { cancelRecording({ reset: true }); toast('Recording stopped: printsim went to the background.', 3600); }
    if (document.visibilityState === 'visible') {
      lastUi = 0;
      if ($('wake').checked) setWake(true);
      maybeAskFinish();
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
    prefs[ghostKey()] = !ghostOn();
    savePrefs();
    view.setGhost(ghostOn());
    updateLegend();
    if (mode === 'run') retireGhostHint();
  };
  $('ghost-hint-close').onclick = retireGhostHint;
}

async function handleFile(f) {
  if (mode === 'run' && !(await confirmBox('Replace the running print?', 'The current sim will stop.', 'Replace'))) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  run = null;
  await openFile(f.name, bytes);
}

async function newFile() {
  if (mode === 'run' && !(await confirmBox('Close this print?', 'The running sim will stop and the file is unloaded.', 'Close'))) return;
  run = null; parsed = null; spoolCum = null; tl = null; file = null;
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
  view.showcase = mode === 'empty';
  if (mode === 'empty') {
    // landing: the printer spins in the space the text leaves free, never behind it
    const land = $('landing'), r = land.getBoundingClientRect();
    if (r.width < window.innerWidth * 0.75) left = r.right;                              // text column on the left
    else bottom = window.innerHeight - (parseFloat(getComputedStyle(land).paddingTop) || 0); // printer band on top
  } else if (!sheet.classList.contains('hidden')) {
    const r = sheet.getBoundingClientRect();
    // side card (laptops, phones on their side) vs bottom sheet
    if (r.width < window.innerWidth * 0.75) left = r.right; else bottom = window.innerHeight - r.top;
  }
  view.setInsets(left, bottom);
  // refit once per layout (mode / file / big resize)
  const key = `${mode}|${file && file.name}|${Math.round(left / 40)}|${Math.round(bottom / 40)}|${window.innerWidth > window.innerHeight}`;
  if (key !== insetsFitted) { insetsFitted = key; view.fit(); }
}

function frame() {
  trackInsets();
  tickPreview();
  if (rec) {
    view.dirty = true; // every frame goes into the video, even when nothing moved
    if (rec.endAt && performance.now() >= rec.endAt) finishRecording();
  }
  if (mode !== 'run' || !run || !tl) return;
  const t = now();
  checkAutoPause(t);
  updateRunUI(t);
}

async function init() {
  view = new PrintView($('view'));
  view.onFrame = frame;
  view.setColorMode(prefs.colorMode);
  view.setGhost(ghostOn());
  view.setPhysics(prefs.physics);
  view.setPrinterView(prefs.printerView);
  $('vc-printer').setAttribute('aria-pressed', prefs.printerView);
  setAccent(prefs.color || '#ff7a1a');
  wire();
  show('btn-rec', !!recordingType());
  updateSpeedNote();
  setMode('empty');

  const saved = await idbGet('file');
  if (saved && saved.bytes) {
    const session = await idbGet('session');
    await openFile(saved.name, saved.bytes instanceof Uint8Array ? saved.bytes : new Uint8Array(saved.bytes), session || { setup: null });
  }
  // opened from the calendar's "Print done" alert
  const q = new URLSearchParams(location.search);
  if (q.has('done')) {
    history.replaceState(null, '', location.pathname + location.hash);
    if (mode === 'run') openFinishDialog();
    else if (mode !== 'done') toast('No print is running here. Started it from your home-screen app? Open printsim there.', 5000);
  } else maybeAskFinish();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// Handy for debugging from the console: __printsim.skip(600) jumps 10 min ahead.
// __printsim.recSeconds = 2 makes "Save as video" record a 2 s timelapse (tests).
window.__printsim = {
  recSeconds: 0,
  skip(sec) { if (run) { run.anchorWall -= sec * 1000; if (run.startedWall) run.startedWall -= sec * 1000; if (run.extrudeWall) run.extrudeWall -= sec * 1000; lastUi = 0; saveSession(); } },
  get timeline() { return tl; },
  get run() { return run; },
  get recording() { return !!rec; },
  get view() { return view; },
  get support() { return parsed && { ...parsed.support, material: parsed.activeMaterial }; },
};

init();
