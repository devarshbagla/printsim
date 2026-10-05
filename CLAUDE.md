# printsim: project memory

Phone-first web app that simulates a Prusa 3D print live from its `.bgcode` / `.gcode`.
The user taps Start when the real printer starts; a 3D printer on screen prints the part
in real time with % done, time left and ETA. Built for the Prusa MINI / MINI+ printers at
Brandeis, which are **not networked**, so this is a timed simulation with manual resync
(type the % from the printer screen), never a live feed.

- Owner: Devarsh Bagla. Repo `devarshbagla/printsim` (public, MIT). Live: https://devarshbagla.github.io/printsim/
- Deploy = push to `main` (GitHub Pages, main / root). Live in about a minute.
- Full handoff doc (history, decisions, baselines): https://claude.ai/code/artifact/108e1277-5aa0-43a5-bc47-4df9476711e1
- Deeper references in the repo: `README.md`, `docs/VERIFICATION.md` (every number + its source), `test/README.md`.
- CI (`.github/workflows/tests.yml`) runs on every push to `main`: a Node job (`test/ci-check.mjs` gate + physics geometry, libbgcode pinned to `d4da907`) and a browser job (`test/e2e/e2e.py`, Playwright). Check it's green after pushing.

## Working with Devarsh Bagla

- Blunt, frank, Gen-Z tone. Call him out when he's wrong; no yes-man answers.
- **No em dashes anywhere**: code comments, docs, UI copy, commit messages.
- He often sends several asks at once, from his phone. Do them all, then report plainly what was done and what was skipped and why.
- When he brings a review from another agent (Cursor/Grok etc.), verify each claim with a test and implement the valid parts yourself. Don't have two agents editing the same files.
- "Doesn't need to be accurate to the second." "Forget about old devices." Accuracy should still trace to Prusa's own firmware/slicer numbers.

## Hard rules

- No build step: plain ES modules, three.js r170 vendored in `vendor/`, import map in `index.html`. Keep it that way.
- Everything runs in the browser. User files never leave the device.
- **Bump `CACHE` in `sw.js`** (`printsim-vN`, currently `printsim-v20`) on every release, and add any new `js/` module to its precache list (CI fails otherwise; a missing module breaks offline boot).
- File-derived text (file names, config values) goes in via `textContent`, never `innerHTML`.
- The 3D printer is MINI-*style*, not a replica: no Prusa logos, wordmark or signature orange. Layout, sizes and motion follow Prusa's open-source part drawings ([Original-Prusa-MINI](https://github.com/prusa3d/Original-Prusa-MINI)): 30x30x289 Z extrusion, two 262 mm Y extrusions, extruder rides the Z carriage, probe 29 mm left of the nozzle, 275 mm Bowden tube that loops (reshaped in place each frame, never flatter than a 30 mm lift), 190x200 sheet, spool on a stand behind in the filament colour. Static parts merged per material (~44 draw calls).
- Timelapse speeds are 10x / 50x / 200x / 1000x + layer by layer (2x to 8x was rejected as useless).
- Ghost ("what's left to print") overlay: pref `ghost` (preview, default on) and `ghostRun` (live print, default **off**). The tip next to its button is laptop-only (min-width 900px, hover + fine pointer), shown max twice, gone once closed or the button is used. Never on phones.
- Physics is a rule-based height-map check, not a rigid-body sim. Declined: PBD solver, two-hop perimeter bonding, invented flow-rate factor.
- Live prints render at 30 fps, evenly paced (`view.maxFps`, full rate while dragging), head drawn exactly; previews run full rate and the drawn head follows the real one on a critically damped spring (`view.setMotionSmoothing`, `motionTau` in app.js: 0.04 s at 10x to 0.12 s at 1000x).
- Update `docs/VERIFICATION.md` whenever a number or assumption changes.

## Map

| File | Job |
| --- | --- |
| `js/parser.worker.js` | Worker: decode, parse, detect material, physics, post transferable buffers. Also re-runs physics for a filament switch (`type: 'physics'`) so the page never freezes; the first parse takes the remembered filament |
| `js/bgcode.js` | Prusa .bgcode decoder (Heatshrink, MeatPack, Deflate); byte-identical to libbgcode |
| `js/gcode.js` | Byte-level parser + Marlin/Buddy classic-jerk planner replica; `Ev` and `Feature` enums |
| `js/printers.js` | MINI + generic profiles, hardware caps, heater model, exact UBL probe replay (4x4 = 16 points) |
| `js/timeline.js` | Per-move times anchored to `M73 P` (stealth `Q`), warm-up/homing/probing prelude, `factor = calibration * 100 / speedPct`. `tempsAt` (both heaters), `remainingAt` (`M73 R`, minutes), `MINI_STATUS` (prelude wording) |
| `js/materials.js` | Filament limits per material, fan normalised to each material's own Prusa default fan; `limitsFor(mat, fan01, temp, cool)` |
| `js/physics.js` | Support check (`analyzeSupport`), `splitSegments` for falling animation, `simulatePhysics` |
| `js/renderer.js` | `PrintView`: one instanced strand mesh, `uHead` progress uniform, ghost pass, fall shader, camera fit |
| `js/printer3d.js` | `PrinterModel`: bed-slinger (head X, gantry Z, bed Y), Bowden tube, canvas screen |
| `js/app.js` | Modes empty/setup/run/done, preview player, run clock (timestamp based), resync, calibration, persistence, ghost tip. Debug: `window.__printsim` (`skip(sec)`, `view`, `support`, `recSeconds`) |
| `js/store.js` | IndexedDB (file + session) and localStorage (prefs, calibration, `printsim.ghostHint`). Named printers (`printsim.units`, "Which one?"): each has its own calibration (`printsim.calib.unit.<id>`) and every finish also teaches the model pool (`printsim.calib.<model>`), which a new printer uses until its first print (`effectiveCalibration`, `learnCalibration`). Runs store `calFactor` = calibration only; never feed `tl.factor`/`run.factor` (they include 100/speed%) back in as calibration (`runCal` in app.js handles old sessions) |
| `js/report.js` | Spaghetti report: when it fails (time + layer + %), grams at stake (net E from `moves.e`, matches PrusaSlicer within 0.4%), why no supports (off, or on but paint-only) |
| `js/spool.js` | Filament runout: `cumulativeGrams` (net E -> grams, scaled to stated), `runoutMove` (binary search), `spoolCheck` (need / left / tight) |
| `js/ics.js` | "Remind me": `.ics` with alarms for the finish and filament swaps + Google Calendar link; iOS gets a `data:text/calendar` URL; fresh UIDs per export |
| `js/finish.js` | "When did it finish?": `clockToWall` (time input -> wall, past midnight, before start = null), `expectedEndWall`, `measureRun` (pauses count only up to the finish). The prompt opens from the ETA banner, `?done=1` (calendar finish alert), "End print" past 90%, and on return >5 min after the ETA (once per ETA, `run.askedFor`) |
| `js/recorder.js` | "Save as video": ~12 s timelapse via MediaRecorder (MP4 where possible, else WebM), copied from WebGL in `renderer.onRendered`; Web Share or save |
| `css/style.css` | Bottom sheet on phones; side card at >=900px and on landscape phones (max-height 520px) |

## Physics constants that matter

- `CELL 0.15`, `SAMPLE 0.4`, `SAG_MIN 0.06`, `LINK_TOL 0.05`, `CATCH 0.8` (mm).
- Sample states: 1 vertical, 2 side-bonded (one hop), 3 hinge, 4 stub, 5 caught, 0 unsupported.
- Catch rule: a would-fall sample with held plastic or the bed within 0.8 mm below sags onto it and holds (print-in-place gaps). Fixed the YAFIC infinity cube false alarm (7.6% to 0.00%).
- Short spans: tied at both ends and <= 2.5 cantilever lengths holds whatever its shape (re-checked after the catch rule); floating strands <= 3 mm (`SHORT`) are decided at the end of their layer (held if they touch same-layer held plastic). YAFIC now has zero falling plastic.
- Hinges/stubs are stamped at `z - 1.5h - CATCH` so overhangs can't creep outward layer by layer. Don't undo this.
- Warning box shows only when failedFraction >= 0.2% and failedSegments >= 20. Under 5% failing gets a milder message.
- Parts that start in mid-air are counted separately (union-find over each layer's strands, merged up through layers).
- Fallen plastic conserves volume: the pile rises by exactly what lands; a fallen strand keeps the w x h cross-section area; a strand tied to a hinge hangs no lower than its length allows.
- A fall takes 0.7 s of **print** time for cold plastic, up to ~1.7 s for soft plastic, so faster playback falls faster. Heat = `softSeconds` (materials.js, Newton cooling by fan/temp/strand size) / 8 s, per piece as `segs.heat` -> `iHeat`: soft strands ooze down without bouncing, cold ones jut out, drop and curl hard; fresh plastic keeps a wet gloss for its soft time.
- Nozzle blobs: loose runs can stick to the nozzle (chance by material `stick` x heat x length), ride with the head (`uNozzle` = drawn head), get wiped onto the part after 5-60 mm of held printing or drop past 120 mm3. `segs.blob` (1 + blob id per piece), `segs.blobPiece`/`blobPos` -> `uBlobs` texture (rest xyz + radius, time off). Stuck plastic is not debris where it was laid; its volume lands with the blob. Separate RNG (`randB`) so blobs never move other debris.
- Strands render with their real cross-section (flat-topped stadium, w x h, half a layer under the nozzle); sub-pixel layers shade as the surface they form.

## Tests (run before and after every change)

```bash
git clone --depth 1 https://github.com/prusa3d/libbgcode <somewhere>/libbgcode
D=<somewhere>/libbgcode/tests/data
node test/decode-test.mjs $D
node test/parse-test.mjs $D
node test/timeline-test.mjs $D
node test/physics-test.mjs samples/*.gcode test/bridge.gcode $D/*.bgcode
MATS=PETG,ABS node test/physics-test.mjs test/bridge.gcode samples/mushroom-no-supports.gcode
node test/physics-geometry-test.mjs
node test/ci-check.mjs $D                 # the CI gate: asserts the invariants, exits nonzero
python test/e2e/e2e.py --shots /tmp/shots  # Playwright, phone + laptop, a few minutes
```

Expected: decode identical for `mini_cube_b`; motion estimate within 0.5% of PrusaSlicer;
every real print 0% fails; mushroom PLA ~52.9% from layer 61; bridge PLA 0% / PETG ~11% /
ABS ~17%; geometry test "all checks passed". (Mushroom PLA is 52.27% since the short-span rule.) Devarsh's real test files (laptop stand, two
Cessna kits, YAFIC cube on his Google Drive) are not in the repo; all were 0%. A later one, a
19h17m melting Switch stand (1.39M strands), correctly flags 8 parts starting in mid-air.

## Gotchas

- Serve over HTTP (`python3 -m http.server 8765`); the import map fails on `file://`.
- Headless Chromium (SwiftShader) runs ~1 fps: use DPR 1, small viewports, long timeouts. CSS transitions barely advance there, so `opacity: 0` on a visible element is a test artifact.
- In Node, load .bgcode as `decodeBgcode(bytes)` then `parseGcode(d.gcode)` and merge `d.metadata.slicer` + `d.metadata.printer` into `parsed.meta.config`.
- Debugging a physics flag: break failing samples down by layer and feature, then plot slices and a vertical cross-section (matplotlib). Found the YAFIC hinge gap that way.
- After a push, poll `https://devarshbagla.github.io/printsim/sw.js` for the new cache name to confirm deploy.

## Session log (latest first)

Each line is a pushed commit; CI was green and the deploy confirmed for every one.

- **v20** Real MINI prelude. Both heaters keep moving (`tempsAt`). Status words match the printer (`MINI_STATUS`: Waiting for hotend, Waiting for bed, Homing, Probing n/16). The head follows the 16-point mesh. `remainingAt` is the on-screen time left from `M73 R`. Probe overhead 0.15 s to 0.45 s from one lab print (2 Oct 2026), about 4.8 s on a 16-point mesh.
- **v19 `9330ead`** Calibration per physical printer. "Which one?" picker under Printer (Not sure / named printers / + Add a printer, bin button forgets one). Each named printer learns its own factor; every finish also teaches the model pool, used until a printer has its own print. **Bug fixed**: runs used to save `tl.factor` (calibration x 100/speed%), so at non-100% speed reopening mid-print applied the speed twice and an on-time 50% print saved x1.6 as calibration. Runs now store `calFactor`; `runCal()` converts old sessions.
- **v18 `89f969e`** (built by Cursor Auto from a prompt Claude wrote, then reviewed by Claude: clean) Filament runout prediction: "Filament left on the spool" field in setup, warning (runs out at time/%/layer, or "cutting it close"), auto-pause at the runout move like an M600 (`type: 'runout'` in `tl.pauses`), calendar event. MINI pauses and unloads on runout (Prusa-Firmware-Buddy issue #1279). Known weak test: "runoutMove(half)" computes its expected value the same way as the code.
- **v17 `c959059`** "When did it finish?" prompt (Just now / Earlier at [time], prefilled with the expected finish when >10 min late / It failed / Still printing). Opens from the ETA banner, the calendar finish alert (`?done=1`), "End print" past 90%, and on return >5 min after the ETA. Fixed: tapping "done" hours late used to record "now" and poison calibration. Placeholder em dashes in index.html removed. `__printsim.skip()` now saves the session.
- **v16 `ddd5d36`** Resync by the time left on the printer screen (`rAnchors` from M73 R, `timeForRemaining`). Finer than 1% steps on long prints. Undoes the MINI's speed scaling of R (assumption, from Prusa-Firmware-Buddy issue #708: on-screen time left changes with Tune > Speed; check once at the lab at non-100% speed). If time left and % disagree by >3%, it warns and uses the %.
- **v15 and earlier**: see the handoff doc and `git log`. Highlights: CI + Playwright e2e, calendar reminders, spaghetti report with grams and mid-air parts, video export, real strand shading, MINI model from Prusa drawings, volume-conserving falls, heat-aware falls, nozzle blobs, YAFIC false alarm fixed, filament switch in the worker, landing layout, smooth head motion, Bowden tube that never goes taut.

## Roadmap (agreed with Devarsh, Prusa MINI+ only, no new printers)

Done: #1 resync by time left, #3 per-printer calibration, #4 finish prompt, #5 runout.
Left, in Claude's recommended order:
- **#6 + #7 topple and warp warnings** (planned as the next Cursor task; self-contained rule checks): bed-slinger topple risk for tall parts with a small footprint (height vs first-layer footprint, suggest a brim); warp risk for large flat PETG/ABS/ASA parts on the open-frame MINI+.
- **#2 snap-to-resync**: point the phone at the printer screen, on-device OCR reads % and time left. Nothing leaves the phone.
- **#8 "risk" colour mode**: colour strands by physics state (held, sagging, hinged, falling). The shader already gets the data; touches renderer.js, so Claude, not Cursor.
- **#9 multi-printer dashboard** (several MINIs at once), **#10 laptop to phone handoff via QR** (start time, speed, file hash), **#11 status link** (ETA countdown URL, no server).
- Skip for now: more rendering realism (past diminishing returns).

## Working with Cursor

- Devarsh runs some tasks in Cursor (Auto model). Claude writes a very detailed prompt: read CLAUDE.md etc. first, exact files and function names, hard rules, tests to add, docs to update, and "do the git yourself": pull --rebase, commit, push to main, poll the GitHub Actions API until green (fix up to twice, then stop and report), poll live `sw.js` for the new cache name.
- Only one agent touches the repo at a time. When Cursor reports done, Claude pulls, reviews the diff, and reruns the Node gate before starting anything.
- Good Cursor tasks: self-contained, no physics/renderer/parser changes. Keep calibration/storage migrations and shader work for Claude.

## Test gotchas learned this session

- The session save (`saveSession`, IndexedDB) is async: wait ~1.5 s after an action before `page.reload()` in e2e, or the reload restores the previous session.
- After clicking OK in a dialog, wait for `!dialog.open` before reading the toast (headless runs ~1 fps).
- e2e is 102 checks, about 7 minutes; run it detached (`setsid nohup`) and poll its log, since a single command is capped at 10 minutes.

## Open items

- Waiting on Devarsh's real-device feedback: phone layout, landscape side card, landing, ghost tip on a laptop, calendar reminders on iOS, video export, the new finish prompt, named printers.
- **The real print vs sim timing test at the Brandeis lab still hasn't happened.** It's the most valuable thing left: start a print, tap Start, name the printer, and answer "When did it finish?".
- iOS: if printsim runs from the home screen, the calendar's `?done=1` link opens in Safari, which has separate storage; it shows a toast pointing back to the home-screen app.
- Don't print Devarsh's Nintendo/Switch stand as sliced: supports are paint-only with nothing painted, 8 drips start in mid-air.
- People: Tim **Hebert** (one r), Brandeis MakerLab / Automation Lab, embedded systems; a meeting about printsim was planned. The feature list prepared for it predates v6 to v19.
- Ideas, not requested: more printers (MK4/MK4S, Core One, Bambu), `.gcode.3mf`.
