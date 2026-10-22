import { describe, expect, it } from 'vitest';
import { PRESETS, validateLoadout, loadoutCost } from '../data/catalog';
import { BUDGET } from './constants';
import { buildSpecs } from './deploy';
import { findPath } from './pathfinding';
import { generateTerrain, sampleHeight } from './terrain';
import { createMatch } from './world';

describe('exército', () => {
  it('aceita cada lista pronta e recusa orçamento vazio', () => {
    for (const preset of PRESETS) {
      expect(validateLoadout(preset.counts), preset.id).toEqual([]);
      expect(loadoutCost(preset.counts)).toBeLessThanOrEqual(BUDGET);
    }
    expect(validateLoadout({})).not.toEqual([]);
  });
});

describe('terreno', () => {
  it('é determinístico e tem relevo de verdade', () => {
    const a = generateTerrain(20261022);
    const b = generateTerrain(20261022);
    expect(a.heights[10]).toBe(b.heights[10]);
    expect(a.heights[4000]).toBe(b.heights[4000]);
    let min = Infinity;
    let max = -Infinity;
    for (const h of a.heights) {
      if (h < min) min = h;
      if (h > max) max = h;
    }
    expect(max - min).toBeGreaterThan(4);
    const spawn = a.spawns[0];
    const center = sampleHeight(a, 0, 0);
    expect(Math.abs(sampleHeight(a, spawn.x, spawn.z) - spawn.y)).toBeLessThan(0.05);
    expect(center).toBeGreaterThan(1.5);
  });

  it('liga a base ao centro', () => {
    const terrain = generateTerrain(20261022);
    const spawn = terrain.spawns[0];
    const path = findPath(terrain, spawn.x, spawn.z, 0, 0);
    expect(path.length).toBeGreaterThanOrEqual(2);
    const end = path[path.length - 1];
    expect(Math.hypot(end.x, end.z)).toBeLessThan(2);
  });
});

describe('simulação', () => {
  it('repete o mesmo hash com a mesma semente', () => {
    const terrain = generateTerrain(11);
    const specs = [
      ...buildSpecs(terrain, PRESETS[0].counts, 0, 0, [], true),
      ...buildSpecs(terrain, PRESETS[2].counts, 1, 4, [], true),
    ];
    const options = { seed: 11, specs, aiTeams: [0, 1], openingPush: true };
    const a = createMatch(options);
    const b = createMatch(options);
    expect(a.units.length).toBe(b.units.length);
    expect(a.units.length).toBeGreaterThan(10);
    for (let i = 0; i < 80; i++) {
      if (i === 10) {
        const ids = a.units.filter((u) => u.team === 0 && u.alive).slice(0, 4).map((u) => u.id);
        const command = { type: 'move' as const, tick: 10, team: 0 as const, ids, x: 2, z: -3, attackMove: true };
        a.submit(command);
        b.submit(command);
      }
      a.step();
      b.step();
      expect(a.hash).toBe(b.hash);
    }
  });
});
