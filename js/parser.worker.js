// Parses a .gcode / .bgcode file off the main thread.
import { isBgcode, decodeBgcode } from './bgcode.js';
import { parseGcode, parseDuration, transferList } from './gcode.js';
import { analyzeSupport, splitFallingSegments } from './physics.js';

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
      onProgress: (f) => self.postMessage({ id, type: 'progress', stage: 'Reading moves', value: f }),
    });
    if (bgMeta) {
      // bgcode metadata blocks take priority over comment config
      Object.assign(result.meta.config, bgMeta.slicer, bgMeta.print, bgMeta.printer, bgMeta.file);
      const est = bgMeta.print['estimated printing time (normal mode)'];
      if (est) result.meta.slicerEstimate = parseDuration(est) ?? result.meta.slicerEstimate;
      result.thumbs.push(...bgThumbs.filter(t => t.format === 'png' || t.format === 'jpg'));
    }
    self.postMessage({ id, type: 'progress', stage: 'Checking for overhangs', value: 1 });
    const { drop, summary } = analyzeSupport(result);
    result.support = summary;
    splitFallingSegments(result, drop);
    result.binary = binary;
    result.gcodeBytes = gcode.length;
    self.postMessage({ id, type: 'done', result }, [...transferList(result), result.segs.drop.buffer, result.segs.frac.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
