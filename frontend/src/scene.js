import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export const MODE_COLORS = [0x3b82f6, 0xf59e0b, 0x22c55e, 0xef4444, 0x3b82f6, 0x8b95a5]; // idle, work, eat, starve, sleep, dead
const SKIN = [0xf1c7a1, 0xe0ac82, 0xc58c63, 0x9a6a47, 0x6f4a33, 0xf6d5b8];
const rand = (seed) => { let s = seed * 9301 + 49297; return () => ((s = (s * 9301 + 49297) % 233280) / 233280); };
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angLerp = (a, b, t) => { let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; if (d < -Math.PI) d += Math.PI * 2; return a + d * t; };

export class CityScene {
  constructor(canvas, labelsEl) {
    this.canvas = canvas; this.labelsEl = labelsEl;
    this.CELL = 2;
    this.citizens = new Map(); this.drones = new Map();
    this.labels = []; this.mats = new Map();
    this.selected = null; this.hovered = null; this.follow = false;
    this.onSelect = () => {};
    this.hour = 12;
    this.clock = new THREE.Clock();

    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.8;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xa9c4dd, 120, 420);
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.5, 1500);
    this.camera.position.set(-40, 62, 128);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(42, 0, 42);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49; this.controls.minDistance = 6; this.controls.maxDistance = 260;
    this.controls.autoRotateSpeed = 0.5;

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.35, 0.6, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.setupLights();
    this.setupSky();
    this.windowMat = new THREE.MeshStandardMaterial({ color: 0x1b2433, emissive: 0xffc46b, emissiveIntensity: 0, roughness: 0.3, metalness: 0.2 });
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe2a0, emissiveIntensity: 0 });

    this.ray = new THREE.Raycaster(); this.pointer = new THREE.Vector2(-9, -9);
    canvas.addEventListener('pointermove', (e) => { this.pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); this.moved = true; });
    canvas.addEventListener('pointerdown', (e) => { this.downAt = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
      if (!this.downAt || Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 5) return;
      const id = this.pick(e.clientX, e.clientY);
      this.select(id);
    });
    addEventListener('resize', () => this.resize());
    this.resize();
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  // ---- basics ----------------------------------------------------------------
  mat(color, opts = {}) {
    const k = color + JSON.stringify(opts);
    if (!this.mats.has(k)) this.mats.set(k, new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02, ...opts }));
    return this.mats.get(k);
  }
  box(w, h, d, color, x, y, z, parent, opts) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof color === 'number' ? this.mat(color, opts) : color);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  }
  label(text, x, y, z, cls = '') {
    const el = document.createElement('div'); el.className = 'lbl ' + cls; el.textContent = text;
    this.labelsEl.appendChild(el);
    const l = { el, pos: new THREE.Vector3(x, y, z), fixed: true }; this.labels.push(l); return l;
  }

  setupLights() {
    this.hemi = new THREE.HemisphereLight(0xbfdcff, 0x40502f, 0.6); this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = this.sun.shadow.camera; s.left = -70; s.right = 70; s.top = 70; s.bottom = -70; s.near = 10; s.far = 400;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.05;
    this.sun.target.position.set(42, 0, 42);
    this.scene.add(this.sun, this.sun.target);
    this.moon = new THREE.DirectionalLight(0x7f9bff, 0);
    this.moon.target.position.set(42, 0, 42);
    this.scene.add(this.moon, this.moon.target);
  }

  setupSky() {
    this.sky = new Sky(); this.sky.scale.setScalar(1000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 6; u.rayleigh.value = 1.4; u.mieCoefficient.value = 0.006; u.mieDirectionalG.value = 0.85;
    this.scene.add(this.sky);
    const n = 700, pos = new Float32Array(n * 3), rnd = rand(7);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, e = Math.acos(rnd() * 0.95 + 0.05), R = 800;
      pos[i * 3] = Math.sin(e) * Math.cos(a) * R; pos[i * 3 + 1] = Math.cos(e) * R; pos[i * 3 + 2] = Math.sin(e) * Math.sin(a) * R;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false }));
    this.scene.add(this.stars);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h); this.bloom.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  // ---- world -----------------------------------------------------------------
  buildWorld(world) {
    this.world = world;
    const C = this.CELL, size = world.size * C;
    const root = this.worldRoot = new THREE.Group(); this.scene.add(root);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), this.mat(0x5d7f4a, { roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(size / 2, -0.02, size / 2); ground.receiveShadow = true; root.add(ground);

    // streets
    const road = this.mat(0x2a2e36, { roughness: 0.95 });
    for (let k = 0; k <= 5; k++) {
      const p = k * 8 * C;
      const h = new THREE.Mesh(new THREE.PlaneGeometry(size, 2 * C), road); h.rotation.x = -Math.PI / 2; h.position.set(size / 2, 0.02, p + C); h.receiveShadow = true; root.add(h);
      const v = new THREE.Mesh(new THREE.PlaneGeometry(2 * C, size), road); v.rotation.x = -Math.PI / 2; v.position.set(p + C, 0.021, size / 2); v.receiveShadow = true; root.add(v);
    }
    // dashed lines (instanced)
    const dash = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.4, 0.12), new THREE.MeshBasicMaterial({ color: 0xe8e3c8 }), 600);
    let di = 0; const dm = new THREE.Matrix4(), rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), rotV = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2));
    for (let k = 0; k <= 5; k++) for (let t = 1; t < size - 1; t += 3) {
      const m = (((t - C) % (8 * C)) + 8 * C) % (8 * C); // distance to the nearest intersection
      if (m < 3.6 || m > 8 * C - 3.6) continue;
      dm.compose(new THREE.Vector3(t, 0.035, k * 8 * C + C), rot, new THREE.Vector3(1, 1, 1)); dash.setMatrixAt(di++, dm);
      dm.compose(new THREE.Vector3(k * 8 * C + C, 0.035, t), rotV, new THREE.Vector3(1, 1, 1)); dash.setMatrixAt(di++, dm);
    }
    dash.count = di; root.add(dash);

    // blocks & buildings
    for (const b of world.blocks) this.buildBlock(b, root);
    for (const b of world.buildings) this.buildBuilding(b, root);
    this.buildLamps(root);
    this.buildTrees(root);
  }

  buildBlock(b, root) {
    const C = this.CELL, x = b.x * C, z = b.z * C, w = b.w * C;
    const color = b.type === 'park' ? 0x4f8a45 : b.type === 'farm' ? 0x6a5a3a : b.type === 'homes' ? 0x7a9a5c : 0x9a9a98;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 1, 0.2, w + 1), this.mat(color, { roughness: 1 }));
    slab.position.set(x + w / 2, 0.08, z + w / 2); slab.receiveShadow = true; root.add(slab);
    const curb = new THREE.Mesh(new THREE.BoxGeometry(w + 1.4, 0.16, w + 1.4), this.mat(0xb9b6ad));
    curb.position.set(x + w / 2, 0.04, z + w / 2); curb.receiveShadow = true; root.add(curb);
  }

  buildBuilding(b, root) {
    const C = this.CELL, g = new THREE.Group(), x = b.x * C, z = b.z * C, w = b.w * C, d = b.d * C, r = rand(b.id + 3);
    g.position.set(x, 0.18, z); root.add(g);
    const W = this.windowMat;
    switch (b.type) {
      case 'house': {
        const pal = [0xf2e3c9, 0xe9c8b0, 0xcfe0d3, 0xc9d6ea, 0xeadbb1, 0xd9c3dd];
        const col = pal[Math.floor(r() * pal.length)];
        const bw = 4.8, bd = 4.8, bh = 3;
        this.box(bw, bh, bd, col, w / 2, bh / 2, d / 2, g);
        const roof = new THREE.Mesh(new THREE.ConeGeometry(4.2, 2, 4), this.mat([0x9c3d32, 0x5c4a3d, 0x7a3b3b, 0x3f4f63][Math.floor(r() * 4)]));
        roof.rotation.y = Math.PI / 4; roof.position.set(w / 2, bh + 1, d / 2); roof.castShadow = true; g.add(roof);
        const dir = b.side === 'w' ? -1 : 1;
        this.box(0.2, 2, 0.9, 0x5a3b28, w / 2 + dir * (bw / 2), 1, d / 2, g);
        for (const s of [-1, 1]) { this.box(0.1, 0.9, 0.8, W, w / 2 + dir * (bw / 2 + 0.02), 1.7, d / 2 + s * 1.5, g); this.box(0.8, 0.9, 0.1, W, w / 2 + s * 1.4, 1.7, d / 2 + bd / 2 + 0.02, g); this.box(0.8, 0.9, 0.1, W, w / 2 + s * 1.4, 1.7, d / 2 - bd / 2 - 0.02, g); }
        this.box(0.6, 1.4, 0.6, 0x7b5648, w / 2 - dir * 1.2, bh + 1.4, d / 2 + 0.8, g);
        break;
      }
      case 'farm': {
        // greenhouse: half cylinder (the lower half sinks into the ground)
        const ghg = new THREE.Group(); ghg.position.set(w / 2, 0, 4.2); g.add(ghg);
        const shell = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 17, 16, 1, true), new THREE.MeshPhysicalMaterial({ color: 0xcfeeff, transparent: true, opacity: 0.35, roughness: 0.1, side: THREE.DoubleSide, depthWrite: false }));
        shell.rotation.z = Math.PI / 2; ghg.add(shell);
        for (let i = -3; i <= 3; i++) this.box(0.15, 0.15, 5, 0x9aa5ad, i * 2.4, 2.55, 0, ghg);
        for (let i = -3; i <= 3; i++) this.box(1.2, 0.5, 4.2, 0x3c8a3a, i * 2.4, 0.5, 0, ghg);
        // field
        for (let i = 0; i < 6; i++) this.box(w - 3, 0.35, 1.0, i % 2 ? 0x7ea43d : 0xb8a14a, w / 2, 0.3, 11 + i * 1.9, g);
        this.box(1.6, 1.3, 1.6, 0x8b5a3c, 3, 0.65, 9.6, g);
        break;
      }
      case 'workshop': {
        this.box(9, 4.4, 7, 0x8a98a8, w / 2 + 0.5, 2.2, d / 2, g);
        for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.CylinderGeometry(0, 1.8, 3, 3), this.mat(0x4a5766)); s.rotation.y = Math.PI / 2; s.scale.set(1, 1, 1.2); s.position.set(w / 2 - 2 + i * 3, 5.5, d / 2); s.rotation.z = 0; s.castShadow = true; g.add(s); }
        this.box(0.8, 3.3, 5.2, W, w / 2 - 4.05, 2.4, d / 2, g);
        const ch = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 8, 10), this.mat(0x8b4a3a)); ch.position.set(w / 2 + 3.5, 6, d / 2 - 2); ch.castShadow = true; g.add(ch);
        this.box(2.5, 0.2, 2.5, 0x666, 5, 0.1, 19, g);
        for (let i = 0; i < 5; i++) this.box(1.2, 1.2, 1.2, 0xc2955a, 3 + (i % 3) * 1.4, 0.7 + Math.floor(i / 3) * 1.2, 20 - Math.floor(i / 3) * 0.2, g);
        break;
      }
      case 'hospital': {
        this.box(11, 7.5, 9, 0xf1f4f7, w / 2 + 0.3, 3.75, d / 2 - 0.5, g);
        for (let row = 0; row < 3; row++) for (let i = 0; i < 4; i++) this.box(1.4, 0.9, 0.1, W, w / 2 - 3.8 + i * 2.6, 1.8 + row * 2.1, d / 2 + 4.05, g);
        this.box(0.12, 3.2, 1, 0xe03a3a, w / 2 - 5.3, 5.6, d / 2 - 0.5, g); this.box(0.12, 1, 3.2, 0xe03a3a, w / 2 - 5.3, 5.6, d / 2 - 0.5, g);
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.2, 24), this.mat(0x30363f)); pad.position.set(w / 2 + 0.3, 7.6, d / 2 - 0.5); g.add(pad);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.08, 6, 32), new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 1.4 })); ring.rotation.x = Math.PI / 2; ring.position.set(w / 2 + 0.3, 7.75, d / 2 - 0.5); g.add(ring);
        this.box(3, 2.2, 3, 0xdfe6ee, 3, 1.1, 21, g);
        break;
      }
      case 'depot': {
        this.box(10.5, 5, 8, 0xd98c3d, w / 2 + 0.8, 2.5, d / 2 - 1.5, g);
        const roof = this.box(11, 0.4, 8.6, 0x8b5a2b, w / 2 + 0.8, 5.1, d / 2 - 1.5, g);
        for (let i = 0; i < 3; i++) this.box(0.2, 3.2, 2, 0x3b2a1c, w / 2 - 4.5, 1.6, d / 2 - 4 + i * 2.8, g);
        for (let i = 0; i < 14; i++) this.box(1.1 + r() * 0.5, 1.0 + r() * 0.6, 1.1 + r() * 0.5, [0xc9a26b, 0xb98a50, 0x7aa1c2][i % 3], 3 + r() * 6, 0.7 + (i > 9 ? 1 : 0), 18 + r() * 3.5, g);
        this.box(3, 0.3, 3, 0x8dd68d, 3, 0.15, 12, g);
        break;
      }
      case 'gov': {
        for (let i = 0; i < 3; i++) this.box(15 - i * 1.4, 0.45, 14 - i * 1.4, 0xd8d6d0, w / 2, 0.22 + i * 0.45, d / 2, g);
        this.box(9, 5.2, 8, 0xf2f0ea, w / 2, 1.35 + 2.6, d / 2 - 0.5, g);
        for (let i = 0; i < 6; i++) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 5.2, 12), this.mat(0xffffff)); c.position.set(w / 2 - 4 + i * 1.6, 1.35 + 2.6, d / 2 + 4.1); c.castShadow = true; g.add(c); }
        const tri = new THREE.Shape(); tri.moveTo(-5, 0); tri.lineTo(5, 0); tri.lineTo(0, 2); tri.closePath();
        const ped = new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: 0.7, bevelEnabled: false }), this.mat(0xe6e3dc));
        ped.position.set(w / 2, 1.35 + 5.2, d / 2 + 3.6); ped.castShadow = true; g.add(ped);
        const dome = new THREE.Mesh(new THREE.SphereGeometry(2.8, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), this.mat(0xd9b24c, { metalness: 0.7, roughness: 0.3 })); dome.position.set(w / 2, 1.35 + 5.2 + 0.2, d / 2 - 0.5); dome.castShadow = true; g.add(dome);
        this.aiCore = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1, 1), new THREE.MeshStandardMaterial({ color: 0x66e0ff, emissive: 0x2ad4ff, emissiveIntensity: 2.2, wireframe: true }));
        this.aiCore.position.set(w / 2, 11.5, d / 2 - 0.5); g.add(this.aiCore);
        this.aiRing = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.06, 8, 40), new THREE.MeshStandardMaterial({ color: 0x66e0ff, emissive: 0x2ad4ff, emissiveIntensity: 2 })); this.aiRing.position.copy(this.aiCore.position); g.add(this.aiRing);
        const pl = new THREE.PointLight(0x4fd8ff, 25, 28, 2); pl.position.copy(this.aiCore.position); g.add(pl);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 5), this.mat(0xcccccc)); pole.position.set(w / 2 + 6, 3, d / 2 + 5); g.add(pole);
        this.box(1.6, 0.9, 0.05, 0x3b82f6, w / 2 + 6.8, 5, d / 2 + 5, g);
        break;
      }
      case 'park': {
        const pond = new THREE.Mesh(new THREE.CircleGeometry(3.2, 28), new THREE.MeshStandardMaterial({ color: 0x3a82c4, roughness: 0.1, metalness: 0.3 })); pond.rotation.x = -Math.PI / 2; pond.position.set(w / 2, 0.06, d / 2); g.add(pond);
        for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; this.box(1.6, 0.4, 0.5, 0x7a5a3a, w / 2 + Math.cos(a) * 5, 0.4, d / 2 + Math.sin(a) * 5, g); }
        break;
      }
    }
    // building labels (special buildings only)
    if (b.type !== 'house' && b.type !== 'park') {
      const names = { farm: '🌾 Greenhouses', workshop: '🔧 Workshop', hospital: '🏥 Hospital', depot: '📦 Distribution center', gov: '🏛️ City Hall · AI government' };
      this.label(names[b.type], x + w / 2, 11.5, z + d / 2, 'big').type = b.type;
    }
  }

  buildLamps(root) {
    const C = this.CELL, pts = [];
    for (let kx = 0; kx <= 5; kx++) for (let kz = 0; kz <= 5; kz++) for (const [sx, sz] of [[-1, -1], [1, 1], [-1, 1], [1, -1]]) pts.push([kx * 8 * C + C + sx * 2.1, kz * 8 * C + C + sz * 2.1]);
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.09, 4, 6), this.mat(0x2b2f36), pts.length);
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 8, 6), this.lampMat, pts.length);
    const m = new THREE.Matrix4();
    pts.forEach(([x, z], i) => { m.makeTranslation(x, 2, z); poles.setMatrixAt(i, m); m.makeTranslation(x, 4.1, z); bulbs.setMatrixAt(i, m); });
    root.add(poles, bulbs);
  }

  buildTrees(root) {
    const C = this.CELL, rnd = rand(42), spots = [];
    for (const b of this.world.blocks) {
      if (b.type === 'park') for (let i = 0; i < 18; i++) { const a = rnd() * 6.28, rr = 4 + rnd() * 7; spots.push([b.x * C + 6 * C / 2 + Math.cos(a) * rr, b.z * C + 6 * C / 2 + Math.sin(a) * rr, 1.3]); }
      else if (b.type === 'homes') for (let i = 0; i < 3; i++) spots.push([b.x * C + 5.8 + rnd() * 0.4, b.z * C + 5.8 + rnd() * 0.4, 0.8]);
    }
    // trees along the edges of the city
    for (let i = 0; i < 60; i++) { const a = rnd() * 6.28, rr = 62 + rnd() * 50; spots.push([42 + Math.cos(a) * rr, 42 + Math.sin(a) * rr, 1.5 + rnd()]); }
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.22, 1.6, 6), this.mat(0x5c4128), spots.length);
    const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1.1, 3, 7), this.mat(0x2f6b3a), spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    spots.forEach(([x, z, k], i) => {
      s.set(k, k, k); m.compose(new THREE.Vector3(x, 0.8 * k, z), q, s); trunk.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, 2.9 * k, z), q, s); crown.setMatrixAt(i, m);
    });
    trunk.castShadow = crown.castShadow = true; root.add(trunk, crown);
  }

  // ---- citizens ----------------------------------------------------------------
  makeCitizen(c) {
    const g = new THREE.Group(), r = rand(c.id * 13 + 1);
    const skin = SKIN[Math.floor(r() * SKIN.length)];
    const bodyMat = new THREE.MeshStandardMaterial({ color: MODE_COLORS[0], roughness: 0.55, emissive: MODE_COLORS[0], emissiveIntensity: 0.08 });
    const pantsMat = this.mat([0x2d3340, 0x3b3f4d, 0x4a3b32, 0x24324a][Math.floor(r() * 4)]);
    const skinMat = this.mat(skin, { roughness: 0.7 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.62, 4, 10), bodyMat); body.position.y = 1.18; body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 14, 12), skinMat); head.position.y = 1.86; head.castShadow = true; g.add(head);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), this.mat([0x2a1c14, 0x6b4a2b, 0xb98a4a, 0x181818, 0x9b9b9b][Math.floor(r() * 5)])); hair.position.y = 1.9; g.add(hair);
    const legGeo = new THREE.CapsuleGeometry(0.1, 0.5, 3, 6), armGeo = new THREE.CapsuleGeometry(0.075, 0.45, 3, 6);
    const mk = (geo, mat, x, y) => { const p = new THREE.Group(); p.position.set(x, y, 0); const m = new THREE.Mesh(geo, mat); m.position.y = -0.3; m.castShadow = true; p.add(m); g.add(p); return p; };
    const legL = mk(legGeo, pantsMat, -0.13, 0.75), legR = mk(legGeo, pantsMat, 0.13, 0.75);
    const armL = mk(armGeo, bodyMat, -0.34, 1.52), armR = mk(armGeo, bodyMat, 0.34, 1.52);
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 2.2, 8), new THREE.MeshBasicMaterial({ visible: false })); hit.position.y = 1.1; hit.userData.cid = c.id; g.add(hit);
    const sick = new THREE.Mesh(new THREE.OctahedronGeometry(0.14), new THREE.MeshStandardMaterial({ color: 0xc084fc, emissive: 0xa855f7, emissiveIntensity: 1.5 })); sick.position.y = 2.35; sick.visible = false; g.add(sick);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.9, 32), new THREE.MeshBasicMaterial({ color: 0x7cc4ff, side: THREE.DoubleSide, transparent: true, opacity: 0.95 })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06; ring.visible = false; g.add(ring);
    g.scale.setScalar(0.95 + r() * 0.15);
    this.scene.add(g);
    return { id: c.id, g, body, bodyMat, legL, legR, armL, armR, sick, ring, from: null, to: null, t0: 0, x: 0, z: 0, h: 0, mode: 0, flags: 0, phase: r() * 6, name: c.name, init: false };
  }

  clearCitizens() {
    for (const o of this.citizens.values()) this.scene.remove(o.g);
    this.citizens.clear(); this.selected = null; this.hovered = null;
    for (const el of this.nameLabels?.values() || []) el.remove();
    this.nameLabels?.clear();
  }

  setCitizens(list) {
    for (const c of list) if (!this.citizens.has(c.id)) this.citizens.set(c.id, this.makeCitizen(c));
  }

  applyFrame(f) {
    const now = performance.now(), C = this.CELL;
    for (const [id, x, z, h, mode, flags, hunger] of f.c) {
      const o = this.citizens.get(id); if (!o) continue;
      if (!o.init) { o.x = x * C; o.z = z * C; o.h = h; o.init = true; o.from = [o.x, o.z, o.h]; }
      else o.from = [o.x, o.z, o.h];
      o.to = [x * C, z * C, h]; o.t0 = now; o.hunger = hunger;
      if (o.mode !== mode) { o.mode = mode; const col = MODE_COLORS[mode] ?? MODE_COLORS[0]; o.bodyMat.color.setHex(col); o.bodyMat.emissive.setHex(col); }
      o.flags = flags;
    }
    for (const [id, kind, x, z, st, food] of f.d) {
      let d = this.drones.get(id);
      if (!d) { d = this.makeDrone(kind); d.id = id; this.drones.set(id, d); d.x = x * C; d.z = z * C; }
      d.from = [d.x, d.z]; d.to = [x * C, z * C]; d.t0 = now; d.st = st; d.food = !!food;
    }
  }

  makeDrone(kind) {
    const g = new THREE.Group();
    const col = kind === 0 ? 0xf5f7fa : 0xffd23f;
    this.box(0.9, 0.22, 0.9, col, 0, 0, 0, g);
    const rotors = [];
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      this.box(0.7, 0.06, 0.07, 0x333a44, sx * 0.4, 0.05, sz * 0.4, g).rotation.y = sx * sz * Math.PI / 4;
      const rot = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.02, 14), new THREE.MeshBasicMaterial({ color: 0xaad4ff, transparent: true, opacity: 0.35 })); rot.position.set(sx * 0.6, 0.14, sz * 0.6); g.add(rot); rotors.push(rot);
    }
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.09), new THREE.MeshStandardMaterial({ color: kind === 0 ? 0xff3b3b : 0xffa000, emissive: kind === 0 ? 0xff3b3b : 0xffa000, emissiveIntensity: 3 })); led.position.y = -0.14; g.add(led);
    const pkg = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.35, 0.45), this.mat(kind === 0 ? 0xffffff : 0xb98a50)); pkg.position.y = -0.38; pkg.castShadow = true; g.add(pkg);
    if (kind === 0) { this.box(0.05, 0.25, 0.01, 0xe03a3a, 0, -0.38, 0.23, g); this.box(0.25, 0.05, 0.01, 0xe03a3a, 0, -0.38, 0.23, g); }
    const beam = new THREE.Mesh(new THREE.ConeGeometry(1.2, 6, 14, 1, true), new THREE.MeshBasicMaterial({ color: kind === 0 ? 0x7cffd0 : 0xffe27c, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false })); beam.position.y = -3.2; beam.visible = false; g.add(beam);
    g.traverse((m) => { if (m.isMesh) m.castShadow = false; });
    this.scene.add(g);
    return { g, rotors, beam, pkg, kind, x: 0, z: 0, y: 1, from: [0, 0], to: [0, 0], t0: 0, st: 0 };
  }

  // ---- interaction --------------------------------------------------------------
  pick(cx, cy) {
    this.ray.setFromCamera(new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1), this.camera);
    const hits = this.ray.intersectObjects([...this.citizens.values()].filter((o) => o.mode !== 4).map((o) => o.g), true);
    for (const h of hits) if (h.object.userData.cid) return h.object.userData.cid;
    return null;
  }
  select(id) {
    if (this.selected != null) { const o = this.citizens.get(this.selected); if (o) o.ring.visible = false; }
    this.selected = id;
    if (id != null) { const o = this.citizens.get(id); if (o) o.ring.visible = true; }
    this.onSelect(id);
  }
  focus(id) {
    const o = this.citizens.get(id); if (!o) return;
    this.controls.target.set(o.x, 1, o.z);
    const off = this.camera.position.clone().sub(this.controls.target); off.setLength(Math.min(off.length(), 28)); this.camera.position.copy(this.controls.target).add(off);
  }
  resetCamera() { this.camera.position.set(-40, 62, 128); this.controls.target.set(42, 0, 42); this.follow = false; }

  // ---- day/night ----------------------------------------------------------------
  setTime(minutes) {
    this.hour = (minutes % 1440) / 60;
    const h = this.hour, ang = ((h - 6) / 24) * Math.PI * 2, elev = Math.sin(ang);
    const dir = new THREE.Vector3(Math.cos(ang), elev, 0.35).normalize();
    const day = clamp(elev * 3 + 0.15, 0, 1), night = clamp(-elev * 3 + 0.1, 0, 1);
    this.sun.position.copy(this.sun.target.position).addScaledVector(dir, 160);
    this.sun.intensity = 3.2 * day;
    const warm = clamp(1 - elev * 2.2, 0, 1);
    this.sun.color.setRGB(1, lerp(0.96, 0.62, warm), lerp(0.88, 0.4, warm));
    this.moon.position.copy(this.moon.target.position).addScaledVector(new THREE.Vector3(-dir.x, Math.max(0.4, -dir.y), 0.3).normalize(), 160);
    this.moon.intensity = 0.55 * night;
    this.hemi.intensity = lerp(0.12, 0.75, day);
    this.renderer.toneMappingExposure = lerp(0.55, 0.85, day);
    this.sky.material.uniforms.sunPosition.value.copy(elev > -0.05 ? dir : new THREE.Vector3(dir.x, -0.05, dir.z));
    this.stars.material.opacity = clamp(night * 1.2, 0, 1);
    const fogDay = new THREE.Color(0xa9c4dd), fogDusk = new THREE.Color(0xe0a27a), fogNight = new THREE.Color(0x070b18);
    const f = fogNight.clone().lerp(fogDay.clone().lerp(fogDusk, warm * 0.7), day);
    this.scene.fog.color.copy(f);
    this.windowMat.emissiveIntensity = night * 1.3;
    this.lampMat.emissiveIntensity = night * 3;
    this.bloom.strength = 0.15 + night * 0.35;
    this.isNight = night > 0.5;
  }

  // ---- render loop ----------------------------------------------------------------
  animate() {
    requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.1), t = this.clock.elapsedTime, now = performance.now();
    for (const o of this.citizens.values()) this.updateCitizen(o, now, t);
    for (const d of this.drones.values()) this.updateDrone(d, now, t);
    if (this.aiCore) { this.aiCore.rotation.y += dt * 0.8; this.aiCore.rotation.x += dt * 0.4; this.aiRing.rotation.x = t * 0.9; this.aiRing.rotation.y = t * 0.5; }
    if (this.follow && this.selected != null) { const o = this.citizens.get(this.selected); if (o) { const d = new THREE.Vector3(o.x, 1, o.z).sub(this.controls.target); this.controls.target.add(d.multiplyScalar(0.12)); this.camera.position.add(d); } }
    this.controls.update();
    this.composer.render();
    this.updateLabels();
    if (this.moved) { this.moved = false; const id = this.pick((this.pointer.x + 1) / 2 * innerWidth, (1 - this.pointer.y) / 2 * innerHeight); this.setHover(id); }
  }

  setHover(id) {
    if (id === this.hovered) return;
    this.hovered = id; this.canvas.style.cursor = id ? 'pointer' : 'default';
  }

  updateCitizen(o, now, t) {
    if (!o.to) { o.g.visible = false; return; }
    const k = Math.min(1, (now - o.t0) / 205);
    o.x = lerp(o.from[0], o.to[0], k); o.z = lerp(o.from[1], o.to[1], k); o.h = angLerp(o.from[2], o.to[2], k);
    const hidden = o.mode === 4;
    o.g.visible = !hidden;
    if (hidden) return;
    const moving = !!(o.flags & 8), dead = o.mode === 5;
    o.g.position.set(o.x, 0.2, o.z);
    o.g.rotation.y = o.h;
    o.sick.visible = !!(o.flags & 1) && !dead;
    if (o.sick.visible) { o.sick.position.y = 2.35 + Math.sin(t * 3 + o.phase) * 0.06; o.sick.rotation.y = t * 2; }
    if (dead) { o.g.rotation.x = -Math.PI / 2; o.g.position.y = 0.45; o.g.rotation.z = 0; return; }
    o.g.rotation.x = 0;
    const sw = moving ? Math.sin(t * 9 + o.phase) : 0;
    o.legL.rotation.x = sw * 0.7; o.legR.rotation.x = -sw * 0.7;
    o.armL.rotation.x = -sw * 0.6; o.armR.rotation.x = sw * 0.6;
    o.body.position.y = 1.18 + (moving ? Math.abs(Math.sin(t * 9 + o.phase)) * 0.05 : 0);
    o.g.rotation.z = 0;
    if (!moving) {
      o.legL.rotation.x = o.legR.rotation.x = 0;
      if (o.mode === 1) { o.armR.rotation.x = -1.2 + Math.sin(t * 7 + o.phase) * 0.7; o.armL.rotation.x = -0.4 + Math.sin(t * 7 + o.phase + 1.5) * 0.3; }       // working: hammering
      else if (o.mode === 2) { o.armR.rotation.x = -1.7 + Math.sin(t * 5 + o.phase) * 0.25; o.armL.rotation.x = 0; o.body.position.y += Math.sin(t * 5 + o.phase) * 0.015; } // eating
      else if (o.mode === 3) { o.g.rotation.z = Math.sin(t * 2 + o.phase) * 0.12; o.armL.rotation.x = o.armR.rotation.x = 0.3; o.body.position.y -= 0.05; }          // staggering
      else { o.armL.rotation.x = o.armR.rotation.x = Math.sin(t * 1.5 + o.phase) * 0.05; }
    }
  }

  updateDrone(d, now, t) {
    const k = Math.min(1, (now - d.t0) / 205);
    d.x = lerp(d.from[0], d.to[0], k); d.z = lerp(d.from[1], d.to[1], k);
    const flying = d.st !== 0, targetY = d.st === 0 ? 1.1 : d.st === 2 ? 4 : 9;
    d.y = lerp(d.y, targetY, 0.06);
    d.g.position.set(d.x, d.y + (flying ? Math.sin(t * 3 + d.id) * 0.15 : 0), d.z);
    d.rotors.forEach((r, i) => { r.rotation.y = t * 40 * (i % 2 ? 1 : -1); r.visible = flying; });
    d.beam.visible = d.st === 2;
    d.pkg.visible = d.st !== 3 || d.kind === 0;
    const dx = d.to[0] - d.from[0], dz = d.to[1] - d.from[1];
    if (Math.hypot(dx, dz) > 0.01) { d.g.rotation.y = angLerp(d.g.rotation.y, Math.atan2(dx, dz), 0.1); d.g.rotation.z = THREE_clamp(-0.18, 0.18, Math.hypot(dx, dz) * 0.5) * 0.5; }
    else d.g.rotation.z = 0;
  }

  updateLabels() {
    const w = innerWidth, h = innerHeight, v = new THREE.Vector3();
    const dist = this.camera.position.distanceTo(this.controls.target);
    for (const l of this.labels) {
      v.copy(l.pos).project(this.camera);
      const lim = l.type === 'farm' || l.type === 'workshop' ? 85 : 210;
      const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && dist < lim;
      l.el.style.display = vis ? 'block' : 'none';
      if (vis) l.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(-50%,-100%)`;
    }
    // name label for hover/selected
    const show = [this.selected, this.hovered].filter((x, i, a) => x != null && a.indexOf(x) === i);
    this.nameLabels ??= new Map();
    for (const [id, el] of this.nameLabels) if (!show.includes(id)) { el.remove(); this.nameLabels.delete(id); }
    for (const id of show) {
      const o = this.citizens.get(id); if (!o || o.mode === 4) { this.nameLabels.get(id)?.remove(); this.nameLabels.delete(id); continue; }
      let el = this.nameLabels.get(id);
      if (!el) { el = document.createElement('div'); el.className = 'lbl cz'; el.style.position = 'absolute'; el.style.left = '0'; el.style.top = '0'; this.labelsEl.appendChild(el); this.nameLabels.set(id, el); }
      el.textContent = o.name;
      v.set(o.x, 2.9, o.z).project(this.camera);
      el.style.display = v.z < 1 ? 'block' : 'none';
      el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(-50%,-100%)`;
    }
  }
}
function THREE_clamp(a, b, v) { return Math.max(a, Math.min(b, v)); }
