import { BY_ID, CATALOG, type UnitDef } from '../data/catalog';
import { nearestWalkable, type Terrain } from './terrain';

export interface ManualPlacement {
  defId: string;
  x: number;
  z: number;
}

export interface SpawnSpec {
  defId: string;
  team: 0 | 1;
  x: number;
  z: number;
  heading: number;
}

export function immobileQueue(counts: Record<string, number>): string[] {
  const ids: string[] = [];
  for (const def of CATALOG) {
    if (!def.immobile) continue;
    const n = counts[def.id] ?? 0;
    for (let i = 0; i < n; i++) ids.push(def.id);
  }
  return ids;
}

function basis(heading: number): { fx: number; fz: number; rx: number; rz: number } {
  return {
    fx: Math.sin(heading),
    fz: Math.cos(heading),
    rx: Math.cos(heading),
    rz: -Math.sin(heading),
  };
}

export function buildSpecs(
  terrain: Terrain,
  counts: Record<string, number>,
  team: 0 | 1,
  spawnIndex: number,
  manuals: ManualPlacement[],
  autoImmobile: boolean,
): SpawnSpec[] {
  const spawn = terrain.spawns[spawnIndex];
  const { fx, fz, rx, rz } = basis(spawn.heading);
  const specs: SpawnSpec[] = [];
  const mobiles: UnitDef[] = [];
  const immobiles: UnitDef[] = [];

  for (const def of CATALOG) {
    const n = counts[def.id] ?? 0;
    for (let i = 0; i < n; i++) {
      if (def.role === 'jet') {
        specs.push({ defId: def.id, team, x: spawn.x, z: spawn.z, heading: spawn.heading });
      } else if (def.immobile) immobiles.push(def);
      else mobiles.push(def);
    }
  }

  const cols = Math.min(6, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, mobiles.length)))));
  mobiles.forEach((def, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const wide = def.radius > 0.8;
    const side = (col - (cols - 1) / 2) * (wide ? 2.55 : 1.38);
    const ahead = 1.8 + row * (wide ? 2.35 : 1.55);
    let x = spawn.x + fx * ahead + rx * side;
    let z = spawn.z + fz * ahead + rz * side;
    const snapped = nearestWalkable(terrain, x, z, 6);
    if (snapped) {
      x = snapped.x;
      z = snapped.z;
    }
    specs.push({ defId: def.id, team, x, z, heading: spawn.heading });
  });

  let manualI = 0;
  immobiles.forEach((def, index) => {
    const manual = manuals[manualI];
    if (manual && manual.defId === def.id) {
      specs.push({ defId: def.id, team, x: manual.x, z: manual.z, heading: spawn.heading });
      manualI += 1;
      return;
    }
    if (!autoImmobile) return;
    const back = def.weapon ? -1.4 - index * 0.15 : 2.6;
    const spread = (index - (immobiles.length - 1) / 2) * 2.4;
    let x = spawn.x + fx * back + rx * spread;
    let z = spawn.z + fz * back + rz * spread;
    const snapped = nearestWalkable(terrain, x, z, 8);
    if (snapped) {
      x = snapped.x;
      z = snapped.z;
    }
    specs.push({ defId: def.id, team, x, z, heading: spawn.heading });
  });

  return specs;
}

export function deployRadius(): number {
  return 7.3;
}

export function placementValid(
  terrain: Terrain,
  spawnIndex: number,
  x: number,
  z: number,
  placed: ManualPlacement[],
  defId: string,
): boolean {
  const spawn = terrain.spawns[spawnIndex];
  if (Math.hypot(x - spawn.x, z - spawn.z) > deployRadius()) return false;
  if (!nearestWalkable(terrain, x, z, 1.2)) return false;
  const near = nearestWalkable(terrain, x, z, 1.2)!;
  if (Math.hypot(near.x - x, near.z - z) > 0.85) return false;
  const radius = BY_ID[defId]?.radius ?? 1;
  for (const p of placed) {
    const other = BY_ID[p.defId]?.radius ?? 1;
    if (Math.hypot(p.x - x, p.z - z) < radius + other + 0.4) return false;
  }
  return true;
}
