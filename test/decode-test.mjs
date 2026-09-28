import { readFileSync } from 'node:fs';
import { decodeBgcode } from '../js/bgcode.js';
const dir = process.argv[2];
for (const name of ['mini_cube_b', 'mini_cube_ps2.8.1']) {
  const bytes = new Uint8Array(readFileSync(`${dir}/${name}.bgcode`));
  const t0 = performance.now();
  const { gcode, metadata, thumbnails } = await decodeBgcode(bytes);
  const ms = (performance.now() - t0).toFixed(1);
  const ref = readFileSync(`${dir}/${name}_ref.gcode`, 'utf8');
  const mine = new TextDecoder().decode(gcode);
  const idx = ref.indexOf(mine.slice(0, 200));
  const refBody = idx >= 0 ? ref.slice(idx, idx + mine.length) : '';
  let firstDiff = -1;
  for (let i = 0; i < mine.length; i++) if (mine[i] !== refBody[i]) { firstDiff = i; break; }
  console.log(name, `${ms}ms`, 'bytes', gcode.length, 'bodyStartInRef', idx, 'identical', mine === refBody, 'firstDiff', firstDiff);
  if (firstDiff >= 0) console.log('MINE:', JSON.stringify(mine.slice(firstDiff - 80, firstDiff + 80)), '\nREF :', JSON.stringify(refBody.slice(firstDiff - 80, firstDiff + 80)));
  console.log('  printer:', JSON.stringify(metadata.printer).slice(0, 300));
  console.log('  print:', JSON.stringify(metadata.print).slice(0, 300));
  console.log('  slicer keys:', Object.keys(metadata.slicer).length, 'filament_colour', metadata.slicer.filament_colour, 'thumbs', thumbnails.map(t => `${t.format} ${t.width}x${t.height} ${t.data.length}B`).join(', '));
  console.log('  remaining ref after body:', JSON.stringify(ref.slice(idx + mine.length, idx + mine.length + 120)));
}
