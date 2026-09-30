// Parses a .gcode / .bgcode file off the main thread, then runs the
// support/physics pass for the filament the file was sliced for.
import { isBgcode, decodeBgcode } from './bgcode.js';
import { parseGcode, parseDuration } from './gcode.js';
import { simulatePhysics } from './physics.js';
import { detectMaterial, nozzleTemp, MATERIALS } from './materials.js';

function buffersOf(obj, out = new Set()) {
  if (!obj || typeof obj !== 'object') return out;
  if (ArrayBuffer.isView(obj)) { out.add(obj.buffer); return out; }
  for (const v of Object.values(obj)) buffersOf(v, out);
  return out;
}

self.onmessage = async (ev) => {
  if (ev.data.type === 'physics') return rerunPhysics(ev.data);
  const { id, bytes, material } = ev.data;
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
    // the filament the user picked last time (reopening the app), else the file's
    result.activeMaterial = MATERIALS[material] ? material : result.material;
    simulatePhysics(result, result.activeMaterial, result.nozzleTemp);
    result.binary = binary;
    result.gcodeBytes = gcode.length;
    self.postMessage({ id, type: 'done', result }, [...buffersOf(result)]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

// The support check again for another filament, off the main thread (it takes
// seconds on a million-strand print). The page sends its untouched raw strands.
function rerunPhysics(d) {
  try {
    const r = {
      rawSegs: d.rawSegs, rawLayerSeg: d.rawLayerSeg,
      layers: { z: d.layerZ, seg: d.rawLayerSeg.slice() },
      moves: { raw: d.movesRaw }, meta: { config: d.config },
    };
    simulatePhysics(r, d.material, d.temp);
    const result = { segs: r.segs, layerSeg: r.layers.seg, support: r.support };
    self.postMessage({ id: d.id, type: 'done', result }, [...buffersOf({ segs: result.segs, layerSeg: result.layerSeg })]);
  } catch (err) {
    self.postMessage({ id: d.id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
}
