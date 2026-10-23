import { MAP_RADIUS } from './constants';
import { clamp, len2, smoothstep } from './math';
import { Rng } from './rng';

export type PropKind = 'tree' | 'car' | 'lamp' | 'wall' | 'rubble' | 'barricade' | 'tower' | 'bag';

export interface Prop {
  id: number;
  kind: PropKind;
  x: number;
  z: number;
  y: number;
  scale: number;
  rot: number;
  radius: number;
  height: number;
  hp: number;
  maxHp: number;
  alive: boolean;
}

export interface SpawnPoint {
  index: number;
  x: number;
  z: number;
  y: number;
  heading: number;
}

export interface Terrain {
  seed: number;
  resolution: number;
  radius: number;
  heights: Float32Array;
  navRes: number;
  walkable: Uint8Array;
  cost: Float32Array;
  props: Prop[];
  spawns: SpawnPoint[];
}

const RES = 176;
const NAV = 88;

function noise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const v00 = Rng.hash2(x0, z0, seed);
  const v10 = Rng.hash2(x0 + 1, z0, seed);
  const v01 = Rng.hash2(x0, z0 + 1, seed);
  const v11 = Rng.hash2(x0 + 1, z0 + 1, seed);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sz;
}

function fbm(x: number, z: number, seed: number): number {
  let a = 0;
  let f = 1;
  let w = 0.5;
  let sum = 0;
  for (let o = 0; o < 5; o++) {
    a += noise(x * f, z * f, seed + o * 101) * w;
    sum += w;
    f *= 2.02;
    w *= 0.5;
  }
  return a / sum;
}

export function worldToGrid(t: Terrain, x: number, z: number): { i: number; j: number } | null {
  const u = x / t.radius * 0.5 + 0.5;
  const v = z / t.radius * 0.5 + 0.5;
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return null;
  return {
    i: Math.min(t.navRes - 1, Math.floor(u * t.navRes)),
    j: Math.min(t.navRes - 1, Math.floor(v * t.navRes)),
  };
}

export function gridCenter(t: Terrain, i: number, j: number): { x: number; z: number } {
  const u = (i + 0.5) / t.navRes;
  const v = (j + 0.5) / t.navRes;
  return { x: (u * 2 - 1) * t.radius, z: (v * 2 - 1) * t.radius };
}

export function sampleHeight(t: Terrain, x: number, z: number): number {
  const res = t.resolution;
  const fx = (x / t.radius * 0.5 + 0.5) * (res - 1);
  const fz = (z / t.radius * 0.5 + 0.5) * (res - 1);
  if (fx < 0 || fz < 0 || fx > res - 1 || fz > res - 1) return 0;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, res - 1);
  const z1 = Math.min(z0 + 1, res - 1);
  const tx = fx - x0;
  const tz = fz - z0;
  const h00 = t.heights[z0 * res + x0];
  const h10 = t.heights[z0 * res + x1];
  const h01 = t.heights[z1 * res + x0];
  const h11 = t.heights[z1 * res + x1];
  return (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
}

export function isWalkable(t: Terrain, x: number, z: number): boolean {
  if (len2(x, z) > t.radius * 0.9) return false;
  const c = worldToGrid(t, x, z);
  if (!c) return false;
  return t.walkable[c.j * t.navRes + c.i] === 1;
}

export function moveCost(t: Terrain, x: number, z: number): number {
  const c = worldToGrid(t, x, z);
  if (!c) return 4;
  return t.cost[c.j * t.navRes + c.i];
}

/** How strongly a molded path pulls this point. Visual + gameplay share it. */
export function corridorWeight(x: number, z: number): number {
  const ring = MAP_RADIUS * 0.7;
  const radial = len2(x, z);
  const ringW = Math.exp(-((radial - ring) ** 2) / (2 * 2.15 ** 2));
  let spoke = 0;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const px = Math.cos(a);
    const pz = Math.sin(a);
    const along = x * px + z * pz;
    if (along < 0 || along > ring + 1) continue;
    const sx = px * along;
    const sz = pz * along;
    const side = Math.hypot(x - sx, z - sz);
    spoke = Math.max(spoke, Math.exp(-(side * side) / (2 * 2.35 ** 2)));
  }
  return clamp(Math.max(ringW * 0.85, spoke), 0, 1);
}

function stamp(heights: Float32Array, res: number, radius: number, cx: number, cz: number, width: number, target: (x: number, z: number, h: number) => number, amount: number) {
  const reach = width * 3;
  const minI = clamp(Math.floor(((cx - reach) / radius * 0.5 + 0.5) * (res - 1)), 0, res - 1);
  const maxI = clamp(Math.ceil(((cx + reach) / radius * 0.5 + 0.5) * (res - 1)), 0, res - 1);
  const minJ = clamp(Math.floor(((cz - reach) / radius * 0.5 + 0.5) * (res - 1)), 0, res - 1);
  const maxJ = clamp(Math.ceil(((cz + reach) / radius * 0.5 + 0.5) * (res - 1)), 0, res - 1);
  for (let j = minJ; j <= maxJ; j++) {
    for (let i = minI; i <= maxI; i++) {
      const x = (i / (res - 1) * 2 - 1) * radius;
      const z = (j / (res - 1) * 2 - 1) * radius;
      const d = Math.hypot(x - cx, z - cz);
      const w = Math.exp(-(d * d) / (2 * width * width));
      if (w < 0.02) continue;
      const idx = j * res + i;
      const h = heights[idx];
      heights[idx] = h + (target(x, z, h) - h) * clamp(w * amount, 0, 1);
    }
  }
}

function writeCell(t: Terrain, i: number, j: number) {
  const cell = (t.radius * 2) / t.navRes;
  const { x, z } = gridCenter(t, i, j);
  const idx = j * t.navRes + i;
  const d = len2(x, z);
  if (d > t.radius * 0.9) {
    t.walkable[idx] = 0;
    t.cost[idx] = 99;
    return;
  }
  const h = sampleHeight(t, x, z);
  const slope = Math.max(
    Math.abs(sampleHeight(t, x + cell, z) - h),
    Math.abs(sampleHeight(t, x, z + cell) - h),
  ) / cell;
  let blocked = slope > 1.02;
  for (const prop of t.props) {
    if (!prop.alive || prop.radius < 0.4) continue;
    if (Math.hypot(x - prop.x, z - prop.z) < prop.radius + 0.22) blocked = true;
  }
  t.walkable[idx] = blocked ? 0 : 1;
  const mud = h < 0.42 ? 1.45 : 1;
  const hill = 1 + clamp(slope, 0, 1) * 1.4;
  t.cost[idx] = blocked ? 99 : mud * hill;
}

function rebuildNav(t: Terrain) {
  for (let j = 0; j < t.navRes; j++) {
    for (let i = 0; i < t.navRes; i++) writeCell(t, i, j);
  }
}

/** Recompute the cells a broken prop used to occupy. */
export function refreshNavAround(t: Terrain, x: number, z: number, radius: number) {
  const cell = (t.radius * 2) / t.navRes;
  const reach = Math.ceil(radius / cell) + 2;
  const c = worldToGrid(t, x, z);
  if (!c) return;
  for (let j = c.j - reach; j <= c.j + reach; j++) {
    for (let i = c.i - reach; i <= c.i + reach; i++) {
      if (i < 0 || j < 0 || i >= t.navRes || j >= t.navRes) continue;
      writeCell(t, i, j);
    }
  }
}

export function nearestWalkable(t: Terrain, x: number, z: number, maxR = 8): { x: number; z: number } | null {
  if (isWalkable(t, x, z)) return { x, z };
  const start = worldToGrid(t, x, z);
  if (!start) return null;
  const seen = new Uint8Array(t.navRes * t.navRes);
  const q: { i: number; j: number }[] = [start];
  seen[start.j * t.navRes + start.i] = 1;
  const maxCell = Math.ceil(maxR / ((t.radius * 2) / t.navRes));
  while (q.length) {
    const c = q.shift()!;
    if (t.walkable[c.j * t.navRes + c.i]) return gridCenter(t, c.i, c.j);
    if (Math.abs(c.i - start.i) > maxCell || Math.abs(c.j - start.j) > maxCell) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const i = c.i + di;
      const j = c.j + dj;
      if (i < 0 || j < 0 || i >= t.navRes || j >= t.navRes) continue;
      const id = j * t.navRes + i;
      if (seen[id]) continue;
      seen[id] = 1;
      q.push({ i, j });
    }
  }
  return null;
}

function addProp(
  list: Prop[],
  kind: PropKind,
  x: number,
  z: number,
  rot: number,
  scale: number,
  radius: number,
  height: number,
  hp: number,
) {
  list.push({
    id: list.length,
    kind,
    x,
    z,
    y: 0,
    scale,
    rot,
    radius,
    height,
    hp,
    maxHp: hp,
    alive: true,
  });
}

/** Ruined Paris on the toy circle: tower, burned cars, walls, lamps. Roads stay open. */
function placeParis(seed: number, spawns: SpawnPoint[]): Prop[] {
  const props: Prop[] = [];
  const rng = new Rng(seed ^ 0x51ed);
  const towerA = -Math.PI / 2 + Math.PI / 8;
  addProp(props, 'tower', Math.cos(towerA) * 15.2, Math.sin(towerA) * 15.2, towerA + 0.4, 1.45, 1.55, 9.6, 96);

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const px = -Math.sin(a);
    const pz = Math.cos(a);
    const along = 9.5 + (i % 2) * 4.2;
    const side = 4.15;
    addProp(props, 'car', Math.cos(a) * along + px * side, Math.sin(a) * along + pz * side, a + (i % 2 ? 0.4 : -0.2), 0.95 + (i % 3) * 0.08, 0.95, 0.85, 26);
    const lampU = 12 + (i % 2) * 5;
    addProp(props, 'lamp', Math.cos(a) * lampU - px * 3.3, Math.sin(a) * lampU - pz * 3.3, a, 1, 0.16, 2.4, 8);
    const wedge = a + Math.PI / 8;
    const wr = 11.5 + (i % 3) * 1.4;
    addProp(props, 'wall', Math.cos(wedge) * wr, Math.sin(wedge) * wr, wedge + Math.PI / 2, 1, 1.15, 1.35, 42);
    if (i % 2 === 0) {
      addProp(props, 'barricade', Math.cos(wedge) * (wr + 3.2), Math.sin(wedge) * (wr + 3.2), wedge, 1, 0.7, 0.7, 18);
    }
  }

  let guard = 0;
  while (props.filter((p) => p.kind === 'rubble').length < 7 && guard < 80) {
    guard++;
    const a = rng.next() * Math.PI * 2;
    const r = 8 + rng.next() * 12;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (corridorWeight(x, z) > 0.22) continue;
    if (len2(x, z) < 7.2) continue;
    let crowded = false;
    for (const s of spawns) if (Math.hypot(x - s.x, z - s.z) < 6) crowded = true;
    for (const p of props) if (Math.hypot(x - p.x, z - p.z) < 2.2) crowded = true;
    if (crowded) continue;
    addProp(props, 'rubble', x, z, rng.next() * Math.PI, 0.8 + rng.next() * 0.5, 0.85, 0.7, 16);
  }
  guard = 0;
  while (props.filter((p) => p.kind === 'tree').length < 6 && guard < 80) {
    guard++;
    const a = rng.next() * Math.PI * 2;
    const r = 8 + rng.next() * 14;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (corridorWeight(x, z) > 0.2) continue;
    if (len2(x, z) < 7.5) continue;
    let crowded = false;
    for (const s of spawns) if (Math.hypot(x - s.x, z - s.z) < 6.5) crowded = true;
    for (const p of props) if (Math.hypot(x - p.x, z - p.z) < 2.4) crowded = true;
    if (crowded) continue;
    const scale = 0.8 + rng.next() * 0.45;
    addProp(props, 'tree', x, z, rng.next() * Math.PI * 2, scale, 0.5 * scale, 2.8 * scale, 14);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    addProp(props, 'bag', Math.cos(a) * 7.6, Math.sin(a) * 7.6, a, 1, 0.55, 0.45, 12);
  }
  return props;
}

export function generateTerrain(seed: number): Terrain {
  const radius = MAP_RADIUS;
  const heights = new Float32Array(RES * RES);
  const rng = new Rng(seed);
  const craters: { x: number; z: number; rad: number; depth: number }[] = [];
  for (let n = 0; n < 5; n++) {
    const a = rng.next() * Math.PI * 2;
    const r = 7 + rng.next() * 9;
    craters.push({
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      rad: 2.4 + rng.next() * 2.1,
      depth: 1.5 + rng.next() * 1.5,
    });
  }

  for (let j = 0; j < RES; j++) {
    for (let i = 0; i < RES; i++) {
      const x = (i / (RES - 1) * 2 - 1) * radius;
      const z = (j / (RES - 1) * 2 - 1) * radius;
      const warpX = fbm(x * 0.07, z * 0.07 + 4, seed + 3);
      const warpZ = fbm(x * 0.07 + 8, z * 0.07, seed + 9);
      const base = fbm((x + warpX * 8) * 0.085, (z + warpZ * 8) * 0.085, seed);
      let ridge = 1 - Math.abs(fbm(x * 0.15 + 20, z * 0.15, seed + 17) * 2 - 1);
      ridge *= ridge;
      let h = base * 2.1 + ridge * 4.6 + fbm(x * 0.22, z * 0.22, seed + 29) * 0.7;
      for (const c of craters) {
        const d = Math.hypot(x - c.x, z - c.z);
        const bowl = 1 - smoothstep(c.rad * 0.15, c.rad, d);
        h -= bowl * c.depth;
        const rim = Math.exp(-((d - c.rad * 0.92) ** 2) / (2 * (c.rad * 0.16) ** 2));
        h += rim * 0.85;
      }
      const mesa = 1 - smoothstep(2.2, 6.4, len2(x, z));
      h = h * (1 - mesa * 0.75) + 2.85 * mesa * 0.75 + h * mesa * 0.25;
      heights[j * RES + i] = h;
    }
  }

  // Molded avenues: eight spokes and a ring, so the relief stays rude between them
  // and every spawn can still reach the hill in the middle.
  const ring = radius * 0.7;
  for (let s = 0; s <= 72; s++) {
    const u = s / 72;
    const a = u * Math.PI * 2;
    const x = Math.cos(a) * ring;
    const z = Math.sin(a) * ring;
    stamp(heights, RES, radius, x, z, 2.15, (_x, _z, h) => h * 0.35 + 1.15, 0.9);
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const sx = Math.cos(a) * ring;
    const sz = Math.sin(a) * ring;
    for (let s = 0; s <= 28; s++) {
      const u = s / 28;
      const x = sx * u;
      const z = sz * u;
      const endH = 2.5;
      const padH = 1.2;
      stamp(heights, RES, radius, x, z, 2.45, () => padH + (endH - padH) * (1 - u), 0.82);
    }
    stamp(heights, RES, radius, sx, sz, 6.6, () => 1.18, 0.96);
  }

  // Hills parked between the avenues so the spokes stay walkable.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2 + Math.PI / 8;
    const hx = Math.cos(a) * 13.5;
    const hz = Math.sin(a) * 13.5;
    stamp(heights, RES, radius, hx, hz, 2.7, (_x, _z, h) => h + 4.2, 1);
  }

  for (let j = 0; j < RES; j++) {
    for (let i = 0; i < RES; i++) {
      const x = (i / (RES - 1) * 2 - 1) * radius;
      const z = (j / (RES - 1) * 2 - 1) * radius;
      const d = len2(x, z);
      let h = Math.max(0.08, heights[j * RES + i]);
      if (d > radius * 0.96) {
        const k = smoothstep(radius * 0.96, radius, d);
        h = h * (1 - k) + 0.62 * k;
      }
      heights[j * RES + i] = h;
    }
  }

  const spawns: SpawnPoint[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * ring;
    const z = Math.sin(a) * ring;
    spawns.push({
      index: i,
      x,
      z,
      y: 1.18,
      heading: Math.atan2(-x, -z),
    });
  }

  const props = placeParis(seed, spawns);

  const terrain: Terrain = {
    seed,
    resolution: RES,
    radius,
    heights,
    navRes: NAV,
    walkable: new Uint8Array(NAV * NAV),
    cost: new Float32Array(NAV * NAV),
    props,
    spawns,
  };
  for (const prop of props) prop.y = sampleHeight(terrain, prop.x, prop.z);
  for (const s of spawns) s.y = sampleHeight(terrain, s.x, s.z);
  rebuildNav(terrain);
  return terrain;
}

export interface Los {
  clear: boolean;
  grazing: boolean;
}

export function lineOfSight(
  t: Terrain,
  x0: number,
  z0: number,
  y0: number,
  x1: number,
  z1: number,
  y1: number,
): Los {
  const steps = 20;
  let minClear = Infinity;
  for (let i = 1; i < steps; i++) {
    const u = i / steps;
    const x = x0 + (x1 - x0) * u;
    const z = z0 + (z1 - z0) * u;
    const y = y0 + (y1 - y0) * u;
    const ground = sampleHeight(t, x, z);
    const clear = y - ground;
    if (clear < minClear) minClear = clear;
    if (clear < 0.28) return { clear: false, grazing: true };
    for (const prop of t.props) {
      if (!prop.alive || prop.radius < 0.35) continue;
      if (Math.hypot(x - prop.x, z - prop.z) < prop.radius && y < prop.y + prop.height * 0.82) {
        return { clear: false, grazing: false };
      }
    }
  }
  return { clear: true, grazing: minClear < 0.75 };
}

export function terrainTint(x: number, z: number, h: number, slope: number, seed: number): [number, number, number] {
  const n = Rng.hash2(Math.floor(x * 2.4), Math.floor(z * 2.4), seed);
  const path = corridorWeight(x, z);
  const grassA: [number, number, number] = [0.34, 0.3, 0.26];
  const grassB: [number, number, number] = [0.42, 0.36, 0.3];
  let r = grassA[0] + (grassB[0] - grassA[0]) * n;
  let g = grassA[1] + (grassB[1] - grassA[1]) * n;
  let b = grassA[2] + (grassB[2] - grassA[2]) * n;
  const dirt = clamp((0.55 - h) / 0.55, 0, 1);
  r = r * (1 - dirt) + 0.36 * dirt;
  g = g * (1 - dirt) + 0.26 * dirt;
  b = b * (1 - dirt) + 0.16 * dirt;
  const rock = clamp((slope - 0.55) / 0.6, 0, 1);
  r = r * (1 - rock) + 0.45 * rock;
  g = g * (1 - rock) + 0.43 * rock;
  b = b * (1 - rock) + 0.4 * rock;
  const pad = clamp(1 - Math.min(
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      return Math.hypot(x - Math.cos(a) * MAP_RADIUS * 0.7, z - Math.sin(a) * MAP_RADIUS * 0.7) / 6.4;
    }),
  ), 0, 1);
  r = r * (1 - pad) + 0.78 * pad;
  g = g * (1 - pad) + 0.7 * pad;
  b = b * (1 - pad) + 0.5 * pad;
  const mesa = 1 - smoothstep(2, 6.2, len2(x, z));
  r = r * (1 - mesa) + 0.62 * mesa;
  g = g * (1 - mesa) + 0.56 * mesa;
  b = b * (1 - mesa) + 0.36 * mesa;
  const p = clamp(path, 0, 1) * (1 - pad) * (1 - mesa * 0.5);
  r = r * (1 - p) + 0.4 * p;
  g = g * (1 - p) + 0.38 * p;
  b = b * (1 - p) + 0.36 * p;
  if (slope > 0.9) {
    const plastic = clamp((slope - 0.9) / 0.5, 0, 1) * 0.35;
    r = r * (1 - plastic) + 0.22 * plastic;
    g = g * (1 - plastic) + 0.42 * plastic;
    b = b * (1 - plastic) + 0.24 * plastic;
  }
  return [r, g, b];
}
