export interface CommandMove {
  type: 'move';
  tick: number;
  team: 0 | 1;
  ids: number[];
  x: number;
  z: number;
  attackMove: boolean;
}

export interface CommandAttack {
  type: 'attack';
  tick: number;
  team: 0 | 1;
  ids: number[];
  target: number;
}

export interface CommandGround {
  type: 'ground';
  tick: number;
  team: 0 | 1;
  ids: number[];
  x: number;
  z: number;
}

export interface CommandAbility {
  type: 'ability';
  tick: number;
  team: 0 | 1;
  ids: number[];
  x: number;
  z: number;
}

export interface CommandStop {
  type: 'stop';
  tick: number;
  team: 0 | 1;
  ids: number[];
}

export interface CommandSurrender {
  type: 'surrender';
  tick: number;
  team: 0 | 1;
}

/** The only input a peer is allowed to feed the simulation. */
export type Command =
  | CommandMove
  | CommandAttack
  | CommandGround
  | CommandAbility
  | CommandStop
  | CommandSurrender;

export type FxEvent =
  | { kind: 'tracer'; x: number; y: number; z: number; x2: number; y2: number; z2: number; team: 0 | 1; shot: 'bullet' | 'shell' | 'rocket' | 'missile' | 'bomb' }
  | { kind: 'muzzle'; x: number; y: number; z: number; team: 0 | 1 }
  | { kind: 'boom'; x: number; y: number; z: number; size: number; team: 0 | 1 }
  | { kind: 'hit'; id: number; x: number; y: number; z: number }
  | { kind: 'death'; id: number; x: number; y: number; z: number; team: 0 | 1 }
  | { kind: 'marker'; x: number; y: number; z: number; team: 0 | 1 };

export interface UnitSnap {
  id: number;
  team: 0 | 1;
  defId: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  turret: number;
  hp: number;
  hpMax: number;
  state: 'idle' | 'move' | 'attack' | 'dead' | 'fly' | 'run';
  spotted0: boolean;
  spotted1: boolean;
  death: number;
  garrison: boolean;
  ability: number;
}

export interface ProjSnap {
  x: number;
  y: number;
  z: number;
  team: 0 | 1;
  shot: 'bullet' | 'shell' | 'rocket' | 'missile' | 'bomb';
}

export interface Snapshot {
  tick: number;
  seconds: number;
  hash: number;
  winner: -1 | 0 | 1;
  over: boolean;
  cap: [number, number];
  contested: boolean;
  units: UnitSnap[];
  projectiles: ProjSnap[];
  fx: FxEvent[];
  alive: [number, number];
  losses: [number, number];
}
