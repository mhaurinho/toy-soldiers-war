import { BY_ID, canCapture, isCombatant, type UnitDef, type WeaponDef } from '../data/catalog';
import type { SpawnSpec } from './deploy';
import { CAPTURE_RADIUS, CAPTURE_SECONDS, GRAVITY, MAP_RADIUS, SIM_DT, SIM_HZ } from './constants';
import { angDiff, clamp, lerpAngle } from './math';
import { findPath } from './pathfinding';
import { Rng } from './rng';
import { generateTerrain, isWalkable, lineOfSight, nearestWalkable, sampleHeight, type Terrain } from './terrain';
import { aiThink } from './ai';
import type { Command, FxEvent, ProjSnap, Snapshot, UnitSnap } from './types';

export interface MatchOptions {
  seed: number;
  specs: SpawnSpec[];
  aiTeams: number[];
  openingPush: boolean;
}

export type Order =
  | { kind: 'none' }
  | { kind: 'move'; x: number; z: number; attackMove: boolean }
  | { kind: 'attack'; target: number }
  | { kind: 'ground'; x: number; z: number };

export interface SimUnit {
  id: number;
  team: 0 | 1;
  defId: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  turret: number;
  hp: number;
  cooldown: number;
  abilityCd: number;
  order: Order;
  path: { x: number; z: number }[];
  pathI: number;
  stuckT: number;
  garrison: number;
  revealUntil: [number, number];
  spotted: [boolean, boolean];
  death: number;
  alive: boolean;
  orbit: number;
  mode: 'ground' | 'orbit' | 'run';
  runT: number;
  runDur: number;
  runFromX: number;
  runFromZ: number;
  runOutX: number;
  runOutZ: number;
  ax: number;
  az: number;
  firedRun: boolean;
  sought: boolean;
  lock: number;
}

interface Projectile {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  team: 0 | 1;
  attacker: number;
  damage: number;
  aoe: number;
  pen: number;
  ttl: number;
  arc: boolean;
  indirect: boolean;
  homing: boolean;
  targetId: number;
  speed: number;
  shot: WeaponDef['kind'];
  alive: boolean;
}

interface Strike {
  tick: number;
  x: number;
  z: number;
  team: 0 | 1;
  damage: number;
  aoe: number;
  left: number;
}

export class World {
  readonly terrain: Terrain;
  readonly aiTeams: number[];
  readonly units: SimUnit[] = [];
  tick = 0;
  hash = 0;
  winner: -1 | 0 | 1 = -1;
  over = false;
  cap0 = 0;
  cap1 = 0;
  contested = false;
  losses: [number, number] = [0, 0];

  private readonly rng: Rng;
  private readonly queue: Command[] = [];
  private readonly projectiles: Projectile[] = [];
  private strikes: Strike[] = [];
  private fx: FxEvent[] = [];
  constructor(opts: MatchOptions) {
    this.terrain = generateTerrain(opts.seed);
    this.rng = new Rng((opts.seed ^ 0x9e3779b9) >>> 0);
    this.aiTeams = [...opts.aiTeams].sort((a, b) => a - b);
    let jet0 = 0;
    let jet1 = 0;
    for (const spec of opts.specs) {
      const def = BY_ID[spec.defId];
      if (!def) continue;
      const id = this.units.length;
      const unit = this.makeUnit(id, spec, def);
      if (def.role === 'jet') {
        const n = spec.team === 0 ? jet0++ : jet1++;
        unit.mode = 'orbit';
        unit.orbit = (spec.team === 0 ? 0.35 : Math.PI + 0.35) + n * 0.9;
        const radius = MAP_RADIUS + 6;
        unit.x = Math.cos(unit.orbit) * radius;
        unit.z = Math.sin(unit.orbit) * radius;
        unit.y = def.altitude;
        unit.heading = unit.orbit + Math.PI / 2;
      } else if (def.flying) {
        unit.y = Math.max(def.altitude, sampleHeight(this.terrain, unit.x, unit.z) + 3.4);
      } else {
        unit.y = sampleHeight(this.terrain, unit.x, unit.z);
      }
      this.units.push(unit);
    }
    if (opts.openingPush) {
      const ids = this.units.filter((u) => u.team === 0 && u.alive && BY_ID[u.defId].role !== 'jet' && !BY_ID[u.defId].immobile).map((u) => u.id);
      if (ids.length) this.apply({ type: 'move', tick: 0, team: 0, ids, x: 0, z: 0, attackMove: true });
    }
    this.updateVision();
    this.hash = this.hashState();
  }

  submit(command: Command) {
    this.queue.push(command);
  }

  orderMove(ids: number[], x: number, z: number, attackMove: boolean) {
    if (!ids.length) return;
    const team = this.units[ids[0]]?.team;
    if (team === undefined) return;
    this.apply({ type: 'move', tick: this.tick, team, ids, x, z, attackMove });
  }

  orderAttack(ids: number[], target: number) {
    if (!ids.length) return;
    const team = this.units[ids[0]]?.team;
    if (team === undefined) return;
    this.apply({ type: 'attack', tick: this.tick, team, ids, target });
  }

  orderGround(ids: number[], x: number, z: number) {
    if (!ids.length) return;
    const team = this.units[ids[0]]?.team;
    if (team === undefined) return;
    this.apply({ type: 'ground', tick: this.tick, team, ids, x, z });
  }

  orderAbility(ids: number[], x: number, z: number) {
    if (!ids.length) return;
    const team = this.units[ids[0]]?.team;
    if (team === undefined) return;
    this.apply({ type: 'ability', tick: this.tick, team, ids, x, z });
  }

  step() {
    if (this.over) return;
    this.applyDue();
    if (this.tick % 15 === 1) {
      // Imported lazily-in-spirit: caller passes AI from outside to avoid a cycle.
      this.aiHook?.(this);
    }
    this.updateStrikes();
    for (const unit of this.units) this.updateUnit(unit);
    this.separate();
    for (const unit of this.units) {
      const def = BY_ID[unit.defId];
      if (!def.flying && unit.alive) unit.y = sampleHeight(this.terrain, unit.x, unit.z);
      if (!unit.alive && unit.death >= 0 && unit.death < 8) unit.death += SIM_DT;
    }
    this.updateProjectiles();
    this.updateObjective();
    this.updateElimination();
    this.updateVision();
    this.tick += 1;
    this.hash = this.hashState();
    if (this.fx.length > 80) this.fx.splice(0, this.fx.length - 80);
  }

  /** Set by the AI module so the sim stays free of an import cycle. */
  aiHook: ((world: World) => void) | null = null;

  snapshot(): Snapshot {
    const fx = this.fx;
    this.fx = [];
    const units: UnitSnap[] = [];
    const alive: [number, number] = [0, 0];
    for (const u of this.units) {
      const def = BY_ID[u.defId];
      if (!u.alive && u.death > 2.6) continue;
      if (u.alive && isCombatant(def)) alive[u.team] += 1;
      units.push({
        id: u.id,
        team: u.team,
        defId: u.defId,
        x: u.x,
        y: u.y,
        z: u.z,
        heading: u.heading,
        turret: u.turret,
        hp: Math.max(0, u.hp),
        hpMax: def.hp,
        state: this.visualState(u, def),
        spotted0: u.spotted[0],
        spotted1: u.spotted[1],
        death: u.alive ? -1 : u.death,
        garrison: u.garrison >= 0,
        ability: def.ability && def.ability.cooldown > 0 ? clamp(u.abilityCd / def.ability.cooldown, 0, 1) : 0,
      });
    }
    const projectiles: ProjSnap[] = [];
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      projectiles.push({ x: p.x, y: p.y, z: p.z, team: p.team, shot: p.shot });
    }
    return {
      tick: this.tick,
      seconds: this.tick * SIM_DT,
      hash: this.hash,
      winner: this.winner,
      over: this.over,
      cap: [this.cap0, this.cap1],
      contested: this.contested,
      units,
      projectiles,
      fx,
      alive,
      losses: [this.losses[0], this.losses[1]],
    };
  }

  private makeUnit(id: number, spec: SpawnSpec, def: UnitDef): SimUnit {
    return {
      id,
      team: spec.team,
      defId: spec.defId,
      x: spec.x,
      y: 0,
      z: spec.z,
      heading: spec.heading,
      turret: spec.heading,
      hp: def.hp,
      cooldown: 0,
      abilityCd: 0,
      order: { kind: 'none' },
      path: [],
      pathI: 0,
      stuckT: 0,
      garrison: -1,
      revealUntil: [0, 0],
      spotted: [spec.team === 0, spec.team === 1],
      death: -1,
      alive: true,
      orbit: 0,
      mode: 'ground',
      runT: 0,
      runDur: 2.4,
      runFromX: 0,
      runFromZ: 0,
      runOutX: 0,
      runOutZ: 0,
      ax: 0,
      az: 0,
      firedRun: false,
      sought: false,
      lock: -1,
    };
  }

  private visualState(u: SimUnit, def: UnitDef): UnitSnap['state'] {
    if (!u.alive) return 'dead';
    if (def.role === 'jet' && u.mode === 'run') return 'run';
    if (def.flying) return 'fly';
    if (u.order.kind === 'attack' || (def.weapon && u.cooldown > def.weapon.period * 0.65)) return 'attack';
    if (u.pathI < u.path.length && (u.order.kind === 'move' || u.order.kind === 'ground')) return 'move';
    return 'idle';
  }

  private applyDue() {
    if (this.queue.length > 1) {
      this.queue.sort((a, b) => a.tick - b.tick || a.team - b.team);
    }
    const later: Command[] = [];
    for (const command of this.queue) {
      if (command.tick <= this.tick) this.apply(command);
      else later.push(command);
    }
    this.queue.length = 0;
    for (const command of later) this.queue.push(command);
  }

  private livingIds(team: 0 | 1, ids: number[]): number[] {
    return ids.filter((id) => {
      const u = this.units[id];
      return !!u && u.alive && u.team === team;
    }).sort((a, b) => a - b);
  }

  private apply(command: Command) {
    if (this.over) return;
    if (command.type === 'surrender') {
      this.finish(command.team === 0 ? 1 : 0);
      return;
    }
    const ids = this.livingIds(command.team, command.ids);
    if (!ids.length) return;
    if (command.type === 'stop') {
      for (const id of ids) {
        const u = this.units[id];
        u.order = { kind: 'none' };
        u.path = [];
        u.pathI = 0;
        if (u.mode === 'run') {
          /* let the pass finish */
        }
      }
      return;
    }
    if (command.type === 'attack') {
      const target = this.units[command.target];
      if (!target || !target.alive || target.team === command.team) return;
      for (const id of ids) this.units[id].order = { kind: 'attack', target: target.id };
      return;
    }
    if (command.type === 'ability') {
      for (const id of ids) this.tryBarrage(this.units[id], command.x, command.z);
      return;
    }
    if (command.type === 'ground') {
      for (const id of ids) {
        const u = this.units[id];
        const def = BY_ID[u.defId];
        if (def.role === 'jet') {
          u.order = { kind: 'ground', x: command.x, z: command.z };
          continue;
        }
        if (!def.weapon) continue;
        u.order = { kind: 'ground', x: command.x, z: command.z };
        u.path = [];
        u.pathI = 0;
      }
      return;
    }
    const cols = Math.ceil(Math.sqrt(ids.length));
    ids.forEach((id, index) => {
      const u = this.units[id];
      const def = BY_ID[u.defId];
      if (def.role === 'jet') {
        u.order = { kind: 'ground', x: command.x, z: command.z };
        return;
      }
      if (def.immobile) {
        if (def.weapon) u.order = { kind: 'ground', x: command.x, z: command.z };
        return;
      }
      const col = index % cols;
      const row = Math.floor(index / cols);
      const spacing = def.radius > 0.8 ? 2.5 : 1.4;
      let x = command.x + (col - (cols - 1) / 2) * spacing;
      let z = command.z + row * spacing * 0.85;
      if (!def.flying) {
        const snapped = nearestWalkable(this.terrain, x, z, 5);
        if (snapped) {
          x = snapped.x;
          z = snapped.z;
        }
      }
      u.order = { kind: 'move', x, z, attackMove: command.attackMove };
      u.garrison = -1;
      this.setPath(u, x, z);
    });
  }

  private tryBarrage(unit: SimUnit, x: number, z: number) {
    const ability = BY_ID[unit.defId].ability;
    if (!ability || ability.id !== 'barrage' || unit.abilityCd > 0) return;
    if (Math.hypot(x - unit.x, z - unit.z) > ability.range) return;
    unit.abilityCd = ability.cooldown;
    this.strikes.push({
      tick: this.tick + Math.round(1.15 * SIM_HZ),
      x,
      z,
      team: unit.team,
      damage: ability.damage,
      aoe: ability.aoe,
      left: 3,
    });
    this.fx.push({ kind: 'marker', x, y: sampleHeight(this.terrain, x, z) + 0.2, z, team: unit.team });
  }

  private setPath(unit: SimUnit, x: number, z: number) {
    const def = BY_ID[unit.defId];
    if (def.flying) {
      unit.path = [{ x, z }];
      unit.pathI = 0;
      return;
    }
    unit.path = findPath(this.terrain, unit.x, unit.z, x, z);
    unit.pathI = 0;
    unit.stuckT = 0;
  }

  private updateStrikes() {
    const next: Strike[] = [];
    for (const strike of this.strikes) {
      if (strike.left <= 0) continue;
      if (this.tick < strike.tick) {
        next.push(strike);
        continue;
      }
      const jx = (this.rng.next() - 0.5) * strike.aoe * 0.8;
      const jz = (this.rng.next() - 0.5) * strike.aoe * 0.8;
      this.boom(strike.team, -1, strike.x + jx, strike.z + jz, strike.damage, strike.aoe, 0.45, true);
      strike.left -= 1;
      strike.tick = this.tick + 4;
      if (strike.left > 0) next.push(strike);
    }
    this.strikes = next;
  }

  private updateUnit(unit: SimUnit) {
    if (!unit.alive) return;
    const def = BY_ID[unit.defId];
    unit.cooldown = Math.max(0, unit.cooldown - SIM_DT);
    unit.abilityCd = Math.max(0, unit.abilityCd - SIM_DT);
    if (def.role === 'jet') {
      this.updateJet(unit);
      return;
    }
    this.updateGarrison(unit);
    if (unit.garrison >= 0) {
      this.faceThreat(unit);
      this.tryFire(unit);
      return;
    }
    if (def.flying) this.moveAir(unit);
    else if (!def.immobile) this.moveGround(unit);
    else this.faceThreat(unit);
    this.tryFire(unit);
  }

  private faceThreat(unit: SimUnit) {
    const def = BY_ID[unit.defId];
    const aim = this.aimPoint(unit);
    if (!aim) return;
    const ang = Math.atan2(aim.x - unit.x, aim.z - unit.z);
    if (def.turret) unit.turret = lerpAngle(unit.turret, ang, 2.8 * SIM_DT);
    else unit.heading = lerpAngle(unit.heading, ang, def.turn * SIM_DT);
  }

  private aimPoint(unit: SimUnit): { x: number; z: number } | null {
    if (unit.order.kind === 'attack') {
      const t = this.units[unit.order.target];
      if (t?.alive) return t;
    }
    if (unit.order.kind === 'ground') return { x: unit.order.x, z: unit.order.z };
    return null;
  }

  private updateGarrison(unit: SimUnit) {
    const def = BY_ID[unit.defId];
    if (def.role !== 'infantry') {
      unit.garrison = -1;
      return;
    }
    if (!this.holding(unit)) {
      unit.garrison = -1;
      return;
    }
    if (unit.garrison >= 0) {
      const trench = this.units[unit.garrison];
      if (!trench?.alive) unit.garrison = -1;
      else return;
    }
    let best: SimUnit | null = null;
    let bestD = 1.85;
    for (const other of this.units) {
      if (!other.alive || other.team !== unit.team) continue;
      const od = BY_ID[other.defId];
      if (od.garrison <= 0) continue;
      const d = Math.hypot(other.x - unit.x, other.z - unit.z);
      if (d > bestD) continue;
      let used = 0;
      for (const mate of this.units) if (mate.alive && mate.garrison === other.id) used += 1;
      if (used >= od.garrison) continue;
      best = other;
      bestD = d;
    }
    if (best) {
      unit.garrison = best.id;
      unit.path = [];
      unit.pathI = 0;
    }
  }

  private holding(unit: SimUnit): boolean {
    if (unit.order.kind === 'none' || unit.order.kind === 'ground') return true;
    if (unit.order.kind === 'attack') {
      const t = this.units[unit.order.target];
      return !t?.alive || this.inWeaponRange(unit, t);
    }
    if (unit.order.kind === 'move') {
      if (unit.order.attackMove) {
        const got = this.acquire(unit);
        if (got) return true;
      }
      return unit.pathI >= unit.path.length && Math.hypot(unit.order.x - unit.x, unit.order.z - unit.z) < 1.3;
    }
    return false;
  }

  private moveAir(unit: SimUnit) {
    const def = BY_ID[unit.defId];
    let gx = unit.x;
    let gz = unit.z;
    let moving = false;
    if (unit.order.kind === 'move') {
      gx = unit.order.x;
      gz = unit.order.z;
      if (unit.order.attackMove && this.acquire(unit)) moving = false;
      else moving = true;
    } else if (unit.order.kind === 'attack') {
      const t = this.units[unit.order.target];
      if (t?.alive && !this.inWeaponRange(unit, t)) {
        gx = t.x;
        gz = t.z;
        moving = true;
      }
    } else if (unit.order.kind === 'ground') {
      const w = def.weapon;
      const d = Math.hypot(unit.order.x - unit.x, unit.order.z - unit.z);
      if (w && (d > w.range || d < w.minRange)) {
        gx = unit.order.x;
        gz = unit.order.z;
        moving = true;
      }
    }
    if (moving) {
      const dx = gx - unit.x;
      const dz = gz - unit.z;
      const dist = Math.hypot(dx, dz);
      const step = def.speed * SIM_DT;
      if (dist > 0.2) {
        const s = Math.min(step, dist);
        unit.x += (dx / dist) * s;
        unit.z += (dz / dist) * s;
        unit.heading = lerpAngle(unit.heading, Math.atan2(dx, dz), def.turn * SIM_DT);
      } else if (unit.order.kind === 'move' && !unit.order.attackMove) {
        unit.order = { kind: 'none' };
      }
    }
    this.faceThreat(unit);
    const ground = sampleHeight(this.terrain, unit.x, unit.z);
    const desired = Math.max(def.altitude, ground + 3.5);
    unit.y += (desired - unit.y) * Math.min(1, SIM_DT * 2.2);
    const lim = MAP_RADIUS * 0.95;
    const d = Math.hypot(unit.x, unit.z);
    if (d > lim) {
      unit.x = (unit.x / d) * lim;
      unit.z = (unit.z / d) * lim;
    }
  }

  private moveGround(unit: SimUnit) {
    const def = BY_ID[unit.defId];
    if (unit.order.kind === 'attack') {
      const t = this.units[unit.order.target];
      if (!t?.alive) unit.order = { kind: 'none' };
      else if (!this.inWeaponRange(unit, t)) this.chase(unit, t.x, t.z);
      else {
        unit.path = [];
        this.faceThreat(unit);
        return;
      }
    } else if (unit.order.kind === 'ground') {
      const w = def.weapon;
      const d = Math.hypot(unit.order.x - unit.x, unit.order.z - unit.z);
      if (w && d > w.range) this.chase(unit, unit.order.x, unit.order.z);
      else if (w && d < w.minRange) {
        const ang = Math.atan2(unit.x - unit.order.x, unit.z - unit.order.z);
        this.chase(unit, unit.x + Math.sin(ang) * 5, unit.z + Math.cos(ang) * 5);
      } else {
        unit.path = [];
        this.faceThreat(unit);
        return;
      }
    } else if (unit.order.kind === 'move') {
      if (unit.order.attackMove) {
        const got = this.acquire(unit);
        if (got) {
          this.faceThreatToward(unit, got);
          return;
        }
      }
      if (unit.pathI >= unit.path.length && Math.hypot(unit.order.x - unit.x, unit.order.z - unit.z) > 1.6) {
        this.setPath(unit, unit.order.x, unit.order.z);
      }
    } else {
      this.faceThreat(unit);
      return;
    }
    this.follow(unit);
    if (def.turret) this.faceThreat(unit);
    else if (unit.pathI >= unit.path.length) this.faceThreat(unit);
  }

  private faceThreatToward(unit: SimUnit, target: SimUnit) {
    const def = BY_ID[unit.defId];
    const ang = Math.atan2(target.x - unit.x, target.z - unit.z);
    if (def.turret) unit.turret = lerpAngle(unit.turret, ang, 2.8 * SIM_DT);
    unit.heading = lerpAngle(unit.heading, ang, def.turn * SIM_DT);
  }

  private chase(unit: SimUnit, x: number, z: number) {
    const goal = unit.path[unit.path.length - 1];
    if (!goal || Math.hypot(goal.x - x, goal.z - z) > 2.8) this.setPath(unit, x, z);
    this.follow(unit);
  }

  private follow(unit: SimUnit) {
    if (unit.pathI >= unit.path.length) {
      if (unit.order.kind === 'move' && !unit.order.attackMove) {
        if (Math.hypot(unit.order.x - unit.x, unit.order.z - unit.z) < 1.4) unit.order = { kind: 'none' };
      }
      return;
    }
    const def = BY_ID[unit.defId];
    const wp = unit.path[unit.pathI];
    const dx = wp.x - unit.x;
    const dz = wp.z - unit.z;
    const dist = Math.hypot(dx, dz) || 0.0001;
    const h0 = sampleHeight(this.terrain, unit.x, unit.z);
    const h1 = sampleHeight(this.terrain, unit.x + dx / dist, unit.z + dz / dist);
    const slope = Math.abs(h1 - h0);
    const factor = clamp(1 - clamp(slope - 0.15, 0, 0.8), 0.42, 1) * (h0 < 0.4 ? 0.7 : 1);
    const step = def.speed * factor * SIM_DT;
    const prevX = unit.x;
    const prevZ = unit.z;
    unit.heading = lerpAngle(unit.heading, Math.atan2(dx, dz), Math.min(1, def.turn * SIM_DT));
    if (dist <= Math.max(0.18, step)) {
      unit.x = wp.x;
      unit.z = wp.z;
      unit.pathI += 1;
    } else {
      unit.x += (dx / dist) * step;
      unit.z += (dz / dist) * step;
    }
    if (!isWalkable(this.terrain, unit.x, unit.z)) {
      unit.x = prevX;
      unit.z = prevZ;
      unit.stuckT += SIM_DT;
      if (unit.stuckT > 0.45) {
        unit.stuckT = 0;
        unit.pathI += 1;
      }
    } else {
      const moved = Math.hypot(unit.x - prevX, unit.z - prevZ);
      unit.stuckT = moved < 0.02 ? unit.stuckT + SIM_DT : 0;
    }
  }

  private inWeaponRange(unit: SimUnit, target: SimUnit): boolean {
    const w = BY_ID[unit.defId].weapon;
    if (!w) return false;
    const d = this.fightDist(unit, target);
    return d <= w.range && d >= w.minRange;
  }

  private fightDist(a: SimUnit, b: SimUnit): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    if (BY_ID[a.defId].flying || BY_ID[b.defId].flying) return Math.hypot(dx, this.eye(a) - this.eye(b), dz);
    return Math.hypot(dx, dz);
  }

  private eye(unit: SimUnit): number {
    const def = BY_ID[unit.defId];
    if (def.flying) return unit.y;
    return sampleHeight(this.terrain, unit.x, unit.z) + def.eye;
  }

  private acquire(unit: SimUnit): SimUnit | null {
    const w = BY_ID[unit.defId].weapon;
    if (!w) return null;
    let best: SimUnit | null = null;
    let bestScore = -Infinity;
    for (const target of this.units) {
      if (!target.alive || target.team === unit.team) continue;
      if (!target.spotted[unit.team]) continue;
      const td = BY_ID[target.defId];
      const mult = td.flying ? w.vsAir : w.vsGround;
      if (mult <= 0) continue;
      const d = this.fightDist(unit, target);
      if (d > w.range || d < w.minRange) continue;
      if (!w.indirect) {
        const los = lineOfSight(this.terrain, unit.x, unit.z, this.eye(unit), target.x, target.z, this.eye(target));
        if (!los.clear) continue;
      }
      let score = mult * 120 - d + (1 - target.hp / td.hp) * 36;
      if (td.role === 'emplacement' && !td.weapon) score -= 50;
      if (td.flying && w.vsAir > w.vsGround) score += 40;
      if (score > bestScore || (score === bestScore && best && target.id < best.id)) {
        bestScore = score;
        best = target;
      }
    }
    return best;
  }

  private tryFire(unit: SimUnit) {
    const w = BY_ID[unit.defId].weapon;
    if (!w || unit.cooldown > 0) return;
    if (unit.order.kind === 'ground') {
      this.firePoint(unit, unit.order.x, unit.order.z, -1);
      return;
    }
    let target: SimUnit | null = null;
    if (unit.order.kind === 'attack') {
      const locked = this.units[unit.order.target];
      if (locked?.alive && locked.team !== unit.team) target = locked;
      else unit.order = { kind: 'none' };
    }
    if (!target && (unit.order.kind === 'none' || (unit.order.kind === 'move' && unit.order.attackMove))) {
      target = this.acquire(unit);
    }
    if (!target && unit.order.kind === 'attack') target = null;
    if (target) this.fireUnit(unit, target);
  }

  private facing(unit: SimUnit, x: number, z: number): boolean {
    const def = BY_ID[unit.defId];
    const aim = Math.atan2(x - unit.x, z - unit.z);
    const face = def.turret ? unit.turret : unit.heading;
    return angDiff(face, aim) < 0.5;
  }

  private fireUnit(unit: SimUnit, target: SimUnit) {
    const w = BY_ID[unit.defId].weapon;
    if (!w) return;
    const td = BY_ID[target.defId];
    const mult = td.flying ? w.vsAir : w.vsGround;
    if (mult <= 0) return;
    const dist = this.fightDist(unit, target);
    if (dist > w.range || dist < w.minRange) return;
    if (!this.facing(unit, target.x, target.z)) return;
    let grazing = false;
    if (!w.indirect) {
      const los = lineOfSight(this.terrain, unit.x, unit.z, this.eye(unit), target.x, target.z, this.eye(target));
      if (!los.clear) return;
      grazing = los.grazing;
    }
    const scatter = (1 - w.accuracy) * Math.min(2.4, dist * 0.14);
    const ang = this.rng.next() * Math.PI * 2;
    const mag = this.rng.next() * scatter;
    const tx = target.x + Math.cos(ang) * mag;
    const tz = target.z + Math.sin(ang) * mag;
    const ty = td.flying ? target.y : sampleHeight(this.terrain, tx, tz) + 0.8;
    unit.cooldown = w.period;
    if (w.speed <= 0) {
      const chance = clamp(0.22 + w.accuracy * 0.72 * (1 - 0.4 * dist / Math.max(0.1, w.range)), 0.12, 0.97);
      const y0 = this.eye(unit);
      this.fx.push({
        kind: 'tracer',
        x: unit.x,
        y: y0,
        z: unit.z,
        x2: tx,
        y2: ty,
        z2: tz,
        team: unit.team,
        shot: w.kind,
      });
      if (this.rng.next() <= chance) this.hurt(target, w.damage * mult, unit, w.pen, false, grazing);
      return;
    }
    this.launch(unit, tx, ty, tz, target.id, w, w.damage * mult);
  }

  private firePoint(unit: SimUnit, x: number, z: number, targetId: number) {
    const w = BY_ID[unit.defId].weapon;
    if (!w || w.vsGround <= 0) return;
    const dist = Math.hypot(x - unit.x, z - unit.z);
    if (dist > w.range || dist < w.minRange) return;
    if (!this.facing(unit, x, z)) return;
    if (!w.indirect) {
      const los = lineOfSight(this.terrain, unit.x, unit.z, this.eye(unit), x, z, sampleHeight(this.terrain, x, z) + 0.6);
      if (!los.clear) return;
    }
    unit.cooldown = w.period;
    const scatter = (1 - w.accuracy) * Math.min(2.6, dist * 0.12);
    const ang = this.rng.next() * Math.PI * 2;
    const mag = scatter * this.rng.next();
    const tx = x + Math.cos(ang) * mag;
    const tz = z + Math.sin(ang) * mag;
    const ty = sampleHeight(this.terrain, tx, tz);
    this.launch(unit, tx, ty, tz, targetId, w, w.damage * w.vsGround);
  }

  private launch(unit: SimUnit, tx: number, ty: number, tz: number, targetId: number, w: WeaponDef, damage: number) {
    const y0 = this.eye(unit);
    const x0 = unit.x + Math.sin(unit.turret) * Math.min(1.1, BY_ID[unit.defId].radius + 0.3);
    const z0 = unit.z + Math.cos(unit.turret) * Math.min(1.1, BY_ID[unit.defId].radius + 0.3);
    const dx = tx - x0;
    const dy = ty - y0;
    const dz = tz - z0;
    const flat = Math.hypot(dx, dz) || 0.001;
    let vx: number;
    let vy: number;
    let vz: number;
    if (w.arc) {
      const time = clamp(flat / Math.max(4, w.speed), 0.45, 2.5);
      vx = dx / time;
      vz = dz / time;
      vy = (dy + 0.5 * GRAVITY * time * time) / time;
    } else {
      const time = Math.max(0.08, flat / Math.max(8, w.speed));
      vx = dx / time;
      vz = dz / time;
      vy = dy / time;
    }
    this.projectiles.push({
      x: x0,
      y: y0,
      z: z0,
      vx,
      vy,
      vz,
      team: unit.team,
      attacker: unit.id,
      damage,
      aoe: w.aoe,
      pen: w.pen,
      ttl: 4.5,
      arc: w.arc,
      indirect: w.indirect,
      homing: w.homing,
      targetId,
      speed: Math.hypot(vx, vy, vz),
      shot: w.kind,
      alive: true,
    });
    this.fx.push({ kind: 'muzzle', x: x0, y: y0, z: z0, team: unit.team });
    if (this.projectiles.length > 96) {
      const drop = this.projectiles.findIndex((p) => p.alive);
      if (drop >= 0) this.projectiles.splice(drop, 1);
    }
  }

  private updateJet(unit: SimUnit) {
    const def = BY_ID[unit.defId];
    const radius = MAP_RADIUS + 6;
    if (unit.mode === 'orbit') {
      unit.orbit += (def.speed / radius) * SIM_DT;
      unit.x = Math.cos(unit.orbit) * radius;
      unit.z = Math.sin(unit.orbit) * radius;
      unit.y = def.altitude;
      unit.heading = unit.orbit + Math.PI / 2;
      unit.turret = unit.heading;
      if (unit.abilityCd > 0) return;
      let ax = 0;
      let az = 0;
      let lock = -1;
      if (unit.order.kind === 'attack') {
        const t = this.units[unit.order.target];
        if (t?.alive && t.team !== unit.team) {
          ax = t.x;
          az = t.z;
          lock = t.id;
        }
      } else if (unit.order.kind === 'ground' || unit.order.kind === 'move') {
        ax = unit.order.x;
        az = unit.order.z;
      }
      if (unit.order.kind === 'none') return;
      if (ax === 0 && az === 0 && lock < 0) return;
      unit.mode = 'run';
      unit.runT = 0;
      unit.runDur = def.id === 'jato_bombardeiro' ? 2.7 : 2.25;
      unit.runFromX = unit.x;
      unit.runFromZ = unit.z;
      unit.ax = ax;
      unit.az = az;
      unit.lock = lock;
      unit.firedRun = false;
      const out = Math.hypot(ax, az) || 1;
      unit.runOutX = (-ax / out) * radius;
      unit.runOutZ = (-az / out) * radius;
      if (Math.hypot(unit.runOutX - unit.x, unit.runOutZ - unit.z) < 8) {
        unit.runOutX = Math.cos(unit.orbit + Math.PI) * radius;
        unit.runOutZ = Math.sin(unit.orbit + Math.PI) * radius;
      }
      return;
    }
    unit.runT += SIM_DT;
    const t = clamp(unit.runT / unit.runDur, 0, 1);
    const u = 1 - t;
    const p1y = Math.max(6.2, sampleHeight(this.terrain, unit.ax, unit.az) + 3.5);
    const x = u * u * unit.runFromX + 2 * u * t * unit.ax + t * t * unit.runOutX;
    const z = u * u * unit.runFromZ + 2 * u * t * unit.az + t * t * unit.runOutZ;
    const y = u * u * def.altitude + 2 * u * t * p1y + t * t * def.altitude;
    unit.heading = Math.atan2(x - unit.x, z - unit.z);
    unit.turret = unit.heading;
    unit.x = x;
    unit.y = y;
    unit.z = z;
    if (!unit.firedRun && t >= 0.46) {
      unit.firedRun = true;
      this.jetStrike(unit);
      unit.abilityCd = def.weapon?.period ?? 7;
    }
    if (t >= 1) {
      unit.mode = 'orbit';
      unit.orbit = Math.atan2(unit.z, unit.x);
      unit.order = { kind: 'none' };
    }
  }

  private jetStrike(unit: SimUnit) {
    const w = BY_ID[unit.defId].weapon;
    if (!w) return;
    const y = sampleHeight(this.terrain, unit.ax, unit.az);
    this.fx.push({ kind: 'boom', x: unit.ax, y: y + 0.3, z: unit.az, size: Math.max(w.aoe, 1.4), team: unit.team });
    for (const target of this.units) {
      if (!target.alive || target.team === unit.team) continue;
      const td = BY_ID[target.defId];
      const mult = td.flying ? w.vsAir : w.vsGround;
      if (mult <= 0) continue;
      const extra = td.flying ? Math.abs(target.y - y) * 0.35 : 0;
      const d = Math.hypot(target.x - unit.ax, target.z - unit.az) + extra;
      const rad = Math.max(w.aoe, td.flying ? 2.4 : 1.6);
      if (d > rad + td.radius) continue;
      const fall = clamp(1 - d / (rad + 0.2), 0.3, 1);
      this.hurt(target, w.damage * mult * fall, unit, w.pen, true, false);
    }
  }

  private updateProjectiles() {
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      if (p.homing && p.targetId >= 0) {
        const target = this.units[p.targetId];
        if (target?.alive) {
          const dx = target.x - p.x;
          const dy = this.eye(target) - p.y;
          const dz = target.z - p.z;
          const mag = Math.hypot(dx, dy, dz) || 1;
          const spd = Math.hypot(p.vx, p.vy, p.vz) || p.speed;
          const steer = Math.min(1, SIM_DT * 3.5);
          p.vx = p.vx * (1 - steer) + (dx / mag) * spd * steer;
          p.vy = p.vy * (1 - steer) + (dy / mag) * spd * steer;
          p.vz = p.vz * (1 - steer) + (dz / mag) * spd * steer;
          const n = Math.hypot(p.vx, p.vy, p.vz) || 1;
          p.vx = (p.vx / n) * spd;
          p.vy = (p.vy / n) * spd;
          p.vz = (p.vz / n) * spd;
          if (mag < 0.85) {
            this.detonate(p);
            continue;
          }
        }
      }
      p.x += p.vx * SIM_DT;
      p.y += p.vy * SIM_DT;
      p.z += p.vz * SIM_DT;
      if (p.arc) p.vy -= GRAVITY * SIM_DT;
      p.ttl -= SIM_DT;
      const ground = sampleHeight(this.terrain, p.x, p.z);
      if (p.y <= ground + 0.12 || p.ttl <= 0) this.detonate(p);
    }
    let w = 0;
    for (let i = 0; i < this.projectiles.length; i++) {
      if (this.projectiles[i].alive) this.projectiles[w++] = this.projectiles[i];
    }
    this.projectiles.length = w;
  }

  private detonate(p: Projectile) {
    if (!p.alive) return;
    p.alive = false;
    const attacker = p.attacker >= 0 ? this.units[p.attacker] : null;
    if (p.aoe <= 0.2) {
      const t = p.targetId >= 0 ? this.units[p.targetId] : undefined;
      const y = Math.max(p.y, sampleHeight(this.terrain, p.x, p.z));
      this.fx.push({ kind: 'boom', x: p.x, y, z: p.z, size: 0.55, team: p.team });
      if (t?.alive && Math.hypot(t.x - p.x, t.z - p.z) < BY_ID[t.defId].radius + 1.1) {
        this.hurt(t, p.damage, attacker, p.pen, p.indirect, false);
      }
      return;
    }
    this.boom(p.team, p.attacker, p.x, p.z, p.damage, p.aoe, p.pen, p.indirect);
  }

  private boom(team: 0 | 1, attackerId: number, x: number, z: number, damage: number, aoe: number, pen: number, indirect: boolean) {
    const y = sampleHeight(this.terrain, x, z);
    this.fx.push({ kind: 'boom', x, y: y + 0.15, z, size: Math.max(0.7, aoe), team });
    const attacker = attackerId >= 0 ? this.units[attackerId] : null;
    for (const target of this.units) {
      if (!target.alive || target.team === team) continue;
      const rad = aoe + BY_ID[target.defId].radius * 0.35;
      const d = Math.hypot(target.x - x, target.z - z);
      if (d > rad) continue;
      const fall = clamp(1 - (d / rad) * 0.7, 0.25, 1);
      this.hurt(target, damage * fall, attacker?.alive || attacker ? attacker : null, pen, indirect, false);
    }
  }

  private hurt(target: SimUnit, raw: number, attacker: SimUnit | null, pen: number, indirect: boolean, grazing: boolean) {
    if (!target.alive || raw <= 0) return;
    const def = BY_ID[target.defId];
    let dmg = raw * (1 - def.armor * (1 - clamp(pen, 0, 1)));
    if (attacker && !indirect) {
      const ad = BY_ID[attacker.defId];
      if (!ad.flying && !def.flying) {
        const adv = clamp(
          (sampleHeight(this.terrain, attacker.x, attacker.z) - sampleHeight(this.terrain, target.x, target.z)) / 5.5,
          -0.28,
          0.4,
        );
        dmg *= 1 + adv;
      }
    }
    let cover = this.coverAt(target);
    if (indirect) cover *= 0.45;
    if (grazing) cover = Math.max(cover, 0.18);
    dmg *= 1 - Math.min(0.72, cover);
    dmg *= 1 - this.auraReduction(target);
    if (dmg <= 0) return;
    target.hp -= dmg;
    this.fx.push({ kind: 'hit', id: target.id, x: target.x, y: target.y + def.eye, z: target.z });
    if (target.hp <= 0) this.kill(target);
  }

  private coverAt(unit: SimUnit): number {
    let cover = 0;
    for (const other of this.units) {
      if (!other.alive || other.team !== unit.team || other.id === unit.id) continue;
      const def = BY_ID[other.defId];
      if (def.cover <= 0) continue;
      if (Math.hypot(other.x - unit.x, other.z - unit.z) <= def.coverRadius) cover = Math.max(cover, def.cover);
    }
    return cover;
  }

  private auraReduction(unit: SimUnit): number {
    let reduction = 0;
    for (const other of this.units) {
      if (!other.alive || other.team !== unit.team) continue;
      const ability = BY_ID[other.defId].ability;
      if (ability?.id !== 'aura') continue;
      if (Math.hypot(other.x - unit.x, other.z - unit.z) <= ability.radius) reduction = Math.max(reduction, ability.reduction);
    }
    return reduction;
  }

  private kill(target: SimUnit) {
    if (!target.alive) return;
    target.alive = false;
    target.hp = 0;
    target.death = 0;
    target.order = { kind: 'none' };
    target.path = [];
    target.garrison = -1;
    this.losses[target.team] += 1;
    for (const u of this.units) if (u.garrison === target.id) u.garrison = -1;
    this.fx.push({ kind: 'death', id: target.id, x: target.x, y: target.y, z: target.z, team: target.team });
  }

  private separate() {
    const ground: SimUnit[] = [];
    for (const u of this.units) {
      if (!u.alive || u.garrison >= 0) continue;
      const def = BY_ID[u.defId];
      if (def.flying || def.immobile) continue;
      ground.push(u);
    }
    for (let i = 0; i < ground.length; i++) {
      for (let j = i + 1; j < ground.length; j++) {
        const a = ground[i];
        const b = ground[j];
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let d = Math.hypot(dx, dz);
        const min = BY_ID[a.defId].radius + BY_ID[b.defId].radius + 0.05;
        if (d < 0.0008) {
          dx = 0.02;
          dz = 0;
          d = 0.02;
        }
        if (d >= min) continue;
        const push = (min - d) * 0.5;
        const nx = dx / d;
        const nz = dz / d;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
      }
    }
    for (const u of ground) {
      for (const tree of this.terrain.trees) {
        const dx = u.x - tree.x;
        const dz = u.z - tree.z;
        const d = Math.hypot(dx, dz);
        const min = tree.radius + BY_ID[u.defId].radius;
        if (d < min && d > 0.0001) {
          u.x = tree.x + (dx / d) * min;
          u.z = tree.z + (dz / d) * min;
        }
      }
      if (!isWalkable(this.terrain, u.x, u.z)) {
        const back = nearestWalkable(this.terrain, u.x, u.z, 3);
        if (back) {
          u.x = back.x;
          u.z = back.z;
        }
      }
    }
  }

  private updateObjective() {
    let has0 = false;
    let has1 = false;
    for (const u of this.units) {
      if (!u.alive) continue;
      const def = BY_ID[u.defId];
      if (!canCapture(def)) continue;
      if (Math.hypot(u.x, u.z) <= CAPTURE_RADIUS) {
        if (u.team === 0) has0 = true;
        else has1 = true;
      }
    }
    this.contested = has0 && has1;
    const rate = SIM_DT / CAPTURE_SECONDS;
    if (has0 && !has1) {
      this.cap0 = Math.min(1, this.cap0 + rate);
      this.cap1 = Math.max(0, this.cap1 - rate * 0.45);
    } else if (has1 && !has0) {
      this.cap1 = Math.min(1, this.cap1 + rate);
      this.cap0 = Math.max(0, this.cap0 - rate * 0.45);
    } else if (!has0 && !has1) {
      this.cap0 = Math.max(0, this.cap0 - rate * 0.12);
      this.cap1 = Math.max(0, this.cap1 - rate * 0.12);
    }
    if (this.cap0 >= 1) this.finish(0);
    else if (this.cap1 >= 1) this.finish(1);
  }

  private updateElimination() {
    let a0 = false;
    let a1 = false;
    for (const u of this.units) {
      if (!u.alive || !isCombatant(BY_ID[u.defId])) continue;
      if (u.team === 0) a0 = true;
      else a1 = true;
    }
    if (!a0 && !a1) this.finish(-1);
    else if (!a0) this.finish(1);
    else if (!a1) this.finish(0);
  }

  private finish(winner: -1 | 0 | 1) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
  }

  private updateVision() {
    for (const u of this.units) {
      if (!u.alive) u.spotted = [true, true];
      else u.spotted = [u.team === 0, u.team === 1];
    }
    for (const viewer of this.units) {
      if (!viewer.alive) continue;
      const vd = BY_ID[viewer.defId];
      const reach = vd.vision * vd.vision;
      for (const target of this.units) {
        if (!target.alive || target.team === viewer.team) continue;
        const team = viewer.team;
        if (target.revealUntil[team] >= this.tick) {
          target.spotted[team] = true;
          continue;
        }
        if (target.spotted[team]) continue;
        const dx = target.x - viewer.x;
        const dz = target.z - viewer.z;
        if (dx * dx + dz * dz > reach) continue;
        let seen = false;
        if (vd.flying) seen = true;
        else seen = lineOfSight(this.terrain, viewer.x, viewer.z, this.eye(viewer), target.x, target.z, this.eye(target)).clear;
        if (!seen) continue;
        target.spotted[team] = true;
        if (vd.ability?.id === 'mark') target.revealUntil[team] = this.tick + 5 * SIM_HZ;
      }
    }
  }

  private hashState(): number {
    let h = 2166136261;
    const mix = (v: number) => {
      h ^= v | 0;
      h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
      h >>>= 0;
    };
    mix(this.tick);
    mix(this.winner + 3);
    mix(Math.round(this.cap0 * 1000));
    mix(Math.round(this.cap1 * 1000));
    mix(this.rng.raw);
    for (const u of this.units) {
      mix(u.id);
      mix(Math.round(u.x * 40));
      mix(Math.round(u.z * 40));
      mix(Math.round(u.y * 40));
      mix(Math.round(u.hp * 10));
      mix(u.alive ? 1 : 0);
      mix(u.order.kind === 'none' ? 0 : u.order.kind === 'move' ? 1 : u.order.kind === 'attack' ? 2 : 3);
    }
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      mix(Math.round(p.x * 20));
      mix(Math.round(p.y * 20));
      mix(Math.round(p.z * 20));
    }
    return h >>> 0;
  }
}

export function createMatch(opts: MatchOptions): World {
  const world = new World(opts);
  world.aiHook = aiThink;
  return world;
}
