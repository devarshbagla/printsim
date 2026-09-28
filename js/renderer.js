// three.js scene. Every extrusion segment is one instance of a camera-facing
// quad that the fragment shader shades like a round filament strand.
// Progress is a single uniform (uHead = segments done + fraction of current),
// so advancing the print costs nothing on the CPU.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { PrinterModel } from './printer3d.js';

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
  attribute vec2 iDrop;       // how far each end of this piece falls (0 = held)
  attribute vec2 iTime;       // sim time each end of this piece is extruded
  attribute float iSeed;      // per-strand seed, so neighbouring strands fold differently
  attribute vec2 iSag;        // bridge droop at start/end of this piece (mm)
  uniform float uCurl;        // material: how wild fallen strands get
  uniform float uHead;
  uniform float uSimTime;
  uniform float uFallTime;    // sim seconds a fall takes (scaled with playback speed)
  uniform float uPhysics;
  uniform float uWarnTint;    // tint doomed strands red in the printed pass
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
  varying float vDoom;

  // Smooth wobble so fallen strands curl like spaghetti. It depends only on the
  // ORIGINAL position of a point and its strand's seed, so the shared end of two
  // neighbouring pieces always moves identically: strands never tear apart.
  vec2 curl(vec3 g, float seed) {
    float a = seed * 6.2832, k = 0.7 + seed * 0.6;
    vec2 w = vec2(sin(g.y * 0.83 * k + g.z * 2.1 + a) + 0.6 * sin(g.x * 0.31 + g.z * 0.7 + a * 1.7),
                  sin(g.x * 0.77 * k + g.z * 1.9 - a) + 0.6 * sin(g.y * 0.29 + g.z * 0.9 + a * 2.3));
    float c = cos(a), s = sin(a);
    return vec2(c * w.x - s * w.y, s * w.x + c * w.y);
  }
  // fall of one END of a piece: hangs, accelerates, settles (zero speed at both ends)
  float fallOf(float t0) {
    float p = clamp((uSimTime - t0) / uFallTime, 0.0, 1.0);
    return p * p * (3.0 - 2.0 * p);
  }

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

    vDoom = (uPhysics > 0.5 && (iDrop.x > 0.0 || iDrop.y > 0.0)) ? 1.0 : 0.0;
    if (uPhysics > 0.5) { s.z -= iSag.x; e.z -= iSag.y; }
    if (uPass < 0.5 && vDoom > 0.5) {
      // each end falls on its own clock (the moment the nozzle laid it) by its own
      // distance; the strand stays attached at the nozzle and at any hinge
      vec3 s0 = iStart, e0 = iEnd;
      float fs = fallOf(iTime.x), fe = fallOf(iTime.y);
      s.xy += curl(s0, iSeed) * min(0.25 + iDrop.x * 0.22, 4.0) * uCurl * fs * step(0.0001, iDrop.x);
      e.xy += curl(e0, iSeed) * min(0.25 + iDrop.y * 0.22, 4.0) * uCurl * fe * step(0.0001, iDrop.y);
      s.z -= iDrop.x * fs;
      e.z -= iDrop.y * fe;
    }

    float feat = floor(iMeta / 4.0 + 0.001);
    float width = iMeta - feat * 4.0;
    vec3 ws = toWorld(s);
    vec3 we = toWorld(e);
    vec3 d = we - ws;
    float L = length(d);
    vec3 dn = L > 1e-5 ? d / L : vec3(1.0, 0.0, 0.0);
    vec3 mid = 0.5 * (ws + we);
    vec3 viewDir = normalize(cameraPosition - (modelMatrix * vec4(mid, 1.0)).xyz);
    vec3 side = cross(dn, viewDir);
    if (length(side) < 1e-4) side = cross(dn, vec3(0.0, 1.0, 0.0));
    side = normalize(side);
    float hw = 0.5 * width;
    vec3 p = mix(ws - dn * hw * 0.5, we + dn * hw * 0.5, corner.x) + side * corner.y * hw;

    vSide = corner.y;
    vSideDir = side;
    vViewDir = viewDir;
    int fi = int(feat);
    vColor = uColorMode > 0.5 ? (vDoom > 0.5 ? vec3(1.0, 0.16, 0.12) : uPalette[fi]) : uColor;
    if (vDoom > 0.5 && uPass < 0.5) vColor = mix(vColor, vec3(1.0, 0.16, 0.12), uWarnTint);
    // freshly extruded plastic is a touch brighter right behind the nozzle
    vHot = uPass < 0.5 ? uGlow * 0.4 * exp(-(headIdx - idx) / 10.0) : 0.0;
    gl_Position = projectionMatrix * viewMatrix * (modelMatrix * vec4(p, 1.0));
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
  varying float vDoom;

  void main() {
    float s = clamp(vSide, -1.0, 1.0);
    float c = sqrt(max(1.0 - s * s, 0.0));
    vec3 n = normalize(vSideDir * s + vViewDir * c);
    if (uPass > 0.5) {
      float a = uGhostAlpha * (0.35 + 0.65 * c);
      vec3 gc = vDoom > 0.5 ? vec3(1.0, 0.25, 0.2) : mix(vColor, vec3(0.82, 0.86, 0.92), 0.72);
      gl_FragColor = vec4(gc, vDoom > 0.5 ? min(a * 2.2, 0.5) : a);
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
    col = mix(col, min(vColor * 1.35 + vec3(0.08), vec3(1.0)), clamp(vHot, 0.0, 0.4));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

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
      uSimTime: { value: 0 },
      uFallTime: { value: 0.8 },
      uPhysics: { value: 1 },
      uWarnTint: { value: 0 },
      uCurl: { value: 1 },
    };


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

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x202328, 0.7));
    const dl = new THREE.DirectionalLight(0xffffff, 1.3);
    dl.position.set(100, 250, 120);
    this.scene.add(dl);

    this.mesh = null;
    this.ghost = null;
    this.segCount = 0;
    this.dirty = true;
    this.lastW = 0; this.lastH = 0;
    this.insets = { left: 0, bottom: 0 };
    this.printerView = true;
    this.lastHead = null;
    this.setBed(180, 180);

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  setBed(w, d) {
    this.bedW = w; this.bedD = d;
    this.center.set(w / 2, d / 2);
    if (this.printer) {
      this.scene.remove(this.printer.root, this.printer.gantry, this.printer.bed);
      // keep the print meshes: they get re-parented below
    }
    this.printer = new PrinterModel(w, d);
    this.scene.add(this.printer.root, this.printer.gantry, this.printer.bed);
    if (this.mesh) this.printer.bed.add(this.mesh);
    if (this.ghost) this.printer.bed.add(this.ghost);
    this._applyView();
    this.dirty = true;
  }

  setPrinterView(on) {
    this.printerView = !!on;
    this._applyView();
    this.fit();
  }

  _applyView() {
    const pr = this.printer;
    if (!pr) return;
    pr.root.visible = this.printerView;
    pr.gantry.visible = this.printerView;
    pr.bedCarriage.visible = this.printerView;
    if (!this.printerView) pr.bed.position.z = 0;
    this._pose();
    this.dirty = true;
  }

  _pose() {
    const pr = this.printer;
    if (!pr) return;
    if (!this.printerView) { this.nozzle.visible = !!(this.lastHead && this.lastHead.show); return; }
    this.nozzle.visible = false;
    const h = this.lastHead;
    let hx, hy, bz, ex = false;
    if (h && h.pos && h.show) {
      hx = h.pos[0] - this.center.x; hy = h.pos[2]; bz = h.pos[1] - this.center.y; ex = h.extruding;
    } else {
      // parked: head to the right, above the print, bed centred
      const top = this.bbox && isFinite(this.bbox.max[2]) ? this.bbox.max[2] : 0;
      hx = this.bedW / 2 - 5; hy = Math.max(top + 25, 40); bz = 0;
    }
    pr.setPose(hx, hy, bz, ex);
  }

  setScreen(opts) { if (this.printer && this.printer.setScreen(opts)) this.dirty = true; }

  setData(segs, bbox) {
    if (this.mesh) { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); }
    if (this.ghost) { this.ghost.removeFromParent(); this.ghost.geometry.dispose(); }
    this.segCount = segs.move.length;
    this.center.set(this.bedW / 2, this.bedD / 2);

    const aStart = new THREE.InstancedBufferAttribute(segs.start, 3);
    const aEnd = new THREE.InstancedBufferAttribute(segs.end, 3);
    const aMeta = new THREE.InstancedBufferAttribute(segs.meta, 1);
    const aDrop = new THREE.InstancedBufferAttribute(segs.drop || new Float32Array(segs.meta.length * 2), 2);
    const aSeed = new THREE.InstancedBufferAttribute(segs.seed || new Float32Array(segs.meta.length), 1);
    const aSag = new THREE.InstancedBufferAttribute(segs.sag || new Float32Array(segs.meta.length * 2), 2);
    this.aTime = new THREE.InstancedBufferAttribute(new Float32Array(segs.meta.length * 2), 2);
    this.aTime.setUsage(THREE.DynamicDrawUsage);
    const corner = new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), 2);
    const index = [0, 2, 1, 1, 2, 3];

    const mk = (pass) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('corner', corner);
      g.setIndex(index);
      g.setAttribute('iStart', aStart);
      g.setAttribute('iEnd', aEnd);
      g.setAttribute('iMeta', aMeta);
      g.setAttribute('iDrop', aDrop);
      g.setAttribute('iTime', this.aTime);
      g.setAttribute('iSag', aSag);
      g.setAttribute('iSeed', aSeed);
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
    this.printer.bed.add(this.mesh);
    this.printer.bed.add(this.ghost);
    this.bbox = bbox;
    this._pose();
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
    if (this.printerView && this.printer) {
      const pb = this.printer.bounds;
      cx = (pb.min[0] + pb.max[0]) / 2; cy = (pb.min[1] + pb.max[1]) / 2 - 20; cz = (pb.min[2] + pb.max[2]) / 2;
      r = Math.hypot(pb.max[0] - pb.min[0], pb.max[1] - pb.min[1], pb.max[2] - pb.min[2]) * (this.camera.aspect < 1 ? 0.46 : 0.38);
    } else if (b && isFinite(b.min[0])) {
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
    this.lastHead = { pos: headPos ? headPos.slice() : null, show: !!show, extruding: !!extruding };
    if (this.printerView) { this._pose(); this.dirty = true; return; }
    this.nozzle.visible = !!show;
    if (show && headPos) {
      const p = this.nozzle.position;
      const nx = headPos[0] - this.center.x, ny = headPos[2], nz = -(headPos[1] - this.center.y);
      if (p.x !== nx || p.y !== ny || p.z !== nz) { p.set(nx, ny, nz); this.dirty = true; }
      const gi = extruding ? 2.5 : 0;
      if (this.nozzleGlow.intensity !== gi) { this.nozzleGlow.intensity = gi; this.dirty = true; }
    }
  }

  /** Sim time at which each segment finishes (drives the fall animation). */
  setSegTimes(times) {
    if (!this.aTime || times.length !== this.aTime.array.length) return;
    this.aTime.array.set(times);
    this.aTime.needsUpdate = true;
    this.dirty = true;
  }
  setSimTime(t, fallTime = 0.8) {
    const u = this.uniforms;
    if (u.uSimTime.value !== t || u.uFallTime.value !== fallTime) {
      u.uSimTime.value = t; u.uFallTime.value = fallTime; this.dirty = true;
    }
  }
  setWarnTint(v) { if (this.uniforms.uWarnTint.value !== v) { this.uniforms.uWarnTint.value = v; this.dirty = true; } }
  setCurl(v) { this.uniforms.uCurl.value = v; this.dirty = true; }
  setPhysics(on) { this.uniforms.uPhysics.value = on ? 1 : 0; this.dirty = true; }

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
