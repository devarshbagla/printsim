// A MINI-layout desktop printer built from primitives, laid out from Prusa's
// open-source drawings (github.com/prusa3d/Original-Prusa-MINI: part drawings
// and axis renders). Mechanics and sizes follow the real machine; no vendor
// logos, wordmark or colours.
//
//  - base: two 30x30x262 mm extrusions, front and rear plates, 8x279 mm Y rods,
//    Y motor on the rear plate, belt down the middle
//  - column (right): 30x30x289 mm extrusion, two 10x341 mm Z rods and the
//    leadscrew in one row front to back (20 mm apart, extrusion behind),
//    Z motor on top under the Z-top, electronics box with switch at the foot
//  - gantry: Z carriage on two LM10 bearings, X motor hanging off it at an
//    angle, the extruder riding on it, 8x279 mm X rods stacked with the belt
//    between them, idler at the free end
//  - head: hotend fan shroud, heater block + nozzle, probe 29 mm left of the
//    nozzle (the firmware's probe offset), blower fan behind with its duct
//  - 275 mm Bowden tube, a fixed length that loops as the head moves
//  - 190 x 200 mm spring steel sheet: locating ears at the back, shallow recess
//    at the front
//  - the spool on a printed arm clipped to the right of the Z column, axis
//    along X, in the filament colour (the lab MINI+, not the separate stand)
//
// World units are mm, Y up. The print area is centred on the origin with the
// sheet surface at y = 0; the front of the printer faces +Z. Moving parts:
//   bed      -> translates along Z   (G-code Y)
//   gantry   -> translates along Y   (G-code Z)
//   head     -> translates along X   (G-code X), child of gantry

import * as THREE from 'three';
import { RoundedBoxGeometry } from '../vendor/RoundedBoxGeometry.js';

const TUBE_LEN = 275; // Bowden PTFE, mm (Prusa part drawing)
const TUBE_LIFT = 30; // mm: the flattest the tube's arc gets (PTFE kinks below ~25 mm bend radius)

function mats() {
  return {
    // Graphite printed parts, visibly not the black frame and not orange.
    printed: new THREE.MeshStandardMaterial({ color: 0x6a6e76, roughness: 0.62, metalness: 0.02 }),
    printedDark: new THREE.MeshStandardMaterial({ color: 0x4a4e55, roughness: 0.66, metalness: 0.02 }),
    // Matte black anodising. Low metalness so the room light doesn't wash it blue-grey.
    anod: new THREE.MeshStandardMaterial({ color: 0x050608, roughness: 0.84, metalness: 0.06 }),
    slot: new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.9, metalness: 0.2 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xe3e6ea, roughness: 0.14, metalness: 1 }),
    alu: new THREE.MeshStandardMaterial({ color: 0xbfc4ca, roughness: 0.36, metalness: 0.9 }),
    screw: new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.3, metalness: 1 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc9a14a, roughness: 0.28, metalness: 1 }),
    pcb: new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.7, metalness: 0.2 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.92 }),
    motor: new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.78, metalness: 0.08 }),
    motorCap: new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.45, metalness: 0.25 }),
    warn: new THREE.MeshStandardMaterial({ color: 0xf0c010, roughness: 0.5, metalness: 0.04, side: THREE.DoubleSide }),
    belt: new THREE.MeshStandardMaterial({ color: 0x121214, roughness: 0.85 }),
    tube: new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.3, metalness: 0, transparent: true, opacity: 0.82 }),
    fanGlass: new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.85 }),
    filament: new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.45, metalness: 0 }),
    spool: new THREE.MeshStandardMaterial({ color: 0x1d1f23, roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide }),
  };
}

// ---- helpers -----------------------------------------------------------
function box(w, h, d, mat, x, y, z, r = 0) {
  const rr = Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01);
  const g = rr > 0.05 ? new RoundedBoxGeometry(w, h, d, 3, rr) : new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  return m;
}
// box between two corners (in any order)
function bb(x0, x1, y0, y1, z0, z1, mat, r = 0) {
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0), d = Math.abs(z1 - z0);
  return box(w, h, d, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, r);
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
// NEMA 17 stepper: 42x42 body with lighter end caps; axis along 'x' | 'y' | 'z'
function stepper(len, m, axis = 'y') {
  const g = new THREE.Group();
  g.add(box(42, len - 8, 42, m.motor, 0, 0, 0, 3));
  g.add(box(42.4, 4, 42.4, m.motorCap, 0, len / 2 - 2, 0, 2));
  g.add(box(42.4, 4, 42.4, m.motorCap, 0, -len / 2 + 2, 0, 2));
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 2, 28), m.motorCap);
  boss.position.y = len / 2 + 1; g.add(boss);
  if (axis === 'x') g.rotation.z = -Math.PI / 2;
  if (axis === 'z') g.rotation.x = Math.PI / 2;
  return g;
}

// 30x30 aluminium profile, black anodised, with its T-slots drawn as dark
// grooves along the length on every face
function extrusion(len, axis, m, x, y, z) {
  const g = new THREE.Group();
  const w = axis === 'x' ? len : 30, h = axis === 'y' ? len : 30, d = axis === 'z' ? len : 30;
  g.add(box(w, h, d, m.anod, 0, 0, 0, 1.5));
  const slot = (sx, sy, sz, px, py, pz) => g.add(box(sx, sy, sz, m.slot, px, py, pz));
  const L = len - 1, s = 8.2, e = 15.05;
  if (axis === 'y') { slot(0.4, L, s, e, 0, 0); slot(0.4, L, s, -e, 0, 0); slot(s, L, 0.4, 0, 0, e); slot(s, L, 0.4, 0, 0, -e); }
  if (axis === 'z') { slot(0.4, s, L, e, 0, 0); slot(0.4, s, L, -e, 0, 0); slot(s, 0.4, L, 0, e, 0); }
  if (axis === 'x') { slot(L, 0.4, s, 0, e, 0); slot(L, s, 0.4, 0, 0, e); slot(L, s, 0.4, 0, 0, -e); }
  g.position.set(x, y, z);
  return g;
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

// filament wound on the spool: faint turns and a slight sheen
function braidTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#1a1a1a';
  g.fillRect(0, 0, 64, 32);
  g.strokeStyle = '#5a5a5a';
  g.lineWidth = 3;
  for (let i = -6; i < 14; i++) {
    g.beginPath();
    g.moveTo(i * 8, 32);
    g.lineTo(i * 8 + 28, 0);
    g.stroke();
    g.beginPath();
    g.moveTo(i * 8, 0);
    g.lineTo(i * 8 + 28, 32);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(22, 2);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function windingTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 256);
  for (let y = 0; y < 256; y += 4) { g.fillStyle = 'rgba(0,0,0,.16)'; g.fillRect(0, y, 16, 1); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 6);
  return t;
}

// Merge every static mesh under `group` into one mesh per material, so the
// printer costs a few dozen draw calls instead of a hundred and fifty.
// Meshes flagged userData.keep (textured, animated or rebuilt) stay as they are.
function mergeStatic(group) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const byMat = new Map(), drop = [];
  group.traverse((o) => {
    if (!o.isMesh || o.userData.keep || Array.isArray(o.material) || o.material.map) return;
    let p = o.parent, skip = false;
    while (p && p !== group) { if (p.userData.keep) { skip = true; break; } p = p.parent; }
    if (skip) return;
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(g);
    drop.push(o);
  });
  for (const o of drop) o.removeFromParent();
  for (const [mat, geos] of byMat) {
    let n = 0; for (const g of geos) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    let o = 0;
    for (const g of geos) {
      pos.set(g.attributes.position.array, o * 3);
      if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
      o += g.attributes.position.count;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.computeBoundingSphere();
    group.add(new THREE.Mesh(geo, mat));
  }
}

// A tube whose shape changes every frame (the Bowden tube, the filament off the
// spool). One buffer, rewritten in place: no new geometry per frame, so no
// garbage-collector hitches. Rings are spaced evenly by ARC LENGTH (a Bezier's
// own parameter bunches them up on the tight bend and stretches them on the
// straight bit) and oriented by parallel transport from a fixed reference, so
// the tube never twists, pinches or flips as it moves.
const DENSE = 96;
class LiveTube {
  constructor(segs, radial, radius, material) {
    this.n = segs; this.m = radial; this.r = radius;
    const V = (segs + 1) * (radial + 1);
    this.pos = new Float32Array(V * 3);
    this.nor = new Float32Array(V * 3);
    const idx = [];
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * (radial + 1) + j, b = a + radial + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aNor = new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('normal', this.aNor);
    g.setIndex(idx);
    this.uv = new Float32Array(V * 2);
    this.aUv = new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('uv', this.aUv);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.userData.keep = true;
    this.dense = new Float32Array((DENSE + 1) * 3);
    this.cum = new Float32Array(DENSE + 1);
    this.ctl = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.pts = new Float32Array((segs + 1) * 3);
    this.N = new THREE.Vector3(); this.T = new THREE.Vector3(); this.B = new THREE.Vector3();
  }

  // sample the cubic Bezier densely; returns its length
  _sample(p0, p1, p2, p3) {
    const d = this.dense, c = this.cum;
    let len = 0;
    for (let i = 0; i <= DENSE; i++) {
      const t = i / DENSE, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, cc = 3 * u * t * t, e = t * t * t;
      d[i * 3] = a * p0.x + b * p1.x + cc * p2.x + e * p3.x;
      d[i * 3 + 1] = a * p0.y + b * p1.y + cc * p2.y + e * p3.y;
      d[i * 3 + 2] = a * p0.z + b * p1.z + cc * p2.z + e * p3.z;
      if (i) len += Math.hypot(d[i * 3] - d[i * 3 - 3], d[i * 3 + 1] - d[i * 3 - 2], d[i * 3 + 2] - d[i * 3 - 1]);
      c[i] = len;
    }
    return len;
  }

  length(p0, p1, p2, p3) { return this._sample(p0, p1, p2, p3); }

  /** reshape the tube along a cubic Bezier */
  setBezier(p0, p1, p2, p3) {
    const total = this._sample(p0, p1, p2, p3);
    const d = this.dense, c = this.cum, n = this.n, m = this.m;
    const P = this.pts, k0 = { k: 0 };
    let o3 = 0;
    const at = (s, out) => {
      let k = k0.k;
      while (k < DENSE - 1 && c[k + 1] < s) k++;
      k0.k = k;
      const f = c[k + 1] > c[k] ? (s - c[k]) / (c[k + 1] - c[k]) : 0;
      out[o3] = d[k * 3] + (d[k * 3 + 3] - d[k * 3]) * f;
      out[o3 + 1] = d[k * 3 + 1] + (d[k * 3 + 4] - d[k * 3 + 1]) * f;
      out[o3 + 2] = d[k * 3 + 2] + (d[k * 3 + 5] - d[k * 3 + 2]) * f;
    };
    for (let i = 0; i <= n; i++) { o3 = i * 3; at((total * i) / n, P); }
    // parallel transport: start from the reference "sideways" axis (world Z,
    // made perpendicular to the first tangent) and carry it along the curve
    const N = this.N, T = this.T, B = this.B;
    const tangent = (i, out) => {
      const a = Math.max(0, i - 1) * 3, b = Math.min(n, i + 1) * 3;
      out.set(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
      if (out.lengthSq() < 1e-12) out.set(0, 1, 0);
      return out.normalize();
    };
    tangent(0, T);
    N.set(0, 0, 1).addScaledVector(T, -T.z);
    if (N.lengthSq() < 1e-6) N.set(1, 0, 0).addScaledVector(T, -T.x);
    N.normalize();
    const pos = this.pos, nor = this.nor, R = this.r;
    for (let i = 0; i <= n; i++) {
      if (i) {
        tangent(i, T);
        N.addScaledVector(T, -N.dot(T));
        if (N.lengthSq() < 1e-9) N.set(0, 0, 1).addScaledVector(T, -T.z);
        N.normalize();
      }
      B.crossVectors(T, N);
      for (let j = 0; j <= m; j++) {
        const a = (j / m) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const nx = ca * N.x + sa * B.x, ny = ca * N.y + sa * B.y, nz = ca * N.z + sa * B.z;
        const o = (i * (m + 1) + j) * 3;
        nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
        pos[o] = P[i * 3] + nx * R; pos[o + 1] = P[i * 3 + 1] + ny * R; pos[o + 2] = P[i * 3 + 2] + nz * R;
        const uo = (i * (m + 1) + j) * 2;
        this.uv[uo] = i / n; this.uv[uo + 1] = j / m;
      }
    }
    this.aPos.needsUpdate = true;
    this.aNor.needsUpdate = true;
    this.aUv.needsUpdate = true;
  }
}

// ---- front screen (MINI layout, measured from a lab photo) --------------
const SCREEN_FONT = "'DejaVu Sans Mono', Menlo, Consolas, monospace";
const SC = {
  bg: '#0b0d16', text: '#dfe6ff', dim: '#aab4e8',
  barDone: '#e8663a', barLeft: '#2a4fd0',
  button: '#3040e0', selected: '#7f90f5', accent: '#e8663a',
  gear: '#1c2450',
};

function fmtElapsed(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
function fmtRemain(min) {
  min = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(min / 60), m = min % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
// One character every 0.25 s, holding 1.5 s at each end, then back.
function marqueeChars(len, nowMs) {
  const span = len - 20;
  if (span <= 0) return 0;
  const step = 250, hold = 1500, leg = span * step, cycle = 2 * (hold + leg);
  let t = nowMs % cycle;
  if (t < hold) return 0;
  t -= hold;
  if (t < leg) return Math.min(span, Math.floor(t / step));
  t -= leg;
  if (t < hold) return span;
  t -= hold;
  return Math.max(0, span - Math.floor(t / step));
}
function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}
function drawPlayCircle(g, x, y, r) {
  g.strokeStyle = SC.text; g.lineWidth = Math.max(2, r * 0.16); g.lineJoin = 'round';
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  g.fillStyle = SC.text;
  g.beginPath();
  g.moveTo(x - r * 0.32, y - r * 0.46);
  g.lineTo(x + r * 0.5, y);
  g.lineTo(x - r * 0.32, y + r * 0.46);
  g.closePath(); g.fill();
}
function drawGear(g, x, y, r) {
  g.save(); g.translate(x, y);
  g.strokeStyle = SC.gear; g.lineWidth = Math.max(3, r * 0.16); g.lineJoin = 'round'; g.lineCap = 'round';
  const teeth = 8, inner = r * 0.68, outer = r;
  g.beginPath();
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2 - Math.PI / 2, span = (Math.PI * 2) / teeth;
    const ang = [0.08, 0.36, 0.64, 0.92].map(f => a + span * f);
    const rad = [inner, outer, outer, inner];
    for (let k = 0; k < 4; k++) {
      const px = Math.cos(ang[k]) * rad[k], py = Math.sin(ang[k]) * rad[k];
      if (i === 0 && k === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
  }
  g.closePath(); g.stroke();
  g.beginPath(); g.arc(0, 0, r * 0.42, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = SC.accent; g.lineWidth = Math.max(3, r * 0.16);
  g.beginPath(); g.arc(0, 0, r * 0.2, 0, Math.PI * 2); g.stroke();
  g.restore();
}
function drawRingIcon(g, cx, cy, r, drawInner) {
  g.strokeStyle = '#f4f7ff'; g.lineWidth = Math.max(3, r * 0.1);
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  drawInner(g, cx, cy, r);
}
function drawNozzleIcon(g, x, y, s) {
  g.strokeStyle = SC.text; g.lineWidth = Math.max(2, s * 0.14); g.lineJoin = 'round'; g.lineCap = 'round';
  g.strokeRect(x - s * 0.38, y - s * 0.2, s * 0.76, s * 0.46);
  g.beginPath();
  g.moveTo(x - s * 0.14, y + s * 0.26); g.lineTo(x, y + s * 0.68); g.lineTo(x + s * 0.14, y + s * 0.26);
  g.moveTo(x, y - s * 0.2); g.lineTo(x, y - s * 0.58);
  g.stroke();
}
function drawBedHeat(g, x, y, s) {
  g.strokeStyle = SC.text; g.lineWidth = Math.max(2, s * 0.12); g.lineCap = 'round';
  g.beginPath(); g.moveTo(x - s * 0.7, y + s * 0.45); g.lineTo(x + s * 0.7, y + s * 0.45); g.stroke();
  for (let i = 0; i < 3; i++) {
    const yy = y + s * 0.05 - i * s * 0.28;
    g.beginPath();
    g.moveTo(x - s * 0.55, yy);
    g.bezierCurveTo(x - s * 0.25, yy - s * 0.28, x + s * 0.05, yy + s * 0.28, x + s * 0.55, yy);
    g.stroke();
  }
}
function drawGauge(g, x, y, s) {
  g.strokeStyle = SC.text; g.lineWidth = Math.max(2, s * 0.16); g.lineCap = 'round';
  const r = s * 0.95, cy = y + s * 0.28;
  g.beginPath(); g.arc(x, cy, r, Math.PI * 1.18, Math.PI * 1.82); g.stroke();
  g.beginPath(); g.moveTo(x, cy); g.lineTo(x + r * 0.35, cy - r * 0.62); g.stroke();
  g.fillStyle = SC.text;
  g.beginPath(); g.arc(x, cy, s * 0.16, 0, Math.PI * 2); g.fill();
}
function drawSpoolIcon(g, x, y, s) {
  g.strokeStyle = SC.accent; g.lineWidth = Math.max(2, s * 0.12);
  g.beginPath(); g.arc(x, y, s * 0.55, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(x, y, s * 0.18, 0, Math.PI * 2); g.stroke();
}

function drawMiniScreen(c, o) {
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const paused = !!(o.paused || o.mode === 'paused');
  g.textBaseline = 'middle'; g.textAlign = 'left';
  g.fillStyle = SC.bg; g.fillRect(0, 0, W, H);

  // header
  const hy = 0.05 * H;
  drawPlayCircle(g, 0.075 * W, hy, 0.028 * H);
  let header = 'PRINTING ...';
  if (o.mode === 'ready') header = 'READY';
  if (o.mode === 'done') header = 'FINISHED';
  if (paused) header = 'PAUSED';
  g.fillStyle = SC.text; g.font = `bold ${Math.round(0.034 * H)}px ${SCREEN_FONT}`;
  g.fillText(header, 0.13 * W, hy);
  g.strokeStyle = SC.dim; g.lineWidth = 2;
  roundRect(g, 0.875 * W, hy - 0.014 * H, 0.07 * W, 0.028 * H, 3); g.stroke();

  // file name marquee: 20 characters fill 0.88W
  const winX = 0.06 * W, winW = 0.88 * W, nameY = 0.17 * H;
  if (!c._charW) {
    g.font = `bold 40px ${SCREEN_FONT}`;
    const w20 = g.measureText('00000000000000000000').width;
    c._fontPx = 40 * (winW / w20);
    g.font = `bold ${c._fontPx}px ${SCREEN_FONT}`;
    c._charW = g.measureText('0').width;
  }
  const name = o.fileName || '';
  g.save();
  g.beginPath(); g.rect(winX, nameY - c._fontPx * 0.7, winW, c._fontPx * 1.4); g.clip();
  g.fillStyle = SC.text; g.font = `bold ${c._fontPx}px ${SCREEN_FONT}`;
  g.fillText(name, winX - (o.marquee || 0) * c._charW, nameY);
  g.restore();

  // progress bar
  const bx = 0.058 * W, bw = (0.935 - 0.058) * W, bh = 0.048 * H, by = 0.263 * H - bh / 2;
  const frac = pct01(o.percent);
  roundRect(g, bx, by, bw, bh, bh * 0.35); g.fillStyle = SC.barLeft; g.fill();
  if (frac > 0) {
    g.save(); roundRect(g, bx, by, bw, bh, bh * 0.35); g.clip();
    g.fillStyle = SC.barDone; g.fillRect(bx, by, bw * frac, bh); g.restore();
  }

  g.fillStyle = SC.text; g.textAlign = 'center';
  g.font = `bold ${Math.round(0.055 * H)}px ${SCREEN_FONT}`;
  g.fillText(`${Math.round(o.percent || 0)}%`, W / 2, 0.328 * H);

  const status = o.status1 ? String(o.status1) : '';
  if (status) {
    g.textAlign = 'left'; g.fillStyle = SC.text;
    g.font = `bold ${Math.round(0.042 * H)}px ${SCREEN_FONT}`;
    g.fillText(status, 0.06 * W, 0.40 * H);
    if (o.status2) {
      g.font = `bold ${Math.round(0.038 * H)}px ${SCREEN_FONT}`;
      g.fillText(String(o.status2), 0.06 * W, 0.455 * H);
    }
  } else {
    g.textAlign = 'center'; g.fillStyle = SC.dim;
    g.font = `bold ${Math.round(0.028 * H)}px ${SCREEN_FONT}`;
    g.fillText('Printing time', 0.273 * W, 0.40 * H);
    g.fillText('Remaining time', 0.738 * W, 0.40 * H);
    g.fillStyle = SC.text; g.font = `bold ${Math.round(0.04 * H)}px ${SCREEN_FONT}`;
    g.fillText(fmtElapsed(o.elapsedSec), 0.273 * W, 0.462 * H);
    g.fillText(fmtRemain(o.remainingMin), 0.738 * W, 0.462 * H);
  }

  // Tune / Pause / Stop
  const btnY = 0.578 * H, btnH = (0.78 - 0.578) * H;
  const buttons = [
    [0.048, 0.298, 'tune'],
    [0.36, 0.61, 'pause'],
    [0.673, 0.927, 'stop'],
  ];
  const labels = ['Tune', paused ? 'Resume' : 'Pause', 'Stop'];
  buttons.forEach(([x0, x1, kind], i) => {
    const x = x0 * W, w = (x1 - x0) * W;
    g.fillStyle = kind === 'tune' ? SC.selected : SC.button;
    roundRect(g, x, btnY, w, btnH, 0.03 * W); g.fill();
    const cx = x + w / 2, cy = btnY + btnH * 0.46, ir = Math.min(w, btnH) * 0.28;
    if (kind === 'tune') drawGear(g, cx, cy, ir * 1.15);
    else if (kind === 'pause') {
      drawRingIcon(g, cx, cy, ir, (gg, ix, iy, r) => {
        if (paused) {
          gg.fillStyle = SC.accent;
          gg.beginPath();
          gg.moveTo(ix - r * 0.28, iy - r * 0.42);
          gg.lineTo(ix + r * 0.48, iy);
          gg.lineTo(ix - r * 0.28, iy + r * 0.42);
          gg.closePath(); gg.fill();
        } else {
          gg.fillStyle = SC.accent;
          gg.fillRect(ix - r * 0.38, iy - r * 0.42, r * 0.26, r * 0.84);
          gg.fillRect(ix + r * 0.12, iy - r * 0.42, r * 0.26, r * 0.84);
        }
      });
    } else {
      drawRingIcon(g, cx, cy, ir, (gg, ix, iy, r) => {
        gg.fillStyle = SC.accent;
        roundRect(gg, ix - r * 0.34, iy - r * 0.34, r * 0.68, r * 0.68, r * 0.12); gg.fill();
      });
    }
    g.fillStyle = SC.dim; g.textAlign = 'center';
    g.font = `bold ${Math.round(0.03 * H)}px ${SCREEN_FONT}`;
    g.fillText(labels[i], cx, 0.81 * H);
  });

  // temps
  const ty = 0.873 * H;
  const nCur = Math.round(Number(o.nozzle && o.nozzle.cur) || 0);
  const nTgt = Math.round(Number(o.nozzle && o.nozzle.tgt) || 0);
  const bCur = Math.round(Number(o.bed && o.bed.cur) || 0);
  const bTgt = Math.round(Number(o.bed && o.bed.tgt) || 0);
  drawNozzleIcon(g, 0.08 * W, ty, 0.028 * H);
  g.fillStyle = SC.text; g.textAlign = 'left';
  g.font = `bold ${Math.round(0.032 * H)}px ${SCREEN_FONT}`;
  g.fillText(`${nCur}/${nTgt}°C`, 0.12 * W, ty);
  drawBedHeat(g, 0.55 * W, ty, 0.026 * H);
  g.fillText(`${bCur}/${bTgt}°C`, 0.60 * W, ty);

  // bottom: speed, Z, material
  const zy = 0.95 * H;
  drawGauge(g, 0.07 * W, zy, 0.022 * H);
  g.fillStyle = SC.text; g.textAlign = 'left';
  g.font = `bold ${Math.round(0.03 * H)}px ${SCREEN_FONT}`;
  g.fillText(`${Math.round(Number(o.speedPct) || 0)}%`, 0.11 * W, zy);
  g.fillStyle = SC.accent; g.textAlign = 'center';
  g.font = `bold ${Math.round(0.032 * H)}px ${SCREEN_FONT}`;
  const zTxt = Number.isFinite(+o.z) ? (+o.z).toFixed(2) : '';
  g.fillText('Z', 0.46 * W, zy);
  g.fillStyle = SC.text; g.textAlign = 'left';
  g.fillText(zTxt, 0.50 * W, zy);
  drawSpoolIcon(g, 0.78 * W, zy, 0.022 * H);
  g.fillStyle = SC.text; g.textAlign = 'left';
  g.fillText(String(o.material || ''), 0.82 * W, zy);
  g.textAlign = 'left';
}
function pct01(p) { return Math.max(0, Math.min(1, (Number(p) || 0) / 100)); }

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
    // one mesh per material in each moving part; the head moves inside the
    // gantry, so it's kept out of the gantry's merge and merged on its own
    this.head.userData.keep = true;
    for (const g of [this.root, this.bedCarriage, this.bed, this.gantry]) mergeStatic(g);
    this.head.userData.keep = false;
    mergeStatic(this.head);
    this.tubeState = NaN;
    this.filState = NaN;
  }

  _build() {
    const { m } = this;
    const hw = this.bedW / 2, hd = this.bedD / 2;
    const table = -62;                  // desk surface (sheet top is y = 0)
    this.baseY = table;
    const yLen = 262, yHalf = yLen / 2; // Y extrusions
    const plate = 34;                   // front / rear plate thickness
    const colX = hw + 60;               // Z column row (rods + leadscrew) x
    const rz = -20;                     // X rods (and leadscrew) depth
    this.colX = colX; this.rz = rz;
    const zRodF = rz + 20, zRodB = rz - 20, zExt = rz - 41; // row from the Z plate drawing
    const plateTop = table + 40;        // top of the electronics box / Z plate
    const extTop = plateTop + 5 + 289;
    this.zExt = zExt; this.extTop = extTop; this.colMidY = plateTop + 5 + 144.5;
    const zTopTop = extTop + 13;
    this.colTop = zTopTop + 34;

    // ---------------- static frame
    const R = this.root;
    // two Y extrusions, black anodised
    for (const x of [-40, 40]) R.add(extrusion(yLen, 'z', m, x, table + 3 + 15, 0));
    // foam pads under the extrusions
    for (const x of [-40, 40]) for (const z of [-yHalf + 20, yHalf - 20]) R.add(bb(x - 12, x + 12, table, table + 3, z - 12, z + 12, m.rubber, 1));
    // front and rear plates with the Y rods at their outer ends
    const plateH = 48, rodY = table + plateH - 8;
    for (const s of [1, -1]) {
      const z0 = s * yHalf, z1 = s * (yHalf + plate);
      const pl = bb(-96, 96, table + 2, table + plateH, Math.min(z0, z1), Math.max(z0, z1), m.printed, 6);
      R.add(pl);
      // chamfered "shoulders" where the rods go in
      for (const x of [-78, 78]) R.add(bb(x - 13, x + 13, table + plateH - 2, table + plateH + 6, Math.min(z0, z1) + 4, Math.max(z0, z1) - 4, m.printed, 4));
    }
    for (const x of [-78, 78]) R.add(rod('z', -yHalf - plate + 6, yHalf + plate - 6, 4, m.chrome, x, rodY + 4));
    // Y motor on the rear plate, shaft sideways, belt down the middle
    const ym = stepper(34, m, 'x');
    ym.position.set(-30, table + 26, -yHalf - plate - 22);
    R.add(ym);
    R.add(bb(-2, 2, table + 22, table + 30, -yHalf - plate + 4, yHalf + plate - 4, m.belt));
    // electronics box at the foot of the column (Buddy board, power switch)
    const eb0 = colX - 34, eb1 = colX + 30;
    R.add(bb(eb0, eb1, table, plateTop, -150, 30, m.printed, 6));
    for (let k = 0; k < 6; k++) R.add(bb(eb0 + 8, eb1 - 8, plateTop - 1, plateTop + 1.4, -130 + k * 11, -125 + k * 11, m.printedDark, 1)); // vents
    const sw = bb(eb1 - 0.5, eb1 + 2.5, table + 12, table + 28, -128, -108, m.rubber, 1.5); R.add(sw); // power switch
    R.add(bb(eb1 + 1.5, eb1 + 4, table + 16, table + 24, -124, -112, m.motorCap, 1));
    R.add(bb(eb1 - 0.4, eb1 + 0.8, table + 16, table + 22, -98, -88, m.rubber));                        // USB
    for (const z of [-140, 20]) R.add(bb(colX - 26, colX + 22, table - 0.01, table + 3, z - 10, z + 10, m.rubber, 1));
    // Z plate bottom (119 x 30 x 5, black anodised) carries the rods and the extrusion
    R.add(bb(colX - 15, colX + 15, plateTop, plateTop + 5, zRodF + 19, zExt - 23, m.anod, 1));
    // the column: extrusion, rods, leadscrew
    R.add(extrusion(289, 'y', m, colX, plateTop + 5 + 144.5, zExt));
    for (const z of [zRodF, zRodB]) R.add(rod('y', plateTop - 20, extTop + 11, 5, m.chrome, colX, z));
    R.add(rod('y', plateTop + 5, zTopTop, 4, m.screw, colX, rz, 14));
    // Z-top with the Z motor on top
    R.add(bb(colX - 17, colX + 17, extTop, zTopTop, zExt - 17, zRodF + 14, m.printed, 5));
    const zm = stepper(34, m, 'y');
    zm.position.set(colX, zTopTop + 17, rz);
    R.add(zm);
    // two plain yellow triangles near the top of the column (no branding)
    for (const y of [extTop - 28, extTop - 52]) {
      const shape = new THREE.Shape();
      shape.moveTo(-8, 0); shape.lineTo(8, 0); shape.lineTo(0, 14); shape.closePath();
      const tri = new THREE.Mesh(new THREE.ShapeGeometry(shape), m.warn);
      tri.position.set(colX, y, zExt + 15.4);
      R.add(tri);
    }

    // display unit, front right, leaning back, knob under the screen
    const disp = new THREE.Group();
    disp.add(bb(-32, 32, 0, 118, -13, 13, m.printed, 7));
    disp.add(bb(-27, 27, 40, 112, 12.4, 13.6, m.rubber, 2));                // bezel
    const screenCanvas = document.createElement('canvas');
    screenCanvas.width = 480; screenCanvas.height = 620;
    this.screenCanvas = screenCanvas;
    this.screenTex = new THREE.CanvasTexture(screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screenTex.magFilter = THREE.LinearFilter;
    this.screenTex.minFilter = THREE.LinearFilter;
    // 46.5 x 60 keeps the real screen's aspect (~0.776) inside the bezel
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(46.5, 60), new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false }));
    screen.position.set(0, 76, 13.7);
    disp.add(screen);
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(11, 12, 12, 32), m.printedDark);
    dial.rotation.x = Math.PI / 2; dial.position.set(0, 20, 18); disp.add(dial);
    for (let k = 0; k < 3; k++) {                                           // knob grip wings
      const wing = box(3, 14, 6, m.printedDark, 0, 0, 0, 1);
      wing.position.set(Math.cos(k * 2.094) * 9, 20 + Math.sin(k * 2.094) * 9, 22);
      wing.rotation.z = k * 2.094;
      disp.add(wing);
    }
    disp.position.set(colX - 34, table, yHalf + plate - 4);
    disp.rotation.x = -0.48; // about 27 degrees, the lab screen leans back ~25-30
    R.add(disp);

    // soft contact shadow
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(600, 640), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.set(30, table + 0.1, -20);
    R.add(sh);

    // spool on its stand, behind the printer
    this._buildSpool(table, colX);

    // ---------------- bed (moves in Z)
    const B = this.bedCarriage;
    B.add(bb(-90, 90, -16, -13, -88, 88, m.alu, 1.5));                        // Y carriage plate
    for (const x of [-78, 78]) for (const z of [-50, 50]) B.add(rod('z', z - 12, z + 12, 7.5, m.printed, x, -24, 16)); // bearing housings
    B.add(bb(-8, 8, -26, -16, -10, 10, m.printed, 2));                        // belt holder
    for (const [x, z] of [[-80, -78], [0, -78], [80, -78], [-80, 0], [0, 0], [80, 0], [-80, 78], [0, 78], [80, 78]]) {
      B.add(rod('y', -13, -4.8, 3, m.brass, x, z, 10));                       // 9 heatbed columns
    }
    B.userData.keep = true;           // hidden with the printer; merged on its own
    this.bed.add(B);
    // heatbed PCB
    this.bed.add(bb(-hw - 4, hw + 4, -4.8, -0.9, -hd - 10, hd + 6, m.pcb, 1));
    this.bed.add(bb(-24, 24, -9, -1.5, -hd - 22, -hd - 8, m.printed, 3));     // cable cover at the back
    // spring steel sheet, 190 x 200 (Prusa drawing): ears with locating holes at
    // the back, a shallow 3.7 mm recess along the front
    const sx0 = -95, sx1 = 95, zF = hd + 8, zB = -hd - 12; // world z of the front / back edge
    const Y = (z) => -z; // shape y = -world z
    const shape = new THREE.Shape();
    const r5 = 5;
    shape.moveTo(sx0 + r5, Y(zF));
    shape.lineTo(sx0 + 45.5 - 2, Y(zF));
    shape.lineTo(sx0 + 45.5 + 2, Y(zF - 3.7));
    shape.lineTo(sx1 - 45.5 - 2, Y(zF - 3.7));
    shape.lineTo(sx1 - 45.5 + 2, Y(zF));
    shape.lineTo(sx1 - r5, Y(zF)); shape.quadraticCurveTo(sx1, Y(zF), sx1, Y(zF - r5));
    shape.lineTo(sx1, Y(zB + r5)); shape.quadraticCurveTo(sx1, Y(zB), sx1 - r5, Y(zB));
    shape.lineTo(sx1 - 22.25 - 6, Y(zB));
    shape.quadraticCurveTo(sx1 - 41.25, Y(zB), sx1 - 44, Y(zB + 8));
    shape.lineTo(sx0 + 44, Y(zB + 8));
    shape.quadraticCurveTo(sx0 + 41.25, Y(zB), sx0 + 22.25 + 6, Y(zB));
    shape.lineTo(sx0 + r5, Y(zB)); shape.quadraticCurveTo(sx0, Y(zB), sx0, Y(zB + r5));
    shape.lineTo(sx0, Y(zF - r5)); shape.quadraticCurveTo(sx0, Y(zF), sx0 + r5, Y(zF));
    for (const hx of [sx0 + 22.25, sx1 - 22.25]) {
      const h = new THREE.Path(); h.absarc(hx, Y(zB + 5), 1.75, 0, Math.PI * 2, true); shape.holes.push(h);
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.8, bevelEnabled: false, curveSegments: 10 });
    const W = sx1 - sx0, D = zF - zB;
    const tex = sheetTexture(W, D, { x0: -hw, x1: hw, y0: -hd, y1: hd }, sx0, Y(zF));
    tex.repeat.set(1 / W, 1 / D);
    tex.offset.set(-sx0 / W, -Y(zF) / D);
    const sheetMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, metalness: 0.25 });
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x9a9da2, roughness: 0.4, metalness: 0.9 });
    const sheet = new THREE.Mesh(geo, [sheetMat, edgeMat]);
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.y = -0.8;
    this.sheet = sheet;
    sheet.userData.keep = true;
    this.bed.add(sheet);
    for (const hx of [sx0 + 22.25, sx1 - 22.25]) this.bed.add(rod('y', -1.2, 0.6, 1.6, m.chrome, hx, zB + 5, 10)); // locating pins

    // ---------------- gantry (moves in Y = print Z). Nozzle tip at y = 0.
    const G = this.gantry;
    this.rodY = [44, 72];
    // Z carriage riding the two Z rods, leadscrew nut in between
    G.add(bb(colX - 21, colX + 19, 26, 96, zRodB - 14, zRodF + 12, m.printed, 5));
    for (const z of [zRodF, zRodB]) G.add(rod('y', 22, 100, 9.6, m.alu, colX, z, 24));   // LM10 bearings
    G.add(rod('y', 96, 101, 7, m.brass, colX, rz, 16));                                      // trapezoidal nut
    // X motor hanging under the carriage, tilted like on the real printer
    const xm = stepper(34, m, 'z');
    xm.rotation.set(Math.PI / 2 + 0.75, 0, 0);
    xm.position.set(colX - 2, 16, zRodF + 26);
    G.add(xm);
    // X rods (8 x 279) from the carriage to the idler, belt between them
    const rodR = colX - 12, rodL = rodR - 279;
    for (const y of this.rodY) G.add(rod('x', rodL, rodR, 4, m.chrome, y, rz));
    G.add(bb(rodL - 18, rodL + 6, 30, 86, rz - 13, rz + 13, m.printed, 5));                 // X idler end
    const tens = rod('x', rodL - 24, rodL - 16, 3, m.screw, 58, rz); G.add(tens);            // tension screw
    G.add(bb(rodL + 2, rodR - 6, 55.5, 60.5, rz - 7, rz - 6, m.belt));
    G.add(bb(rodL + 2, rodR - 6, 55.5, 60.5, rz + 6, rz + 7, m.belt));
    // extruder on the Z carriage, motor to the outside, PTFE fitting on top
    const ex0 = colX + 19;
    G.add(bb(ex0, ex0 + 24, 38, 94, rz - 26, rz + 18, m.printed, 4));
    const em = stepper(26, m, 'x');
    em.position.set(ex0 + 24 + 13, 64, rz - 4);
    G.add(em);
    G.add(bb(ex0 + 5, ex0 + 19, 78, 96, rz + 10, rz + 20, m.printedDark, 3));               // idler lever
    const fit = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 8, 6), m.brass);
    fit.position.set(ex0 + 12, 98, rz - 6); G.add(fit);
    // PTFE leaves the top of the extruder and lands high, toward the column
    this.extruderOut = new THREE.Vector3(ex0 + 8, 120, rz - 16);
    this.extruderIn = new THREE.Vector3(ex0 + 12, 78, rz - 28);       // filament goes in at the back

    // ---------------- print head (moves in X). Origin = nozzle tip.
    const H = this.head;
    H.add(bb(-21, 21, 34, 82, rz - 13, rz + 11, m.printed, 5));                              // X carriage (bearings inside)
    // hotend: heater block, heatbreak, heatsink under a fan shroud
    H.add(bb(-8, 12, 3.4, 14, -6, 7, m.alu, 1));                                             // heater block
    H.add(rod('x', 12, 19, 3, m.chrome, 8.5, 0));                                            // heater cartridge
    H.add(rod('x', -12, -8, 1.6, m.screw, 10, 3));                                           // thermistor
    const hex = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 3, 6), m.brass);
    hex.position.y = 2.4; H.add(hex);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 0.45, 2.2, 20), m.brass);
    tip.position.y = 0.4; H.add(tip);
    this.tip = tip;
    H.add(rod('y', 14, 21, 2.3, m.chrome, 0, 0, 12));                                        // heatbreak
    for (let i = 0; i < 8; i++) H.add(rod('y', 21 + i * 3.1, 22.4 + i * 3.1, 11, m.alu, 0, 0, 28)); // heatsink fins
    // fan shroud with its grille facing front
    H.add(bb(-19, 19, 18, 58, -9, 17, m.printedDark, 4));
    const grille = new THREE.Mesh(new THREE.CircleGeometry(14, 36), m.motor);
    grille.position.set(0, 38, 17.1); H.add(grille);
    for (let k = 0; k < 3; k++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(4 + k * 3.6, 5.2 + k * 3.6, 36), m.printedDark);
      ring.position.set(0, 38, 17.2); H.add(ring);
    }
    for (const a of [0.52, 2.62, 4.71]) {                                                    // grille spokes
      const spoke = box(1.2, 13, 0.6, m.printedDark, Math.cos(a) * 7, 38 + Math.sin(a) * 7, 17.3);
      spoke.rotation.z = a + Math.PI / 2; H.add(spoke);
    }
    // PTFE fitting on top
    const hf = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 7, 6), m.brass);
    hf.position.set(0, 61.5, 0); H.add(hf);
    this.headIn = new THREE.Vector3(0, 68, -2);
    // bed probe on the left: 29 mm off the nozzle, like the firmware's probe offset
    H.add(bb(-37, -21, 26, 38, -6, 10, m.printedDark, 3));                                   // probe holder
    H.add(rod('y', 2.2, 34, 4, m.anod, -29, 3, 20));
    H.add(rod('y', 1.5, 2.2, 3.2, m.pcb, -29, 3, 20));
    // part-cooling blower behind the head, duct down to the nozzle
    const blower = new THREE.Group();
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(23, 23, 14, 36), m.fanGlass);
    housing.rotation.z = Math.PI / 2; blower.add(housing);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 14.4, 24), m.motor);
    hub.rotation.z = Math.PI / 2; blower.add(hub);
    blower.add(bb(-7, 7, -30, -10, 8, 22, m.fanGlass, 3));                                   // outlet
    blower.position.set(16, 50, rz - 34);
    H.add(blower);
    H.add(bb(9, 23, 6, 22, rz - 30, -2, m.printedDark, 3));                                  // duct
    H.add(bb(4, 14, 3, 9, -8, 6, m.printedDark, 2));                                         // duct nozzle
    // glow at the tip while extruding
    this.glow = new THREE.PointLight(0xffa860, 0, 30, 2);
    this.glow.position.y = 1;
    H.add(this.glow);

    // Bowden tube (reshaped in place as the head moves; both ends ride on the gantry)
    this.tubeLive = new LiveTube(64, 12, 2, m.tube);
    this.tube = this.tubeLive.mesh;
    this.gantry.add(this.tube);

    // braided sleeve: head, along the X rods, up the back of the column
    const braid = braidTexture();
    this.cableMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.88, metalness: 0.04, map: braid });
    this.cableLive = new LiveTube(48, 10, 4.2, this.cableMat);
    this.cable = this.cableLive.mesh;
    this.root.add(this.cable);
    this.cableStateX = NaN;
    this.cableStateY = NaN;
  }

  _buildSpool(table, colX) {
    const { m } = this;
    const S = new THREE.Group();
    const zExt = this.zExt, midY = this.colMidY;
    const R = 92, width = 64, hubR = 22;
    // arm clipped to the right face of the Z extrusion, axle along X
    const clipX = colX + 15;
    S.add(bb(colX + 6, clipX + 8, midY - 24, midY + 24, zExt - 20, zExt + 18, m.printed, 3));
    const cx = clipX + 36 + width / 2;
    S.add(bb(clipX, cx - width / 2 + 4, midY - 8, midY + 8, zExt - 9, zExt + 9, m.printed, 2));
    S.add(rod('x', cx - width / 2 - 10, cx + width / 2 + 12, 6, m.screw, midY, zExt, 16));
    const flange = new THREE.CylinderGeometry(R, R, 3.2, 64);
    for (const x of [-width / 2 - 1.6, width / 2 + 1.6]) {
      const f = new THREE.Mesh(flange, m.spool);
      f.rotation.z = Math.PI / 2; f.position.set(cx + x, midY, zExt); S.add(f);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(hubR, hubR, width, 32, 1, true), m.spool);
    hub.rotation.z = Math.PI / 2; hub.position.set(cx, midY, zExt); S.add(hub);
    const windR = R - 14;
    const wm = m.filament.clone();
    wm.map = windingTexture();
    this.windMat = wm;
    const wind = new THREE.Mesh(new THREE.CylinderGeometry(windR, windR, width - 2, 64, 1, true), wm);
    wind.rotation.z = Math.PI / 2; wind.position.set(cx, midY, zExt); S.add(wind);
    wind.userData.keep = true;
    this.spoolTop = new THREE.Vector3(cx, midY + windR, zExt);
    this.root.add(S);
    // the free strand from the top of the spool into the extruder
    this.filLive = new LiveTube(32, 6, 0.9, m.filament);
    this.fil = this.filLive.mesh;
    this.root.add(this.fil);
  }

  /** filament colour for the spool and the strand feeding the printer */
  setFilamentColor(hex) {
    this.m.filament.color.set(hex);
    if (this.windMat) this.windMat.color.set(hex);
  }

  /** hx: nozzle X (world), hy: nozzle height, bedZ: bed offset along Z */
  setPose(hx, hy, bedZ, extruding) {
    this.head.position.x = hx;
    this.gantry.position.y = hy;
    this.bed.position.z = bedZ;
    this.glow.intensity = extruding ? 3 : 0;
    // Bowden tube: a fixed length between the head and the extruder, both on the
    // gantry, so its shape only depends on X. Both ends leave straight up (the
    // push-fit fittings point up) and the tube arcs over: a big loop when the
    // head is close to the extruder, a flatter arc when it's far. A PTFE tube
    // can't bend sharper than ~25 mm without kinking, so the arc never flattens
    // past a 30 mm lift (in the last ~30 mm of travel at the far left that makes
    // it up to ~4% longer than 275 mm, instead of snapping into a straight line).
    if (!(Math.abs(hx - this.tubeState) <= 0.02)) {
      this.tubeState = hx;
      const T = this.tubeLive, c = T.ctl;
      const p0 = c[0].copy(this.headIn); p0.x += hx;
      const p3 = c[3].copy(this.extruderOut);
      const shape = (k) => { c[1].copy(p0); c[1].y += k; c[2].copy(p3); c[2].y += k; };
      let lo = TUBE_LIFT, hi = 400;
      shape(lo);
      if (T.length(p0, c[1], c[2], p3) < TUBE_LEN) {
        for (let i = 0; i < 22; i++) {
          const mid = (lo + hi) / 2;
          shape(mid);
          if (T.length(p0, c[1], c[2], p3) < TUBE_LEN) lo = mid; else hi = mid;
        }
      }
      shape(lo);
      T.setBezier(p0, c[1], c[2], p3);
    }
    // the filament strand from the spool into the back of the extruder
    if (!(Math.abs(hy - this.filState) <= 0.02)) {
      this.filState = hy;
      const F = this.filLive, c = F.ctl;
      const top = c[0].copy(this.spoolTop);
      const pin = c[3].copy(this.extruderIn); pin.y += hy;
      // a quadratic sag-free arc (the strand is under a little tension), as a cubic
      const mid = F.mid || (F.mid = new THREE.Vector3());
      mid.set((top.x + pin.x) / 2, Math.max(top.y, pin.y) + 18, (top.z + pin.z) / 2);
      c[1].copy(top).lerp(mid, 2 / 3);
      c[2].copy(pin).lerp(mid, 2 / 3);
      F.setBezier(top, c[1], c[2], pin);
    }
    // braided cable: follows the head in X and the gantry in Z
    if (this.cableLive && !(Math.abs(hx - this.cableStateX) <= 0.5 && Math.abs(hy - this.cableStateY) <= 0.5)) {
      this.cableStateX = hx;
      this.cableStateY = hy;
      const C = this.cableLive, c = C.ctl;
      // just in front of the X rods so the sleeve reads from the front, then up the column back
      const y = hy + 78, z = this.rz + 8;
      c[0].set(hx - 4, y, z);
      c[1].set((hx + this.colX) * 0.5, y + 10, z);
      c[2].set(this.colX + 6, hy + 90, this.zExt - 20);
      c[3].set(this.colX + 6, this.extTop - 12, this.zExt - 20);
      C.setBezier(c[0], c[1], c[2], c[3]);
    }
  }

  /** Draw the front screen in the MINI's layout. Returns false if nothing changed. */
  setScreen(opts = {}) {
    const o = opts;
    const name = String(o.fileName || '');
    const off = name.length > 20 ? marqueeChars(name.length, Date.now()) : 0;
    const nozzle = o.nozzle || {};
    const bed = o.bed || {};
    const pct = Math.max(0, Math.min(100, Math.round(Number(o.percent) || 0)));
    const key = [
      o.mode, name, off, pct,
      fmtElapsed(o.elapsedSec), fmtRemain(o.remainingMin),
      o.status1 || '', o.status2 || '',
      Math.round(Number(nozzle.cur) || 0), Math.round(Number(nozzle.tgt) || 0),
      Math.round(Number(bed.cur) || 0), Math.round(Number(bed.tgt) || 0),
      Math.round(Number(o.speedPct) || 0),
      Number.isFinite(+o.z) ? (+o.z).toFixed(2) : '',
      o.material || '', o.paused || o.mode === 'paused' ? 1 : 0,
    ].join('|');
    if (key === this._screenKey) return false;
    this._screenKey = key;
    drawMiniScreen(this.screenCanvas, { ...o, fileName: name, percent: pct, marquee: off });
    this.screenTex.needsUpdate = true;
    return true;
  }

  get bounds() {
    // the printer itself (the spool behind it can run off the edge of the frame)
    return { min: [-this.bedW / 2 - 90, this.baseY, -170], max: [this.colX + 160, this.colTop, this.bedD / 2 + 90] };
  }
}
