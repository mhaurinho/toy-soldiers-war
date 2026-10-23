import type { PropKind } from '../sim/terrain';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

type RGB = [number, number, number];

const BODY: RGB = [1, 1, 1];
const SHADE: RGB = [0.78, 0.78, 0.78];
const DARK: RGB = [0.42, 0.42, 0.42];
const METAL: RGB = [0.24, 0.24, 0.24];

function paint(geo: THREE.BufferGeometry, rgb: RGB): THREE.BufferGeometry {
  const count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = rgb[0];
    colors[i * 3 + 1] = rgb[1];
    colors[i * 3 + 2] = rgb[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function part(
  geo: THREE.BufferGeometry,
  rgb: RGB,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): THREE.BufferGeometry {
  const g = paint(geo, rgb);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  _m.compose(_p, _q, _s);
  g.applyMatrix4(_m);
  return g;
}

function capsule(r: number, len: number, cap = 3, radial = 8): THREE.CapsuleGeometry {
  return new THREE.CapsuleGeometry(r, len, cap, radial);
}

function box(w: number, h: number, d: number, r = 0.04): RoundedBoxGeometry {
  return new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w * 0.45, h * 0.45, d * 0.45));
}

function cyl(rt: number, rb: number, h: number, seg = 10): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(rt, rb, h, seg);
}

function sph(r: number, w = 10, h = 8): THREE.SphereGeometry {
  return new THREE.SphereGeometry(r, w, h);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized = parts.map((geo) => {
    const source = geo.index ? geo.toNonIndexed() : geo;
    const clean = new THREE.BufferGeometry();
    const position = source.getAttribute('position');
    clean.setAttribute('position', position.clone());
    const normal = source.getAttribute('normal');
    if (normal) clean.setAttribute('normal', normal.clone());
    const color = source.getAttribute('color');
    if (color) clean.setAttribute('color', color.clone());
    const uv = source.getAttribute('uv');
    clean.setAttribute('uv', uv ? uv.clone() : new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
    if (!normal) clean.computeVertexNormals();
    if (source !== geo) source.dispose();
    geo.dispose();
    return clean;
  });
  const geo = mergeGeometries(normalized, false);
  for (const item of normalized) item.dispose();
  if (!geo) throw new Error('Falha ao fundir malha');
  geo.computeBoundingSphere();
  return geo;
}

function baseOval(y = 0.045): THREE.BufferGeometry {
  return part(cyl(0.46, 0.5, 0.08, 16), SHADE, 0, y, 0, 0, 0, 0, 1.05, 1, 1.28);
}

function limb(x: number, y: number, z: number, len: number, r: number, rx: number, ry: number, rz: number, rgb: RGB = BODY): THREE.BufferGeometry {
  return part(capsule(r, len, 2, 6), rgb, x, y, z, rx, ry, rz);
}

interface SoldierOpts {
  kneel?: boolean;
  rifle?: 'rifle' | 'long' | 'mg' | 'launcher' | 'pistol' | 'none';
  pack?: boolean;
  tube?: boolean;
}

function soldier(opts: SoldierOpts): THREE.BufferGeometry {
  const kneel = opts.kneel ?? false;
  const hip = kneel ? 0.62 : 0.78;
  const torsoY = kneel ? 0.98 : 1.12;
  const headY = kneel ? 1.38 : 1.52;
  const parts: THREE.BufferGeometry[] = [baseOval()];
  parts.push(limb(-0.12, kneel ? 0.34 : 0.46, kneel ? 0.12 : 0.02, kneel ? 0.28 : 0.46, 0.09, kneel ? 0.7 : 0, 0, 0));
  parts.push(limb(0.12, kneel ? 0.42 : 0.46, kneel ? -0.16 : 0.02, kneel ? 0.34 : 0.46, 0.09, kneel ? -1.15 : 0, 0, 0.08));
  parts.push(part(box(0.16, 0.1, 0.28, 0.03), DARK, -0.12, 0.12, kneel ? 0.22 : 0.08));
  parts.push(part(box(0.16, 0.1, 0.28, 0.03), DARK, 0.13, 0.12, kneel ? -0.05 : 0.1));
  parts.push(part(capsule(0.2, 0.34, 3, 8), BODY, 0, torsoY, 0, 0, 0, 0, 1.12, 1, 0.82));
  parts.push(part(cyl(0.2, 0.2, 0.07, 10), DARK, 0, hip, 0, 0, 0, 0, 1.15, 1, 0.9));
  parts.push(part(sph(0.135, 10, 8), SHADE, 0, headY, 0.02));
  parts.push(part(sph(0.155, 10, 8), BODY, 0, headY + 0.05, -0.01, 0, 0, 0, 1.05, 0.78, 1.08));
  parts.push(part(box(0.26, 0.035, 0.16, 0.02), SHADE, 0, headY - 0.02, 0.1));
  parts.push(part(box(0.09, 0.03, 0.02, 0.01), METAL, 0, headY + 0.01, 0.15));

  const armY = torsoY + 0.12;
  if (opts.rifle === 'mg') {
    parts.push(limb(-0.24, armY - 0.08, 0.12, 0.28, 0.07, 1.1, 0, 0.4));
    parts.push(limb(0.22, armY - 0.12, 0.18, 0.26, 0.07, 1.3, 0, -0.5));
  } else if (opts.rifle === 'pistol' || opts.rifle === 'none') {
    parts.push(limb(-0.26, armY - 0.16, 0.02, 0.28, 0.065, 0.3, 0, 0.9));
    parts.push(limb(0.24, armY - 0.05, 0.16, 0.26, 0.065, 1.2, 0, -0.4));
  } else {
    parts.push(limb(-0.2, armY - 0.02, 0.16, 0.26, 0.065, 1.35, 0.2, 0.5));
    parts.push(limb(0.18, armY - 0.08, 0.22, 0.24, 0.065, 1.5, -0.1, -0.35));
  }

  if (opts.rifle === 'rifle' || opts.rifle === 'long') {
    const len = opts.rifle === 'long' ? 0.92 : 0.62;
    parts.push(part(box(0.05, 0.07, len, 0.015), METAL, 0.04, armY - 0.02, 0.18 + len * 0.25));
    parts.push(part(cyl(0.018, 0.018, len * 0.55, 6), DARK, 0.04, armY, 0.18 + len * 0.72, Math.PI / 2, 0, 0));
    parts.push(part(box(0.045, 0.1, 0.16, 0.01), DARK, -0.02, armY - 0.06, 0.05));
  } else if (opts.rifle === 'mg') {
    parts.push(part(box(0.07, 0.08, 0.7, 0.02), METAL, 0, 0.72, 0.42));
    parts.push(part(cyl(0.028, 0.028, 0.42, 6), DARK, 0, 0.76, 0.82, Math.PI / 2));
    parts.push(part(box(0.04, 0.16, 0.04, 0.01), DARK, -0.12, 0.48, 0.36, 0, 0, 0.3));
    parts.push(part(box(0.04, 0.16, 0.04, 0.01), DARK, 0.12, 0.48, 0.36, 0, 0, -0.3));
    parts.push(part(box(0.12, 0.08, 0.16, 0.02), SHADE, -0.16, 0.62, 0.12));
  } else if (opts.rifle === 'launcher') {
    parts.push(part(cyl(0.07, 0.08, 0.42, 8), DARK, 0.08, armY, 0.32, Math.PI / 2));
    parts.push(part(box(0.08, 0.1, 0.12, 0.02), METAL, 0.02, armY - 0.08, 0.16));
  } else if (opts.rifle === 'pistol') {
    parts.push(part(box(0.04, 0.08, 0.16, 0.01), METAL, 0.16, armY - 0.02, 0.22));
  }

  if (opts.pack) {
    parts.push(part(box(0.28, 0.36, 0.12, 0.03), SHADE, 0, torsoY + 0.02, -0.22));
    parts.push(part(cyl(0.012, 0.012, 0.72, 5), METAL, 0.08, headY + 0.28, -0.2));
    parts.push(part(sph(0.04, 6, 5), DARK, 0.08, headY + 0.66, -0.2));
  }
  if (opts.tube) {
    parts.push(part(cyl(0.07, 0.09, 0.48, 8), DARK, 0, 0.62, 0.48, 1.05, 0, 0));
    parts.push(part(box(0.28, 0.03, 0.08, 0.01), METAL, 0, 0.42, 0.34));
    parts.push(part(cyl(0.02, 0.02, 0.28, 5), METAL, -0.1, 0.32, 0.36, 0.4));
    parts.push(part(cyl(0.02, 0.02, 0.28, 5), METAL, 0.1, 0.32, 0.36, 0.4));
  }
  return merge(parts);
}

function plinth(w: number, d: number): THREE.BufferGeometry {
  return part(box(w, 0.07, d, 0.03), SHADE, 0, 0.04, 0);
}

function wheel(x: number, z: number, r = 0.28): THREE.BufferGeometry {
  return part(cyl(r, r, 0.16, 10), METAL, x, r, z, 0, 0, Math.PI / 2);
}

function jeep(kind: 'mg' | 'apc' | 'at'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (kind === 'apc') {
    parts.push(plinth(1.5, 2.9));
    parts.push(part(box(1.35, 0.72, 2.5, 0.08), BODY, 0, 0.62, 0));
    parts.push(part(box(1.15, 0.42, 1.15, 0.06), SHADE, 0, 1.05, -0.15));
    parts.push(part(box(0.7, 0.08, 0.5, 0.02), DARK, 0, 1.28, -0.1));
    for (const z of [-0.85, 0.85]) {
      parts.push(wheel(-0.72, z, 0.32));
      parts.push(wheel(0.72, z, 0.32));
    }
    parts.push(part(cyl(0.035, 0.035, 0.55, 6), METAL, 0.15, 1.2, 0.55, Math.PI / 2));
  } else {
    parts.push(plinth(1.35, 2.35));
    parts.push(part(box(1.2, 0.42, 2.05, 0.06), BODY, 0, 0.52, 0));
    parts.push(part(box(1.05, 0.38, 0.85, 0.05), SHADE, 0, 0.82, -0.25));
    parts.push(part(box(0.08, 0.28, 0.08, 0.02), DARK, -0.42, 0.95, -0.55));
    parts.push(part(box(0.08, 0.28, 0.08, 0.02), DARK, 0.42, 0.95, -0.55));
    parts.push(part(box(0.9, 0.05, 0.08, 0.02), DARK, 0, 1.08, -0.55));
    for (const z of [-0.7, 0.7]) {
      parts.push(wheel(-0.62, z, 0.28));
      parts.push(wheel(0.62, z, 0.28));
    }
    if (kind === 'at') {
      parts.push(part(box(0.16, 0.1, 0.7, 0.03), METAL, 0, 0.95, 0.15));
      parts.push(part(cyl(0.06, 0.06, 0.55, 8), DARK, 0, 1.02, 0.55, Math.PI / 2));
    } else {
      parts.push(part(cyl(0.04, 0.04, 0.38, 6), METAL, 0, 1.05, 0.15, Math.PI / 2));
      parts.push(part(box(0.16, 0.1, 0.22, 0.02), DARK, 0, 0.95, -0.05));
    }
  }
  return merge(parts);
}

function hull(bulk: number): THREE.BufferGeometry {
  const w = 1.15 + bulk * 0.45;
  const l = 2.15 + bulk * 0.7;
  const h = 0.48 + bulk * 0.12;
  const parts: THREE.BufferGeometry[] = [plinth(w + 0.35, l + 0.25)];
  parts.push(part(box(w * 0.42, h * 0.85, l, 0.05), DARK, -w * 0.48, 0.28 + h * 0.2, 0));
  parts.push(part(box(w * 0.42, h * 0.85, l, 0.05), DARK, w * 0.48, 0.28 + h * 0.2, 0));
  parts.push(part(box(w * 0.72, h, l * 0.92, 0.07), BODY, 0, 0.42 + h * 0.35, 0));
  parts.push(part(box(w * 0.55, h * 0.35, 0.45, 0.04), SHADE, 0, 0.55, l * 0.42));
  for (const side of [-1, 1]) {
    for (const z of [-0.7, -0.25, 0.25, 0.7]) {
      parts.push(part(cyl(0.16 + bulk * 0.02, 0.16, 0.12, 8), METAL, side * w * 0.48, 0.22, z * (0.7 + bulk * 0.15), 0, 0, Math.PI / 2));
    }
  }
  return merge(parts);
}

function turret(bulk: number, barrel: number): THREE.BufferGeometry {
  const r = 0.38 + bulk * 0.12;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(cyl(r, r * 1.08, 0.36, 12), BODY, 0, 0.18, 0));
  parts.push(part(sph(r * 0.72, 10, 8), SHADE, 0, 0.32, -0.02, 0, 0, 0, 1.2, 0.7, 1));
  parts.push(part(cyl(0.045 + bulk * 0.012, 0.055 + bulk * 0.012, barrel, 8), METAL, 0, 0.22, barrel * 0.45 + 0.15, Math.PI / 2));
  parts.push(part(box(0.12, 0.08, 0.16, 0.02), DARK, 0, 0.2, 0.2));
  return merge(parts);
}

function helicopter(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(capsule(0.32, 1.15, 4, 10), BODY, 0, 0.55, 0.05, Math.PI / 2, 0, 0, 0.85, 1, 1));
  parts.push(part(sph(0.28, 10, 8), SHADE, 0, 0.62, 0.55, 0, 0, 0, 0.9, 0.75, 1.05));
  parts.push(part(box(0.08, 0.08, 1.35, 0.03), BODY, 0, 0.58, -1.15));
  parts.push(part(box(0.55, 0.08, 0.18, 0.02), SHADE, 0, 0.78, -1.7));
  parts.push(part(box(0.08, 0.28, 0.16, 0.02), SHADE, 0, 0.7, -1.72));
  parts.push(part(box(0.9, 0.05, 0.28, 0.02), DARK, 0, 0.5, 0.1));
  parts.push(part(cyl(0.06, 0.06, 0.18, 6), METAL, 0, 0.95, 0.05));
  parts.push(part(box(0.16, 0.1, 0.42, 0.02), DARK, 0.28, 0.48, 0.15));
  parts.push(part(cyl(0.08, 0.1, 0.16, 8), METAL, 0.42, 0.42, 0.45, 0, 0, Math.PI / 2));
  parts.push(part(box(0.22, 0.16, 0.7, 0.03), SHADE, 0, 0.22, 0.15));
  return merge(parts);
}

function rotor(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(cyl(0.08, 0.08, 0.06, 8), METAL, 0, 0, 0));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    parts.push(part(box(1.85, 0.025, 0.12, 0.01), SHADE, Math.cos(a) * 0.95, 0.02, Math.sin(a) * 0.95, 0, -a, 0));
  }
  return merge(parts);
}

function jet(bomber: boolean): THREE.BufferGeometry {
  const span = bomber ? 2.5 : 2.15;
  const len = bomber ? 2.7 : 2.35;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(capsule(0.18, len, 4, 10), BODY, 0, 0, 0, Math.PI / 2, 0, 0));
  parts.push(part(box(span, 0.06, 0.55, 0.02), SHADE, 0, 0, 0.05));
  parts.push(part(box(0.7, 0.28, 0.08, 0.02), BODY, 0, 0.12, -len * 0.42));
  parts.push(part(box(0.08, 0.22, 0.28, 0.02), SHADE, 0, 0.16, -len * 0.48));
  parts.push(part(sph(0.16, 8, 6), SHADE, 0, 0.08, len * 0.32, 0, 0, 0, 0.8, 0.7, 1.2));
  parts.push(part(cyl(0.1, 0.14, 0.28, 8), DARK, -0.28, -0.02, -0.15, Math.PI / 2));
  parts.push(part(cyl(0.1, 0.14, 0.28, 8), DARK, 0.28, -0.02, -0.15, Math.PI / 2));
  if (bomber) parts.push(part(box(0.22, 0.12, 0.55, 0.03), METAL, 0, -0.16, 0.1));
  return merge(parts);
}

function howitzer(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [plinth(1.3, 2.4)];
  parts.push(part(box(0.7, 0.28, 1.15, 0.05), BODY, 0, 0.4, -0.15));
  parts.push(part(cyl(0.11, 0.14, 1.35, 10), DARK, 0, 0.72, 0.45, Math.PI / 2.7));
  parts.push(part(box(0.18, 0.16, 0.28, 0.03), SHADE, 0, 0.58, 0.05));
  parts.push(wheel(-0.48, -0.15, 0.36));
  parts.push(wheel(0.48, -0.15, 0.36));
  parts.push(part(box(0.08, 0.08, 1.1, 0.02), METAL, -0.28, 0.28, -0.7));
  parts.push(part(box(0.08, 0.08, 1.1, 0.02), METAL, 0.28, 0.28, -0.7));
  return merge(parts);
}

function igla(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [baseOval(0.04)];
  // kneeling gunner
  parts.push(limb(-0.1, 0.38, 0.05, 0.3, 0.08, 0.8, 0, 0));
  parts.push(limb(0.12, 0.4, -0.12, 0.32, 0.08, -1.2, 0, 0));
  parts.push(part(capsule(0.16, 0.28, 2, 7), BODY, 0, 0.78, 0, 0, 0, 0, 1.05, 1, 0.85));
  parts.push(part(sph(0.12, 8, 6), SHADE, 0, 1.12, 0.02));
  parts.push(part(sph(0.14, 8, 6), BODY, 0, 1.16, 0, 0, 0, 0, 1.05, 0.75, 1.05));
  parts.push(part(cyl(0.055, 0.07, 0.72, 8), METAL, 0.05, 1.05, 0.28, Math.PI / 2.4));
  parts.push(part(box(0.12, 0.08, 0.16, 0.02), DARK, 0, 0.95, 0.08));
  return merge(parts);
}

function trench(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(box(3.2, 0.38, 0.28, 0.06), SHADE, 0, 0.2, 0.85));
  parts.push(part(box(0.28, 0.38, 2.4, 0.06), SHADE, -1.45, 0.2, -0.2));
  parts.push(part(box(0.28, 0.38, 2.4, 0.06), SHADE, 1.45, 0.2, -0.2));
  parts.push(part(box(2.6, 0.12, 1.8, 0.04), DARK, 0, 0.06, -0.15));
  return merge(parts);
}

function sandbags(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    parts.push(part(capsule(0.16, 0.42, 2, 6), SHADE, (i - 2) * 0.42, 0.2, 0, 0, 0, Math.PI / 2));
  }
  for (let i = 0; i < 4; i++) {
    parts.push(part(capsule(0.15, 0.38, 2, 6), BODY, (i - 1.5) * 0.42, 0.46, 0.02, 0, 0.4, Math.PI / 2));
  }
  return merge(parts);
}

function nest(aa: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(cyl(0.85, 0.95, 0.28, 12), SHADE, 0, 0.14, 0));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.push(part(capsule(0.14, 0.36, 2, 5), BODY, Math.cos(a) * 0.72, 0.32, Math.sin(a) * 0.72, 0, -a, Math.PI / 2));
  }
  if (!aa) {
    parts.push(part(box(0.12, 0.1, 0.7, 0.02), METAL, 0, 0.55, 0.35));
    parts.push(part(cyl(0.04, 0.04, 0.4, 6), DARK, 0, 0.58, 0.7, Math.PI / 2));
  }
  return merge(parts);
}

function aaGun(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(cyl(0.18, 0.22, 0.2, 8), BODY, 0, 0.1, 0));
  parts.push(part(cyl(0.045, 0.05, 0.85, 6), METAL, -0.1, 0.28, 0.3, Math.PI / 2.5));
  parts.push(part(cyl(0.045, 0.05, 0.85, 6), METAL, 0.1, 0.28, 0.3, Math.PI / 2.5));
  parts.push(part(box(0.28, 0.1, 0.2, 0.02), DARK, 0, 0.22, 0));
  return merge(parts);
}

function tree(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(cyl(0.08, 0.14, 0.7, 6), [0.62, 0.5, 0.36], 0, 0.4, 0));
  parts.push(part(sph(0.55, 8, 6), [0.7, 0.95, 0.55], 0, 1.15, 0));
  parts.push(part(sph(0.38, 8, 6), [0.85, 1, 0.62], 0.28, 1.45, 0.12));
  parts.push(part(sph(0.32, 7, 6), [0.6, 0.85, 0.48], -0.26, 1.4, -0.08));
  parts.push(part(cyl(0.45, 0.5, 0.08, 10), SHADE, 0, 0.05, 0));
  return merge(parts);
}

function burnedCar(): THREE.BufferGeometry {
  const rust: RGB = [0.32, 0.22, 0.16];
  const soot: RGB = [0.12, 0.1, 0.09];
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(box(1.5, 0.38, 0.72, 0.06), rust, 0, 0.32, 0));
  parts.push(part(box(0.72, 0.32, 0.64, 0.05), soot, -0.05, 0.62, 0));
  parts.push(part(box(0.22, 0.22, 0.08, 0.02), [0.08, 0.08, 0.08], 0.55, 0.28, 0.34));
  parts.push(part(box(0.22, 0.22, 0.08, 0.02), [0.08, 0.08, 0.08], 0.55, 0.28, -0.34));
  parts.push(part(box(0.22, 0.22, 0.08, 0.02), [0.08, 0.08, 0.08], -0.55, 0.28, 0.34));
  parts.push(part(box(0.22, 0.22, 0.08, 0.02), [0.08, 0.08, 0.08], -0.55, 0.28, -0.34));
  return merge(parts);
}

function streetLamp(): THREE.BufferGeometry {
  const iron: RGB = [0.45, 0.42, 0.38];
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(cyl(0.06, 0.09, 1.7, 6), iron, 0, 0.9, 0));
  parts.push(part(box(0.55, 0.06, 0.08, 0.02), iron, 0.22, 1.72, 0));
  parts.push(part(box(0.16, 0.1, 0.12, 0.02), [0.95, 0.86, 0.55], 0.42, 1.62, 0));
  return merge(parts);
}

function stoneWall(): THREE.BufferGeometry {
  const stone: RGB = [0.72, 0.66, 0.56];
  const chip: RGB = [0.45, 0.38, 0.3];
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(box(1.6, 0.9, 0.38, 0.04), stone, 0, 0.5, 0));
  parts.push(part(box(0.4, 0.55, 0.42, 0.03), chip, 0.45, 0.85, 0));
  parts.push(part(box(0.28, 0.2, 0.4, 0.02), chip, -0.4, 0.2, 0.1));
  return merge(parts);
}

function rubblePile(): THREE.BufferGeometry {
  const stone: RGB = [0.55, 0.5, 0.44];
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(box(0.7, 0.28, 0.5, 0.04), stone, 0, 0.16, 0, 0, 0.4, 0.2));
  parts.push(part(box(0.4, 0.22, 0.36, 0.03), [0.4, 0.36, 0.3], 0.28, 0.28, 0.1, 0.2, 0.6, 0));
  parts.push(part(box(0.32, 0.18, 0.28, 0.02), stone, -0.25, 0.22, -0.12, 0, 1, 0.4));
  return merge(parts);
}

function barricade(): THREE.BufferGeometry {
  const wood: RGB = [0.45, 0.28, 0.16];
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(box(1.2, 0.08, 0.12, 0.02), wood, 0, 0.45, 0, 0, 0, 0.5));
  parts.push(part(box(1.2, 0.08, 0.12, 0.02), wood, 0, 0.28, 0, 0, 0, -0.4));
  parts.push(part(cyl(0.16, 0.16, 0.4, 8), [0.18, 0.16, 0.14], 0.45, 0.22, 0.15));
  return merge(parts);
}

function eiffel(): THREE.BufferGeometry {
  const iron: RGB = [0.72, 0.58, 0.38];
  const dark: RGB = [0.28, 0.22, 0.16];
  const parts: THREE.BufferGeometry[] = [];
  const legs: [number, number][] = [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]];
  for (const [x, z] of legs) {
    parts.push(part(box(0.14, 5.4, 0.14, 0.015), iron, x * 0.62, 2.7, z * 0.62, z * 0.11, 0, -x * 0.11));
  }
  parts.push(part(box(1.55, 0.06, 0.06, 0.01), dark, 0, 1.35, -0.55, 0.6, 0, 0.75));
  parts.push(part(box(1.55, 0.06, 0.06, 0.01), dark, 0, 1.35, -0.55, -0.6, 0, -0.75));
  parts.push(part(box(1.55, 0.06, 0.06, 0.01), dark, -0.55, 1.35, 0, 0, 0.6, 0.75));
  parts.push(part(box(1.55, 0.06, 0.06, 0.01), dark, -0.55, 1.35, 0, 0, -0.6, -0.75));
  parts.push(part(box(2.15, 0.1, 2.15, 0.02), iron, 0, 4.7, 0));
  parts.push(part(box(0.78, 1.45, 0.78, 0.02), iron, 0, 5.5, 0));
  parts.push(part(box(1.15, 0.08, 1.15, 0.015), iron, 0, 6.28, 0));
  parts.push(part(box(0.18, 1.5, 0.18, 0.015), dark, 0.16, 7.05, 0, 0, 0, 0.5));
  parts.push(part(box(0.12, 0.9, 0.12, 0.01), dark, 0.55, 6.35, 0.18, 1.05, 0.25, 0.35));
  return merge(parts);
}

function sandHeap(): THREE.BufferGeometry {
  const tan: RGB = [0.72, 0.58, 0.36];
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(box(0.9, 0.28, 0.42, 0.08), tan, 0, 0.16, 0));
  parts.push(part(box(0.7, 0.22, 0.38, 0.06), [0.8, 0.66, 0.42], 0.1, 0.32, 0.05));
  return merge(parts);
}

let propGeos: Record<PropKind, THREE.BufferGeometry> | null = null;

export function propLibrary(): Record<PropKind, THREE.BufferGeometry> {
  if (propGeos) return propGeos;
  propGeos = {
    tree: tree(),
    car: burnedCar(),
    lamp: streetLamp(),
    wall: stoneWall(),
    rubble: rubblePile(),
    barricade: barricade(),
    tower: eiffel(),
    bag: sandHeap(),
  };
  return propGeos;
}

let library: Record<string, THREE.BufferGeometry> | null = null;

export function meshLibrary(): Record<string, THREE.BufferGeometry> {
  if (library) return library;
  library = {
    fuzileiro: soldier({ rifle: 'rifle' }),
    atirador: soldier({ kneel: true, rifle: 'long' }),
    morteiro: soldier({ rifle: 'none', tube: true }),
    radio: soldier({ rifle: 'pistol', pack: true }),
    metralhador: soldier({ kneel: true, rifle: 'mg' }),
    granadeiro: soldier({ rifle: 'launcher' }),
    heli: helicopter(),
    rotor: rotor(),
    jato: jet(false),
    jato_bomba: jet(true),
    jipe: jeep('mg'),
    blindado: jeep('apc'),
    jipe_at: jeep('at'),
    tanque_leve: hull(0),
    tanque_medio: hull(0.55),
    tanque_pesado: hull(1.15),
    torre_leve: turret(0, 0.95),
    torre_media: turret(0.45, 1.2),
    torre_pesada: turret(0.9, 1.45),
    obuseiro: howitzer(),
    igla: igla(),
    trincheira: trench(),
    sacos: sandbags(),
    ninho_aa: nest(true),
    torre_aa: aaGun(),
    ninho_mg: nest(false),
    arvore: tree(),
  };
  return library;
}

/** Local offset of a turret pivot on its hull. */
export function turretOffset(mesh: string): THREE.Vector3 {
  if (mesh === 'torre_pesada') return new THREE.Vector3(0, 1.05, -0.05);
  if (mesh === 'torre_media') return new THREE.Vector3(0, 0.92, -0.02);
  if (mesh === 'torre_leve') return new THREE.Vector3(0, 0.82, 0);
  if (mesh === 'torre_aa') return new THREE.Vector3(0, 0.48, 0);
  return new THREE.Vector3(0, 0.9, 0);
}

export function rotorOffset(): THREE.Vector3 {
  return new THREE.Vector3(0, 1.05, 0.05);
}
