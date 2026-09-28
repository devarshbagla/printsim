// Parses a .gcode / .bgcode file off the main thread, then runs the
// support/physics pass for the filament the file was sliced for.
import { isBgcode, decodeBgcode } from './bgcode.js';
import { parseGcode, parseDuration } from './gcode.js';
import { simulatePhysics } from './physics.js';
import { detectMaterial, nozzleTemp } from './materials.js';

function buffersOf(obj, out = new Set()) {
  if (!obj || typeof obj !== 'object') return out;
  if (ArrayBuffer.isView(obj)) { out.add(obj.buffer); return out; }
  for (const v of Object.values(obj)) buffersOf(v, out);
  return out;
}

self.onmessage = async (ev) => {
  const { id, bytes } = ev.data;
  try {
    const src = new Uint8Array(bytes);
    let gcode = src, bgMeta = null, bgThumbs = [];
    const binary = isBgcode(src);
    if (binary) {
      self.postMessage({ id, type: 'progress', stage: 'Decompressing', value: 0 });
      const dec = await decodeBgcode(src, (f) => self.postMessage({ id, type: 'progress', stage: 'Decompressing', value: f }));
      gcode = dec.gcode; bgMeta = dec.metadata; bgThumbs = dec.thumbnails;
    }
    const result = parseGcode(gcode, {
      printerModel: bgMeta ? bgMeta.printer.printer_model : undefined,
      onProgress: (f) => self.postMessage({ id, type: 'progress', stage: 'Reading moves', value: f }),
    });
    if (bgMeta) {
      // bgcode metadata blocks take priority over comment config
      Object.assign(result.meta.config, bgMeta.slicer, bgMeta.print, bgMeta.printer, bgMeta.file);
      const est = bgMeta.print['estimated printing time (normal mode)'];
      if (est) result.meta.slicerEstimate = parseDuration(est) ?? result.meta.slicerEstimate;
      const sil = bgMeta.print['estimated printing time (silent mode)'];
      if (sil) result.meta.silentEstimate = parseDuration(sil) ?? result.meta.silentEstimate;
      result.thumbs.push(...bgThumbs.filter(t => t.format === 'png' || t.format === 'jpg'));
    }
    self.postMessage({ id, type: 'progress', stage: 'Checking overhangs and bridges', value: 1 });
    result.rawSegs = result.segs;
    result.rawLayerSeg = result.layers.seg.slice();
    result.material = detectMaterial(result.meta.config);
    result.nozzleTemp = nozzleTemp(result.meta.config);
    simulatePhysics(result, result.material, result.nozzleTemp);
    result.binary = binary;
    result.gcodeBytes = gcode.length;
    self.postMessage({ id, type: 'done', result }, [...buffersOf(result)]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
