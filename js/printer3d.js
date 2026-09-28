// A MINI-layout desktop printer built from primitives: single Z column on the
// right, a gantry carrying the X axis over the bed, and a bed that slides
// front-to-back (Y). Dimensions follow the real machine; no vendor branding.
//
// World units are mm, Y up. The print area is centred on the origin; the
// front of the printer faces +Z. Moving parts:
//   bed      -> translates along Z   (G-code Y)
//   gantry   -> translates along Y   (G-code Z)
//   head     -> translates along X   (G-code X), child of gantry

import * as THREE from 'three';
import { RoundedBoxGeometry } from '../vendor/RoundedBoxGeometry.js';

const COL = {
  printed: 0x343941,
  frame: 0x151619,
  chrome: 0xdfe3e8,
  alu: 0xb9bec5,
  brass: 0xc9a14a,
  pcb: 0x23262b,
  rubber: 0x0e0f11,
};

function mats() {
  return {
    printed: new THREE.MeshStandardMaterial({ color: COL.printed, roughness: 0.62, metalness: 0.05 }),
    frame: new THREE.MeshStandardMaterial({ color: COL.frame, roughness: 0.55, metalness: 0.35 }),
    chrome: new THREE.MeshStandardMaterial({ color: COL.chrome, roughness: 0.16, metalness: 1 }),
    alu: new THREE.MeshStandardMaterial({ color: COL.alu, roughness: 0.38, metalness: 0.9 }),
    brass: new THREE.MeshStandardMaterial({ color: COL.brass, roughness: 0.28, metalness: 1 }),
    pcb: new THREE.MeshStandardMaterial({ color: COL.pcb, roughness: 0.7, metalness: 0.2 }),
    rubber: new THREE.MeshStandardMaterial({ color: COL.rubber, roughness: 0.9 }),
    motor: new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.45, metalness: 0.6 }),
    tube: new THREE.MeshStandardMaterial({ color: 0xf1f1ee, roughness: 0.35, metalness: 0, transparent: true, opacity: 0.88 }),
  };
}

// ---- helpers -----------------------------------------------------------
function box(w, h, d, mat, x, y, z, r = 0) {
  const g = r > 0 ? new RoundedBoxGeometry(w, h, d, 3, r) : new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  return m;
}
// box from min/max corners
function bb(x0, x1, y0, y1, z0, z1, mat, r = 0) {
  return box(x1 - x0, y1 - y0, z1 - z0, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, r);
}
function rod(axis, a0, a1, r, mat, p, q, seg = 20) {
  const len = a1 - a0;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
  const mid = (a0 + a1) / 2;
  if (axis === 'x') { m.rotation.z = Math.PI / 2; m.position.set(mid, p, q); }
  else if (axis === 'y') { m.position.set(p, mid, q); }
  else { m.rotation.x = Math.PI / 2; m.position.set(p, q, mid); }
  return m;
}

function extrusionTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#18191c'; g.fillRect(0, 0, 64, 256);
  g.fillStyle = '#0a0a0b'; g.fillRect(26, 0, 12, 256);    // T-slot
  g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(24, 0, 2, 256); g.fillRect(38, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function sheetTexture(W, D, area, x0, y0) {
  // canvas covers the whole sheet; 4 px per mm
  const px = 4;
  const c = document.createElement('canvas');
  c.width = Math.round(W * px); c.height = Math.round(D * px);
  const g = c.getContext('2d');
  // textured powder-coat look
  g.fillStyle = '#6c6e72';
  g.fillRect(0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n + 1;
  }
  g.putImageData(img, 0, 0);
  // faint brushed streaks
  g.globalAlpha = 0.05;
  for (let i = 0; i < 260; i++) {
    const y = Math.random() * c.height;
    g.fillStyle = Math.random() < 0.5 ? '#fff' : '#000';
    g.fillRect(0, y, c.width, 1 + Math.random() * 2);
  }
  g.globalAlpha = 1;
  // print-area outline + 4x4 dashed grid (sheet coords: x right, y towards back)
  const toPx = (sx, sy) => [(sx - x0) * px, c.height - (sy - y0) * px];
  const [ax0, ay0] = toPx(area.x0, area.y0), [ax1, ay1] = toPx(area.x1, area.y1);
  g.strokeStyle = 'rgba(235,237,240,.75)';
  g.lineWidth = 2;
  g.strokeRect(ax0, ay1, ax1 - ax0, ay0 - ay1);
  g.setLineDash([6, 5]);
  g.lineWidth = 1.6;
  g.strokeStyle = 'rgba(235,237,240,.6)';
  for (let k = 1; k < 4; k++) {
    const x = ax0 + (ax1 - ax0) * k / 4, y = ay1 + (ay0 - ay1) * k / 4;
    g.beginPath(); g.moveTo(x, ay1); g.lineTo(x, ay0); g.stroke();
    g.beginPath(); g.moveTo(ax0, y); g.lineTo(ax1, y); g.stroke();
  }
  g.setLineDash([]);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  r.addColorStop(0, 'rgba(0,0,0,.55)');
  r.addColorStop(0.55, 'rgba(0,0,0,.22)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

// ---- the printer ---------------------------------------------------------
export class PrinterModel {
  constructor(bedW = 180, bedD = 180) {
    this.bedW = bedW; this.bedD = bedD;
    this.m = mats();
    this.root = new THREE.Group();      // everything static
    this.bed = new THREE.Group();       // moves along Z
    this.bedCarriage = new THREE.Group();
    this.gantry = new THREE.Group();    // moves along Y
    this.head = new THREE.Group();      // moves along X (child of gantry)
    this.gantry.add(this.head);
    this._build();
    this.tubeState = '';
  }

  _build() {
    const { m } = this;
    const hw = this.bedW / 2, hd = this.bedD / 2;
    const baseY = -64;
    this.baseY = baseY;
    const colX = hw + 65;           // Z column centre
    const colZ = -40;
    this.colX = colX; this.colZ = colZ;
    const top = 340;                // top of the column

    // ---------------- static frame
    const R = this.root;
    // Y spine under the bed
    R.add(bb(-56, 56, baseY, -20, -hd - 75, hd + 75, m.frame, 4));   // 330 mm deep overall
    R.add(bb(-62, 62, baseY, -14, hd + 57, hd + 75, m.printed, 4));   // front Y end
    R.add(bb(-62, 62, baseY, -14, -hd - 75, -hd - 57, m.printed, 4)); // rear Y end
    for (const x of [-38, 38]) R.add(rod('z', -hd - 60, hd + 60, 4, m.chrome, x, -22));
    // feet
    for (const [x, z] of [[-50, hd + 68], [50, hd + 68], [-50, -hd - 68], [50, -hd - 68]]) {
      const f = new THREE.Mesh(new THREE.CylinderGeometry(7, 8, 4, 20), m.rubber);
      f.position.set(x, baseY - 2, z); R.add(f);
    }
    // column foot + extrusion + motor
    R.add(bb(colX - 42, colX + 32, baseY, -26, colZ - 42, colZ + 44, m.printed, 5));
    const ext = new THREE.Mesh(new THREE.BoxGeometry(40, top - baseY, 40), new THREE.MeshStandardMaterial({ map: extrusionTexture(), roughness: 0.5, metalness: 0.4 }));
    ext.material.map.repeat.set(1, 6);
    ext.position.set(colX, (top + baseY) / 2, colZ);
    R.add(ext);
    R.add(bb(colX - 22, colX + 22, top, top + 44, colZ - 22, colZ + 22, m.motor, 2));   // Z motor
    R.add(bb(colX - 24, colX + 24, top - 6, top, colZ - 24, colZ + 24, m.printed, 2));  // motor mount
    for (const x of [colX - 16, colX + 16]) R.add(rod('y', baseY + 34, top - 6, 4, m.chrome, x, colZ + 30));
    const screw = rod('y', baseY + 34, top - 6, 4, new THREE.MeshStandardMaterial({ color: 0x8d9097, roughness: 0.3, metalness: 1 }), colX, colZ + 30, 12);
    R.add(screw);
    // extruder on the side of the column top
    R.add(bb(colX + 20, colX + 44, top - 70, top - 20, colZ - 20, colZ + 20, m.printed, 4));
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 8, 24), m.motor);
    knob.rotation.z = Math.PI / 2; knob.position.set(colX + 48, top - 45, colZ); R.add(knob);
    this.extruderPoint = new THREE.Vector3(colX + 30, top - 18, colZ);

    // display unit, front right, leaning back a little
    const disp = new THREE.Group();
    disp.add(bb(-34, 34, 0, 112, -14, 14, m.printed, 7));
    const screenCanvas = document.createElement('canvas');
    screenCanvas.width = 240; screenCanvas.height = 300;
    this.screenCanvas = screenCanvas;
    this.screenTex = new THREE.CanvasTexture(screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(52, 65), new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false }));
    screen.position.set(0, 72, 14.2);
    disp.add(screen);
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(10, 11, 10, 32), m.motor);
    dial.rotation.x = Math.PI / 2; dial.position.set(0, 22, 18); disp.add(dial);
    disp.position.set(colX - 10, baseY, hd + 58);
    disp.rotation.x = -0.2;
    R.add(disp);

    // soft contact shadow
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(560, 620), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.set(30, baseY - 3.9, 0);
    R.add(sh);

    // ---------------- bed (moves in Z)
    const B = this.bedCarriage;
    B.add(bb(-72, 72, -16, -7, -72, 72, m.frame, 2));
    for (const [x, z] of [[-38, 50], [-38, -50], [38, 50], [38, -50]]) B.add(bb(x - 10, x + 10, -24, -14, z - 14, z + 14, m.printed, 2)); // bearings
    this.bed.add(B);
    // heatbed PCB with screws
    const mx = 12, mzF = 14, mzB = 12;
    const sx0 = -hw - mx, sx1 = hw + mx, sz0 = -hd - mzB, sz1 = hd + mzF;   // sheet extents (world z)
    this.bed.add(bb(sx0 + 2, sx1 - 2, -3.6, -0.9, sz0 + 3, sz1 - 3, m.pcb, 1));
    for (const [x, z] of [[sx0 + 8, sz0 + 8], [sx1 - 8, sz0 + 8], [sx0 + 8, sz1 - 8], [sx1 - 8, sz1 - 8], [0, sz0 + 8], [0, sz1 - 8]]) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 1.2, 12), m.alu);
      s.position.set(x, -0.8, z); this.bed.add(s);
    }
    // spring steel sheet: tabs at the front corners, one at the back
    const shape = new THREE.Shape();
    const Y = (z) => -z; // shape y = -world z
    const r = 5, tab = 6;
    const fx0 = sx0, fx1 = sx1, fz0 = sz0, fz1 = sz1;
    shape.moveTo(fx0 + r, Y(fz0));
    shape.lineTo(-45, Y(fz0)); shape.lineTo(-40, Y(fz0 - tab)); shape.lineTo(40, Y(fz0 - tab)); shape.lineTo(45, Y(fz0));
    shape.lineTo(fx1 - r, Y(fz0)); shape.quadraticCurveTo(fx1, Y(fz0), fx1, Y(fz0 + r));
    shape.lineTo(fx1, Y(fz1 - r));
    shape.lineTo(fx1 - 2, Y(fz1 + tab - 1)); shape.quadraticCurveTo(fx1 - 3, Y(fz1 + tab), fx1 - 8, Y(fz1 + tab));
    shape.lineTo(fx1 - 30, Y(fz1 + tab)); shape.lineTo(fx1 - 34, Y(fz1));
    shape.lineTo(fx0 + 34, Y(fz1)); shape.lineTo(fx0 + 30, Y(fz1 + tab));
    shape.lineTo(fx0 + 8, Y(fz1 + tab)); shape.quadraticCurveTo(fx0 + 3, Y(fz1 + tab), fx0 + 2, Y(fz1 + tab - 1));
    shape.lineTo(fx0, Y(fz1 - r));
    shape.lineTo(fx0, Y(fz0 + r)); shape.quadraticCurveTo(fx0, Y(fz0), fx0 + r, Y(fz0));
    for (const hx of [fx0 + 14, fx1 - 14]) {
      const h = new THREE.Path(); h.absarc(hx, Y(fz1 + 2), 2.2, 0, Math.PI * 2, true); shape.holes.push(h);
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.8, bevelEnabled: false, curveSegments: 10 });
    const W = fx1 - fx0, D = (fz1 + tab) - (fz0 - tab);
    const tex = sheetTexture(W, D, { x0: -hw, x1: hw, y0: -hd, y1: hd }, fx0, Y(fz1 + tab));
    tex.repeat.set(1 / W, 1 / D);
    tex.offset.set(-fx0 / W, -Y(fz1 + tab) / D);
    const sheetMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, metalness: 0.25 });
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x9a9da2, roughness: 0.4, metalness: 0.9 });
    const sheet = new THREE.Mesh(geo, [sheetMat, edgeMat]);
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.y = -0.8;
    this.sheet = sheet;
    this.bed.add(sheet);

    // ---------------- gantry (moves in Y = print Z)
    const G = this.gantry;
    const rz = -22;       // X rods behind the nozzle line
    this.rodY = [52, 78];
    G.add(bb(colX - 30, colX + 24, 36, 98, colZ + 10, rz + 16, m.printed, 5));          // Z carriage
    G.add(bb(colX - 28, colX + 14, 42, 84, rz + 16, rz + 50, m.motor, 3));             // X motor (faces front)
    G.add(bb(colX - 27, colX + 13, 43, 83, rz + 50, rz + 51.5, m.alu));                // motor label plate
    for (const y of this.rodY) G.add(rod('x', -hw - 70, colX - 30, 4, m.chrome, y, rz));
    G.add(bb(-hw - 88, -hw - 62, 36, 96, rz - 14, rz + 14, m.printed, 5));             // X idler end
    G.add(bb(-hw - 66, colX - 30, 63.5, 66.5, rz + 5, rz + 7, m.rubber));             // belt
    G.add(bb(-hw - 66, colX - 30, 63.5, 66.5, rz - 7, rz - 5, m.rubber));

    // ---------------- print head (moves in X). Origin = nozzle tip.
    const H = this.head;
    H.add(bb(-24, 24, 38, 94, rz - 12, rz + 12, m.printed, 5));                        // carriage
    H.add(bb(-20, 20, 14, 60, rz + 12, -6, m.printed, 3));                             // back plate
    for (let i = 0; i < 9; i++) {                                                      // heatsink fins
      const fin = new THREE.Mesh(new THREE.CylinderGeometry(10.5, 10.5, 1.3, 28), m.alu);
      fin.position.set(0, 23 + i * 2.7, 0); H.add(fin);
    }
    H.add(rod('y', 22, 47, 4.2, m.alu, 0, 0, 16));                                     // heatsink core
    H.add(rod('y', 16, 23, 2.2, m.chrome, 0, 0, 12));                                  // heat break
    H.add(bb(-13, 7, 6, 17, -8, 8, m.alu, 1));                                         // heater block
    H.add(rod('x', 7, 13, 3, m.chrome, 11.5, 0));                                     // heater cartridge
    const hex = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 3, 6), m.brass);
    hex.position.y = 4.6; H.add(hex);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(3, 0.45, 3.2, 20), m.brass);
    tip.position.y = 1.6; H.add(tip);
    this.tip = tip;
    // hotend fan (front) with grille
    H.add(bb(-17, 17, 18, 52, 11, 21, m.printed, 3));
    const hub = new THREE.Mesh(new THREE.CircleGeometry(13, 32), m.motor);
    hub.position.set(0, 35, 21.1); H.add(hub);
    for (let k = 0; k < 3; k++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(4 + k * 3.6, 5 + k * 3.6, 32), m.printed);
      ring.position.set(0, 35, 21.2); H.add(ring);
    }
    // part-cooling fan + duct on the left
    H.add(bb(-36, -18, 10, 44, -12, 14, m.printed, 3));
    H.add(bb(-19, -7, 3.5, 9, -6, 6, m.printed, 1.5));
    // glow at the tip while extruding
    this.glow = new THREE.PointLight(0xffa860, 0, 30, 2);
    this.glow.position.y = 1;
    H.add(this.glow);

    // Bowden tube (rebuilt as the head moves)
    this.tube = new THREE.Mesh(new THREE.BufferGeometry(), m.tube);
    this.root.add(this.tube);
  }

  /** hx: nozzle X (world), hy: nozzle height, bedZ: bed offset along Z */
  setPose(hx, hy, bedZ, extruding) {
    this.head.position.x = hx;
    this.gantry.position.y = hy;
    this.bed.position.z = bedZ;
    this.glow.intensity = extruding ? 3 : 0;
    const key = `${Math.round(hx)}|${Math.round(hy)}`;
    if (key !== this.tubeState) {
      this.tubeState = key;
      const start = new THREE.Vector3(hx, hy + 47, 0);
      const e = this.extruderPoint;
      const pts = [
        start,
        new THREE.Vector3(hx, hy + 110, 0),
        new THREE.Vector3((hx + e.x) / 2 - 20, Math.max(hy + 170, e.y + 60), (e.z) / 2),
        new THREE.Vector3(e.x, e.y + 45, e.z),
        e.clone(),
      ];
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      this.tube.geometry.dispose();
      this.tube.geometry = new THREE.TubeGeometry(curve, 48, 2, 10, false);
    }
  }

  /** Draw the little front screen. */
  setScreen({ title = 'printsim', big = '', line1 = '', line2 = '', progress = 0, accent = '#ff7a1a' }) {
    const key = [title, big, line1, line2, Math.round(progress * 200), accent].join('|');
    if (key === this._screenKey) return false;
    this._screenKey = key;
    const c = this.screenCanvas, g = c.getContext('2d');
    g.fillStyle = '#0b0d10'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#16191e'; g.fillRect(0, 0, c.width, 36);
    g.fillStyle = '#9aa3ad'; g.font = '600 18px system-ui, sans-serif'; g.textBaseline = 'middle';
    g.fillText(title, 14, 19);
    g.fillStyle = '#f2f4f7'; g.font = '700 84px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(big, c.width / 2, 120);
    g.fillStyle = '#2a2e35'; g.fillRect(18, 176, c.width - 36, 12);
    g.fillStyle = accent; g.fillRect(18, 176, (c.width - 36) * Math.max(0, Math.min(1, progress)), 12);
    g.fillStyle = '#cfd4db'; g.font = '500 22px system-ui, sans-serif';
    g.fillText(line1, c.width / 2, 222);
    g.fillStyle = '#8b939d'; g.font = '500 19px system-ui, sans-serif';
    g.fillText(line2, c.width / 2, 258);
    g.textAlign = 'left';
    this.screenTex.needsUpdate = true;
    return true;
  }

  get bounds() {
    return { min: [-this.bedW / 2 - 90, this.baseY, -this.bedD / 2 - 80], max: [this.colX + 50, 390, this.bedD / 2 + 80] };
  }
}
