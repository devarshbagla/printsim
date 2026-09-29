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

// Each strand is drawn with its real cross-section: a "stadium" as wide as the
// line and as tall as the layer (flat where it was squashed against the layer
// below, round at the sides), which is how slicers model extrusions. The quad
// faces the camera and the fragment shader finds which point of that profile
// the pixel sees, so tops read flat, walls show their layer lines, and the
// highlights move the way they do on real plastic as you orbit.
//
// When layers get thinner than a pixel (0.1 mm layers on a phone), shading the
// profile per pixel only makes noise, so it fades to the profile's average
// normal: the same idea as mipmapping a texture.
const vert = /* glsl */`
  attribute vec2 corner;
  attribute vec3 iStart;
  attribute vec3 iEnd;
  attribute float iMeta;
  attribute float iH;         // layer height (normalized byte, x 2.55 = mm)
  attribute vec2 iDrop;       // how far each end of this piece falls (0 = held)
  attribute vec2 iTime;       // sim time each end of this piece is extruded
  attribute float iSeed;      // per-strand seed, so neighbouring strands fold differently
  attribute vec2 iSag;        // bridge droop at start/end of this piece (mm)
  uniform float uCurl;        // material: how wild fallen strands get
  uniform float uHead;
  uniform float uSimTime;
  uniform float uFallTime;    // sim seconds a fall takes (fixed: faster playback = faster falls)
  uniform float uPhysics;
  uniform float uWarnTint;    // tint doomed strands red in the printed pass
  uniform float uPass;        // 0 = printed, 1 = ghost (not yet printed)
  uniform vec2 uCenter;       // bed center in gcode coords
  uniform vec3 uColor;
  uniform float uColorMode;   // 0 filament, 1 feature
  uniform vec3 uPalette[15];
  uniform float uGlow;
  uniform float uPxScale;     // drawing-buffer px per mm at 1 mm from the camera
  varying float vSide;
  varying float vT;           // across-strand offset of this pixel (mm)
  varying vec2 vE2;           // across-screen direction in the profile plane (H, U)
  varying vec2 vW2;           // towards-camera direction in the profile plane
  varying vec2 vCR;           // profile: half flat width, corner radius (mm)
  varying vec3 vH;            // profile axes in world space: sideways, up
  varying vec3 vU;
  varying vec3 vWorld;
  varying float vDetail;      // 0 = sub-pixel strand (averaged normal), 1 = full profile
  varying float vIron;
  varying float vFlat;        // infill-type features: a flat surface seen from far away
  varying vec3 vTan;          // strand direction (world)
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
  // fall of one END of a piece: pulled off by gravity (accelerating), hits the
  // pile below, bounces back up a touch and settles
  float fallOf(float t0) {
    float p = clamp((uSimTime - t0) / uFallTime, 0.0, 1.0);
    if (p < 0.72) { float q = p / 0.72; return q * q; }
    float b = (p - 0.72) / 0.28;
    return 1.0 - 0.07 * sin(b * 3.14159) * (1.0 - b);
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

    float feat = floor(iMeta / 4.0 + 0.001);
    float width = iMeta - feat * 4.0;
    float lh = max(iH * 2.55, 0.04);
    bool iron = abs(feat - 13.0) < 0.5;
    vIron = iron ? 1.0 : 0.0;
    // infill, solid, top, bridge, support, support interface, ironing: horizontal surfaces
    vFlat = (feat > 3.5 && feat < 7.5) || (feat > 9.5 && feat < 11.5) || iron ? 1.0 : 0.0;
    // the nozzle rides on top of the strand it lays, so the strand's centre is
    // half a layer lower; ironing is a thin, glossy skin right on the top surface
    float hh = iron ? 0.03 : min(lh, width);
    float zoff = iron ? -0.004 : 0.5 * lh;

    vDoom = (uPhysics > 0.5 && (iDrop.x > 0.0 || iDrop.y > 0.0)) ? 1.0 : 0.0;
    if (uPhysics > 0.5) { s.z -= iSag.x; e.z -= iSag.y; }
    float falling = 0.0;
    float L0 = length(e.xy - s.xy);   // length before it falls (curling stretches it)
    if (uPass < 0.5 && vDoom > 0.5) {
      // each end falls on its own clock (the moment the nozzle laid it) by its own
      // distance; the strand stays attached at the nozzle and at any hinge
      vec3 s0 = iStart, e0 = iEnd;
      float fs = fallOf(iTime.x), fe = fallOf(iTime.y);
      falling = max(fs, fe);
      s.xy += curl(s0, iSeed) * min(0.25 + iDrop.x * 0.22, 4.0) * uCurl * fs * step(0.0001, iDrop.x);
      e.xy += curl(e0, iSeed) * min(0.25 + iDrop.y * 0.22, 4.0) * uCurl * fe * step(0.0001, iDrop.y);
      s.z -= iDrop.x * fs;
      e.z -= iDrop.y * fe;
    }
    s.z -= zoff; e.z -= zoff;

    vec3 ws = toWorld(s);
    vec3 we = toWorld(e);
    vec3 d = we - ws;
    float L = length(d);
    vec3 dn = L > 1e-5 ? d / L : vec3(1.0, 0.0, 0.0);
    vec3 mid = 0.5 * (ws + we);
    vec3 midW = (modelMatrix * vec4(mid, 1.0)).xyz;
    vec3 viewDir = normalize(cameraPosition - midW);
    vec3 side = cross(dn, viewDir);
    if (length(side) < 1e-4) side = cross(dn, vec3(0.0, 1.0, 0.0));
    side = normalize(side);

    // profile frame: H sideways, U up (both across the strand)
    vec3 H = cross(dn, vec3(0.0, 1.0, 0.0));
    H = length(H) < 1e-3 ? vec3(1.0, 0.0, 0.0) : normalize(H);
    vec3 U = normalize(cross(H, dn));
    vec3 vp = viewDir - dn * dot(viewDir, dn);
    vp = length(vp) < 1e-4 ? U : normalize(vp);
    vE2 = vec2(dot(side, H), dot(side, U));
    vW2 = vec2(dot(vp, H), dot(vp, U));
    // a strand pulled free of the part is a round string with the SAME volume:
    // cross-section area w x h, thinned by however much curling stretched it
    float round_ = clamp(falling * 3.0, 0.0, 1.0);
    float rFree = sqrt(width * lh / 3.14159) * sqrt(clamp(L0 / max(L, 1e-4), 0.25, 1.0));
    float c = mix(max(width - hh, 0.0) * 0.5, 0.0, round_);
    float r = mix(hh * 0.5, rFree, round_);
    vCR = vec2(c, r);
    float rE = c * abs(vE2.x) + r;

    // sub-pixel strands: keep them at least ~0.6 px wide (no gaps, no flicker)
    float dist = length(cameraPosition - midW);
    float px = rE * uPxScale / max(dist, 1e-3);
    float half_ = max(rE, min(0.6 * dist / uPxScale, width * 0.5));
    vDetail = smoothstep(0.7, 2.4, px);
    vT = corner.y * half_;

    float ext = width * 0.25;
    vec3 p = mix(ws - dn * ext, we + dn * ext, corner.x) + side * vT;

    vSide = corner.y;
    vH = H; vU = U; vTan = dn;
    vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
    int fi = int(feat);
    vColor = uColorMode > 0.5 ? (vDoom > 0.5 ? vec3(1.0, 0.16, 0.12) : uPalette[fi]) : uColor;
    if (vDoom > 0.5 && uPass < 0.5) vColor = mix(vColor, vec3(1.0, 0.16, 0.12), uWarnTint);
    // freshly extruded plastic is a touch brighter right behind the nozzle
    vHot = uPass < 0.5 ? uGlow * 0.4 * exp(-(headIdx - idx) / 10.0) : 0.0;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const frag = /* glsl */`
  uniform float uPass;
  uniform float uGhostAlpha;
  uniform float uRough;       // surface roughness (PLA ~0.42, PETG glossier, silk very glossy)
  uniform float uMetal;       // silk filaments: colour-tinted, metal-like highlights
  varying float vSide;
  varying float vT;
  varying vec2 vE2;
  varying vec2 vW2;
  varying vec2 vCR;
  varying vec3 vH;
  varying vec3 vU;
  varying vec3 vWorld;
  varying float vDetail;
  varying float vIron;
  varying float vFlat;
  varying vec3 vTan;
  varying vec3 vColor;
  varying float vHot;
  varying float vDoom;

  // Which point of the stadium profile (flat top/bottom of half-width c, round
  // sides of radius r) a ray at offset t across the strand hits first.
  vec2 profileNormal(float t, vec2 e2, vec2 w2, float c, float r) {
    float best = -1e9;
    vec2 n = w2;
    if (c > 0.0 && abs(w2.y) > 1e-4) {
      float sy = w2.y > 0.0 ? 1.0 : -1.0;
      float lam = (sy * r - t * e2.y) / w2.y;
      float x = t * e2.x + lam * w2.x;
      if (abs(x) <= c) { best = lam; n = vec2(0.0, sy); }
    }
    for (int k = 0; k < 2; k++) {
      vec2 C = vec2(k == 0 ? -c : c, 0.0);
      float qe = dot(C, e2), qw = dot(C, w2);
      float dd = r * r - (t - qe) * (t - qe);
      if (dd >= 0.0) {
        float lam = qw + sqrt(dd);
        if (lam > best) { best = lam; n = (t * e2 + lam * w2 - C) / r; }
      }
    }
    return n;
  }

  float ggx(float NdH, float a) {
    float a2 = a * a, d = NdH * NdH * (a2 - 1.0) + 1.0;
    return a2 / (3.14159 * d * d + 1e-5);
  }

  // a photo studio: bright overhead softbox, a strip light on the right, soft walls
  vec3 studio(vec3 R, float rough) {
    float sharp = mix(60.0, 3.5, rough);
    vec3 col = mix(vec3(0.10, 0.10, 0.11), vec3(0.50, 0.55, 0.64), smoothstep(-0.25, 0.7, R.y));
    col += vec3(1.25, 1.22, 1.16) * exp((dot(R, normalize(vec3(0.15, 1.0, 0.3))) - 1.0) * sharp);
    col += vec3(0.75, 0.80, 0.90) * exp((dot(R, normalize(vec3(1.0, 0.25, 0.2))) - 1.0) * sharp * 1.4);
    return col;
  }

  void main() {
    vec2 w2 = normalize(vW2), e2 = normalize(vE2);
    float c = vCR.x, r = vCR.y;
    float rE = c * abs(e2.x) + r;
    float t = clamp(vT, -rE * 0.999, rE * 0.999);
    vec2 n2 = profileNormal(t, e2, w2, c, r);
    // far away, only the surface the strands build up is visible: walls face
    // outwards (towards whichever side of the strand the camera is on), infill
    // and skins face up
    vec2 avg = vFlat > 0.5 ? vec2(0.0, 1.0) : normalize(vec2(clamp(w2.x * 3.0, -1.0, 1.0), 0.28));
    n2 = normalize(mix(avg, n2, vDetail));
    vec3 N = normalize(n2.x * vH + n2.y * vU);
    vec3 V = normalize(cameraPosition - vWorld);
    if (dot(N, V) < 0.0) N = normalize(N - V * dot(N, V) * 1.02);

    if (uPass > 0.5) {
      float edge = sqrt(max(1.0 - vSide * vSide, 0.0));
      float a = uGhostAlpha * (0.35 + 0.65 * edge);
      vec3 gc = vDoom > 0.5 ? vec3(1.0, 0.25, 0.2) : mix(vColor, vec3(0.82, 0.86, 0.92), 0.72);
      gl_FragColor = vec4(gc, vDoom > 0.5 ? min(a * 2.2, 0.5) : a);
      return;
    }

    vec3 base = vColor;
    float rough = vIron > 0.5 ? max(uRough * 0.45, 0.12) : uRough;
    float a = rough * rough;
    float NdV = clamp(dot(N, V), 1e-3, 1.0);
    vec3 F0 = mix(vec3(0.045), base, uMetal);

    // grooves between layers (profile facing down/in) get less light
    float ao = mix(0.55, 1.0, smoothstep(-0.95, 0.45, n2.y));
    vec3 amb = mix(vec3(0.09, 0.085, 0.08), vec3(0.52, 0.57, 0.66), N.y * 0.5 + 0.5) * 0.36;
    vec3 diff = amb * ao;
    vec3 spec = vec3(0.0);
    // key (front right, high), cool fill (left), rim (behind)
    vec3 Ls[3]; vec3 Cs[3];
    Ls[0] = normalize(vec3(0.62, 0.5, 0.6)); Cs[0] = vec3(1.12, 1.07, 1.0);
    Ls[1] = normalize(vec3(-0.85, 0.25, 0.3)); Cs[1] = vec3(0.13, 0.15, 0.2);
    Ls[2] = normalize(vec3(-0.25, 0.45, -0.95)); Cs[2] = vec3(0.32, 0.33, 0.37);
    for (int i = 0; i < 3; i++) {
      vec3 L = Ls[i];
      float NdL = dot(N, L);
      // PLA & co. are a little translucent: light wraps round the strand a bit
      diff += Cs[i] * max((NdL + 0.12) / 1.12, 0.0) * mix(0.75, 1.0, ao);
      if (NdL > 0.0) {
        vec3 Hh = normalize(L + V);
        float VdH = clamp(dot(V, Hh), 0.0, 1.0);
        vec3 F = F0 + (1.0 - F0) * pow(1.0 - VdH, 5.0);
        float k = a * 0.5;
        float vis = 0.25 / ((NdV * (1.0 - k) + k) * (NdL * (1.0 - k) + k));
        spec += Cs[i] * F * ggx(max(dot(N, Hh), 0.0), a) * vis * NdL;
      }
    }
    // Layer lines too fine to see still show: light catching thousands of parallel
    // ridges spreads into a satin streak along them (like brushed metal or hair),
    // which slides over the part as you move. Kajiya-Kay highlight along the strand.
    float fine = (1.0 - vDetail) * (1.0 - vFlat) * (1.0 - uMetal * 0.5);
    if (fine > 0.01) {
      vec3 T = normalize(vTan);
      for (int i = 0; i < 3; i++) {
        vec3 Hh = normalize(Ls[i] + V);
        float th = dot(T, Hh);
        float sTH = sqrt(max(1.0 - th * th, 0.0));
        float lit = smoothstep(-0.1, 0.35, dot(N, Ls[i]));
        spec += Cs[i] * (0.09 * pow(sTH, 90.0 * (1.0 - rough) + 8.0) + 0.05 * pow(sTH, 12.0)) * lit * fine * (1.0 - rough * 0.6);
      }
    }
    // reflections of the room: stronger at grazing angles (Fresnel), which is why
    // walls seen edge-on get that sheen
    vec3 Fr = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - NdV, 5.0);
    vec3 env = studio(reflect(-V, N), rough) * Fr * ao * 0.8;
    vec3 col = base * diff * (1.0 - Fr * 0.5) * (1.0 - uMetal * 0.6) + spec + env;
    col = mix(col, min(base * 1.35 + vec3(0.08), vec3(1.0)), clamp(vHot, 0.0, 0.4));
    // soft shoulder instead of hard clipping on white filament and highlights
    float m = max(col.r, max(col.g, col.b));
    if (m > 0.8) col *= (0.8 + (1.0 - exp(-(m - 0.8) * 2.5)) * 0.2) / m;
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
      uPxScale: { value: 1000 },
      uRough: { value: 0.42 },
      uMetal: { value: 0 },
    };
    // live prints don't need 60 fps: capping the frame rate keeps a phone that sits
    // on the page for hours cool (dragging the view still renders at full rate)
    this.maxFps = 0;
    this.lastRender = 0;
    this.interactUntil = 0;
    this.controls.addEventListener('start', () => { this.interactUntil = Infinity; });
    this.controls.addEventListener('end', () => { this.interactUntil = performance.now() + 800; });


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
    this.printer.setFilamentColor('#' + this.uniforms.uColor.value.getHexString());
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

  /** layers: parser layers ({z, seg}) for per-strand layer height */
  setData(segs, bbox, layers) {
    if (this.mesh) { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); }
    if (this.ghost) { this.ghost.removeFromParent(); this.ghost.geometry.dispose(); }
    this.segCount = segs.move.length;
    this.center.set(this.bedW / 2, this.bedD / 2);

    const aStart = new THREE.InstancedBufferAttribute(segs.start, 3);
    const aEnd = new THREE.InstancedBufferAttribute(segs.end, 3);
    const aMeta = new THREE.InstancedBufferAttribute(segs.meta, 1);
    // layer height per strand, 0.01 mm steps in one byte
    const hBytes = new Uint8Array(segs.meta.length).fill(20);
    if (layers && layers.z && layers.seg) {
      const NL = layers.z.length, S = hBytes.length;
      for (let L = 0; L < NL; L++) {
        const h = L > 0 ? layers.z[L] - layers.z[L - 1] : layers.z[0];
        const v = Math.round(Math.min(Math.max(h, 0.04), 1.2) * 100);
        hBytes.fill(v, layers.seg[L], L + 1 < NL ? layers.seg[L + 1] : S);
      }
    }
    const aH = new THREE.InstancedBufferAttribute(hBytes, 1, true);
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
      g.setAttribute('iH', aH);
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
    const w0 = Math.max(this.lastW || this.canvas.clientWidth, 1), h0 = Math.max(this.lastH || this.canvas.clientHeight, 1);
    const narrow = Math.min(w0, h0) < 600; // phones: the print is the point, not the frame
    if (this.printerView && this.printer && narrow) {
      // frame the bed and the print; the gantry and frame run off the edges
      const top = b && isFinite(b.max[2]) ? b.max[2] : 20;
      const pd = b && isFinite(b.min[0]) ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 60;
      cx = 0; cy = Math.max(18, top * 0.45); cz = 0;
      r = Math.max(this.bedW * 0.55, pd * 0.6, top * 0.7 + 30);
    } else if (this.printerView && this.printer) {
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

  setColor(hex) {
    this.uniforms.uColor.value.set(hex);
    if (this.printer) this.printer.setFilamentColor(hex);
    this.dirty = true;
  }
  setColorMode(mode) { this.uniforms.uColorMode.value = mode === 'feature' ? 1 : 0; this.dirty = true; }
  setGhost(on) { if (this.ghost) this.ghost.visible = on; this.ghostOn = on; this.dirty = true; }
  setGlow(on) { this.uniforms.uGlow.value = on ? 1 : 0; this.dirty = true; }
  /** how the plastic reflects: roughness 0..1, metal 0..1 (silk) */
  setSurface({ rough = 0.42, metal = 0 } = {}) { this.uniforms.uRough.value = rough; this.uniforms.uMetal.value = metal; this.dirty = true; }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w !== this.lastW || h !== this.lastH) {
      this.lastW = w; this.lastH = h;
      this.renderer.setSize(w, h, false);
      const bh = h * this.renderer.getPixelRatio();
      this.uniforms.uPxScale.value = bh / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
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
    const t = performance.now();
    const interacting = t < this.interactUntil;
    if (this.dirty && this.maxFps > 0 && !interacting && t - this.lastRender < 1000 / this.maxFps) return;
    if (this.dirty) {
      this.lastRender = t;
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
      if (this.onRendered) this.onRendered(); // same task: the WebGL buffer is still readable
    }
  }
}

export { FEATURE_COLORS };
