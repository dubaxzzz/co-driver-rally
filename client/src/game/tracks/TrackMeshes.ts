import * as THREE from 'three';
import type { BuiltStage } from '@cdr/shared';

/** Deterministic value noise + fbm for terrain. */
export function makeNoise(seed: number) {
  const hash = (x: number, y: number) => {
    let n = x * 374761393 + y * 668265263 + seed * 2147483647;
    n = (n ^ (n >>> 13)) * 1274126177;
    n = n ^ (n >>> 16);
    return (n & 0xffff) / 0xffff;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  return (x: number, y: number, octaves = 4) => {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += value(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  };
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gravelTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8a7a62';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = 90 + Math.random() * 90;
    g.fillStyle = `rgba(${v + 20},${v + 8},${v - 15},${0.35 + Math.random() * 0.4})`;
    const s = Math.random() * 2.4 + 0.6;
    g.fillRect(Math.random() * 256, Math.random() * 256, s, s);
  }
  // worn wheel tracks (darker, compacted)
  for (const x of [70, 186]) {
    const grad = g.createLinearGradient(x - 26, 0, x + 26, 0);
    grad.addColorStop(0, 'rgba(60,50,38,0)');
    grad.addColorStop(0.5, 'rgba(60,50,38,0.35)');
    grad.addColorStop(1, 'rgba(60,50,38,0)');
    g.fillStyle = grad;
    g.fillRect(x - 26, 0, 52, 256);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export interface TerrainData {
  heightAt(x: number, z: number): number;
  roadDistanceAt(x: number, z: number): number;
  origin: { x: number; z: number };
  cell: number;
  cols: number;
  rows: number;
}

export interface TrackBuild {
  road: THREE.Mesh;
  terrain: THREE.Mesh;
  data: TerrainData;
  roadCollider: { vertices: Float32Array; indices: Uint32Array };
  terrainCollider: { vertices: Float32Array; indices: Uint32Array };
}

const MARGIN = 280;
const CELL = 5;
const VISIBLE_RADIUS = 300;
const COLLIDE_RADIUS = 110;

/** Builds the road ribbon and surrounding terrain from the stage centreline. */
export function buildTrack(stage: BuiltStage): TrackBuild {
  const hw = stage.def.roadWidth / 2;
  const samples = stage.samples;

  // ---- Road ribbon ----
  const across = [-hw - 1.4, -hw, -hw * 0.5, 0, hw * 0.5, hw, hw + 1.4];
  const crown = [-0.14, 0.0, 0.05, 0.07, 0.05, 0.0, -0.14];
  const cols = across.length;
  const n = samples.length;
  const pos = new Float32Array(n * cols * 3);
  const uv = new Float32Array(n * cols * 2);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const lx = Math.cos(s.h), lz = -Math.sin(s.h); // left vector
    for (let j = 0; j < cols; j++) {
      const o = (i * cols + j) * 3;
      const off = -across[j]; // index 0 = right edge
      pos[o] = s.x + lx * off;
      pos[o + 1] = s.y + crown[j] + 0.02;
      pos[o + 2] = s.z + lz * off;
      uv[(i * cols + j) * 2] = (across[j] + hw + 1.4) / (2 * hw + 2.8);
      uv[(i * cols + j) * 2 + 1] = s.d / 7;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  roadGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  roadGeo.setIndex(idx);
  roadGeo.computeVertexNormals();
  const roadMat = new THREE.MeshStandardMaterial({ map: gravelTexture(), roughness: 1, metalness: 0 });
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.receiveShadow = true;

  // ---- Terrain grid ----
  const b = stage.bounds;
  const ox = b.minX - MARGIN, oz = b.minZ - MARGIN;
  const gcols = Math.ceil((b.maxX - b.minX + MARGIN * 2) / CELL) + 1;
  const grows = Math.ceil((b.maxZ - b.minZ + MARGIN * 2) / CELL) + 1;
  const heights = new Float32Array(gcols * grows);
  const dists = new Float32Array(gcols * grows);
  const noise = makeNoise(stage.def.seed);
  const coarseStep = 8;

  for (let r = 0; r < grows; r++) {
    for (let c = 0; c < gcols; c++) {
      const x = ox + c * CELL, z = oz + r * CELL;
      // coarse nearest search, then refine locally
      let best = 0, bestD2 = Infinity;
      for (let i = 0; i < n; i += coarseStep) {
        const dx = samples[i].x - x, dz = samples[i].z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      const lo = Math.max(0, best - coarseStep), hi = Math.min(n - 1, best + coarseStep);
      for (let i = lo; i <= hi; i++) {
        const dx = samples[i].x - x, dz = samples[i].z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      const dist = Math.sqrt(bestD2);
      const roadY = samples[best].y;
      const hills = (noise(x * 0.004, z * 0.004, 5) - 0.42) * 46 + (noise(x * 0.03 + 50, z * 0.03, 2) - 0.5) * 3;
      const t = Math.min(1, Math.max(0, (dist - hw - 2.5) / 34));
      const blend = t * t * (3 - 2 * t);
      let y = roadY - 0.18 + blend * hills;
      // shallow drainage ditch beside the road
      if (dist > hw + 1.5 && dist < hw + 6) y -= Math.sin(((dist - hw - 1.5) / 4.5) * Math.PI) * 0.45;
      heights[r * gcols + c] = y;
      dists[r * gcols + c] = dist;
    }
  }

  const tPos = new Float32Array(gcols * grows * 3);
  const tCol = new Float32Array(gcols * grows * 3);
  const grassA = new THREE.Color(0x3d5a2a), grassB = new THREE.Color(0x56702f), dirt = new THREE.Color(0x6b5a43), moss = new THREE.Color(0x2c4424);
  const tmp = new THREE.Color();
  for (let r = 0; r < grows; r++) {
    for (let c = 0; c < gcols; c++) {
      const i = r * gcols + c;
      const x = ox + c * CELL, z = oz + r * CELL;
      tPos[i * 3] = x;
      tPos[i * 3 + 1] = heights[i];
      tPos[i * 3 + 2] = z;
      const nv = noise(x * 0.05, z * 0.05, 3);
      tmp.copy(grassA).lerp(grassB, nv);
      if (noise(x * 0.012 + 9, z * 0.012, 2) > 0.62) tmp.lerp(moss, 0.6);
      const d = dists[i];
      if (d < hw + 5) tmp.lerp(dirt, 1 - Math.max(0, (d - hw) / 5));
      tCol[i * 3] = tmp.r;
      tCol[i * 3 + 1] = tmp.g;
      tCol[i * 3 + 2] = tmp.b;
    }
  }
  const visIdx: number[] = [];
  const colIdx: number[] = [];
  for (let r = 0; r < grows - 1; r++) {
    for (let c = 0; c < gcols - 1; c++) {
      const a = r * gcols + c, bb = a + 1, cc = a + gcols, d = cc + 1;
      const minDist = Math.min(dists[a], dists[bb], dists[cc], dists[d]);
      if (minDist > VISIBLE_RADIUS) continue;
      visIdx.push(a, cc, bb, bb, cc, d);
      if (minDist < COLLIDE_RADIUS) colIdx.push(a, cc, bb, bb, cc, d);
    }
  }
  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 3));
  terrainGeo.setIndex(visIdx);
  terrainGeo.computeVertexNormals();
  const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: false }));
  terrain.receiveShadow = true;

  const sampleGrid = (arr: Float32Array, x: number, z: number) => {
    const fx = Math.min(gcols - 1.001, Math.max(0, (x - ox) / CELL));
    const fz = Math.min(grows - 1.001, Math.max(0, (z - oz) / CELL));
    const c = Math.floor(fx), r = Math.floor(fz);
    const u = fx - c, v = fz - r;
    const i = r * gcols + c;
    // match the triangle split used by the mesh (a, cc, bb) / (bb, cc, d)
    if (u + v <= 1) return arr[i] + (arr[i + 1] - arr[i]) * u + (arr[i + gcols] - arr[i]) * v;
    const d = arr[i + gcols + 1];
    return d + (arr[i + gcols] - d) * (1 - u) + (arr[i + 1] - d) * (1 - v);
  };

  return {
    road,
    terrain,
    data: {
      heightAt: (x, z) => sampleGrid(heights, x, z),
      roadDistanceAt: (x, z) => sampleGrid(dists, x, z),
      origin: { x: ox, z: oz },
      cell: CELL,
      cols: gcols,
      rows: grows,
    },
    roadCollider: { vertices: pos, indices: new Uint32Array(idx) },
    terrainCollider: { vertices: tPos, indices: new Uint32Array(colIdx) },
  };
}
