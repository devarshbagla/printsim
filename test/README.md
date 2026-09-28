# Tests

Node checks for the decoder, parser and time model. They need Prusa's
reference files from https://github.com/prusa3d/libbgcode (`tests/data`):

```
git clone --depth 1 https://github.com/prusa3d/libbgcode /tmp/libbgcode
node test/decode-test.mjs   /tmp/libbgcode/tests/data   # .bgcode -> text, compared byte-for-byte with Prusa's reference
node test/parse-test.mjs    /tmp/libbgcode/tests/data   # moves, layers, our time estimate vs PrusaSlicer's
node test/timeline-test.mjs /tmp/libbgcode/tests/data   # warm-up model, resync by %
```
