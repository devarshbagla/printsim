# Tests

Node checks for the decoder, parser and time model. They need Prusa's
reference files from https://github.com/prusa3d/libbgcode (`tests/data`):

```
git clone --depth 1 https://github.com/prusa3d/libbgcode /tmp/libbgcode
node test/decode-test.mjs   /tmp/libbgcode/tests/data   # .bgcode -> text, compared byte-for-byte with Prusa's reference
node test/parse-test.mjs    /tmp/libbgcode/tests/data   # moves, layers, our time estimate vs PrusaSlicer's
node test/timeline-test.mjs /tmp/libbgcode/tests/data   # warm-up model, resync by %
node test/physics-test.mjs samples/*.gcode test/bridge.gcode /tmp/libbgcode/tests/data/*.bgcode
# support check: mushroom must fail from its cap up, everything else 0%
node test/physics-geometry-test.mjs
# geometry: a 26 mm bridge holds and sags a little, the mushroom cap over the stem holds
# while its rim falls, a line hanging 70% off a pad hinges ~2 mm past the edge then drops,
# and a part printed 0.5 mm over another (print-in-place gap) lands on it instead of falling
```
