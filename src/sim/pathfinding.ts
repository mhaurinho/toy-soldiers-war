import { gridCenter, isWalkable, type Terrain, worldToGrid } from './terrain';

const SQRT2 = Math.SQRT2;
const DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
] as const;

class Heap {
  private a: { i: number; f: number }[] = [];
  get size(): number {
    return this.a.length;
  }
  push(i: number, f: number) {
    const a = this.a;
    a.push({ i, f });
    let n = a.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (a[p].f <= a[n].f) break;
      const tmp = a[p];
      a[p] = a[n];
      a[n] = tmp;
      n = p;
    }
  }
  pop(): number | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0].i;
    const last = a.pop();
    if (last && a.length) {
      a[0] = last;
      let n = 0;
      for (;;) {
        const l = n * 2 + 1;
        const r = l + 1;
        let s = n;
        if (l < a.length && a[l].f < a[s].f) s = l;
        if (r < a.length && a[r].f < a[s].f) s = r;
        if (s === n) break;
        const tmp = a[n];
        a[n] = a[s];
        a[s] = tmp;
        n = s;
      }
    }
    return top;
  }
}

function lineClear(t: Terrain, x0: number, z0: number, x1: number, z1: number): boolean {
  const dist = Math.hypot(x1 - x0, z1 - z0);
  const steps = Math.max(2, Math.ceil(dist / 0.7));
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    if (!isWalkable(t, x0 + (x1 - x0) * u, z0 + (z1 - z0) * u)) return false;
  }
  return true;
}

export function findPath(t: Terrain, x0: number, z0: number, x1: number, z1: number): { x: number; z: number }[] {
  const sCell = worldToGrid(t, x0, z0);
  const gCell = worldToGrid(t, x1, z1);
  if (!sCell || !gCell) return [];
  const n = t.navRes;
  const start = sCell.j * n + sCell.i;
  let goal = gCell.j * n + gCell.i;
  if (!t.walkable[goal]) {
    let best = -1;
    let bestD = Infinity;
    const rad = 6;
    for (let j = Math.max(0, gCell.j - rad); j <= Math.min(n - 1, gCell.j + rad); j++) {
      for (let i = Math.max(0, gCell.i - rad); i <= Math.min(n - 1, gCell.i + rad); i++) {
        const id = j * n + i;
        if (!t.walkable[id]) continue;
        const c = gridCenter(t, i, j);
        const d = Math.hypot(c.x - x1, c.z - z1);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
    }
    if (best < 0) return [];
    goal = best;
  }
  if (start === goal) return [{ x: x0, z: z0 }, gridCenter(t, goal % n, Math.floor(goal / n))];

  const open = new Heap();
  const gScore = new Float32Array(n * n);
  gScore.fill(Infinity);
  const parent = new Int32Array(n * n);
  parent.fill(-1);
  const closed = new Uint8Array(n * n);
  gScore[start] = 0;
  const h0 = gridCenter(t, goal % n, Math.floor(goal / n));
  const s0 = gridCenter(t, start % n, Math.floor(start / n));
  open.push(start, Math.hypot(h0.x - s0.x, h0.z - s0.z));

  let guard = 0;
  const limit = n * n;
  while (open.size && guard++ < limit) {
    const cur = open.pop();
    if (cur === undefined) break;
    if (closed[cur]) continue;
    if (cur === goal) break;
    closed[cur] = 1;
    const ci = cur % n;
    const cj = (cur / n) | 0;
    for (const [di, dj, step] of DIRS) {
      const ni = ci + di;
      const nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const id = nj * n + ni;
      if (closed[id] || !t.walkable[id]) continue;
      if (di !== 0 && dj !== 0) {
        if (!t.walkable[cj * n + ni] || !t.walkable[nj * n + ci]) continue;
      }
      const tentative = gScore[cur] + step * t.cost[id];
      if (tentative >= gScore[id]) continue;
      gScore[id] = tentative;
      parent[id] = cur;
      const c = gridCenter(t, ni, nj);
      const goalC = gridCenter(t, goal % n, Math.floor(goal / n));
      open.push(id, tentative + Math.hypot(goalC.x - c.x, goalC.z - c.z));
    }
  }

  if (parent[goal] < 0 && start !== goal) return [];
  const raw: { x: number; z: number }[] = [];
  let cursor = goal;
  const guard2 = n * n;
  let steps = 0;
  while (cursor >= 0 && steps++ < guard2) {
    const c = gridCenter(t, cursor % n, Math.floor(cursor / n));
    raw.push(c);
    if (cursor === start) break;
    cursor = parent[cursor];
  }
  raw.reverse();
  if (!raw.length) return [];
  raw[0] = { x: x0, z: z0 };
  const last = gridCenter(t, goal % n, Math.floor(goal / n));
  if (Math.hypot(last.x - x1, last.z - z1) < 1.4 && isWalkable(t, x1, z1)) raw.push({ x: x1, z: z1 });

  const smooth: { x: number; z: number }[] = [raw[0]];
  let anchor = 0;
  while (anchor < raw.length - 1) {
    let next = anchor + 1;
    for (let i = raw.length - 1; i > anchor + 1; i--) {
      if (lineClear(t, raw[anchor].x, raw[anchor].z, raw[i].x, raw[i].z)) {
        next = i;
        break;
      }
    }
    smooth.push(raw[next]);
    anchor = next;
  }
  if (Math.hypot(smooth[0].x - x0, smooth[0].z - z0) > 0.01) smooth[0] = { x: x0, z: z0 };
  return smooth;
}
