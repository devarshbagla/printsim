// Printer profiles. Only affects things the G-code can't tell us:
// bed size for the scene, how fast heaters warm up, and how long
// homing / mesh bed probing take. Motion timing comes from the file itself.
//
// Heating uses a first-order model: dT/dt = k * (Tmax - T) while heating,
// dT/dt = -c * (T - ambient) while cooling. Tune k/c if your printer is
// consistently early/late during warm-up.

export const PRINTERS = {
  'prusa-mini': {
    id: 'prusa-mini',
    name: 'Prusa MINI / MINI+',
    models: ['MINI', 'MINIIS'],
    bed: { w: 180, d: 180 },
    nozzle: { max: 320, k: 0.0105, c: 0.012, settle: 6 },
    bedHeat: { max: 125, k: 0.0036, c: 0.0022, settle: 2 },
    homeSeconds: 18,
    probeFullSeconds: 80,  // G29 (4x4 mesh)
    probeAreaSeconds: 55,  // G29 P1 (print area)
    probeSmallSeconds: 15, // G29 P1 with W/H (e.g. near purge line)
  },
  generic: {
    id: 'generic',
    name: 'Other / generic printer',
    models: [],
    bed: { w: 220, d: 220 },
    nozzle: { max: 320, k: 0.012, c: 0.012, settle: 6 },
    bedHeat: { max: 130, k: 0.004, c: 0.002, settle: 2 },
    homeSeconds: 20,
    probeFullSeconds: 90,
    probeAreaSeconds: 60,
    probeSmallSeconds: 15,
  },
};

export const AMBIENT = 22;

export function guessPrinter(config) {
  const model = (config.printer_model || '').trim().toUpperCase();
  for (const p of Object.values(PRINTERS)) if (p.models.includes(model)) return p.id;
  return model ? 'generic' : 'prusa-mini';
}
