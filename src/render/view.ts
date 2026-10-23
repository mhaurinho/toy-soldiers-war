import * as THREE from 'three/webgpu';
import { pass, mrt, sample, screenUV, normalView, packNormalToRGB, unpackRGBToNormal, builtinAOContext } from 'three/tsl';
import { ssao } from 'three/addons/tsl/display/SSAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BY_ID, TEAMS } from '../data/catalog';
import { MAP_RADIUS } from '../sim/constants';
import { clamp, lerp, lerpAngle } from '../sim/math';
import { generateTerrain, sampleHeight, terrainTint, type PropKind, type Terrain } from '../sim/terrain';
import type { FxEvent, PropSnap, Snapshot, UnitSnap } from '../sim/types';
import { meshLibrary, propLibrary, rotorOffset, turretOffset } from './meshes';

export type ViewMode = 'menu' | 'builder' | 'deploy' | 'battle';

interface Shot {
  snap: Snapshot;
  at: number;
}

interface LiveFx {
  kind: 'tracer' | 'boom' | 'marker' | 'shock' | 'muzzle';
  life: number;
  max: number;
  mesh: THREE.Object3D;
  size: number;
}

interface Bit {
  life: number;
  max: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  size: number;
  settled: boolean;
}

const PROP_COLOR: Record<PropKind, number> = {
  tree: 0x6d8a48,
  car: 0x4a3428,
  lamp: 0x8d8478,
  wall: 0xc8b79c,
  rubble: 0x8a7e70,
  barricade: 0x8d5a32,
  tower: 0xc2a36a,
  bag: 0xd1b07a,
};

const _dummy = new THREE.Object3D();
const _color = new THREE.Color();
const _team = [new THREE.Color(TEAMS[0].hex), new THREE.Color(TEAMS[1].hex)];
const _white = new THREE.Color(1, 1, 1);
const _treeColor = new THREE.Color(0x2f7a3c);

function woodTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6a4128';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 28; i++) {
    g.strokeStyle = `rgba(${40 + (i % 5) * 8}, ${22 + (i % 3) * 6}, 12, ${0.08 + (i % 4) * 0.04})`;
    g.lineWidth = 2 + (i % 3);
    g.beginPath();
    const y = (i * 37) % 512;
    g.moveTo(0, y);
    g.bezierCurveTo(140, y + 8, 280, y - 10, 512, y + 4);
    g.stroke();
  }
  for (let x = 0; x <= 512; x += 128) {
    g.strokeStyle = 'rgba(30,16,8,0.35)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 6, 512);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function blobTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function roughnessTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  const img = g.createImageData(128, 128);
  for (let i = 0; i < 128 * 128; i++) {
    const n = 168 + ((i * 17) % 50);
    img.data[i * 4] = n;
    img.data[i * 4 + 1] = n;
    img.data[i * 4 + 2] = n;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}

export class GameView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.2, 240);
  renderer!: THREE.WebGPURenderer;
  backend = '…';
  mode: ViewMode = 'menu';
  controlled: 0 | 1 = 0;
  selected = new Set<number>();
  hoverId = -1;

  private canvas: HTMLCanvasElement;
  private fxCanvas: HTMLCanvasElement;
  private fxCtx: CanvasRenderingContext2D;
  private pipeline: { render: () => void } | null = null;
  private terrain: Terrain | null = null;
  private terrainMesh: THREE.Mesh | null = null;
  private propMeshes = new Map<string, THREE.InstancedMesh>();
  private propAlive = new Map<number, boolean>();
  private debris: THREE.InstancedMesh | null = null;
  private bits: Bit[] = [];
  private puddles: THREE.InstancedMesh | null = null;
  private puddleCount = 0;
  private shake = 0;
  private pools = new Map<string, THREE.InstancedMesh>();
  private blobs!: THREE.InstancedMesh;
  private rings!: THREE.InstancedMesh;
  private shots!: THREE.InstancedMesh;
  private clock = 0;
  private last = performance.now();
  private curr: Shot | null = null;
  private prev: Shot | null = null;
  private showcase: UnitSnap[] = [];
  private flashes = new Map<number, number>();
  private ghosts = new Map<number, { snap: UnitSnap; at: number }>();
  private live: LiveFx[] = [];
  private preview = new THREE.Group();
  private previewSpin = 0;
  private cursorGhost: THREE.Mesh | null = null;
  private rangeLine: THREE.Line | null = null;
  private flagCloth!: THREE.Mesh;
  private flagPole!: THREE.Mesh;
  private objectiveRing!: THREE.Mesh;
  private podium!: THREE.Mesh;
  private lip: THREE.Mesh | null = null;
  private miniBake: HTMLCanvasElement | null = null;
  private spawnRings: THREE.Mesh[] = [];
  private spawnLabels: THREE.Mesh[] = [];
  private objective = 0;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private cam = { yaw: 0.55, pitch: 0.78, dist: 34, x: 0, y: 1.2, z: 0 };
  private keys = new Set<string>();
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  private edge = { x: 0, y: 0 };
  private reduceMotion = false;
  private coarse = false;
  private quality: 'high' | 'medium' | 'low' = 'high';
  private pixelRatio = 1;
  private slowFrames = 0;
  private warmed = 0;
  private sun!: THREE.DirectionalLight;
  private menuYaw = 0.2;
  private onFrame: (dt: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement, fx: HTMLCanvasElement) {
    this.canvas = canvas;
    this.fxCanvas = fx;
    const ctx = fx.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D indisponível');
    this.fxCtx = ctx;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  async init(): Promise<void> {
    this.coarse = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    this.quality = this.chooseQuality();
    this.renderer = new THREE.WebGPURenderer({
      canvas: this.canvas,
      antialias: this.quality === 'high',
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    await this.renderer.init();
    const backend = this.renderer.backend as { isWebGPUBackend?: boolean };
    this.backend = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';

    this.scene.background = new THREE.Color(0x17130f);
    this.scene.fog = new THREE.Fog(0x17130f, 48, 128);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.62;
    room.dispose();
    pmrem.dispose();

    this.buildRoom();
    this.buildPools();
    this.applyQuality();
    this.scene.add(this.preview);

    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      this.keys.add(key);
      if (key === ' ' || key.startsWith('arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('mousemove', (e) => {
      if (this.coarse) return;
      const m = 36;
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.edge.x = e.clientX < m ? -1 : e.clientX > w - m ? 1 : 0;
      this.edge.y = e.clientY < m ? -1 : e.clientY > h - m ? 1 : 0;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 1 && !(e.button === 0 && e.altKey)) return;
      this.dragging = true;
      this.dragX = e.clientX;
      this.dragY = e.clientY;
    });
    window.addEventListener('pointerup', () => {
      this.dragging = false;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragX;
      const dy = e.clientY - this.dragY;
      this.dragX = e.clientX;
      this.dragY = e.clientY;
      this.cam.yaw -= dx * 0.005;
      this.cam.pitch = clamp(this.cam.pitch + dy * 0.003, 0.42, 1.22);
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.dist = clamp(this.cam.dist * (e.deltaY > 0 ? 1.08 : 0.92), 8, 86);
    }, { passive: false });

    this.setTerrain(20261022);
    this.dressMenu();
  }

  start(onFrame: (dt: number) => void) {
    this.onFrame = onFrame;
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const next = this.chooseQuality();
    const rank = { high: 2, medium: 1, low: 0 } as const;
    if (rank[next] < rank[this.quality]) {
      this.quality = next;
      this.applyQuality();
      return;
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    const fx = this.pixelRatio;
    this.fxCanvas.width = Math.max(1, Math.round(w * fx));
    this.fxCanvas.height = Math.max(1, Math.round(h * fx));
    this.fxCanvas.style.width = `${w}px`;
    this.fxCanvas.style.height = `${h}px`;
  }

  /** One-finger drag: the map sticks to the finger. */
  panPixels(dx: number, dy: number) {
    const scale = 0.04 * (this.cam.dist / 30);
    const ix = -dx * scale;
    const iz = dy * scale;
    const fx = -Math.sin(this.cam.yaw);
    const fz = -Math.cos(this.cam.yaw);
    const rx = Math.cos(this.cam.yaw);
    const rz = -Math.sin(this.cam.yaw);
    this.cam.x = clamp(this.cam.x + rx * ix + fx * iz, -MAP_RADIUS, MAP_RADIUS);
    this.cam.z = clamp(this.cam.z + rz * ix + fz * iz, -MAP_RADIUS, MAP_RADIUS);
  }

  addZoom(factor: number) {
    this.cam.dist = clamp(this.cam.dist * factor, 8, 86);
  }

  addYaw(delta: number) {
    this.cam.yaw += delta;
  }

  setMode(mode: ViewMode) {
    const changed = this.mode !== mode;
    this.mode = mode;
    const showBoard = mode !== 'builder';
    if (this.terrainMesh) this.terrainMesh.visible = showBoard;
    for (const mesh of this.propMeshes.values()) mesh.visible = showBoard;
    if (this.debris) this.debris.visible = showBoard;
    if (this.puddles) this.puddles.visible = showBoard;
    for (const ring of this.spawnRings) ring.visible = mode === 'deploy' || mode === 'menu';
    for (const label of this.spawnLabels) label.visible = mode === 'deploy';
    if (this.flagPole) this.flagPole.visible = showBoard;
    if (this.flagCloth) this.flagCloth.visible = showBoard;
    if (this.objectiveRing) this.objectiveRing.visible = showBoard;
    if (this.podium) this.podium.visible = mode === 'builder';
    this.preview.visible = mode === 'builder';
    this.preview.position.set(mode === 'builder' ? 2.15 : 0, 0, mode === 'builder' ? 0.15 : 0);
    if (mode === 'menu') this.dressMenu();
    if (mode === 'builder') this.showcase = [];
    if (mode !== 'deploy' && this.cursorGhost) this.cursorGhost.visible = false;
    if (mode !== 'battle') this.showRange(null);
    if (changed && mode === 'battle') {
      const short = window.innerHeight < 520;
      this.cam.dist = short ? 36 : 24;
      this.cam.pitch = short ? 0.9 : 0.68;
    }
    if (changed && mode === 'deploy') {
      const short = window.innerHeight < 520;
      this.cam.dist = short ? 96 : 74;
      this.cam.pitch = short ? 1.16 : 1.05;
      this.cam.yaw = 0.62;
      this.cam.x = 0;
      this.cam.z = 0;
      this.cam.y = 2.2;
    }
  }

  setTerrain(seed: number) {
    this.terrain = generateTerrain(seed);
    this.rebuildTerrainMesh();
    this.layoutProps();
    this.placeSpawns();
  }

  focusSpawn(index: number) {
    if (!this.terrain) return;
    const s = this.terrain.spawns[index];
    this.cam.x = s.x * 0.35;
    this.cam.z = s.z * 0.35;
    this.cam.yaw = Math.atan2(s.x, s.z);
  }

  setShowcase(units: UnitSnap[]) {
    this.showcase = units;
  }

  setPreview(defId: string | null, team: 0 | 1) {
    this.preview.clear();
    if (!defId) return;
    const def = BY_ID[defId];
    if (!def) return;
    const lib = meshLibrary();
    const mat = this.pools.get(def.mesh)?.material as THREE.Material | undefined;
    const geo = lib[def.mesh];
    if (!geo || !mat) return;
      const tinted = (mat as THREE.MeshPhysicalMaterial).clone();
      tinted.color.copy(_team[team]);
      const mesh = new THREE.Mesh(geo, tinted);
      mesh.scale.setScalar(def.scale);
    mesh.castShadow = true;
    mesh.position.y = 0.02;
    this.preview.add(mesh);
    if (def.turret && lib[def.turret]) {
      const t = new THREE.Mesh(lib[def.turret], tinted);
      const off = turretOffset(def.turret);
      t.position.copy(off);
      t.castShadow = true;
      mesh.add(t);
    }
    if (def.rotor && lib.rotor) {
      const r = new THREE.Mesh(lib.rotor, tinted);
      r.position.copy(rotorOffset());
      r.name = 'rotor';
      mesh.add(r);
    }
    this.preview.userData.team = team;
    const tint = _team[team];
    mesh.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh) return;
      m.userData.tint = tint;
    });
  }

  setCursorGhost(defId: string | null, x: number, z: number, ok: boolean, heading = 0) {
    if (!defId || !this.terrain) {
      if (this.cursorGhost) this.cursorGhost.visible = false;
      return;
    }
    const def = BY_ID[defId];
    const lib = meshLibrary();
    if (!def) return;
    if (!this.cursorGhost || this.cursorGhost.userData.defId !== defId) {
      if (this.cursorGhost) {
        this.scene.remove(this.cursorGhost);
        (this.cursorGhost.material as THREE.Material).dispose();
      }
      const geo = lib[def.mesh];
      if (!geo) return;
      const mat = new THREE.MeshPhysicalMaterial({
        color: ok ? 0xd7ffe0 : 0xffc1b5,
        roughness: 0.35,
        metalness: 0,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      this.cursorGhost = new THREE.Mesh(geo, mat);
      this.cursorGhost.userData.defId = defId;
      this.scene.add(this.cursorGhost);
    }
    const mat = this.cursorGhost.material as THREE.MeshPhysicalMaterial;
    mat.color.set(ok ? 0xd7ffe0 : 0xffb0a4);
    const y = sampleHeight(this.terrain, x, z);
    this.cursorGhost.visible = true;
    this.cursorGhost.position.set(x, y, z);
    this.cursorGhost.scale.setScalar(def.scale);
    this.cursorGhost.rotation.y = heading;
  }

  poseCamera(x: number, z: number, yaw: number, pitch: number, dist: number) {
    this.cam.x = x;
    this.cam.z = z;
    this.cam.y = 2.1;
    this.cam.yaw = yaw;
    this.cam.pitch = pitch;
    this.cam.dist = dist;
  }

  focusPoint(x: number, z: number) {
    this.cam.x = clamp(x, -MAP_RADIUS, MAP_RADIUS);
    this.cam.z = clamp(z, -MAP_RADIUS, MAP_RADIUS);
  }

  highlightSpawns(taken: number[], active: number | null, hover: number | null) {
    this.spawnRings.forEach((ring, i) => {
      const mat = ring.material as THREE.MeshStandardMaterial;
      const used = taken.includes(i);
      mat.emissive.set(used ? 0x5a3030 : i === active ? 0xc9892e : i === hover ? 0x8fb56a : 0x000000);
      mat.color.set(used ? 0x6a4038 : 0xe6d2a4);
      ring.scale.setScalar(i === hover || i === active ? 1.08 : 1);
    });
  }

  pushSnapshot(snapshot: Snapshot) {
    this.prev = this.curr;
    this.curr = { snap: snapshot, at: performance.now() };
    this.objective = snapshot.cap[0] - snapshot.cap[1];
    this.syncProps(snapshot.props);
    for (const event of snapshot.fx) this.spawnFx(event);
  }

  groundAt(clientX: number, clientY: number): { x: number; y: number; z: number } | null {
    if (!this.terrainMesh) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.terrainMesh, false);
    if (!hits.length) return null;
    const p = hits[0].point;
    return { x: p.x, y: p.y, z: p.z };
  }

  project(x: number, y: number, z: number): { sx: number; sy: number; behind: boolean } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return {
      sx: (v.x * 0.5 + 0.5) * window.innerWidth,
      sy: (-v.y * 0.5 + 0.5) * window.innerHeight,
      behind: v.z > 1,
    };
  }

  showRange(unit: UnitSnap | null) {
    if (this.rangeLine) {
      this.scene.remove(this.rangeLine);
      this.rangeLine.geometry.dispose();
      this.rangeLine = null;
    }
    if (!unit || !this.terrain) return;
    const def = BY_ID[unit.defId];
    if (!def?.weapon) return;
    const segs = 96;
    const positions: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const x = unit.x + Math.cos(a) * def.weapon.range;
      const z = unit.z + Math.sin(a) * def.weapon.range;
      const y = sampleHeight(this.terrain, x, z) + 0.12;
      positions.push(x, y, z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: TEAMS[unit.team].hex, transparent: true, opacity: 0.55 });
    this.rangeLine = new THREE.Line(geo, mat);
    this.scene.add(this.rangeLine);
  }

  paintMinimap(canvas: HTMLCanvasElement) {
    if (!this.terrain) return;
    const w = canvas.width;
    const h = canvas.height;
    if (this.miniBake?.dataset.seed === String(this.terrain.seed) && this.miniBake.width === w) return;
    const bake = document.createElement('canvas');
    bake.width = w;
    bake.height = h;
    bake.dataset.seed = String(this.terrain.seed);
    const ctx = bake.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const res = this.terrain.resolution;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1);
        const v = y / (h - 1);
        const wx = (u * 2 - 1) * this.terrain.radius;
        const wz = (v * 2 - 1) * this.terrain.radius;
        const o = (y * w + x) * 4;
        if (Math.hypot(wx, wz) > this.terrain.radius) {
          img.data[o + 3] = 0;
          continue;
        }
        const i = clamp(Math.floor(u * (res - 1)), 0, res - 1);
        const j = clamp(Math.floor(v * (res - 1)), 0, res - 1);
        const hh = this.terrain.heights[j * res + i];
        const slope = 0.2 + hh * 0.05;
        const tint = terrainTint(wx, wz, hh, slope, this.terrain.seed);
        img.data[o] = Math.round(tint[0] * 255);
        img.data[o + 1] = Math.round(tint[1] * 255);
        img.data[o + 2] = Math.round(tint[2] * 255);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.miniBake = bake;
  }

  minimapDots(snapshot: Snapshot | null, canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !this.terrain || !this.miniBake) return;
    const w = canvas.width;
    ctx.clearRect(0, 0, w, canvas.height);
    ctx.drawImage(this.miniBake, 0, 0);
    const draw = (x: number, z: number, color: string, rad: number) => {
      const sx = ((x / this.terrain!.radius) * 0.5 + 0.5) * w;
      const sy = ((z / this.terrain!.radius) * 0.5 + 0.5) * w;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      ctx.fill();
    };
    ctx.strokeStyle = 'rgba(226,177,87,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w / 2, w / 2, (4.7 / this.terrain.radius) * w * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    if (!snapshot) return;
    for (const u of snapshot.units) {
      if (u.death >= 0) continue;
      const own = u.team === this.controlled;
      const seen = this.controlled === 0 ? u.spotted0 : u.spotted1;
      if (!own && !seen && this.mode === 'battle') continue;
      draw(u.x, u.z, TEAMS[u.team].plastic, own ? 3.2 : 2.6);
    }
  }

  pan(dx: number, dz: number) {
    this.cam.x = clamp(this.cam.x + dx, -MAP_RADIUS, MAP_RADIUS);
    this.cam.z = clamp(this.cam.z + dz, -MAP_RADIUS, MAP_RADIUS);
  }

  private frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    this.noteFrame(dt);
    this.onFrame(dt);
    this.updateCamera(dt);
    this.updateFx(dt);
    const list = this.mode === 'battle' ? this.sampleUnits() : this.showcase;
    this.drawUnits(list, this.mode === 'battle');
    this.drawProjectiles();
    this.drawBars();
    if (this.flagCloth) {
      const t = (this.objective + 1) / 2;
      const mat = this.flagCloth.material as THREE.MeshStandardMaterial;
      mat.color.copy(_team[0]).lerp(_team[1], 1 - t);
      if (Math.abs(this.objective) < 0.08) mat.color.set(0xf2efe6);
      this.flagCloth.rotation.y = Math.sin(this.clock * 1.5) * 0.25;
    }
    const rotor = this.preview.getObjectByName('rotor');
    if (rotor) rotor.rotation.y = this.clock * 14;
    if (this.mode === 'builder') {
      this.previewSpin += dt * 0.7;
      this.preview.rotation.y = this.previewSpin;
    }
    if (this.pipeline) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
  }

  private updateCamera(dt: number) {
    if (this.mode === 'menu') {
      if (!this.reduceMotion) this.menuYaw += dt * 0.12;
      const s = this.terrain?.spawns[0];
      const tx = s ? s.x * 0.62 : 0;
      const tz = s ? s.z * 0.62 : -6;
      this.cam.x = lerp(this.cam.x, tx, 0.04);
      this.cam.z = lerp(this.cam.z, tz, 0.04);
      this.cam.y = 1.3;
      this.cam.yaw = this.menuYaw;
      this.cam.pitch = 0.58;
      this.cam.dist = 16.5;
    } else if (this.mode === 'builder') {
      this.cam.x = lerp(this.cam.x, 0.15, 0.08);
      this.cam.y = lerp(this.cam.y, 0.95, 0.08);
      this.cam.z = lerp(this.cam.z, 0.05, 0.08);
      this.cam.yaw = lerpAngle(this.cam.yaw, 0.15, 0.08);
      this.cam.pitch = lerp(this.cam.pitch, 0.36, 0.08);
      this.cam.dist = lerp(this.cam.dist, 5.4, 0.08);
    } else if (this.mode === 'battle' || this.mode === 'deploy') {
      let ix = 0;
      let iz = 0;
      const commandKeys = this.mode === 'battle';
      if ((this.keys.has('a') && !commandKeys) || this.keys.has('arrowleft')) ix -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) ix += 1;
      if (this.keys.has('w') || this.keys.has('arrowup')) iz += 1;
      if ((this.keys.has('s') && !commandKeys) || this.keys.has('arrowdown')) iz -= 1;
      if (this.mode === 'battle' && !this.coarse) {
        ix += this.edge.x;
        iz -= this.edge.y;
      }
      if (this.keys.has('q')) this.cam.yaw += dt * 0.9;
      if (this.keys.has('e')) this.cam.yaw -= dt * 0.9;
      const speed = 16 * (this.cam.dist / 30);
      const fx = -Math.sin(this.cam.yaw);
      const fz = -Math.cos(this.cam.yaw);
      const rx = Math.cos(this.cam.yaw);
      const rz = -Math.sin(this.cam.yaw);
      this.cam.x = clamp(this.cam.x + (rx * ix + fx * iz) * speed * dt, -MAP_RADIUS, MAP_RADIUS);
      this.cam.z = clamp(this.cam.z + (rz * ix + fz * iz) * speed * dt, -MAP_RADIUS, MAP_RADIUS);
    }
    const horiz = Math.cos(this.cam.pitch) * this.cam.dist;
      const bob = this.shake > 0 ? Math.sin(this.clock * 46) * this.shake : 0;
      this.camera.position.set(
      this.cam.x + Math.sin(this.cam.yaw) * horiz + bob,
      this.cam.y + Math.sin(this.cam.pitch) * this.cam.dist + Math.cos(this.clock * 33) * this.shake * 0.45,
      this.cam.z + Math.cos(this.cam.yaw) * horiz,
    );
    this.camera.lookAt(this.cam.x, this.cam.y + bob * 0.2, this.cam.z);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 1.35);
  }

  private sampleUnits(): UnitSnap[] {
    const curr = this.curr?.snap;
    if (!curr) return [];
    const prev = this.prev?.snap;
    if (!prev) return curr.units;
    const alpha = clamp((performance.now() - (this.curr?.at ?? 0)) / 50, 0, 1);
    const map = new Map(prev.units.map((u) => [u.id, u]));
    return curr.units.map((u) => {
      const p = map.get(u.id);
      if (!p || p.defId !== u.defId) return u;
      return {
        ...u,
        x: lerp(p.x, u.x, alpha),
        y: lerp(p.y, u.y, alpha),
        z: lerp(p.z, u.z, alpha),
        heading: lerpAngle(p.heading, u.heading, alpha),
        turret: lerpAngle(p.turret, u.turret, alpha),
        death: u.death < 0 ? -1 : lerp(Math.max(0, p.death), u.death, alpha),
      };
    });
  }

  private drawUnits(list: UnitSnap[], fog: boolean) {
    const counts = new Map<string, number>();
    const blobCount = { n: 0 };
    const ringCount = { n: 0 };
    const now = performance.now();
    const draws: { snap: UnitSnap; ghost: boolean }[] = [];
    for (const unit of list) {
      const own = unit.team === this.controlled;
      const seen = this.controlled === 0 ? unit.spotted0 : unit.spotted1;
      const visible = !fog || own || seen || unit.death >= 0;
      if (visible) {
        draws.push({ snap: unit, ghost: false });
        if (fog && unit.death < 0) this.ghosts.set(unit.id, { snap: unit, at: now });
      } else {
        const ghost = this.ghosts.get(unit.id);
        if (ghost && now - ghost.at < 8000) draws.push({ snap: { ...ghost.snap, x: ghost.snap.x, z: ghost.snap.z }, ghost: true });
      }
    }
    for (const draw of draws) {
      const unit = draw.snap;
      const def = BY_ID[unit.defId];
      if (!def) continue;
      const dead = unit.death >= 0;
      const melt = dead ? clamp(1 - unit.death / 1.05, 0.08, 1) : 1;
      const tilt = dead ? clamp(unit.death / 0.45, 0, 1) * 1.25 : 0;
      const bob = !dead && (unit.state === 'move' || unit.state === 'fly') ? Math.sin(this.clock * 10 + unit.id) * 0.035 : 0;
      const y = unit.y + bob - (dead ? (1 - melt) * 0.42 : 0);
      this.put(def.mesh, counts, unit, y, unit.heading, def.scale * (0.25 + 0.75 * melt), tilt, draw.ghost);
      if (def.turret) {
        const off = turretOffset(def.turret);
        const hx = unit.x + Math.sin(unit.heading) * off.z + Math.cos(unit.heading) * off.x;
        const hz = unit.z + Math.cos(unit.heading) * off.z - Math.sin(unit.heading) * off.x;
        this.putAt(def.turret, counts, hx, y + off.y * def.scale, hz, unit.turret, def.scale, unit, draw.ghost, 0);
      }
      if (def.rotor) {
        const off = rotorOffset();
        const spin = this.clock * (14 + (unit.id % 5));
        this.putAt('rotor', counts, unit.x, y + off.y * def.scale, unit.z, unit.heading + spin, def.scale, unit, draw.ghost, 0);
      }
      if (!def.flying && !dead) {
        const i = blobCount.n++;
        if (i < this.blobs.count) {
          _dummy.position.set(unit.x, y + 0.06, unit.z);
          _dummy.rotation.set(-Math.PI / 2, 0, 0);
          _dummy.scale.setScalar(def.radius * 3.1);
          _dummy.updateMatrix();
          this.blobs.setMatrixAt(i, _dummy.matrix);
        }
      }
      if (this.selected.has(unit.id) && !draw.ghost && unit.death < 0) {
        const i = ringCount.n++;
        _dummy.position.set(unit.x, y + 0.08, unit.z);
        _dummy.rotation.set(-Math.PI / 2, 0, 0);
        _dummy.scale.setScalar(0.75 + def.radius);
        _dummy.updateMatrix();
        this.rings.setMatrixAt(i, _dummy.matrix);
        this.rings.setColorAt(i, _team[unit.team]);
      }
    }
    for (const [key, mesh] of this.pools) {
      mesh.count = counts.get(key) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.blobs.count = blobCount.n;
    this.blobs.instanceMatrix.needsUpdate = true;
    this.rings.count = ringCount.n;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
  }

  private put(meshKey: string, counts: Map<string, number>, unit: UnitSnap, y: number, heading: number, scale: number, tilt: number, ghost: boolean) {
    this.putAt(meshKey, counts, unit.x, y, unit.z, heading, scale, unit, ghost, tilt);
  }

  private putAt(
    meshKey: string,
    counts: Map<string, number>,
    x: number,
    y: number,
    z: number,
    heading: number,
    scale: number,
    unit: UnitSnap,
    ghost: boolean,
    tilt: number,
  ) {
    const mesh = this.pools.get(meshKey);
    if (!mesh) return;
    const i = counts.get(meshKey) ?? 0;
    if (i >= mesh.instanceMatrix.count) return;
    counts.set(meshKey, i + 1);
    _dummy.position.set(x, y, z);
    _dummy.rotation.set(tilt, heading, 0);
    const flash = this.flashes.get(unit.id) ?? 0;
    const s = scale * (ghost ? 0.96 : 1);
    _dummy.scale.setScalar(s);
    _dummy.updateMatrix();
    mesh.setMatrixAt(i, _dummy.matrix);
    _color.copy(unit.defId === 'arvore' ? _treeColor : _team[unit.team]);
    const jitter = 0.94 + (unit.id % 5) * 0.015;
    _color.multiplyScalar(jitter);
    if (flash > 0) _color.lerp(_white, clamp(flash, 0, 0.7));
    if (ghost) _color.lerp(_white, 0.55);
    mesh.setColorAt(i, _color);
  }

  private drawBars() {
    const ctx = this.fxCtx;
    const dpr = this.fxCanvas.width / Math.max(1, window.innerWidth);
    ctx.clearRect(0, 0, this.fxCanvas.width, this.fxCanvas.height);
    if (this.mode !== 'battle') return;
    const list = this.sampleUnits();
    ctx.save();
    ctx.scale(dpr, dpr);
    for (const unit of list) {
      if (unit.death >= 0) continue;
      const own = unit.team === this.controlled;
      const seen = this.controlled === 0 ? unit.spotted0 : unit.spotted1;
      if (!own && !seen) continue;
      const show = this.selected.has(unit.id) || unit.id === this.hoverId || unit.hp < unit.hpMax - 0.5;
      if (!show) continue;
      const def = BY_ID[unit.defId];
      const p = this.project(unit.x, unit.y + (def?.eye ?? 1.4) + 0.55, unit.z);
      if (p.behind) continue;
      const w = 36;
      const h = 4;
      const x = p.sx - w / 2;
      const y = p.sy;
      ctx.fillStyle = 'rgba(12,10,8,0.7)';
      ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
      ctx.fillStyle = unit.team === 0 ? '#2f9a48' : '#d1a86a';
      ctx.fillRect(x, y, w * clamp(unit.hp / unit.hpMax, 0, 1), h);
    }
    ctx.restore();
  }

  private spawnFx(event: FxEvent) {
    if (event.kind === 'hit') {
      this.flashes.set(event.id, 1);
      return;
    }
    if (event.kind === 'muzzle') {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xfff2c4, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      mesh.position.set(event.x, event.y, event.z);
      this.scene.add(mesh);
      this.live.push({ kind: 'muzzle', life: 0.08, max: 0.08, mesh, size: event.shot === 'bullet' ? 1.4 : 2.4 });
      return;
    }
    if (event.kind === 'tracer') {
      const positions = new Float32Array([event.x, event.y, event.z, event.x2, event.y2, event.z2]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const hot = event.shot === 'shell' || event.shot === 'bomb' ? 0xffe08a : event.shot === 'rocket' || event.shot === 'missile' ? 0xffb070 : 0xfff6cf;
      const mat = new THREE.LineBasicMaterial({
        color: hot,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Line(geo, mat);
      this.scene.add(mesh);
      this.live.push({ kind: 'tracer', life: event.shot === 'bullet' ? 0.16 : 0.28, max: 0.28, mesh, size: 1 });
      return;
    }
    if (event.kind === 'break') {
      this.hideProp(event.id);
      this.toss(event.x, event.y, event.z, event.prop === 'tower' ? 22 : 12, PROP_COLOR[event.prop], 4.2 + event.size);
      this.shake = Math.max(this.shake, 0.16);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffc48a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      mesh.position.set(event.x, event.y, event.z);
      this.scene.add(mesh);
      this.live.push({ kind: 'boom', life: 0.35, max: 0.35, mesh, size: event.size });
      return;
    }
    if (event.kind === 'death') {
      this.dropPuddle(event.x, event.y, event.z, event.team);
      this.toss(event.x, event.y + 0.4, event.z, 6, event.team === 0 ? 0x2f9a48 : 0xd1a86a, 1.6);
    }
    if (event.kind === 'boom' || event.kind === 'death') {
      const size = event.kind === 'boom' ? event.size : 0.7;
      const y = event.kind === 'boom' ? event.y : event.y + 0.35;
      if (event.kind === 'boom' && size > 0.45) {
        const dist = Math.hypot(event.x - this.cam.x, event.z - this.cam.z);
        this.shake = Math.max(this.shake, clamp((size * 0.42) / (1.6 + dist * 0.12), 0, 0.38));
        if (size > 0.8) this.toss(event.x, y, event.z, Math.min(12, Math.round(size * 3)), 0x6a5a48, size * 1.4);
      }
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 10, 8),
        new THREE.MeshBasicMaterial({
          color: event.kind === 'death' ? 0x2a241c : 0xffb15a,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      mesh.position.set(event.x, y, event.z);
      this.scene.add(mesh);
      this.live.push({ kind: 'boom', life: size > 1 ? 0.62 : 0.4, max: 0.62, mesh, size });
      if (event.kind === 'boom' && size > 0.7) this.pulseShock(event.x, y, event.z, size);
      return;
    }
    if (event.kind === 'marker') {
      const geo = new THREE.RingGeometry(0.4, 0.55, 24);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      );
      mesh.position.set(event.x, event.y, event.z);
      this.scene.add(mesh);
      this.live.push({ kind: 'marker', life: 1.3, max: 1.3, mesh, size: 3 });
    }
  }

  private updateFx(dt: number) {
    for (const [id, t] of this.flashes) {
      const n = t - dt * 3.5;
      if (n <= 0) this.flashes.delete(id);
      else this.flashes.set(id, n);
    }
    this.live = this.live.filter((fx) => {
      fx.life -= dt;
      const k = clamp(fx.life / fx.max, 0, 1);
      if (fx.kind === 'tracer') {
        ((fx.mesh as THREE.Line).material as THREE.LineBasicMaterial).opacity = k;
      } else if (fx.kind === 'boom') {
        const s = fx.size * (1.2 - k);
        fx.mesh.scale.setScalar(Math.max(0.2, s));
        ((fx.mesh as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = k;
      } else {
        fx.mesh.scale.setScalar(1 + (1 - k) * fx.size);
        ((fx.mesh as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = k;
      }
      if (fx.life <= 0) {
        this.scene.remove(fx.mesh);
        const mesh = fx.mesh as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | undefined;
        mat?.dispose();
        return false;
      }
      return true;
    });
    this.stepDebris(dt);
  }

  private pulseShock(x: number, y: number, z: number, size: number) {
    const mesh = new THREE.Mesh(
      (() => {
        const geo = new THREE.RingGeometry(0.25, 0.42, 28);
        geo.rotateX(-Math.PI / 2);
        return geo;
      })(),
      new THREE.MeshBasicMaterial({ color: 0xffd7a2, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.position.set(x, y + 0.08, z);
    this.scene.add(mesh);
    this.live.push({ kind: 'shock', life: 0.45, max: 0.45, mesh, size: Math.max(2.2, size) });
  }

  private dropPuddle(x: number, y: number, z: number, team: 0 | 1) {
    this.ensureJuice();
    if (!this.puddles) return;
    const i = this.puddleCount % 48;
    this.puddleCount += 1;
    this.puddles.count = Math.min(48, this.puddleCount);
    _dummy.position.set(x, y + 0.05, z);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.set(1.3, 1, 1.05);
    _dummy.updateMatrix();
    this.puddles.setMatrixAt(i, _dummy.matrix);
    _color.set(team === 0 ? 0x1f7a38 : 0xc49255);
    this.puddles.setColorAt(i, _color);
    this.puddles.instanceMatrix.needsUpdate = true;
    if (this.puddles.instanceColor) this.puddles.instanceColor.needsUpdate = true;
  }

  private toss(x: number, y: number, z: number, count: number, color: number, force: number) {
    this.ensureJuice();
    _color.set(color);
    for (let n = 0; n < count; n++) {
      const bit = this.bits.find((item) => item.life <= 0) ?? this.bits.find((item) => item.settled) ?? this.bits[n % this.bits.length];
      const ang = Math.random() * Math.PI * 2;
      const spd = force * (0.35 + Math.random() * 0.8);
      bit.life = 0.7 + Math.random() * 0.5;
      bit.max = bit.life;
      bit.x = x;
      bit.y = y;
      bit.z = z;
      bit.vx = Math.cos(ang) * spd;
      bit.vz = Math.sin(ang) * spd;
      bit.vy = 1.4 + Math.random() * force;
      bit.spin = Math.random() * 6;
      bit.size = 0.35 + Math.random() * 0.7;
      bit.settled = false;
      if (this.debris) this.debris.setColorAt(this.bits.indexOf(bit), _color);
    }
    if (this.debris?.instanceColor) this.debris.instanceColor.needsUpdate = true;
  }

  private stepDebris(dt: number) {
    if (!this.debris) return;
    this.bits.forEach((bit, i) => {
      if (bit.life <= 0) {
        _dummy.position.set(0, -8, 0);
        _dummy.scale.setScalar(0);
        _dummy.updateMatrix();
        this.debris!.setMatrixAt(i, _dummy.matrix);
        return;
      }
      if (!bit.settled) {
        bit.vy -= 14 * dt;
        bit.x += bit.vx * dt;
        bit.y += bit.vy * dt;
        bit.z += bit.vz * dt;
        const ground = this.terrain ? sampleHeight(this.terrain, bit.x, bit.z) : 0;
        if (bit.y <= ground + 0.05) {
          bit.y = ground + 0.05;
          bit.vy = 0;
          bit.vx *= 0.2;
          bit.vz *= 0.2;
          bit.settled = true;
          bit.life = 8;
          bit.max = 8;
        } else bit.life -= dt;
      } else {
        bit.life -= dt;
      }
      _dummy.position.set(bit.x, bit.y, bit.z);
      _dummy.rotation.set(bit.spin, bit.spin * 0.7, 0);
      _dummy.scale.setScalar(bit.size * (bit.settled ? 0.7 : 1));
      _dummy.updateMatrix();
      this.debris!.setMatrixAt(i, _dummy.matrix);
    });
    this.debris.instanceMatrix.needsUpdate = true;
  }

  private buildRoom() {
    const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.72, metalness: 0.04, color: 0xffffff });
    const table = new THREE.Mesh(new THREE.CylinderGeometry(54, 56, 1.4, 72), wood);
    table.position.y = -2.15;
    table.receiveShadow = true;
    this.scene.add(table);
    const felt = new THREE.Mesh(
      new THREE.CircleGeometry(36, 64),
      new THREE.MeshStandardMaterial({ color: 0x1d4630, roughness: 0.95, metalness: 0 }),
    );
    felt.rotation.x = -Math.PI / 2;
    felt.position.y = -1.42;
    felt.receiveShadow = true;
    this.scene.add(felt);

    const hemi = new THREE.HemisphereLight(0xfff4e4, 0x2a3a28, 0.72);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1dd, 3.35);
    this.sun = sun;
    sun.position.set(-18, 32, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 8;
    sun.shadow.camera.far = 70;
    sun.shadow.camera.left = -36;
    sun.shadow.camera.right = 36;
    sun.shadow.camera.top = 36;
    sun.shadow.camera.bottom = -36;
    sun.shadow.bias = -0.00012;
    sun.shadow.normalBias = 0.035;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xc9d7ff, 0.55);
    fill.position.set(20, 12, -10);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffc48a, 0.85);
    rim.position.set(-6, 10, -24);
    this.scene.add(rim);

    const shadeMat = new THREE.MeshStandardMaterial({
      color: 0xf4e2c2,
      emissive: 0xffc98a,
      emissiveIntensity: 0.85,
      roughness: 0.45,
      side: THREE.DoubleSide,
    });
    const shade = new THREE.Mesh(new THREE.ConeGeometry(1.3, 0.9, 18, 1, true), shadeMat);
    shade.position.set(-24, 11.5, -16);
    shade.rotation.z = 0.4;
    this.scene.add(shade);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff1d2 }),
    );
    bulb.position.set(-23.4, 11.1, -15.6);
    this.scene.add(bulb);

    const die = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.7, 0.7),
      new THREE.MeshPhysicalMaterial({ color: 0xf3efe4, roughness: 0.35, clearcoat: 0.6 }),
    );
    die.position.set(33, -1.05, 8);
    die.rotation.set(0.4, 0.5, 0.2);
    die.castShadow = true;
    this.scene.add(die);
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.34, 0.7, 12),
      new THREE.MeshPhysicalMaterial({ color: 0xb4332a, roughness: 0.32, clearcoat: 0.8 }),
    );
    pot.position.set(-31, -1.05, 14);
    pot.castShadow = true;
    this.scene.add(pot);

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.04, 2.4, 8),
      new THREE.MeshStandardMaterial({ color: 0xded6c6, roughness: 0.4, metalness: 0.2 }),
    );
    pole.position.set(0, 1.2, 0);
    pole.castShadow = true;
    this.flagPole = pole;
    this.scene.add(pole);
    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7, 0.42),
      new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.7, side: THREE.DoubleSide }),
    );
    cloth.position.set(0.35, 2.15, 0);
    this.flagCloth = cloth;
    this.scene.add(cloth);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(4.3, 4.7, 48),
      new THREE.MeshBasicMaterial({ color: 0xe2b15a, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 2.95;
    this.objectiveRing = ring;
    this.scene.add(ring);

    this.podium = new THREE.Mesh(
      new THREE.CylinderGeometry(1.35, 1.48, 0.28, 40),
      new THREE.MeshPhysicalMaterial({ color: 0x6b4229, roughness: 0.48, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
    );
    this.podium.position.set(2.15, -0.14, 0.15);
    this.podium.castShadow = true;
    this.podium.receiveShadow = true;
    this.podium.visible = false;
    this.scene.add(this.podium);
  }

  private buildPools() {
    const lib = meshLibrary();
    const plastic = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      color: 0xffffff,
      roughness: 0.32,
      metalness: 0.02,
      clearcoat: 1,
      clearcoatRoughness: 0.18,
      sheen: 0.25,
      sheenColor: new THREE.Color(0xfff6ea),
      sheenRoughness: 0.45,
      roughnessMap: roughnessTexture(),
      envMapIntensity: 1.05,
    });
    for (const [key, geo] of Object.entries(lib)) {
      const mesh = new THREE.InstancedMesh(geo, plastic, key === 'arvore' ? 24 : 80);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.pools.set(key, mesh);
    }
    const blobGeo = new THREE.PlaneGeometry(1, 1);
    this.blobs = new THREE.InstancedMesh(
      blobGeo,
      new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }),
      80,
    );
    this.blobs.count = 0;
    this.blobs.frustumCulled = false;
    this.scene.add(this.blobs);
    const ringGeo = new THREE.RingGeometry(0.55, 0.72, 28);
    this.rings = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
      40,
    );
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.scene.add(this.rings);
    this.shots = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.14, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      96,
    );
    this.shots.count = 0;
    this.shots.frustumCulled = false;
    this.scene.add(this.shots);
  }

  private drawProjectiles() {
    const list = this.mode === 'battle' ? (this.curr?.snap.projectiles ?? []) : [];
    let i = 0;
    for (const shot of list) {
      if (i >= 96) break;
      const scale = shot.shot === 'bomb' ? 2.4 : shot.shot === 'missile' || shot.shot === 'rocket' ? 1.7 : shot.shot === 'shell' ? 1.25 : 0.65;
      _dummy.position.set(shot.x, shot.y, shot.z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      this.shots.setMatrixAt(i, _dummy.matrix);
      _color.set(shot.team === 0 ? 0xfff6cf : 0xffcba8);
      this.shots.setColorAt(i, _color);
      i += 1;
    }
    this.shots.count = i;
    this.shots.instanceMatrix.needsUpdate = true;
    if (this.shots.instanceColor) this.shots.instanceColor.needsUpdate = true;
  }

  private chooseQuality(): 'high' | 'medium' | 'low' {
    const narrow = Math.min(window.innerWidth, window.innerHeight) < 520;
    const cores = navigator.hardwareConcurrency || 8;
    if (narrow || (this.coarse && cores <= 4)) return 'low';
    if (this.coarse || window.innerWidth < 1024) return 'medium';
    return 'high';
  }

  private applyQuality() {
    const dpr = window.devicePixelRatio || 1;
    const cap = this.quality === 'low' ? 1 : this.quality === 'medium' ? 1.25 : 1.6;
    let ratio = Math.min(dpr, cap);
    const longest = Math.max(window.innerWidth, window.innerHeight) * ratio;
    const limit = this.quality === 'low' ? 1280 : this.quality === 'medium' ? 1700 : 2400;
    if (longest > limit) ratio *= limit / longest;
    this.pixelRatio = Math.max(0.65, ratio);
    this.renderer.shadowMap.enabled = this.quality !== 'low';
    if (this.sun) {
      const size = this.quality === 'high' ? 2048 : this.quality === 'medium' ? 1024 : 512;
      this.sun.castShadow = this.quality !== 'low';
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.syncShadowCasters();
    if (this.quality === 'low') this.pipeline = null;
    else this.buildPost(this.quality === 'high');
    this.resize();
  }

  private syncShadowCasters() {
    const on = this.quality !== 'low';
    if (this.terrainMesh) {
      this.terrainMesh.castShadow = on;
      this.terrainMesh.receiveShadow = on;
    }
    if (this.lip) {
      this.lip.castShadow = on;
      this.lip.receiveShadow = on;
    }
    for (const mesh of this.propMeshes.values()) {
      mesh.castShadow = on;
      mesh.receiveShadow = on;
    }
    if (this.debris) {
      this.debris.castShadow = false;
      this.debris.receiveShadow = on;
    }
    for (const mesh of this.pools.values()) {
      mesh.castShadow = on;
      mesh.receiveShadow = on;
    }
  }

  private noteFrame(dt: number) {
    this.warmed += dt;
    if (this.warmed < 2.5 || this.quality === 'low') return;
    if (dt > 0.034) this.slowFrames += 1;
    else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (this.slowFrames < 40) return;
    this.quality = this.quality === 'high' ? 'medium' : 'low';
    this.slowFrames = 0;
    this.applyQuality();
  }

  private buildPost(withAo: boolean) {
    try {
      const scenePass = pass(this.scene, this.camera);
      if (withAo) {
        const prePass = pass(this.scene, this.camera);
        prePass.transparent = false;
        prePass.setMRT(mrt({ output: packNormalToRGB(normalView) }));
        const prePassNormal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)));
        const prePassDepth = prePass.getTextureNode('depth');
        const aoPass = ssao(prePassDepth, prePassNormal, this.camera);
        aoPass.resolutionScale = 0.75;
        aoPass.radius.value = 1.35;
        aoPass.intensity.value = 1.05;
        aoPass.bias.value = 0.035;
        aoPass.samples.value = 10;
        scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
      }
      const color = scenePass.getTextureNode('output');
      const bloomPass = bloom(color, withAo ? 0.22 : 0.14, 0.36, 0.9);
      const pipeline = new THREE.RenderPipeline(this.renderer);
      pipeline.outputNode = color.add(bloomPass);
      this.pipeline = pipeline;
    } catch (err) {
      console.warn('Pós-processamento indisponível, seguindo com o render direto.', err);
      this.pipeline = null;
    }
  }

  private rebuildTerrainMesh() {
    if (!this.terrain) return;
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
    }
    const t = this.terrain;
    const res = t.resolution;
    const positions = new Float32Array(res * res * 3);
    const colors = new Float32Array(res * res * 3);
    const normals = new Float32Array(res * res * 3);
    const stride = (x: number, z: number) => clamp(z, 0, res - 1) * res + clamp(x, 0, res - 1);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const u = i / (res - 1);
        const v = j / (res - 1);
        let x = (u * 2 - 1) * t.radius;
        let z = (v * 2 - 1) * t.radius;
        const d = Math.hypot(x, z);
        let y = t.heights[j * res + i];
        if (d > t.radius) {
          const k = clamp((d - t.radius) / (t.radius * 0.045), 0, 1);
          y = y * (1 - k) + -1.25 * k;
          const s = t.radius * 1.045 / d;
          x *= s;
          z *= s;
        }
        const idx = j * res + i;
        positions[idx * 3] = x;
        positions[idx * 3 + 1] = y;
        positions[idx * 3 + 2] = z;
      }
    }
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const iL = stride(i - 1, j);
        const iR = stride(i + 1, j);
        const iD = stride(i, j - 1);
        const iU = stride(i, j + 1);
        const hL = positions[iL * 3 + 1];
        const hR = positions[iR * 3 + 1];
        const hD = positions[iD * 3 + 1];
        const hU = positions[iU * 3 + 1];
        const dx = (2 * t.radius) / res;
        const nx = hL - hR;
        const ny = 2 * dx;
        const nz = hD - hU;
        const len = Math.hypot(nx, ny, nz) || 1;
        const idx = j * res + i;
        normals[idx * 3] = nx / len;
        normals[idx * 3 + 1] = ny / len;
        normals[idx * 3 + 2] = nz / len;
        const slope = 1 - ny / len;
        const tint = terrainTint(positions[idx * 3], positions[idx * 3 + 2], positions[idx * 3 + 1], slope * 1.4, t.seed);
        colors[idx * 3] = tint[0];
        colors[idx * 3 + 1] = tint[1];
        colors[idx * 3 + 2] = tint[2];
      }
    }
    const index = new Uint32Array((res - 1) * (res - 1) * 6);
    let w = 0;
    for (let j = 0; j < res - 1; j++) {
      for (let i = 0; i < res - 1; i++) {
        const a = j * res + i;
        index[w++] = a;
        index[w++] = a + res;
        index[w++] = a + 1;
        index[w++] = a + 1;
        index[w++] = a + res;
        index[w++] = a + res + 1;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.02,
      envMapIntensity: 0.25,
    });
    this.terrainMesh = new THREE.Mesh(geo, mat);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.castShadow = true;
    this.scene.add(this.terrainMesh);

    if (this.lip) this.scene.remove(this.lip);
    this.lip = new THREE.Mesh(
      new THREE.TorusGeometry(t.radius, 0.38, 10, 80),
      new THREE.MeshPhysicalMaterial({ color: 0x6d8a52, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.2 }),
    );
    this.lip.rotation.x = Math.PI / 2;
    this.lip.position.y = 0.62;
    this.lip.castShadow = true;
    this.lip.receiveShadow = true;
    this.scene.add(this.lip);
    this.syncShadowCasters();
  }

  private hideProp(id: number) {
    this.propAlive.set(id, false);
    this.layoutProps();
  }

  private syncProps(list: PropSnap[]) {
    let changed = this.propMeshes.size === 0;
    for (const prop of list) {
      const prev = this.propAlive.get(prop.id);
      if (prev !== prop.alive) {
        this.propAlive.set(prop.id, prop.alive);
        changed = true;
      }
    }
    if (changed) this.layoutProps();
  }

  private layoutProps() {
    if (!this.terrain) return;
    this.ensureJuice();
    const lib = propLibrary();
    for (const [kind, geo] of Object.entries(lib) as [PropKind, THREE.BufferGeometry][]) {
      const all = this.terrain.props.filter((prop) => prop.kind === kind);
      let mesh = this.propMeshes.get(kind);
      if (!mesh) {
        const cap = Math.max(all.length, 1);
        mesh = new THREE.InstancedMesh(
          geo,
          new THREE.MeshStandardMaterial({ roughness: 0.66, metalness: 0.08, color: 0xffffff }),
          cap,
        );
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        mesh.frustumCulled = false;
        mesh.castShadow = this.quality !== 'low';
        mesh.receiveShadow = this.quality !== 'low';
        this.scene.add(mesh);
        this.propMeshes.set(kind, mesh);
      }
      _color.set(PROP_COLOR[kind]);
      let shown = 0;
      all.forEach((prop, i) => {
        if (i >= mesh!.instanceMatrix.count) return;
        const alive = this.propAlive.get(prop.id) !== false;
        _dummy.position.set(prop.x, alive ? prop.y : -8, prop.z);
        _dummy.rotation.set(0, prop.rot, 0);
        _dummy.scale.setScalar(alive ? prop.scale : 0);
        _dummy.updateMatrix();
        mesh!.setMatrixAt(i, _dummy.matrix);
        mesh!.setColorAt(i, _color);
        if (alive) shown += 1;
      });
      mesh.count = all.length;
      mesh.visible = shown > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private ensureJuice() {
    if (this.debris) return;
    this.debris = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.16, 0.1, 0.2),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.05 }),
      140,
    );
    this.debris.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(140 * 3), 3);
    this.debris.frustumCulled = false;
    this.debris.count = 140;
    this.scene.add(this.debris);
    for (let i = 0; i < 140; i++) {
      this.bits.push({ life: 0, max: 1, x: 0, y: -8, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, size: 0.2, settled: false });
      _dummy.position.set(0, -8, 0);
      _dummy.scale.setScalar(0);
      _dummy.updateMatrix();
      this.debris.setMatrixAt(i, _dummy.matrix);
    }
    const puddleGeo = new THREE.CircleGeometry(0.42, 14);
    puddleGeo.rotateX(-Math.PI / 2);
    this.puddles = new THREE.InstancedMesh(
      puddleGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.22, metalness: 0.05, transparent: true, opacity: 0.92 }),
      48,
    );
    this.puddles.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(48 * 3), 3);
    this.puddles.frustumCulled = false;
    this.puddles.count = 0;
    this.scene.add(this.puddles);
  }

  private placeSpawns() {
    for (const mesh of this.spawnRings) this.scene.remove(mesh);
    for (const mesh of this.spawnLabels) this.scene.remove(mesh);
    this.spawnRings = [];
    this.spawnLabels = [];
    if (!this.terrain) return;
    this.terrain.spawns.forEach((spawn, index) => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(2.5, 2.85, 32),
        new THREE.MeshStandardMaterial({ color: 0xe6d2a4, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide, emissive: 0x000000 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(spawn.x, spawn.y + 0.08, spawn.z);
      this.scene.add(ring);
      this.spawnRings.push(ring);
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 128;
      const g = c.getContext('2d')!;
      g.fillStyle = '#1b1712';
      g.beginPath();
      g.arc(64, 64, 58, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#f3ead7';
      g.font = '700 72px Outfit, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(index + 1), 64, 70);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Mesh(
        new THREE.CircleGeometry(0.7, 20),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
      );
      label.rotation.x = -Math.PI / 2;
      label.position.set(spawn.x, spawn.y + 0.12, spawn.z);
      this.scene.add(label);
      this.spawnLabels.push(label);
    });
    if (this.flagCloth && this.terrain) {
      const y = sampleHeight(this.terrain, 0, 0);
      this.flagPole.position.y = y + 1.15;
      this.flagCloth.position.set(0.36, y + 2.05, 0);
      this.objectiveRing.position.y = y + 0.08;
    }
  }

  private dressMenu() {
    if (!this.terrain) return;
    const units: UnitSnap[] = [];
    let id = 0;
    const place = (team: 0 | 1, spawnIndex: number, defs: string[], distForward: number) => {
      const spawn = this.terrain!.spawns[spawnIndex];
      const fx = Math.sin(spawn.heading);
      const fz = Math.cos(spawn.heading);
      const rx = Math.cos(spawn.heading);
      const rz = -Math.sin(spawn.heading);
      defs.forEach((defId, index) => {
        const col = (index % 4) - 1.5;
        const row = Math.floor(index / 4);
        const x = spawn.x + fx * (distForward + row * 1.6) + rx * col * 1.3;
        const z = spawn.z + fz * (distForward + row * 1.6) + rz * col * 1.3;
        const def = BY_ID[defId];
        units.push({
          id: id++,
          team,
          defId,
          x,
          y: def.flying ? def.altitude : sampleHeight(this.terrain!, x, z),
          z,
          heading: team === 0 ? spawn.heading : spawn.heading + Math.PI,
          turret: team === 0 ? spawn.heading : spawn.heading + Math.PI,
          hp: def.hp,
          hpMax: def.hp,
          state: def.flying ? 'fly' : 'idle',
          spotted0: true,
          spotted1: true,
          death: -1,
          garrison: false,
          ability: 0,
        });
      });
    };
    place(0, 0, ['fuzileiro', 'fuzileiro', 'fuzileiro', 'metralhador', 'tanque_medio', 'jipe'], 2.2);
    place(1, 4, ['fuzileiro', 'fuzileiro', 'fuzileiro', 'atirador', 'tanque_leve'], 2.2);
    this.showcase = units;
  }
}
