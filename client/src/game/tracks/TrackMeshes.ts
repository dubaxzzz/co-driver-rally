import * as THREE from 'three';
import { SURFACES, riverDistance, sampleAt, type BuiltStage, type River, type SurfaceId } from '@cdr/shared';

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



export interface TerrainData {
  heightAt(x: number, z: number): number;
  roadDistanceAt(x: number, z: number): number;
  /** Distance to the nearest river centre line (Infinity if none). */
  riverDistanceAt(x: number, z: number): number;
  /** The river (and water height) if this point is in the water. */
  waterAt(x: number, z: number): River | null;
  /** The river here (if any): how far from its centre and which way it flows. */
  riverFlowAt(x: number, z: number): { river: River; dist: number; dirX: number; dirZ: number } | null;
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
  road: THREE.Group;
  terrain: THREE.Group;
  water: WaterBody[];
  data: TerrainData;
  roadCollider: { vertices: Float32Array; indices: Uint32Array };
  terrainCollider: { vertices: Float32Array; indices: Uint32Array };
}

/**
 * Road surface textures – kept gentle: a base colour, a light speckle and faint
 * tyre lines (plus edge lines on tarmac). No stones or patches.
 */
function surfaceTexture(surface: SurfaceId, tint: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const base: Record<SurfaceId, string> = {
    gravel: `#${new THREE.Color(tint).lerp(new THREE.Color(0xb5aa98), 0.25).getHexString()}`,
    tarmac: '#46484c',
    snow: '#e5eaee',
    mud: '#4f3d2b',
    sand: '#c9a46a',
    wood: '#6b4a2e',
  } as Record<SurfaceId, string>;
  g.fillStyle = base[surface] ?? base.gravel;
  g.fillRect(0, 0, 128, 128);
  // light speckle
  for (let i = 0; i < 900; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';
    g.fillRect(rnd() * 128, rnd() * 128, 1.5, 1.5);
  }
  // faint tyre lines where cars drive
  g.fillStyle = surface === 'snow' ? 'rgba(90,110,130,0.09)' : 'rgba(0,0,0,0.06)';
  for (const x of [36, 82]) g.fillRect(x, 0, 10, 128);
  if (surface === 'tarmac') {
    g.fillStyle = 'rgba(235,235,225,0.7)'; // edge lines
    g.fillRect(8, 0, 2.5, 128);
    g.fillRect(117.5, 0, 2.5, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** The terrain's grass colour at a point (noise-blended, with patches). */
function grassColour(sc: BuiltStage['def']['scenery'], noise: ReturnType<typeof makeNoise>) {
  const grassA = new THREE.Color(sc.grassA), grassB = new THREE.Color(sc.grassB), patch = new THREE.Color(sc.patch);
  const out = new THREE.Color();
  return (x: number, z: number) => {
    out.copy(grassA).lerp(grassB, noise(x * 0.05, z * 0.05, 3));
    if (noise(x * 0.012 + 9, z * 0.012, 2) > 0.62) out.lerp(patch, 0.6);
    return out;
  };
}

const MARGIN = 280;
const CELL = 5;
const VISIBLE_RADIUS = 300;
const COLLIDE_RADIUS = 75;
/** Terrain tile size in cells (tiles only exist near the road). */
const TILE = 32;

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
  const noise = makeNoise(def.seed);
  const grassAt = grassColour(sc, noise);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const lx = Math.cos(s.h), lz = -Math.sin(s.h); // left vector
    for (let j = 0; j < cols; j++) {
      const o = (i * cols + j) * 3;
      const off = -across[j]; // index 0 = left edge (offset along the left vector)
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
        // column 0 is the LEFT edge (offset along the left vector), so wind the
        // triangles this way round for them to face up (they were facing down
        // and got culled – the road was invisible from above)
        const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
        idx.push(a, b, c, b, d, c);
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
  // drawn in ~400 m chunks (sharing one vertex buffer) so the far road is culled
  const road = new THREE.Group();
  road.name = 'road';
  const CHUNK = 400;
  const tri = roadGeo.index!.array as ArrayLike<number>;
  for (let c0 = 0; c0 < n - 1; c0 += CHUNK) {
    const c1 = Math.min(n - 1, c0 + CHUNK);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', roadGeo.getAttribute('position'));
    geo.setAttribute('uv', roadGeo.getAttribute('uv'));
    geo.setAttribute('normal', roadGeo.getAttribute('normal'));
    const cidx: number[] = [];
    for (const g of roadGeo.groups) {
      const start = cidx.length;
      for (let k = g.start; k < g.start + g.count; k += 6) {
        const row = Math.floor(tri[k] / cols);
        if (row < c0 || row >= c1) continue;
        for (let q = 0; q < 6; q++) cidx.push(tri[k + q]);
      }
      if (cidx.length > start) geo.addGroup(start, cidx.length - start, g.materialIndex ?? 0);
    }
    if (!cidx.length) continue;
    geo.setIndex(cidx);
    const mid = samples[Math.floor((c0 + c1) / 2)];
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(mid.x, mid.y, mid.z), (c1 - c0) * stage.step * 0.6 + 20);
    const mesh = new THREE.Mesh(geo, roadMats);
    mesh.receiveShadow = true;
    road.add(mesh);
  }

  // ---- the short cuts / bypasses at the forks: their own ribbons ----
  const extraPos: number[] = [];
  const extraIdx: number[] = [];
  const baseVerts = pos.length / 3;
  for (const sp of stage.splits) {
    const bh = sp.width / 2;
    const acr = [-bh - 1.2, -bh, 0, bh, bh + 1.2];
    const cr = [-0.12, 0, 0.05, 0, -0.12];
    const bs = sp.samples;
    const bn = bs.length;
    const bpos = new Float32Array(bn * acr.length * 3);
    const buv = new Float32Array(bn * acr.length * 2);
    for (let i = 0; i < bn; i++) {
      const q = bs[i];
      const lx = Math.cos(q.h), lz = -Math.sin(q.h);
      for (let j = 0; j < acr.length; j++) {
        const o = (i * acr.length + j) * 3;
        const off = -acr[j];
        bpos[o] = q.x + lx * off;
        bpos[o + 1] = q.y + cr[j] + 0.03;
        bpos[o + 2] = q.z + lz * off;
        buv[(i * acr.length + j) * 2] = (acr[j] + bh + 1.2) / (2 * bh + 2.4);
        buv[(i * acr.length + j) * 2 + 1] = q.d / 7;
      }
    }
    const bidx: number[] = [];
    for (let i = 0; i < bn - 1; i++)
      for (let j = 0; j < acr.length - 1; j++) {
        const a = i * acr.length + j, b2 = a + 1, c = a + acr.length, d = c + 1;
        bidx.push(a, b2, c, b2, d, c);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(bpos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(buv, 2));
    g.setIndex(bidx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({ map: surfaceTexture(sp.surface, sc.verge), roughness: sp.surface === 'mud' ? 0.45 : 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.name = `split-${sp.index}`;
    road.add(mesh);
    const off = baseVerts + extraPos.length / 3;
    for (const v of bpos) extraPos.push(v);
    for (const k of bidx) extraIdx.push(k + off);
  }

  // ---- the pit apron at the service zone (long stages) ----
  const sv = stage.service;
  /** Where a point is relative to the pit apron (null when well away from it). */
  const pitLocal = (x: number, z: number) => {
    if (!sv) return null;
    const c = sampleAt(samples, sv.boxD);
    const along = (x - c.x) * Math.sin(c.h) + (z - c.z) * Math.cos(c.h);
    const out = ((x - c.x) * Math.cos(c.h) + (z - c.z) * -Math.sin(c.h)) * sv.side;
    const d = sv.boxD + along;
    const m = 6;
    if (d < sv.apronFrom - m || d > sv.apronTo + m || out < hw - 1 || out > sv.lat1 + m) return null;
    const edge = Math.min(1, (d - (sv.apronFrom - m)) / m, (sv.apronTo + m - d) / m, (sv.lat1 + m - out) / m);
    return { d, out, edge: Math.max(0, edge), roadY: sampleAt(samples, d).y };
  };
  if (sv) {
    const rows = Math.ceil((sv.apronTo - sv.apronFrom) / 4) + 1;
    const lats = [sv.lat0, (sv.lat0 + sv.lat1) / 2, sv.lat1];
    const ap = new Float32Array(rows * lats.length * 3);
    const auv = new Float32Array(rows * lats.length * 2);
    for (let r = 0; r < rows; r++) {
      const d = Math.min(sv.apronTo, sv.apronFrom + r * 4);
      const q = sampleAt(samples, d);
      const lx = Math.cos(q.h) * sv.side, lz = -Math.sin(q.h) * sv.side;
      lats.forEach((lat, j) => {
        const o = (r * lats.length + j) * 3;
        ap[o] = q.x + lx * lat;
        ap[o + 1] = q.y + 0.04;
        ap[o + 2] = q.z + lz * lat;
        auv[(r * lats.length + j) * 2] = (lat - sv.lat0) / (sv.lat1 - sv.lat0);
        auv[(r * lats.length + j) * 2 + 1] = (d - sv.apronFrom) / (sv.apronTo - sv.apronFrom);
      });
    }
    const aidx: number[] = [];
    for (let r = 0; r < rows - 1; r++)
      for (let j = 0; j < lats.length - 1; j++) {
        const a = r * lats.length + j, b2 = a + 1, c2 = a + lats.length, d2 = c2 + 1;
        // wound to face up on either side of the road
        if (sv.side < 0) aidx.push(a, b2, c2, b2, d2, c2);
        else aidx.push(a, c2, b2, b2, c2, d2);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(ap, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(auv, 2));
    g.setIndex(aidx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: pitTexture(sv), roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    mesh.receiveShadow = true;
    mesh.name = 'pit-apron';
    road.add(mesh);
    const off = baseVerts + extraPos.length / 3;
    for (const v of ap) extraPos.push(v);
    for (const k of aidx) extraIdx.push(k + off);
  }

  // the terrain follows the short cuts too
  const ts = stage.splits.length ? samples.concat(...stage.splits.map((sp) => sp.samples)) : samples;
  const tn = ts.length;
  // ---- Terrain: sparse tiles around the road ----
  // Only tiles near the road exist (a 30 km stage would otherwise need millions of
  // cells). Distance to the road is "splatted" from the centreline outwards.
  const b = stage.bounds;
  const ox = b.minX - MARGIN, oz = b.minZ - MARGIN;
  const gcols = Math.ceil((b.maxX - b.minX + MARGIN * 2) / CELL) + 1;
  const grows = Math.ceil((b.maxZ - b.minZ + MARGIN * 2) / CELL) + 1;
  const T = TILE;
  const tilesX = Math.ceil(gcols / T), tilesZ = Math.ceil(grows / T);
  type Tile = { tx: number; tz: number; heights: Float32Array; dists: Float32Array; rdists: Float32Array; best: Int32Array; d2b: Float32Array; best2: Int32Array; ry: Float32Array };
  const tiles: Array<Tile | null> = new Array(tilesX * tilesZ).fill(null);
  const reach = VISIBLE_RADIUS + 30;
  const tileM = T * CELL;
  for (let i = 0; i < tn; i += 20) {
    const sx = ts[i].x - ox, sz = ts[i].z - oz;
    const t0x = Math.max(0, Math.floor((sx - reach) / tileM)), t1x = Math.min(tilesX - 1, Math.floor((sx + reach) / tileM));
    const t0z = Math.max(0, Math.floor((sz - reach) / tileM)), t1z = Math.min(tilesZ - 1, Math.floor((sz + reach) / tileM));
    for (let tz = t0z; tz <= t1z; tz++)
      for (let tx = t0x; tx <= t1x; tx++) {
        const k = tz * tilesX + tx;
        if (!tiles[k]) tiles[k] = { tx, tz, heights: new Float32Array(T * T), dists: new Float32Array(T * T).fill(1e9), rdists: new Float32Array(T * T).fill(1e9), best: new Int32Array(T * T).fill(-1), d2b: new Float32Array(T * T).fill(1e9), best2: new Int32Array(T * T).fill(-1), ry: new Float32Array(T * T) };
      }
  }
  const tileOf = (c: number, r: number) => (c < 0 || r < 0 || c >= gcols || r >= grows ? null : tiles[Math.floor(r / T) * tilesX + Math.floor(c / T)]);
  const cellIdx = (c: number, r: number) => (r % T) * T + (c % T);
  // splat: every 4th sample claims the cells around it
  const coarseStep = 4;
  const rc = Math.ceil(reach / CELL);
  for (let i = 0; i < tn; i += coarseStep) {
    const sx = ts[i].x, sz = ts[i].z;
    const cc0 = Math.round((sx - ox) / CELL), rr0 = Math.round((sz - oz) / CELL);
    for (let r = Math.max(0, rr0 - rc); r <= Math.min(grows - 1, rr0 + rc); r++) {
      const dz = oz + r * CELL - sz;
      for (let c = Math.max(0, cc0 - rc); c <= Math.min(gcols - 1, cc0 + rc); c++) {
        const tl = tileOf(c, r);
        if (!tl) continue;
        const dx = ox + c * CELL - sx;
        const d2 = dx * dx + dz * dz;
        const ci = cellIdx(c, r);
        const bi = tl.best[ci];
        if (d2 < tl.dists[ci]) {
          // the old best is kept as "another part of the road" (e.g. the leg of a
          // switchback above/below) if it's far enough along the stage
          if (bi >= 0 && Math.abs(i - bi) > 60 && tl.dists[ci] < tl.d2b[ci]) {
            tl.d2b[ci] = tl.dists[ci];
            tl.best2[ci] = bi;
          }
          tl.dists[ci] = d2;
          tl.best[ci] = i;
        } else if (d2 < tl.d2b[ci] && bi >= 0 && Math.abs(i - bi) > 60) {
          tl.d2b[ci] = d2;
          tl.best2[ci] = i;
        }
      }
    }
  }
  const hillsAt = (x: number, z: number) => (noise(x * 0.004, z * 0.004, 5) - 0.42) * sc.hills + (noise(x * 0.03 + 50, z * 0.03, 2) - 0.5) * 3;
  let lowest = Infinity;
  for (const tl of tiles) {
    if (!tl) continue;
    for (let lr = 0; lr < T; lr++)
      for (let lc = 0; lc < T; lc++) {
        const c = tl.tx * T + lc, r = tl.tz * T + lr;
        const ci = lr * T + lc;
        const x = ox + c * CELL, z = oz + r * CELL;
        let best = tl.best[ci];
        let bestD2 = tl.dists[ci];
        if (best < 0) {
          // too far from the road for any sample to reach: plain hills at the nearest road height we know
          tl.dists[ci] = 1e4;
          tl.heights[ci] = NaN;
          continue;
        }
        // refine around the coarse match
        for (let j = Math.max(0, best - coarseStep); j <= Math.min(tn - 1, best + coarseStep); j++) {
          const dx = ts[j].x - x, dz = ts[j].z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; best = j; }
        }
        const dist = Math.sqrt(bestD2);
        const roadY = ts[best].y;
        const t = Math.min(1, Math.max(0, (dist - hw - 2.5) / 34));
        let blend = t * t * (3 - 2 * t);
        let baseY = roadY;
        // between two parts of the road (switchback legs): a smooth bank from one to the other
        const b2 = tl.best2[ci];
        if (b2 >= 0 && Math.abs(b2 - best) > 60) {
          let bestB = b2, d2B = Infinity;
          for (let j = Math.max(0, b2 - coarseStep); j <= Math.min(tn - 1, b2 + coarseStep); j++) {
            const dx = ts[j].x - x, dz = ts[j].z - z;
            const d2 = dx * dx + dz * dz;
            if (d2 < d2B) { d2B = d2; bestB = j; }
          }
          const distB = Math.sqrt(d2B);
          if (distB < 60) {
            const eA = Math.max(0, dist - hw - 2), eB = Math.max(0, distB - hw - 2);
            if (eA + eB > 0) baseY = (roadY * eB + ts[bestB].y * eA) / (eA + eB);
            blend *= Math.min(1, Math.max(0, (distB - 30) / 30)); // no hills squeezed in between
          }
        }
        let y = baseY - 0.18 + blend * hillsAt(x, z);
        // shallow drainage ditch beside the road
        if (dist > hw + 1.5 && dist < hw + 6) y -= Math.sin(((dist - hw - 1.5) / 4.5) * Math.PI) * 0.45;
        // the pit apron at the service zone: flat ground level with the road
        const pit = pitLocal(x, z);
        if (pit) {
          const k = pit.edge;
          y = y + (pit.roadY - 0.06 - y) * k;
        }
        // River channel: carved everywhere except right next to the road – apart
        // from under its own bridge, where the river flows beneath the deck.
        if (stage.rivers.length) {
          const rv = riverDistance(stage, x, z);
          tl.rdists[ci] = rv.dist;
          const river = rv.river;
          if (river && rv.dist < river.halfWidth + 12) {
            const bridge = stage.bridges[river.bridgeIndex];
            const underBridge = Math.abs(ts[best].d - bridge.distance) < bridge.length / 2 + 14;
            const roadGuard = underBridge ? 1 : Math.min(1, Math.max(0, (dist - hw - 4) / 8));
            const u = Math.min(1, Math.max(0, (rv.dist - river.halfWidth * 0.55) / (river.halfWidth * 0.45 + 12)));
            const bank = u * u * (3 - 2 * u);
            const carved = river.bedY + (Math.max(y, river.waterY + 0.6) - river.bedY) * bank;
            y = y + (Math.min(y, carved) - y) * roadGuard;
          }
        }
        tl.heights[ci] = y;
        tl.ry[ci] = roadY;
        tl.dists[ci] = pit && pit.edge > 0.5 ? Math.min(dist, hw) : dist;
        lowest = Math.min(lowest, y);
      }
  }
  // cells no sample reached: copy a neighbour's height so there are no holes at the edge
  for (const tl of tiles) {
    if (!tl) continue;
    for (let ci = 0; ci < T * T; ci++) if (Number.isNaN(tl.heights[ci])) tl.heights[ci] = lowest;
  }
  // mountain stages: relax the slopes between stacked roads (no cliffs or spikes),
  // leaving the road and its verges exactly where they are
  if (def.flatBase) {
    const list = tiles.filter((t): t is Tile => !!t);
    for (let it = 0; it < 6; it++) {
      for (const tl of list) {
        const next = new Float32Array(tl.heights);
        for (let lr = 0; lr < T; lr++)
          for (let lc = 0; lc < T; lc++) {
            const ci = lr * T + lc;
            if (tl.dists[ci] < hw + 3.5 || tl.rdists[ci] < 25) continue;
            const c = tl.tx * T + lc, r = tl.tz * T + lr;
            let sum = 0, cnt = 0;
            for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nt = tileOf(c + dc, r + dr);
              if (!nt) continue;
              sum += nt.heights[cellIdx(c + dc, r + dr)];
              cnt++;
            }
            if (cnt) next[ci] = tl.heights[ci] * 0.2 + (sum / cnt) * 0.8;
          }
        tl.heights.set(next);
      }
    }
  }
  // The ground must never come up over the road: next to the road (anywhere a
  // terrain triangle could reach across it) it stays just below the road surface.
  {
    const reachRoad = hw + 1.4 + CELL * 1.5;
    for (const tl of tiles) {
      if (!tl) continue;
      for (let ci = 0; ci < T * T; ci++) {
        if (tl.dists[ci] < reachRoad && tl.best[ci] >= 0) tl.heights[ci] = Math.min(tl.heights[ci], tl.ry[ci] - 0.22);
      }
    }
  }
  const get = (arr: 'heights' | 'dists' | 'rdists', c: number, r: number, fallback: number) => {
    const tl = tileOf(c, r);
    return tl ? tl[arr][cellIdx(c, r)] : fallback;
  };

  // one mesh per tile: far tiles are culled, and the GPU only draws what's near
  const riverBank = new THREE.Color(0x4a4036);
  const verge = new THREE.Color(sc.verge);
  const tmp = new THREE.Color();
  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const snowWhite = new THREE.Color(0xe9eef2);
  // big mountains: the top fifth is under snow
  const snowLineY = b.maxY - Math.max(150, (b.maxY - b.minY) * 0.2);
  const terrain = new THREE.Group();
  terrain.name = 'terrain';
  const colPos: number[] = [];
  const colIdx: number[] = [];
  for (const tl of tiles) {
    if (!tl) continue;
    const V = T + 1;
    const c0 = tl.tx * T, r0 = tl.tz * T;
    const tPos = new Float32Array(V * V * 3);
    const tCol = new Float32Array(V * V * 3);
    const tDist = new Float32Array(V * V);
    const exists = new Uint8Array(V * V);
    for (let lr = 0; lr < V; lr++)
      for (let lc = 0; lc < V; lc++) {
        const c = c0 + lc, r = r0 + lr;
        const i = lr * V + lc;
        const x = ox + c * CELL, z = oz + r * CELL;
        const nt = tileOf(c, r);
        exists[i] = nt ? 1 : 0;
        const y = nt ? nt.heights[cellIdx(c, r)] : lowest;
        const d = nt ? nt.dists[cellIdx(c, r)] : 1e4;
        const rd = nt ? nt.rdists[cellIdx(c, r)] : 1e9;
        tDist[i] = d;
        tPos[i * 3] = x;
        tPos[i * 3 + 1] = y;
        tPos[i * 3 + 2] = z;
        tmp.copy(grassAt(x, z));
        // a dusty verge either side of the road, fading into the grass
        if (d < hw + 5) tmp.lerp(verge, (1 - Math.max(0, (d - hw) / 5)) * 0.55);
        if (rd < 22) tmp.lerp(riverBank, Math.max(0, 1 - rd / 22) * 0.8);
        // mountain stages: snow on the high ground
        if (def.flatBase && y > snowLineY) tmp.lerp(snowWhite, Math.min(0.92, (y - snowLineY) / 120));
        tCol[i * 3] = tmp.r;
        tCol[i * 3 + 1] = tmp.g;
        tCol[i * 3 + 2] = tmp.b;
      }
    const visIdx: number[] = [];
    const base = colPos.length / 3;
    const colMap = new Int32Array(V * V).fill(-1);
    const colVert = (i: number) => {
      if (colMap[i] < 0) {
        colMap[i] = colPos.length / 3 - base;
        colPos.push(tPos[i * 3], tPos[i * 3 + 1], tPos[i * 3 + 2]);
      }
      return base + colMap[i];
    };
    for (let lr = 0; lr < T; lr++)
      for (let lc = 0; lc < T; lc++) {
        const a = lr * V + lc, bb = a + 1, cc = a + V, d = cc + 1;
        if (!exists[a] || !exists[bb] || !exists[cc] || !exists[d]) continue;
        const minDist = Math.min(tDist[a], tDist[bb], tDist[cc], tDist[d]);
        if (minDist > VISIBLE_RADIUS) continue;
        visIdx.push(a, cc, bb, bb, cc, d);
        if (minDist < COLLIDE_RADIUS) {
          const A = colVert(a), B = colVert(bb), C = colVert(cc), D = colVert(d);
          colIdx.push(A, C, B, B, C, D);
        }
      }
    if (!visIdx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(tCol, 3));
    geo.setIndex(visIdx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, terrainMat);
    mesh.receiveShadow = true;
    terrain.add(mesh);
  }

  const sampleGrid = (arr: 'heights' | 'dists', x: number, z: number, fallback: number) => {
    const fx = Math.min(gcols - 1.001, Math.max(0, (x - ox) / CELL));
    const fz = Math.min(grows - 1.001, Math.max(0, (z - oz) / CELL));
    const c = Math.floor(fx), r = Math.floor(fz);
    const u = fx - c, v = fz - r;
    const g00 = get(arr, c, r, fallback), g10 = get(arr, c + 1, r, fallback), g01 = get(arr, c, r + 1, fallback);
    // match the triangle split used by the mesh (a, cc, bb) / (bb, cc, d)
    if (u + v <= 1) return g00 + (g10 - g00) * u + (g01 - g00) * v;
    const g11 = get(arr, c + 1, r + 1, fallback);
    return g11 + (g01 - g11) * (1 - u) + (g10 - g11) * (1 - v);
  };

  const heightAt = (x: number, z: number) => sampleGrid('heights', x, z, lowest);
  // rock on the steep banks (mountain faces between switchbacks)
  const rockCol = new THREE.Color(sc.rock);
  for (const m of terrain.children) {
    const g = (m as THREE.Mesh).geometry;
    const nrm = g.getAttribute('normal');
    const col = g.getAttribute('color');
    for (let i = 0; i < nrm.count; i++) {
      const ny = nrm.getY(i);
      if (ny > 0.8) continue;
      const k = Math.min(1, (0.8 - ny) / 0.25);
      tmp.setRGB(col.getX(i), col.getY(i), col.getZ(i)).lerp(rockCol, k * 0.85);
      col.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
  }

  // ---- Far landscape: a coarse skirt of hills and mountains out to the horizon ----
  // It sits just under the detailed tiles and fills everything beyond them, so from
  // high on a mountain you look out over valleys instead of into the void.
  {
    const FC = 80;
    const fm = 2400;
    const fox = b.minX - fm, foz = b.minZ - fm;
    const fcols = Math.ceil((b.maxX - b.minX + fm * 2) / FC) + 1;
    const frows = Math.ceil((b.maxZ - b.minZ + fm * 2) / FC) + 1;
    const fd = new Float32Array(fcols * frows).fill(1e12);
    const fy = new Float32Array(fcols * frows);
    const R = Math.ceil(fm / FC);
    for (let i = 0; i < n; i += 30) {
      const c0 = Math.round((samples[i].x - fox) / FC), r0 = Math.round((samples[i].z - foz) / FC);
      for (let r = Math.max(0, r0 - R); r <= Math.min(frows - 1, r0 + R); r++)
        for (let c = Math.max(0, c0 - R); c <= Math.min(fcols - 1, c0 + R); c++) {
          const dx = fox + c * FC - samples[i].x, dz = foz + r * FC - samples[i].z;
          const d2 = dx * dx + dz * dz;
          const k = r * fcols + c;
          if (d2 < fd[k]) {
            fd[k] = d2;
            fy[k] = samples[i].y;
          }
        }
    }
    const big = def.flatBase ? Math.max(520, (b.maxY - b.minY) * 0.45) : Math.max(60, sc.hills * 3);
    const snowLine = snowLineY;
    const fPos = new Float32Array(fcols * frows * 3);
    const fCol = new Float32Array(fcols * frows * 3);
    const snowC = new THREE.Color(0xeef2f5);
    for (let r = 0; r < frows; r++)
      for (let c = 0; c < fcols; c++) {
        const k = r * fcols + c;
        const x = fox + c * FC, z = foz + r * FC;
        const dist = Math.sqrt(fd[k]);
        const ramp = Math.min(1, Math.max(0, (dist - 260) / 900));
        const mountains = (noise(x * 0.0011 + 7, z * 0.0011, 4) - 0.42) * big * ramp * ramp;
        let y = (dist > 1e5 ? b.minY : fy[k]) - 6 + hillsAt(x, z) + mountains;
        if (dist < VISIBLE_RADIUS + 10) y = heightAt(x, z) - 3; // just under the detailed tiles
        // its big triangles must never reach up over the road either
        if (dist < FC * 2.3 && dist < 1e5) y = Math.min(y, fy[k] - 4);
        fPos[k * 3] = x;
        fPos[k * 3 + 1] = y;
        fPos[k * 3 + 2] = z;
        tmp.copy(grassAt(x, z)).lerp(rockCol, Math.min(0.8, Math.max(0, mountains / big) * 1.6));
        if (def.flatBase && y > snowLine) tmp.lerp(snowC, Math.min(1, (y - snowLine) / 80));
        fCol[k * 3] = tmp.r;
        fCol[k * 3 + 1] = tmp.g;
        fCol[k * 3 + 2] = tmp.b;
      }
    const fIdx: number[] = [];
    for (let r = 0; r < frows - 1; r++)
      for (let c = 0; c < fcols - 1; c++) {
        const a = r * fcols + c, bb = a + 1, cc = a + fcols, d = cc + 1;
        fIdx.push(a, cc, bb, bb, cc, d);
      }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
    fg.setAttribute('color', new THREE.BufferAttribute(fCol, 3));
    fg.setIndex(fIdx);
    fg.computeVertexNormals();
    fg.computeBoundingSphere();
    fg.boundingSphere!.radius = 1e7; // never distance-culled
    const farMesh = new THREE.Mesh(fg, terrainMat);
    farMesh.name = 'far-land';
    terrain.add(farMesh);
  }

  const data: TerrainData = {
    heightAt,
    roadDistanceAt: (x, z) => sampleGrid('dists', x, z, 1e4),
    riverDistanceAt: (x, z) => (stage.rivers.length ? riverDistance(stage, x, z).dist : Infinity),
    waterAt: (x, z) => {
      if (!stage.rivers.length) return null;
      const rv = riverDistance(stage, x, z);
      if (!rv.river || rv.dist > rv.river.halfWidth + 6) return null;
      return heightAt(x, z) < rv.river.waterY ? rv.river : null;
    },
    riverFlowAt: (x, z) => {
      if (!stage.rivers.length) return null;
      const rv = riverDistance(stage, x, z);
      if (!rv.river || rv.dist > rv.river.halfWidth + 3) return null;
      return { river: rv.river, dist: rv.dist, dirX: rv.dirX, dirZ: rv.dirZ };
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
    roadCollider: extraPos.length
      ? (() => {
          const v = new Float32Array(pos.length + extraPos.length);
          v.set(pos);
          v.set(extraPos, pos.length);
          const mainIdx = roadGeo.index!.array as ArrayLike<number>;
          const ix = new Uint32Array(mainIdx.length + extraIdx.length);
          ix.set(mainIdx);
          ix.set(extraIdx, mainIdx.length);
          return { vertices: v, indices: ix };
        })()
      : { vertices: pos, indices: new Uint32Array(roadGeo.index!.array as ArrayLike<number>) },
    terrainCollider: { vertices: new Float32Array(colPos), indices: new Uint32Array(colIdx) },
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

/**
 * The road breaks up as cars go over it: the first car sweeps the loose gravel
 * off the line, later cars dig ruts, and rain makes it far worse. Kept in 10 m
 * cells along the stage; drawn as dark wheel tracks that deepen as it wears.
 */
export class RoadWear {
  static readonly CELL = 10;
  readonly wear: Float32Array;
  readonly mesh: THREE.Mesh;
  private colors: Float32Array;
  private dirty = false;
  private lastPass = new Map<string, number>();
  private readonly soft: boolean;
  private readonly rowStep = 5;

  private drawn = false;
  private dirtyFrom = Infinity;
  private dirtyTo = -Infinity;
  constructor(stage: BuiltStage) {
    const n = Math.ceil(stage.length / RoadWear.CELL) + 1;
    this.wear = new Float32Array(n);
    this.soft = stage.def.surface !== 'tarmac';
    // two wheel tracks either side of the centre line
    const samples = stage.samples;
    const tracks = [-1.15, -0.55, 0.55, 1.15];
    const rows = Math.floor(stage.length / this.rowStep);
    const pos = new Float32Array(rows * tracks.length * 3);
    this.colors = new Float32Array(rows * tracks.length * 4);
    const idx: number[] = [];
    for (let r = 0; r < rows; r++) {
      const s = sampleAt(samples, r * this.rowStep);
      const lx = Math.cos(s.h), lz = -Math.sin(s.h);
      tracks.forEach((off, j) => {
        const o = (r * tracks.length + j) * 3;
        pos[o] = s.x + lx * off;
        pos[o + 1] = s.y + 0.095; // just above the crown
        pos[o + 2] = s.z + lz * off;
      });
      if (r < rows - 1) {
        const a = r * 4;
        for (const [j0, j1] of [[0, 1], [2, 3]]) {
          const p = a + j0, q = a + j1, p2 = p + 4, q2 = q + 4;
          idx.push(p, p2, q, q, p2, q2);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const col = stage.def.surface === 'snow' ? 0x8f9aa6 : stage.def.surface === 'tarmac' ? 0x4a4036 : 0x3b2c1f;
    const mat = new THREE.MeshStandardMaterial({ color: col, vertexColors: true, transparent: true, depthWrite: false, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'road-wear';
    this.mesh.renderOrder = 1;
    this.refresh();
  }

  at(d: number) {
    return this.wear[Math.max(0, Math.min(this.wear.length - 1, Math.floor(d / RoadWear.CELL)))];
  }

  /** A car (id) is at distance d: wears every cell it has crossed since last time. */
  pass(id: string, d: number, wet: number) {
    const last = this.lastPass.get(id);
    this.lastPass.set(id, d);
    if (last === undefined || d <= last || d - last > 200) return;
    const c0 = Math.floor(last / RoadWear.CELL), c1 = Math.floor(d / RoadWear.CELL);
    const add = (this.soft ? 0.11 : 0.04) * (1 + wet * 1.6);
    for (let c = c0 + 1; c <= c1 && c < this.wear.length; c++) this.wear[c] = Math.min(1, this.wear[c] + add);
    if (c1 > c0) {
      this.dirty = true;
      this.dirtyFrom = Math.min(this.dirtyFrom, (c0 + 1) * RoadWear.CELL);
      this.dirtyTo = Math.max(this.dirtyTo, (c1 + 1) * RoadWear.CELL);
    }
  }

  /** New run: cars' last positions are forgotten (the ruts stay). */
  newRun() {
    this.lastPass.clear();
  }

  /** Grip multiplier on the road here (first car on loose gravel; deep ruts later). */
  grip(d: number) {
    const w = this.at(d);
    if (!this.soft) return 1 - 0.03 * w;
    if (w < 0.08) return 0.955; // loose gravel on top: the first car sweeps it
    if (w < 0.5) return 0.97 + 0.06 * Math.min(1, (w - 0.08) / 0.32); // a clean, swept line
    return 1.03 - 0.22 * (w - 0.5); // deep ruts
  }

  /** 0..1 how rough the road is here (ruts kick the car about). */
  rough(d: number) {
    return this.soft ? Math.max(0, (this.at(d) - 0.45) / 0.55) : 0;
  }

  /** Redraw the ruts if anything changed (call about once a second). */
  refresh() {
    if (!this.dirty && this.drawn) return;
    const rows = this.colors.length / 16;
    // only the rows that changed (a whole 30 km stage is a lot to re-upload every second)
    const r0 = this.drawn ? Math.max(0, Math.floor(this.dirtyFrom / this.rowStep) - 1) : 0;
    const r1 = this.drawn ? Math.min(rows, Math.ceil(this.dirtyTo / this.rowStep) + 1) : rows;
    this.dirty = false;
    this.drawn = true;
    this.dirtyFrom = Infinity;
    this.dirtyTo = -Infinity;
    for (let r = r0; r < r1; r++) {
      const w = this.at(r * this.rowStep);
      const a = Math.min(0.75, w * 0.85);
      for (let j = 0; j < 4; j++) {
        const o = (r * 4 + j) * 4;
        this.colors[o] = this.colors[o + 1] = this.colors[o + 2] = 1;
        this.colors[o + 3] = a;
      }
    }
    const attr = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    attr.clearUpdateRanges();
    attr.addUpdateRange(r0 * 16, Math.max(0, r1 - r0) * 16);
    attr.needsUpdate = true;
  }
}

/** Concrete pit apron with the yellow pit box painted on it. */
function pitTexture(sv: NonNullable<BuiltStage['service']>) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 1024;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8d8e8c';
  g.fillRect(0, 0, 256, 1024);
  const rnd = mulberry32(5);
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)';
    g.fillRect(rnd() * 256, rnd() * 1024, 2, 2);
  }
  // expansion joints
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 2;
  for (let y = 0; y < 1024; y += 64) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(256, y);
    g.stroke();
  }
  const W = sv.lat1 - sv.lat0, L = sv.apronTo - sv.apronFrom;
  const u = (lat: number) => ((lat - sv.lat0) / W) * 256;
  const v = (d: number) => (1 - (d - sv.apronFrom) / L) * 1024; // canvas y runs the other way
  // the box
  const x0 = u(sv.boxLat - sv.boxWid / 2), x1 = u(sv.boxLat + sv.boxWid / 2);
  const y0 = v(sv.boxD + sv.boxLen / 2), y1 = v(sv.boxD - sv.boxLen / 2);
  g.fillStyle = 'rgba(255,196,0,0.18)';
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.strokeStyle = '#ffc400';
  g.lineWidth = 6;
  g.strokeRect(x0, y0, x1 - x0, y1 - y0);
  g.save();
  g.translate((x0 + x1) / 2, (y0 + y1) / 2);
  g.rotate(Math.PI / 2);
  g.fillStyle = '#ffc400';
  g.font = 'bold 34px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('PIT', 0, 0);
  g.restore();
  // white line along the road edge with a gap at the way in and out
  g.fillStyle = '#f2f2f2';
  g.fillRect(0, v(sv.apronTo - 18), 6, v(sv.apronFrom + 18) - v(sv.apronTo - 18));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
