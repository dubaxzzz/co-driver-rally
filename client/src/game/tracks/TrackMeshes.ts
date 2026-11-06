import * as THREE from 'three';
import { SURFACES, riverDistance, type BuiltStage, type River, type SurfaceId } from '@cdr/shared';

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

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** Procedural road textures, one per surface. */
function surfaceTexture(surface: SurfaceId, tint: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(surface.length * 97 + tint);
  const speckle = (n: number, colors: string[], maxSize: number) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = colors[Math.floor(rnd() * colors.length)];
      const s = rnd() * maxSize + 0.6;
      g.fillRect(rnd() * 256, rnd() * 256, s, s);
    }
  };
  const tracks = (color: string) => {
    for (const x of [70, 186]) {
      const grad = g.createLinearGradient(x - 26, 0, x + 26, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(0.5, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x - 26, 0, 52, 256);
    }
  };
  switch (surface) {
    case 'tarmac':
      g.fillStyle = '#3b3d40';
      g.fillRect(0, 0, 256, 256);
      speckle(7000, ['rgba(90,92,96,0.5)', 'rgba(30,31,33,0.5)', 'rgba(120,120,120,0.3)'], 1.6);
      tracks('rgba(20,20,22,0.35)');
      g.fillStyle = 'rgba(235,235,225,0.85)'; // edge lines
      g.fillRect(14, 0, 5, 256);
      g.fillRect(237, 0, 5, 256);
      break;
    case 'mud':
      g.fillStyle = '#4a3622';
      g.fillRect(0, 0, 256, 256);
      speckle(4000, ['rgba(70,52,32,0.6)', 'rgba(35,25,16,0.6)'], 4);
      tracks('rgba(25,18,10,0.55)');
      for (let i = 0; i < 18; i++) {
        g.fillStyle = 'rgba(110,100,85,0.35)'; // puddles
        g.beginPath();
        g.ellipse(rnd() * 256, rnd() * 256, 8 + rnd() * 20, 4 + rnd() * 8, 0, 0, Math.PI * 2);
        g.fill();
      }
      break;
    case 'snow':
      g.fillStyle = '#e4eaee';
      g.fillRect(0, 0, 256, 256);
      speckle(3000, ['rgba(200,210,220,0.6)', 'rgba(255,255,255,0.8)'], 2.5);
      tracks('rgba(150,165,180,0.5)'); // icy ruts
      break;
    case 'sand':
      g.fillStyle = hex(tint);
      g.fillRect(0, 0, 256, 256);
      speckle(6000, ['rgba(220,150,90,0.4)', 'rgba(120,60,30,0.35)'], 2);
      tracks('rgba(90,40,20,0.25)');
      break;
    case 'wood':
      g.fillStyle = '#6b4a2e';
      g.fillRect(0, 0, 256, 256);
      for (let y = 0; y < 256; y += 16) {
        g.fillStyle = y % 32 ? '#7a5534' : '#62432a';
        g.fillRect(0, y, 256, 14);
        g.fillStyle = 'rgba(20,12,6,0.6)';
        g.fillRect(0, y + 14, 256, 2);
      }
      speckle(800, ['rgba(40,25,12,0.4)'], 2);
      break;
    default: {
      // gravel, tinted per stage (grey Finnish, red Australian…)
      g.fillStyle = hex(tint);
      g.fillRect(0, 0, 256, 256);
      speckle(9000, ['rgba(255,240,220,0.25)', 'rgba(0,0,0,0.25)', 'rgba(140,130,120,0.35)'], 2.4);
      tracks('rgba(40,30,20,0.32)');
    }
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
  /** Distance to the nearest river centre line (Infinity if none). */
  riverDistanceAt(x: number, z: number): number;
  /** The river (and water height) if this point is in the water. */
  waterAt(x: number, z: number): River | null;
  origin: { x: number; z: number };
  cell: number;
  cols: number;
  rows: number;
}

export interface WaterBody {
  mesh: THREE.Group;
  update(dt: number): void;
}

export interface TrackBuild {
  road: THREE.Mesh;
  terrain: THREE.Mesh;
  water: WaterBody[];
  data: TerrainData;
  roadCollider: { vertices: Float32Array; indices: Uint32Array };
  terrainCollider: { vertices: Float32Array; indices: Uint32Array };
}

const MARGIN = 280;
const CELL = 5;
const VISIBLE_RADIUS = 300;
const COLLIDE_RADIUS = 110;

/** Builds the road ribbon, terrain (with river channels) and flowing water. */
export function buildTrack(stage: BuiltStage): TrackBuild {
  const def = stage.def;
  const sc = def.scenery;
  const hw = def.roadWidth / 2;
  const samples = stage.samples;

  // ---- Road ribbon (one geometry, one material group per surface span) ----
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
  const roadGeo = new THREE.BufferGeometry();
  const surfaceList: SurfaceId[] = [];
  for (const span of stage.surfaceSpans) {
    let m = surfaceList.indexOf(span.surface);
    if (m < 0) {
      surfaceList.push(span.surface);
      m = surfaceList.length - 1;
    }
    // round (not floor/ceil) so neighbouring spans never share a quad
    const i0 = Math.max(0, Math.round(span.from / stage.step));
    const i1 = Math.min(n - 1, Math.round(span.to / stage.step));
    const start = idx.length;
    for (let i = i0; i < i1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    roadGeo.addGroup(start, idx.length - start, m);
  }
  roadGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  roadGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  roadGeo.setIndex(idx);
  roadGeo.computeVertexNormals();
  const roadMats = surfaceList.map((sf) => {
    const wet = sf === 'mud' ? 0.45 : sf === 'snow' ? 0.6 : sf === 'tarmac' ? 0.75 : 1;
    return new THREE.MeshStandardMaterial({ map: surfaceTexture(sf, sc.verge), roughness: wet, metalness: 0 });
  });
  const road = new THREE.Mesh(roadGeo, roadMats);
  road.receiveShadow = true;

  // ---- Terrain grid ----
  const b = stage.bounds;
  const ox = b.minX - MARGIN, oz = b.minZ - MARGIN;
  const gcols = Math.ceil((b.maxX - b.minX + MARGIN * 2) / CELL) + 1;
  const grows = Math.ceil((b.maxZ - b.minZ + MARGIN * 2) / CELL) + 1;
  const heights = new Float32Array(gcols * grows);
  const dists = new Float32Array(gcols * grows);
  const rdists = new Float32Array(gcols * grows).fill(1e9);
  const noise = makeNoise(def.seed);
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
      const hills = (noise(x * 0.004, z * 0.004, 5) - 0.42) * sc.hills + (noise(x * 0.03 + 50, z * 0.03, 2) - 0.5) * 3;
      const t = Math.min(1, Math.max(0, (dist - hw - 2.5) / 34));
      const blend = t * t * (3 - 2 * t);
      let y = roadY - 0.18 + blend * hills;
      // shallow drainage ditch beside the road
      if (dist > hw + 1.5 && dist < hw + 6) y -= Math.sin(((dist - hw - 1.5) / 4.5) * Math.PI) * 0.45;

      // River channel: carved everywhere except right next to the road – apart
      // from under its own bridge, where the river flows beneath the deck.
      if (stage.rivers.length) {
        const rv = riverDistance(stage, x, z);
        rdists[r * gcols + c] = rv.dist;
        const river = rv.river;
        if (river && rv.dist < river.halfWidth + 12) {
          const bridge = stage.bridges[river.bridgeIndex];
          const underBridge = Math.abs(samples[best].d - bridge.distance) < bridge.length / 2 + 14;
          const roadGuard = underBridge ? 1 : Math.min(1, Math.max(0, (dist - hw - 4) / 8));
          const u = Math.min(1, Math.max(0, (rv.dist - river.halfWidth * 0.55) / (river.halfWidth * 0.45 + 12)));
          const bank = u * u * (3 - 2 * u);
          const carved = river.bedY + (Math.max(y, river.waterY + 0.6) - river.bedY) * bank;
          y = y + (Math.min(y, carved) - y) * roadGuard;
        }
      }
      heights[r * gcols + c] = y;
      dists[r * gcols + c] = dist;
    }
  }

  const tPos = new Float32Array(gcols * grows * 3);
  const tCol = new Float32Array(gcols * grows * 3);
  const grassA = new THREE.Color(sc.grassA), grassB = new THREE.Color(sc.grassB), patch = new THREE.Color(sc.patch), verge = new THREE.Color(sc.verge);
  const riverBank = new THREE.Color(0x4a4036);
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
      if (noise(x * 0.012 + 9, z * 0.012, 2) > 0.62) tmp.lerp(patch, 0.6);
      const d = dists[i];
      if (d < hw + 5) tmp.lerp(verge, 1 - Math.max(0, (d - hw) / 5));
      if (rdists[i] < 22) tmp.lerp(riverBank, Math.max(0, 1 - rdists[i] / 22) * 0.8);
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
  const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
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

  const heightAt = (x: number, z: number) => sampleGrid(heights, x, z);
  const data: TerrainData = {
    heightAt,
    roadDistanceAt: (x, z) => sampleGrid(dists, x, z),
    riverDistanceAt: (x, z) => (stage.rivers.length ? riverDistance(stage, x, z).dist : Infinity),
    waterAt: (x, z) => {
      if (!stage.rivers.length) return null;
      const rv = riverDistance(stage, x, z);
      if (!rv.river || rv.dist > rv.river.halfWidth + 6) return null;
      return heightAt(x, z) < rv.river.waterY ? rv.river : null;
    },
    origin: { x: ox, z: oz },
    cell: CELL,
    cols: gcols,
    rows: grows,
  };

  const water = stage.rivers.map((r) => buildWater(stage, r, data));

  return {
    road,
    terrain,
    water,
    data,
    roadCollider: { vertices: pos, indices: new Uint32Array(roadGeo.index!.array as ArrayLike<number>) },
    terrainCollider: { vertices: tPos, indices: new Uint32Array(colIdx) },
  };
}

function flowTexture(foam: boolean) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(foam ? 99 : 7);
  if (!foam) {
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, '#2e5560');
    grad.addColorStop(0.5, '#1d3d47');
    grad.addColorStop(1, '#2e5560');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 128);
  }
  // streaks of white water along the flow (x = downstream)
  for (let i = 0; i < (foam ? 160 : 260); i++) {
    const y = rnd() * 128;
    const edge = Math.min(y, 128 - y) / 64; // more foam at the banks
    const a = foam ? 0.15 + (1 - edge) * 0.55 * rnd() : 0.08 + rnd() * 0.12;
    g.strokeStyle = `rgba(235,245,250,${a})`;
    g.lineWidth = 0.6 + rnd() * (foam ? 2.5 : 1.4);
    const x = rnd() * 256, len = 10 + rnd() * 50;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + len / 2, y + (rnd() - 0.5) * 4, x + len, y + (rnd() - 0.5) * 3);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A fast-flowing river surface: scrolling water + foam layers and a little chop. */
function buildWater(stage: BuiltStage, river: River, terrain: TerrainData): WaterBody {
  const group = new THREE.Group();
  const hw = stage.def.roadWidth / 2;
  const bridge = stage.bridges[river.bridgeIndex];
  const pts = river.points;
  const width = river.halfWidth * 2 + 3;
  const across = 5; // vertices across the river
  // Keep only the stretch that isn't hidden under some other part of the road.
  const keep = pts.map((p) => {
    const nearBridge = Math.hypot(p.x - bridge.x, p.z - bridge.z) < 40;
    return nearBridge || terrain.roadDistanceAt(p.x, p.z) > hw + 5;
  });
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const chopRows: number[] = [];
  let along = 0;
  let base = -1;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[Math.min(pts.length - 1, i + 1)];
    const pr = pts[Math.max(0, i - 1)];
    const dx = q.x - pr.x, dz = q.z - pr.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    if (i > 0) along += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    if (!keep[i]) {
      base = -1;
      continue;
    }
    const row = positions.length / 3;
    for (let k = 0; k < across; k++) {
      const f = k / (across - 1) - 0.5;
      positions.push(p.x + nx * f * width, river.waterY, p.z + nz * f * width);
      uvs.push(along / 14, k / (across - 1));
      if (k > 0 && k < across - 1) chopRows.push(row + k);
    }
    if (base >= 0) {
      for (let k = 0; k < across - 1; k++) {
        const a = base + k, b = a + 1, c = row + k, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    base = row;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const waterTex = flowTexture(false);
  const foamTex = flowTexture(true);
  const waterMat = new THREE.MeshStandardMaterial({ map: waterTex, roughness: 0.15, metalness: 0.25, transparent: true, opacity: 0.92 });
  const foamMat = new THREE.MeshStandardMaterial({ map: foamTex, transparent: true, depthWrite: false, roughness: 0.4 });
  const water = new THREE.Mesh(geo, waterMat);
  const foam = new THREE.Mesh(geo, foamMat);
  foam.position.y = 0.06;
  group.add(water, foam);
  const basePos = Float32Array.from(positions);
  let t = 0;
  return {
    mesh: group,
    update(dt) {
      t += dt;
      // gushing: the water texture races downstream, the foam even faster
      waterTex.offset.x -= dt * 0.32;
      foamTex.offset.x -= dt * 0.55;
      foamTex.offset.y = Math.sin(t * 0.7) * 0.02;
      const p = geo.attributes.position as THREE.BufferAttribute;
      for (const v of chopRows) {
        const x = basePos[v * 3], z = basePos[v * 3 + 2];
        p.setY(v, river.waterY + Math.sin(x * 0.7 + t * 5) * 0.08 + Math.sin(z * 0.9 - t * 6.3) * 0.07);
      }
      p.needsUpdate = true;
    },
  };
}

export { SURFACES };
