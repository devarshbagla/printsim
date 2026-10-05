# printsim

**The fanciest loading bar for your 3D prints.**

Load the `.bgcode` or `.gcode` you sent to the printer, tap **Start** the moment you press print, and watch a live 3D simulation of it building, layer by layer, on your phone, tablet or laptop. Walk away from the printer and still know roughly where it's at.

It's a simulation, not a camera. If the real print fails, printsim will happily keep printing a perfect virtual one.

## Features

- **Reads Prusa binary G-code (`.bgcode`)** natively (Heatshrink + MeatPack decoding, written from the format spec and verified byte-for-byte against Prusa's reference decoder), plus plain `.gcode`.
- **Live 3D view** of every extrusion, with a nozzle marker and freshly laid plastic glowing warm. The unprinted rest of the model can be shown as a see-through ghost (on while previewing, off by default during a live print; laptops get a one-time tip next to the button).
- **Filament colour** picker so the model matches what's actually on the spool. The UI accent follows it.
- **Colour by feature** (perimeters, infill, supports...) to see *how* a print is built.
- **Timelapse preview** before you print: play the whole thing at 10×, 50×, 200× or 1000×, or **layer by layer** like a printer camera timelapse.
- **The printer, printing**: a MINI-layout printer laid out from Prusa's open-source part drawings (30×30 extrusions, Z rods and leadscrew in one row, extruder riding the Z carriage, a 275 mm Bowden tube that loops as the head moves, probe beside the nozzle, 190×200 sheet, the spool behind it in your filament colour, live front screen). It moves exactly like a bed-slinger: the bed carries your print back and forth in Y, the head runs in X, the gantry climbs in Z. Rotate, pan, zoom. Toggle it off for a close-up of just the print.
- **Plastic that looks like plastic**: every line is drawn with its real cross-section (line width × layer height, flat on top, round at the sides), so walls show their layer lines up close and highlights slide across them as you orbit. Far away, where layers are thinner than a pixel, they shade as the smooth surface they form instead of shimmering. PETG reads glossier than PLA, and silk and matte filaments are picked up from the profile name.
- **Material-aware physics**: filament type is read from the file (PLA, PETG, ABS, ASA, PC, nylon, TPU, PVA) and can be overridden. PLA gets special treatment: its overhang and bridge limits follow the part-cooling fan speed at every moment of the print (from `M106`/`M107`), and printing it too hot costs you. Bridges that hold still sag a bit, more for PETG and TPU.
- **"Forgot supports?" physics**: printsim rebuilds what's under every strand. Parts printed in mid-air get flagged before you print, with when it goes wrong ("about 4m 08s in, layer 61"), how much plastic that costs, how many parts start printing in mid-air, and why the slicer didn't support them (supports off, or on but only where painted), and in the sim they droop, fall and pile up as spaghetti (and so does everything printed on top of them). How they fall depends on how hot they still are (fan, nozzle temperature and strand size set how fast they cool): soft plastic oozes down and slumps, cooled plastic snaps off and curls. Some loose strands ball up on the nozzle instead, get dragged along and wiped off onto another part of the print, like a real blob of doom (PETG does this far more than PLA). Try the *"one that forgot its supports"* sample.
- **Save as video**: records the whole print as a ~12 second timelapse with a slow orbit, a caption and a progress bar, then share or save it (MP4 where the browser can, WebM otherwise).
- **Remind me**: adds the finish time and any filament swaps to your calendar with alerts, so your phone buzzes with printsim closed (Apple Calendar / Outlook via `.ics`, Google Calendar via its add-event link).
- **Realistic timing**
  - Motion time is anchored to the slicer's own `M73` progress markers, so the % on screen matches the % on the printer.
  - Warm-up is simulated from the temps you type in. Nozzle and bed heat at the same time, then homing and mesh probing. The "Now" line uses the MINI's own words: Waiting for hotend, Waiting for bed, Homing, Probing 4/16.
  - **"It's extruding now"** button: tap when the purge line starts to cancel out all warm-up guesswork.
  - **Resync**: type the % shown on the printer and the sim jumps to exactly that spot in the file.
  - **Learns your printer**: tap "Printer finished" at the end and future estimates for that printer get calibrated. Name the lab's printers ("Which one?") and each one learns its own speed.
- **Filament changes (`M600`)** auto-pause the sim. Tap Resume when the printer carries on.
- **Filament runout prediction**: type how many grams are left on the spool and printsim warns if it'll run out mid-print, then auto-pauses at that moment so you can load a new spool (same as the MINI+ filament sensor).
- **Survives closing the tab**: the file and clock are stored locally, and time is computed from timestamps, so reopening puts you exactly where the print should be.
- **Private**: runs 100% in the browser. Files never leave your device. No server, no account.
- Installable as a home-screen app, works offline, optional keep-screen-on.

Currently tuned for the **Prusa MINI / MINI+**. Other printers work with generic warm-up timing.

## Run locally

It's a static site, no build step.

```
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

GitHub Pages: Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.

## How the timing works

1. The parser walks every move and estimates its duration with a trapezoidal acceleration model using the file's own `M201/M203/M204` limits (lands within ~0.5% of PrusaSlicer's estimate on test files).
2. That estimate is stretched piecewise between the slicer's `M73 P` markers, so it follows the slicer's much more detailed planner.
3. Startup commands (`M109`, `M190`, `G28`, `G29`) get real durations from a first-order heater model in `js/printers.js`.
4. A per-printer correction factor, learned from finished prints, scales motion time.

## Where the numbers come from

Slicer limits are only half the story: the printer's firmware clamps whatever the file asks for to its own hardware limits and plans motion its own way. For the Prusa MINI, printsim uses the real values from Prusa's open-source firmware ([Prusa-Firmware-Buddy](https://github.com/prusa3d/Prusa-Firmware-Buddy) @ `1ce23f33`, `include/marlin/Configuration_MINI*.h`, `lib/Marlin/.../planner.cpp`, `G2_G3.cpp`) and PrusaSlicer's printer profiles ([PrusaSlicer-settings-prusa-fff](https://github.com/prusa3d/PrusaSlicer-settings-prusa-fff) `PrusaResearch/2.5.10.ini`).

| What | Value (MINI) | Source |
|---|---|---|
| Hardware caps on `M203` feedrate | 400 / 400 / 12 / 80 mm/s (stealth: 180) | `HWLIMIT_NORMAL/STEALTH_MAX_FEEDRATE`, applied in `Planner::apply_settings` |
| Hardware caps on `M201` accel | 7000 / 7000 / 400 / 5000 mm/s² (stealth: 2500) | `HWLIMIT_*_MAX_ACCELERATION` |
| Cornering | classic jerk on X/Y/Z/E, 8 / 8 / 2 / 10 mm/s (cap 10), exact `planner.cpp` junction + safe-speed logic | `CLASSIC_JERK`, `DEFAULT_*JERK`, `HWLIMIT_*_JERK` |
| Arc splitting (`G2`/`G3`) | `clamp(min(√(8·r·0.02), F/50), 0.1, 2.0)` mm | `G2_G3.cpp`, `MAX_ARC_DEVIATION`, `MIN_ARC_SEGMENTS_PER_SEC` |
| Look-ahead | backward + forward pass over junction limits, trapezoid per move | Marlin planner |
| Mesh bed leveling | UBL 6×6 grid with a 1-point border → inner 4×4 = 16 points, 2 samples each, 83 mm/s travel, Z 6 / 2 mm/s; replayed point by point | `GRID_MAX_POINTS_*`, `GRID_BORDER`, `MESH_MIN/MAX_*`, `MULTIPLE_PROBING`, `ubl_G29.cpp` |
| Homing | XY 50 mm/s, Z via probe at (147.4, 21.1), 2 mm re-bump at 1.5 mm/s | `HOMING_FEEDRATE_*`, `Z_SAFE_HOMING_*`, `HOMING_BUMP_DIVISOR` |
| Heater settle | nozzle 1 s, bed 5 s | `TEMP_RESIDENCY_TIME`, `TEMP_BED_RESIDENCY_TIME` |
| Heater power | hotend 40 W, bed ~105 W | Prusa parts + KB resistance specs |
| Print speed knob | remaining time × 100 / speed %, persists between prints | `marlin_server.cpp` |
| Slicer limits written to the file | MINI: 2000 print / 2500 travel accel, 180 mm/s; MINIIS: 4000, 400 mm/s | `machine_max_*` (`machine_limits_usage = emit_to_gcode`) |
| Stealth-mode progress | files carry `M73 Q/S` alongside `M73 P/R` | `silent_mode = 1` |

Not published anywhere: how fast the MINI's heaters warm up. Those stay estimates (first-order model in `js/printers.js`) and get corrected by the *It's extruding now* button and per-printer calibration. Z-homing time also depends on how high the nozzle was parked, so it's an average.

Result: printsim's own motion estimate lands within 0.5% of PrusaSlicer's on every test file *before* it's anchored to the slicer's `M73` markers, so the in-between motion (which layer, where the head is) tracks the real planner closely. It's not accurate to the second and doesn't need to be.

Every claim, its source, and what got corrected along the way: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## How the support check works

Walking the layers bottom-up, printsim keeps a height map of every strand that actually stayed put and checks each new strand for material right below it (allowing normal overhangs up to roughly 65-70° at 0.2 mm layers). An unsupported stretch that's anchored on both ends and roughly straight is a bridge and prints fine; short overhangs are fine; anything cantilevered, U-turning or floating falls. Fallen strands never count as support, so failures cascade upward like real spaghetti. Limits depend on the filament and, for PLA, the fan speed on each strand; strands pressed against a supported neighbour in the same layer count as supported (once, so overhangs can't creep outward), and the slicer's elephant-foot compensation is accounted for on layer 2. It's a heuristic, not FEA: no false alarms on any real test print so far, but treat it as a warning, not a guarantee.

## Project layout

```
index.html            UI shell
css/style.css
js/app.js             state, UI, clock
js/bgcode.js          .bgcode container + Heatshrink + MeatPack
js/gcode.js           G-code parser (moves, layers, features, M73 anchors)
js/timeline.js        time model, lookups, resync
js/renderer.js        three.js scene, instanced tube shader
js/printers.js        printer profiles (bed size, heating, probing)
js/physics.js         support analysis, bridge sag, splitting falling strands
js/materials.js       filament profiles (PLA focus) + detection
js/printer3d.js       the printer model and its kinematics
js/store.js           IndexedDB session + calibration
js/parser.worker.js   parsing off the main thread
js/report.js          spaghetti report: when it fails, grams at stake
js/ics.js             calendar reminders (.ics + Google link)
js/recorder.js        timelapse video export (MediaRecorder)
test/                 Node checks (ci-check.mjs is the CI gate) + Playwright e2e
samples/              demo files (tools/make_sample.py, tools/make_overhang_tests.py)
vendor/               three.js r170 + OrbitControls, RoomEnvironment, RoundedBoxGeometry (MIT)
```

## Roadmap

- More printer profiles (MK4/MK4S, Core One, Bambu), `.gcode.3mf`
- Hand off a running print from laptop to phone
- Optional network sync for printers that expose one (PrusaLink, Moonraker, OctoPrint)

## License

MIT © Devarsh Bagla. three.js is MIT licensed (see `vendor/THREE_LICENSE`).
