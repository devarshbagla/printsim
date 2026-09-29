# Verification log

Every assumption printsim makes, what it was checked against, and what changed.
Primary sources were read directly; web sources are linked. Checked 2026-09-28.

Sources:
- **FW**: [Prusa-Firmware-Buddy](https://github.com/prusa3d/Prusa-Firmware-Buddy) @ `1ce23f33` (Aug 2026)
- **PS**: [PrusaSlicer](https://github.com/prusa3d/PrusaSlicer) @ `30ef591` (Sep 2026), `src/libpgcode`, `GCode/PostProcessor.cpp`
- **PROF**: [PrusaSlicer-settings-prusa-fff](https://github.com/prusa3d/PrusaSlicer-settings-prusa-fff) `PrusaResearch/2.5.10.ini`
- **LIB**: [libbgcode](https://github.com/prusa3d/libbgcode) (reference .bgcode decoder + MINI test files)

## Corrected (these were wrong)

| Claim | Was | Now | Source |
|---|---|---|---|
| Mesh leveling points | 6×6 = 36 | **4×4 = 16** (`GRID_BORDER 1`: outer ring never probed) | FW `Configuration_MINI.h`, `ubl_G29.cpp`; [Prusa KB: "The grid density is 4x4"](https://help.prusa3d.com/article/mesh-bed-leveling_112163) |
| Full mesh time | 80 s guess, then 59 s | **~26 s**, exact replay of `probe_major_points` (snake order, reachability, `C` = skip probed) | FW `ubl_G29.cpp` |
| Bare `G29` | "full mesh", guessed | runs `G29 P1 X0 Y0` = print area grown by one grid step (whole bed without `M555`) | FW `ubl_G29.cpp` |
| Cornering: new move's entry speed | scaled to the slower move | **not scaled** (firmware only scales the previous move's exit) | FW `planner.cpp` classic jerk |
| Cornering: safe-speed override | missing | if both moves' safe speeds exceed the junction limit, use the safe speed | FW `planner.cpp` |
| Extruder in cornering | ignored | **E is a 4th jerk axis** (10 mm/s), retractions planned like other moves | FW `planner.cpp` (`LOOP_XYZE`) |
| Speed before a real stop | jerk-limited "safe speed" | **~0** (`MINIMUM_PLANNER_SPEED` 0.05 mm/s) | FW `planner.cpp` |
| Temperature commands | stopped motion | `M104`/`M140` don't flush the planner; waits/dwells/homing/probing do | FW |
| `G4` dwell | counted inside the slicer's estimate | **not** in PrusaSlicer's estimate (only G0–G3 are timed) | PS `ProcessorImpl.cpp` dispatch |
| Arc segments | fixed 0.8 mm, then my own chord rule | firmware formula `clamp(min(√(8·r·0.02), F/50), 0.1, 2.0)` | FW `G2_G3.cpp` |
| File limits | used as written | **clamped to hardware caps** (normal 400 mm/s, 7000 mm/s², jerk 10; stealth 180 / 2500 / 8) | FW `Planner::apply_settings` |
| Hotend warm-up | 99 s to 215 °C | ~70 s (40 W into ~11 J/K) | [Prusa part: 24V 40W](https://www.prusa3d.com/product/hotend-heater-cartridge-24v-40w-mini/); [KB #12202: 12.3–15.1 Ω](https://help.prusa3d.com/article/preheat-error-print-head-12202-mini_154797) |
| Hotend cool 215→170 | 22 s | ~40 s | same heat balance |
| Heater settle | 6 s / 2 s | 1 s nozzle / 5 s bed | FW `TEMP_RESIDENCY_TIME`, `TEMP_BED_RESIDENCY_TIME` |
| Printer model depth | ~365 mm | 330 mm | [Prusa spec: 380×330×380 mm](https://www.prusa3d.com/product/original-prusa-mini-semi-assembled-3d-printer-enclosure-bundle-5/) |
| Material fan scale | 100 % fan = "fully cooled" for every material | each material judged against **its own** Prusa default fan (PLA 100, PETG 50, ASA 20, ABS 15, PC 20, PA 20, FLEX 50 %) | PROF filament profiles |
| Nylon "too hot" threshold | 275 °C | 290 °C (Prusament PA11 CF profile prints at 285) | PROF |
| TPU "too hot" threshold | 235 °C | 245 °C (FLEX profile prints at 240) | PROF |
| Print speed knob | not modelled | **Print speed %** setting; firmware divides remaining time by it and it persists between prints until restart | FW `marlin_server.cpp`; [forum: estimates doubled after a speed change carried over](https://forum.prusa3d.com/forum/prusaslicer/issue-between-slicer-and-printer-time-estimates/) |
| `M220` in files | ignored | scales feedrate like the firmware | FW |
| Falling filament: where it lands | whole move judged at its midpoint, all or nothing | judged every 0.4 mm; held, sagging and falling parts of one line are split, each end lands on whatever is under it | code review (Cursor/Grok), confirmed with `test/physics-geometry-test.mjs` |
| Falling animation | strands rose ~0.7 mm before dropping, split pieces tore apart | no upward lift; each piece falls from its own end times, joints shared so lines bend instead of tearing | same review, confirmed on screen |
| Bridge detection | any run with anchors at both ends (a U-turn counted as a bridge) | only near-straight runs; sparse infill gets a looser test | same review |
| Heat and short layers | only weakened overhang angle | also weaken cantilever and bridge length; layers under ~8 s get less time to cool | same review |
| Print-in-place gaps | a strand with nothing directly under it fell, even with the part below only 0.5 mm away, and everything above cascaded (YAFIC infinity cube: 7.6 % false alarm) | a strand within **0.8 mm** of held plastic or the bed sags onto it and holds (hinge knuckles, support gaps); YAFIC now 0.00 % | user's print file; `test/physics-geometry-test.mjs` |
| Hinges past an edge | stamped as solid support | stamped 1.5 layers low so overhangs can't creep outward layer by layer | own test (line on a pad) |

Net effect on the motion model vs PrusaSlicer (before M73 anchoring): laptop stand −0.1 %, Cessna 55 m −0.5 %, Cessna 30 m −0.5 %, cube −0.5 %, PS 2.8.1 cube 0.0 %. Previously +0.3 % to +2.6 %.

## Confirmed (already right)

| Claim | Source |
|---|---|
| .bgcode decode is byte-identical to Prusa's reference | LIB test files |
| MINI screen % comes from `M73 P` (stealth: `Q`), falling back to file position only if no M73 for 5 min | FW `marlin_server.cpp`, `M73_PE.h` |
| `M73 P` = floor(100·elapsed/total), written before the move where it changes; `R` = whole minutes | PS `PostProcessor.cpp` |
| PrusaSlicer's estimate excludes heating (`M109` only records the temp), homing (`G28` = move to 0,0,0) and probing (`G29` ignored) | PS `ProcessorImpl.cpp` |
| PrusaSlicer uses classic jerk, matching MINI firmware (its big misses are on junction-deviation printers) | FW; [PrusaSlicer #11672](https://github.com/prusa3d/PrusaSlicer/issues/11672) |
| `M109 S` waits only while heating, `R` waits both ways (same for `M190`) | FW `M104_M109.cpp`, `M140_M190.cpp` |
| Stealth mode exists on the MINI (Settings and Tune menus) | FW `screen_menu_settings.hpp`, `screen_menu_tune.hpp` |
| MINI profiles write both normal (`P/R`) and stealth (`Q/S`) progress | PROF `silent_mode = 1` |
| MINI is 32-bit, sensorless homing (TMC2209), 180×180×180 mm, 280 °C nozzle / 100 °C bed | [Prusa spec](https://www.prusa3d.com/product/original-prusa-mini-semi-assembled-3d-printer-enclosure-bundle-5/), [Wikipedia](https://en.wikipedia.org/wiki/Prusa_Mini) |
| Heatbed ~105 W (4.5–6.5 Ω at 24 V) → bed model within ~10 % of heat-balance estimate | [KB #12201](https://help.prusa3d.com/article/preheat-error-bed-12201-mini_112444) |
| Preheat-error thresholds (2 °C / 20 s nozzle, 2 °C / 240 s bed) match firmware | FW `WATCH_*`; KB #12201 / #12202 |
| PETG bridges/overhangs worse than PLA, ~half fan | [Prusa KB: PETG](https://help.prusa3d.com/article/petg_2059) |
| Quality overhang limits PLA 55–60°, PETG 45–50°, ABS 40–45° (failure limits used by printsim sit above these) | [3DMag](https://www.3dmag.com/3d-wikipedia/3d-printing-overhang-support-angles-materials/); Bambu PLA 55° / 30 mm via [3dx.info](https://3dx.info/material-specific-overhang-strategies-optimizing-angles-for-pla-petg-and-abs/) |
| Safari deletes script-written storage after 7 days of use without interaction | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) |
| `navigator.storage.persist()` granted by heuristics, favouring Home Screen web apps (Safari 17+) | [WebKit: Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/) |
| Home Screen web apps don't share storage with Safari (by design) | [WebKit bug 181849](https://bugs.webkit.org/show_bug.cgi?id=181849) |
| Wake Lock: Safari 16.4; works in Home Screen apps from iOS 18.4 | [Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/), [18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/) |
| Module workers (Safari 15), DecompressionStream (Safari 16.4) | [Safari 15](https://webkit.org/blog/11989/new-webkit-features-in-safari-15/), [16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/) |
| GitHub Free: Pages in public repositories | [GitHub Docs](https://docs.github.com/get-started/learning-about-github/githubs-products) |
| Touch: one finger rotates, two fingers pinch/pan | three.js OrbitControls r170 source |

## Still estimates (no public data)

- **Heater warm-up curves**: sized from real wattages plus estimated heat capacities; corrected at runtime by *It's extruding now* and per-printer calibration.
- **Homing time (~20 s)**: sensorless homing retries (`PRECISE_HOMING_TRIES 15`) and the starting Z height vary.
- **Per-probe overhead**: probe settle time isn't in the firmware config; 0.15 s assumed.
- **Falling physics** is a rule-based check, not a rigid-body sim: strands fall straight down with a small seeded curl and pile where they land. Good enough to show *where* and *when* a print fails.
- **Catch distance (0.8 mm)**: print-in-place clearances of 0.3 to 0.5 mm and support gaps of 0.1 to 0.3 mm print fine in practice; where it stops working is fuzzy.
- **Material failure limits**: set above published quality limits; no systematic failure data exists. Real failed prints are the way to tune them.
