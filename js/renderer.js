// three.js scene. Every extrusion segment is one instance of a camera-facing
// quad that the fragment shader shades like a round filament strand.
// Progress is a single uniform (uHead = segments done + fraction of current),
// so advancing the print costs nothing on the CPU.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

const FEATURE_COLORS = [
  '#9aa0a6', // other
  '#ff8a3d', // external perimeter
  '#ffc857', // perimeter
  '#3d7bff', // overhang
  '#c0392b', // internal infill
  '#a55eea', // solid infill
  '#ff4d6d', // top solid
  '#4dd0e1', // bridge
  '#ffffff', // gap fill
  '#2ecc71', // skirt/brim
  '#27ae60', // support
  '#1abc9c', // support interface
  '#e0e0e0', // wipe tower
  '#95a5a6', // ironing
  '#6c7a89', // custom
];

const vert = /* glsl */`
  attribute vec2 corner;
  attribute vec3 iStart;
  attribute vec3 iEnd;
  attribute float iMeta;
  uniform float uHead;
  uniform float uPass;        // 0 = printed, 1 = ghost (not yet printed)
  uniform vec2 uCenter;       // bed center in gcode coords
  uniform vec3 uColor;
  uniform float uColorMode;   // 0 filament, 1 feature
  uniform vec3 uPalette[15];
  uniform float uGlow;
  varying float vSide;
  varying vec3 vSideDir;
  varying vec3 vViewDir;
  varying vec3 vColor;
  varying float vHot;

  vec3 toWorld(vec3 g) { return vec3(g.x - uCenter.x, g.z, -(g.y - uCenter.y)); }

  void main() {
    float idx = float(gl_InstanceID);
    float headIdx = floor(uHead);
    float f = uHead - headIdx;
    vec3 s = iStart;
    vec3 e = iEnd;
    bool hide = false;
    if (uPass < 0.5) {
      if (idx > headIdx) hide = true;
      else if (idx == headIdx) { if (f <= 0.0) hide = true; else e = mix(s, e, f); }
    } else {
      if (idx < headIdx) hide = true;
      else if (idx == headIdx) s = mix(s, e, f);
    }
    if (hide) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }

    float feat = floor(iMeta / 4.0 + 0.001);
    float width = iMeta - feat * 4.0;
    vec3 ws = toWorld(s);
    vec3 we = toWorld(e);
    vec3 d = we - ws;
    float L = length(d);
    vec3 dn = L > 1e-5 ? d / L : vec3(1.0, 0.0, 0.0);
    vec3 mid = 0.5 * (ws + we);
    vec3 viewDir = normalize(cameraPosition - mid);
    vec3 side = cross(dn, viewDir);
    if (length(side) < 1e-4) side = cross(dn, vec3(0.0, 1.0, 0.0));
    side = normalize(side);
    float hw = 0.5 * width;
    vec3 p = mix(ws - dn * hw * 0.5, we + dn * hw * 0.5, corner.x) + side * corner.y * hw;

    vSide = corner.y;
    vSideDir = side;
    vViewDir = viewDir;
    int fi = int(feat);
    vColor = uColorMode > 0.5 ? uPalette[fi] : uColor;
    // freshly extruded plastic glows a little
    vHot = uPass < 0.5 ? uGlow * exp(-(headIdx - idx) / 25.0) : 0.0;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const frag = /* glsl */`
  uniform float uPass;
  uniform float uGhostAlpha;
  varying float vSide;
  varying vec3 vSideDir;
  varying vec3 vViewDir;
  varying vec3 vColor;
  varying float vHot;

  void main() {
    float s = clamp(vSide, -1.0, 1.0);
    float c = sqrt(max(1.0 - s * s, 0.0));
    vec3 n = normalize(vSideDir * s + vViewDir * c);
    if (uPass > 0.5) {
      float a = uGhostAlpha * (0.35 + 0.65 * c);
      gl_FragColor = vec4(mix(vColor, vec3(0.82, 0.86, 0.92), 0.72), a);
      return;
    }
    vec3 L1 = normalize(vec3(0.35, 0.9, 0.45));
    vec3 L2 = normalize(vec3(-0.6, 0.35, -0.5));
    float diff = max(dot(n, L1), 0.0);
    float fill = max(dot(n, L2), 0.0);
    float head = max(dot(n, vViewDir), 0.0);
    vec3 col = vColor * (0.22 + 0.55 * diff + 0.18 * fill + 0.22 * head);
    vec3 h = normalize(L1 + vViewDir);
    col += vec3(0.28) * pow(max(dot(n, h), 0.0), 36.0);
    col = mix(col, vec3(1.0, 0.62, 0.3), clamp(vHot, 0.0, 0.7));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

function makeBedTexture(w, d) {
  const px = 8; // pixels per mm
  const cw = Math.min(2048, Math.round(w * px)), ch = Math.min(2048, Math.round(d * px));
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, cw, ch);
  grad.addColorStop(0, '#26282d');
  grad.addColorStop(1, '#1b1d21');
  g.fillStyle = grad;
  g.fillRect(0, 0, cw, ch);
  // subtle powder-coat speckle
  const img = g.getImageData(0, 0, cw, ch);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const sx = cw / w, sy = ch / d;
  for (let mm = 0; mm <= Math.max(w, d); mm += 10) {
    const major = mm % 50 === 0;
    g.strokeStyle = major ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
    g.lineWidth = major ? 2 : 1;
    if (mm <= w) { g.beginPath(); g.moveTo(mm * sx, 0); g.lineTo(mm * sx, ch); g.stroke(); }
    if (mm <= d) { g.beginPath(); g.moveTo(0, ch - mm * sy); g.lineTo(cw, ch - mm * sy); g.stroke(); }
  }
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, cw - 4, ch - 4);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class PrintView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 5000);
    this.camera.position.set(160, 170, 230);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 1200;
    this.controls.addEventListener('change', () => { this.dirty = true; });

    this.center = new THREE.Vector2(90, 90);
    this.uniforms = {
      uHead: { value: 0 },
      uPass: { value: 0 },
      uCenter: { value: this.center },
      uColor: { value: new THREE.Color('#ff8000') },
      uColorMode: { value: 0 },
      uPalette: { value: FEATURE_COLORS.map(c => new THREE.Color(c)) },
      uGlow: { value: 1 },
      uGhostAlpha: { value: 0.1 },
    };

    this.bedGroup = new THREE.Group();
    this.scene.add(this.bedGroup);

    // nozzle marker
    const nozzle = new THREE.Group();
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(1.6, 3.5, 24, 1),
      new THREE.MeshStandardMaterial({ color: 0xd4a94f, metalness: 0.8, roughness: 0.3 }),
    );
    tip.rotation.x = Math.PI;
    tip.position.y = 1.75;
    nozzle.add(tip);
    const block = new THREE.Mesh(
      new THREE.CylinderGeometry(2.6, 2.6, 2.2, 6),
      new THREE.MeshStandardMaterial({ color: 0xd4a94f, metalness: 0.8, roughness: 0.3 }),
    );
    block.position.y = 4.6;
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 18, 16),
      new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.7, roughness: 0.35, transparent: true, opacity: 0.3 }),
    );
    barrel.position.y = 14.7;
    nozzle.add(barrel);
    nozzle.add(block);
    const glow = new THREE.PointLight(0xffa860, 0, 30, 2);
    glow.position.y = 1;
    nozzle.add(glow);
    this.nozzleGlow = glow;
    nozzle.visible = false;
    this.nozzle = nozzle;
    this.scene.add(nozzle);

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x202328, 1.1));
    const dl = new THREE.DirectionalLight(0xffffff, 1.6);
    dl.position.set(100, 250, 120);
    this.scene.add(dl);

    this.mesh = null;
    this.ghost = null;
    this.segCount = 0;
    this.dirty = true;
    this.lastW = 0; this.lastH = 0;
    this.insets = { left: 0, bottom: 0 };
    this.setBed(180, 180);

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  setBed(w, d) {
    this.bedW = w; this.bedD = d;
    this.bedGroup.clear();
    const tex = makeBedTexture(w, d);
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(w, 1.2, d),
      [
        new THREE.MeshStandardMaterial({ color: 0x15171a }),
        new THREE.MeshStandardMaterial({ color: 0x15171a }),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.1 }),
        new THREE.MeshStandardMaterial({ color: 0x15171a }),
        new THREE.MeshStandardMaterial({ color: 0x15171a }),
        new THREE.MeshStandardMaterial({ color: 0x15171a }),
      ],
    );
    plate.position.set(0, -0.62, 0);
    this.bedGroup.add(plate);
    this.dirty = true;
  }

  setData(segs, bbox) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost.geometry.dispose(); }
    this.segCount = segs.move.length;
    this.center.set(this.bedW / 2, this.bedD / 2);

    const aStart = new THREE.InstancedBufferAttribute(segs.start, 3);
    const aEnd = new THREE.InstancedBufferAttribute(segs.end, 3);
    const aMeta = new THREE.InstancedBufferAttribute(segs.meta, 1);
    const corner = new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), 2);
    const index = [0, 2, 1, 1, 2, 3];

    const mk = (pass) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('corner', corner);
      g.setIndex(index);
      g.setAttribute('iStart', aStart);
      g.setAttribute('iEnd', aEnd);
      g.setAttribute('iMeta', aMeta);
      g.instanceCount = this.segCount;
      const u = { ...this.uniforms, uPass: { value: pass } };
      const m = new THREE.ShaderMaterial({
        uniforms: u, vertexShader: vert, fragmentShader: frag,
        transparent: pass === 1, depthWrite: pass === 0, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = pass;
      return mesh;
    };
    this.mesh = mk(0);
    this.ghost = mk(1);
    this.scene.add(this.mesh);
    this.scene.add(this.ghost);
    this.bbox = bbox;
    this.fit();
    this.dirty = true;
  }

  /** Space covered by UI (px). The camera shifts so the model sits in the visible part. */
  setInsets(left, bottom) {
    left = Math.round(left); bottom = Math.round(bottom);
    if (left === this.insets.left && bottom === this.insets.bottom) return;
    this.insets = { left, bottom };
    this._applyOffset();
  }

  _applyOffset() {
    const w = this.lastW, h = this.lastH;
    if (!w || !h) return;
    this.camera.setViewOffset(w, h, -this.insets.left / 2, this.insets.bottom / 2, w, h);
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  fit() {
    const b = this.bbox;
    let cx = 0, cy = 0, cz = 0, r = Math.max(this.bedW, this.bedD) * 0.55;
    if (b && isFinite(b.min[0])) {
      cx = (b.min[0] + b.max[0]) / 2 - this.center.x;
      cy = (b.min[2] + b.max[2]) / 2;
      cz = -((b.min[1] + b.max[1]) / 2 - this.center.y);
      const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
      r = Math.max(12, Math.sqrt(sx * sx + sy * sy + sz * sz) * 0.5);
    }
    const w = Math.max(this.lastW || this.canvas.clientWidth, 1), h = Math.max(this.lastH || this.canvas.clientHeight, 1);
    const visW = Math.max(w - this.insets.left, w * 0.3), visH = Math.max(h - this.insets.bottom, h * 0.25);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dV = r / tanV * (h / visH);
    const dH = r / (tanV * (w / h)) * (w / visW);
    const dist = Math.max(dV, dH) * 1.3;
    const target = new THREE.Vector3(cx, cy, cz);
    const dir = new THREE.Vector3(0.55, 0.55, 0.9).normalize();
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.controls.update();
    this.dirty = true;
  }

  setHead(segHead, headPos, show, extruding) {
    const u = this.uniforms;
    if (u.uHead.value !== segHead) { u.uHead.value = segHead; this.dirty = true; }
    if (this.mesh) this.mesh.geometry.instanceCount = Math.min(this.segCount, Math.floor(segHead) + 1);
    this.nozzle.visible = !!show;
    if (show && headPos) {
      const p = this.nozzle.position;
      const nx = headPos[0] - this.center.x, ny = headPos[2], nz = -(headPos[1] - this.center.y);
      if (p.x !== nx || p.y !== ny || p.z !== nz) { p.set(nx, ny, nz); this.dirty = true; }
      const gi = extruding ? 2.5 : 0;
      if (this.nozzleGlow.intensity !== gi) { this.nozzleGlow.intensity = gi; this.dirty = true; }
    }
  }

  setColor(hex) { this.uniforms.uColor.value.set(hex); this.dirty = true; }
  setColorMode(mode) { this.uniforms.uColorMode.value = mode === 'feature' ? 1 : 0; this.dirty = true; }
  setGhost(on) { if (this.ghost) this.ghost.visible = on; this.ghostOn = on; this.dirty = true; }
  setGlow(on) { this.uniforms.uGlow.value = on ? 1 : 0; this.dirty = true; }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w !== this.lastW || h !== this.lastH) {
      this.lastW = w; this.lastH = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / Math.max(h, 1);
      this.camera.updateProjectionMatrix();
      this._applyOffset();
      this.dirty = true;
    }
  }

  _loop() {
    requestAnimationFrame(this._loop);
    if (this.onFrame) this.onFrame();
    this._resize();
    this.controls.update();
    if (this.ghost && this.ghostOn === false) this.ghost.visible = false;
    if (this.dirty) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  }
}

export { FEATURE_COLORS };
