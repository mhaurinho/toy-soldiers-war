import { BY_ID, type UnitDef } from '../data/catalog';
import { gridCenter, sampleHeight, worldToGrid } from './terrain';
import type { SimUnit, World } from './world';

function spottedEnemies(world: World, team: 0 | 1): SimUnit[] {
  const out: SimUnit[] = [];
  for (const unit of world.units) {
    if (unit.alive && unit.team !== team && unit.spotted[team]) out.push(unit);
  }
  return out;
}

function allEnemies(world: World, team: 0 | 1): SimUnit[] {
  return world.units.filter((unit) => unit.alive && unit.team !== team);
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function densest(units: SimUnit[], radius: number): { x: number; z: number; n: number } | null {
  let best: { x: number; z: number; n: number; id: number } | null = null;
  for (const origin of units) {
    let n = 0;
    let x = 0;
    let z = 0;
    for (const other of units) {
      if (dist(origin, other) > radius) continue;
      n += 1;
      x += other.x;
      z += other.z;
    }
    if (n <= 0) continue;
    if (!best || n > best.n || (n === best.n && origin.id < best.id)) {
      best = { x: x / n, z: z / n, n, id: origin.id };
    }
  }
  return best;
}

function hillNear(world: World, unit: SimUnit): { x: number; z: number } | null {
  const start = worldToGrid(world.terrain, unit.x, unit.z);
  if (!start) return null;
  const here = sampleHeight(world.terrain, unit.x, unit.z);
  let best: { x: number; z: number; h: number } | null = null;
  const rad = 12;
  for (let j = start.j - rad; j <= start.j + rad; j++) {
    for (let i = start.i - rad; i <= start.i + rad; i++) {
      if (i < 0 || j < 0 || i >= world.terrain.navRes || j >= world.terrain.navRes) continue;
      if (!world.terrain.walkable[j * world.terrain.navRes + i]) continue;
      const cell = gridCenter(world.terrain, i, j);
      const h = sampleHeight(world.terrain, cell.x, cell.z);
      if (!best || h > best.h) best = { x: cell.x, z: cell.z, h };
    }
  }
  if (!best || best.h < here + 0.75) return null;
  return best;
}

function focusScore(def: UnitDef, target: SimUnit): number {
  const td = BY_ID[target.defId];
  const w = def.weapon;
  if (!w) return -Infinity;
  const mult = td.flying ? w.vsAir : w.vsGround;
  if (mult <= 0) return -Infinity;
  let score = mult * 80 + (1 - target.hp / td.hp) * 40;
  if (td.role === 'emplacement' && !td.weapon) score -= 60;
  if (def.flying && (td.id === 'igla' || td.id === 'ninho_aa')) score += 70;
  if (def.role === 'tank' && td.role === 'tank') score += 25;
  if (td.flying && w.vsAir > w.vsGround) score += 50;
  return score;
}

function pickFocus(def: UnitDef, enemies: SimUnit[]): SimUnit | null {
  let best: SimUnit | null = null;
  let score = -Infinity;
  for (const enemy of enemies) {
    const s = focusScore(def, enemy);
    if (s > score || (s === score && best && enemy.id < best.id)) {
      score = s;
      best = enemy;
    }
  }
  return score < -100 ? null : best;
}

export function aiThink(world: World): void {
  for (const team of world.aiTeams) {
    if (team !== 0 && team !== 1) continue;
    const side = team as 0 | 1;
    const seen = spottedEnemies(world, side);
    const known = seen.length ? seen : allEnemies(world, side);
    const cluster = densest(seen, 6);
    for (const unit of world.units) {
      if (!unit.alive || unit.team !== side) continue;
      const def = BY_ID[unit.defId];
      if (def.role === 'emplacement') continue;
      if (def.role === 'jet') {
        if (unit.mode === 'run' || unit.abilityCd > 0.2) continue;
        const prey = pickFocus(def, seen.length ? seen : known);
        if (prey) world.orderAttack([unit.id], prey.id);
        else world.orderGround([unit.id], 0, 0);
        continue;
      }
      if (def.ability?.id === 'barrage' && unit.abilityCd <= 0 && cluster && cluster.n >= 3) {
        if (dist(unit, cluster) <= def.ability.range) world.orderAbility([unit.id], cluster.x, cluster.z);
      }
      if (def.id === 'atirador' && !unit.sought) {
        unit.sought = true;
        const hill = hillNear(world, unit);
        if (hill) {
          world.orderMove([unit.id], hill.x, hill.z, false);
          continue;
        }
      }
      const weapon = def.weapon;
      if (weapon?.indirect) {
        const aim = cluster ?? densest(known, 8) ?? { x: 0, z: 0, n: 1 };
        const d = dist(unit, aim);
        if (d < weapon.minRange + 0.8 && !def.immobile) {
          const ang = Math.atan2(unit.x - aim.x, unit.z - aim.z);
          world.orderMove([unit.id], unit.x + Math.sin(ang) * 6, unit.z + Math.cos(ang) * 6, false);
        } else if (d <= weapon.range) {
          const same = unit.order.kind === 'ground' && dist(unit.order, aim) < 2.5;
          if (!same) world.orderGround([unit.id], aim.x, aim.z);
        } else if (!def.immobile) {
          const ux = unit.x - aim.x;
          const uz = unit.z - aim.z;
          const mag = Math.hypot(ux, uz) || 1;
          const spot = { x: aim.x + (ux / mag) * weapon.range * 0.75, z: aim.z + (uz / mag) * weapon.range * 0.75 };
          if (!(unit.order.kind === 'move' && dist(unit.order, spot) < 2)) world.orderMove([unit.id], spot.x, spot.z, false);
        }
        continue;
      }
      const focus = pickFocus(def, seen);
      if (focus && weapon && dist(unit, focus) <= weapon.range * 1.05) {
        if (!(unit.order.kind === 'attack' && unit.order.target === focus.id)) world.orderAttack([unit.id], focus.id);
        continue;
      }
      const goal = focus ?? (known.length ? known[0] : null);
      const point = goal ? { x: goal.x, z: goal.z } : { x: 0, z: 0 };
      if (def.immobile) {
        if (goal && weapon && dist(unit, goal) <= weapon.range) world.orderAttack([unit.id], goal.id);
        continue;
      }
      if (unit.order.kind === 'move' && unit.order.attackMove && dist(unit.order, point) < 3) continue;
      world.orderMove([unit.id], point.x, point.z, true);
    }
  }
}
