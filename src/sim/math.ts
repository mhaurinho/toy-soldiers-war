export const TAU = Math.PI * 2;

export function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Shortest-path angle blend. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * t;
}

export function angDiff(a: number, b: number): number {
  let d = b - a;
  d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return Math.abs(d);
}

export function len2(x: number, z: number): number {
  return Math.hypot(x, z);
}
