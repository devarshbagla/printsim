# printsim

**The fanciest loading bar for your 3D prints.**

Load the `.bgcode` or `.gcode` you sent to the printer, tap **Start** the moment you press print, and watch a live 3D simulation of it building, layer by layer, on your phone, tablet or laptop. Walk away from the printer and still know roughly where it's at.

It's a simulation, not a camera. If the real print fails, printsim will happily keep printing a perfect virtual one.

## Features

- **Reads Prusa binary G-code (`.bgcode`)** natively (Heatshrink + MeatPack decoding, written from the format spec and verified byte-for-byte against Prusa's reference decoder), plus plain `.gcode`.
- **Live 3D view** of every extrusion, with the unprinted part shown as a ghost, a nozzle marker, and freshly laid plastic glowing warm.
- **Filament colour** picker so the model matches what's actually on the spool. The UI accent follows it.
- **Colour by feature** (perimeters, infill, supports...) to see *how* a print is built.
- **Timelapse preview** before you print: play the whole thing at 10×, 50×, 200× or 1000×, or **layer by layer** like a printer camera timelapse.
- **The printer, printing**: a MINI-layout printer model (single Z column, gantry, hotend, sliding bed with a textured sheet, live front screen, Bowden tube) that moves exactly like a bed-slinger: the bed carries your print back and forth in Y, the head runs in X, the gantry climbs in Z. Rotate, pan, zoom. Toggle it off for a close-up of just the print.
- **Material-aware physics**: filament type is read from the file (PLA, PETG, ABS, ASA, PC, nylon, TPU, PVA) and can be overridden. PLA gets special treatment: its overhang and bridge limits follow the part-cooling fan speed at every moment of the print (from `M106`/`M107`), and printing it too hot costs you. Bridges that hold still sag a bit, more for PETG and TPU.
- **"Forgot supports?" physics**: printsim rebuilds what's under every strand. Parts printed in mid-air get flagged before you print, and in the sim they droop, fall and pile up as spaghetti (and so does everything printed on top of them). Try the *"one that forgot its supports"* sample.
- **Realistic timing**
  - Motion time is anchored to the slicer's own `M73` progress markers, so the % on screen matches the % on the printer.
  - Warm-up is simulated from the temps you type in (nozzle + bed heating, homing, mesh bed leveling).
  - **"It's extruding now"** button: tap when the purge line starts to cancel out all warm-up guesswork.
  - **Resync**: type the % shown on the printer and the sim jumps to exactly that spot in the file.
  - **Learns your printer**: tap "Printer finished" at the end and future estimates for that printer get calibrated.
- **Filament changes (`M600`)** auto-pause the sim. Tap Resume when the printer carries on.
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
samples/              demo files (tools/make_sample.py, tools/make_overhang_tests.py)
vendor/               three.js r170 + OrbitControls, RoomEnvironment, RoundedBoxGeometry (MIT)
```

## Roadmap

- v2: a virtual printer in the scene doing the printing
- More printer profiles (MK4/MK4S, Core One, Bambu), `.gcode.3mf`
- Hand off a running print from laptop to phone
- Optional network sync for printers that expose one (PrusaLink, Moonraker, OctoPrint)

## License

MIT © Devarsh Bagla. three.js is MIT licensed (see `vendor/THREE_LICENSE`).
