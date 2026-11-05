import * as THREE from 'three';
import { sampleAt, type BuiltStage } from '@cdr/shared';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { mulberry32, type TerrainData } from '../tracks/TrackMeshes';

function bannerTexture(text: string, bg: string, fg = '#ffffff', checker = false) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 1024, 128);
  if (checker) {
    for (let x = 0; x < 1024; x += 32) for (let y = 0; y < 128; y += 32) if (((x + y) / 32) % 2 === 0) { g.fillStyle = '#111'; g.fillRect(x, y, 32, 32); }
    g.fillStyle = 'rgba(0,0,0,0.75)';
    g.fillRect(260, 14, 504, 100);
  }
  g.fillStyle = fg;
  g.font = 'italic 900 84px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 512, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function chevronTexture(dir: 'L' | 'R', color: string) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#111';
  for (let i = 0; i < 3; i++) {
    const x = 40 + i * 70;
    g.beginPath();
    if (dir === 'R') {
      g.moveTo(x, 18); g.lineTo(x + 40, 64); g.lineTo(x, 110); g.lineTo(x + 20, 110); g.lineTo(x + 60, 64); g.lineTo(x + 20, 18);
    } else {
      g.moveTo(x + 60, 18); g.lineTo(x + 20, 64); g.lineTo(x + 60, 110); g.lineTo(x + 40, 110); g.lineTo(x, 64); g.lineTo(x + 40, 18);
    }
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Trees, rocks, grass, barriers, signs, checkpoint gates and the
 * start/finish gantries. Uses instancing to stay fast.
 */
export class Scenery {
  readonly group = new THREE.Group();
  private disposables: Array<{ dispose(): void }> = [];
  /** Checkpoint gate banner materials so they can be recoloured when passed. */
  readonly checkpointMats: THREE.MeshStandardMaterial[] = [];

  constructor(
    private stage: BuiltStage,
    private terrain: TerrainData,
    private physics: PhysicsWorld,
    quality: 'high' | 'low',
  ) {
    const rand = mulberry32(stage.def.seed + 7);
    this.buildTrees(rand, quality === 'high' ? 4200 : 1500);
    this.buildRocks(rand, quality === 'high' ? 500 : 220);
    if (quality === 'high') this.buildGrass(rand, 5000);
    this.buildBarriersAndSigns();
    this.buildGates();
  }

  private track<T extends { dispose(): void }>(o: T) {
    this.disposables.push(o);
    return o;
  }

  private randomPointNearRoad(rand: () => number, minD: number, maxD: number) {
    const s = this.stage;
    for (let tries = 0; tries < 30; tries++) {
      const d = rand() * s.length;
      const c = sampleAt(s.samples, d);
      const side = rand() < 0.5 ? -1 : 1;
      // bias toward the road for denser roadside forest
      const off = minD + Math.pow(rand(), 1.6) * (maxD - minD);
      const lx = Math.cos(c.h), lz = -Math.sin(c.h);
      const x = c.x + lx * off * side + (rand() - 0.5) * 6;
      const z = c.z + lz * off * side + (rand() - 0.5) * 6;
      const rd = this.terrain.roadDistanceAt(x, z);
      if (rd < minD) continue;
      return { x, z, y: this.terrain.heightAt(x, z), rd };
    }
    return null;
  }

  private buildTrees(rand: () => number, count: number) {
    const trunkGeo = this.track(new THREE.CylinderGeometry(0.18, 0.3, 3, 6));
    trunkGeo.translate(0, 1.5, 0);
    const foliage = [
      new THREE.ConeGeometry(2.4, 5, 7).translate(0, 4.2, 0),
      new THREE.ConeGeometry(1.9, 4.2, 7).translate(0, 6.6, 0),
      new THREE.ConeGeometry(1.3, 3.4, 7).translate(0, 8.8, 0),
    ];
    const merged = mergeGeometries(foliage);
    foliage.forEach((g) => g.dispose());
    this.track(merged);
    const trunkMat = this.track(new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 }));
    const leafMat = this.track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }));
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const leaves = new THREE.InstancedMesh(merged, leafMat, count);
    trunks.castShadow = leaves.castShadow = true;
    leaves.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    const R = this.physics.R;
    let placed = 0;
    let colliders = 0;
    for (let i = 0; i < count; i++) {
      const p = this.randomPointNearRoad(rand, this.stage.def.roadWidth / 2 + 5, 240);
      if (!p) continue;
      const s = 0.75 + rand() * 0.75;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
      m.compose(new THREE.Vector3(p.x, p.y - 0.2, p.z), q, new THREE.Vector3(s, s * (0.85 + rand() * 0.4), s));
      trunks.setMatrixAt(placed, m);
      leaves.setMatrixAt(placed, m);
      col.setHSL(0.27 + rand() * 0.08, 0.35 + rand() * 0.2, 0.17 + rand() * 0.1);
      leaves.setColorAt(placed, col);
      placed++;
      if (p.rd < 26 && colliders < 900) {
        colliders++;
        const body = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(p.x, p.y + 2, p.z));
        this.physics.world.createCollider(R.ColliderDesc.cylinder(2, 0.32 * s).setFriction(0.6), body);
      }
    }
    trunks.count = leaves.count = placed;
    trunks.instanceMatrix.needsUpdate = leaves.instanceMatrix.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    this.group.add(trunks, leaves);
  }

  private buildRocks(rand: () => number, count: number) {
    const geo = this.track(new THREE.DodecahedronGeometry(1, 0));
    const mat = this.track(new THREE.MeshStandardMaterial({ color: 0x7a7b78, roughness: 1, flatShading: true }));
    const rocks = new THREE.InstancedMesh(geo, mat, count + 40);
    rocks.castShadow = rocks.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const R = this.physics.R;
    let placed = 0;
    const place = (x: number, y: number, z: number, s: number, collide: boolean) => {
      q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s * 0.6, s * (0.8 + rand() * 0.4)));
      rocks.setMatrixAt(placed++, m);
      if (collide) {
        const body = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, y, z));
        this.physics.world.createCollider(R.ColliderDesc.ball(s * 0.7).setFriction(0.7), body);
      }
    };
    for (let i = 0; i < count; i++) {
      const p = this.randomPointNearRoad(rand, this.stage.def.roadWidth / 2 + 3, 90);
      if (!p) continue;
      const s = 0.3 + rand() * rand() * 1.8;
      place(p.x, p.y + s * 0.15, p.z, s, p.rd < 14 && s > 0.5);
    }
    // Hazard: rocks on the inside of the "rocks" corner
    for (const note of this.stage.paceNotes) {
      if (note.hazard !== 'rocks') continue;
      for (let k = 0; k < 16 && placed < rocks.count; k++) {
        const c = sampleAt(this.stage.samples, note.distance + rand() * note.length);
        const side = note.dir === 'L' ? 1 : -1;
        const off = this.stage.def.roadWidth / 2 + 0.6 + rand() * 1.8;
        const x = c.x + Math.cos(c.h) * off * side, z = c.z - Math.sin(c.h) * off * side;
        const s = 0.35 + rand() * 0.5;
        place(x, this.terrain.heightAt(x, z) + s * 0.2, z, s, true);
      }
    }
    rocks.count = placed;
    rocks.instanceMatrix.needsUpdate = true;
    this.group.add(rocks);
  }

  private buildGrass(rand: () => number, count: number) {
    const geo = this.track(new THREE.ConeGeometry(0.25, 0.7, 4));
    geo.translate(0, 0.3, 0);
    const mat = this.track(new THREE.MeshStandardMaterial({ color: 0x6f8a3a, roughness: 1 }));
    const grass = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const p = this.randomPointNearRoad(rand, this.stage.def.roadWidth / 2 + 1.6, 40);
      if (!p) continue;
      const s = 0.6 + rand() * 0.9;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 6);
      m.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(s, s, s));
      grass.setMatrixAt(placed++, m);
    }
    grass.count = placed;
    this.group.add(grass);
  }

  private buildBarriersAndSigns() {
    const st = this.stage;
    const hw = st.def.roadWidth / 2;
    const R = this.physics.R;
    const postGeo = this.track(new THREE.BoxGeometry(0.14, 1.0, 0.14));
    const railGeo = this.track(new THREE.BoxGeometry(0.08, 0.28, 1));
    const postMat = this.track(new THREE.MeshStandardMaterial({ color: 0x6b4b2e, roughness: 1 }));
    const railMat = this.track(new THREE.MeshStandardMaterial({ color: 0xd9d9d9, roughness: 0.6, metalness: 0.3 }));
    const posts: THREE.Matrix4[] = [];
    const rails: THREE.Matrix4[] = [];
    const signs = new THREE.Group();
    const signMats = {
      L: this.track(new THREE.MeshStandardMaterial({ map: this.track(chevronTexture('L', '#ffd21f')), roughness: 0.6 })),
      R: this.track(new THREE.MeshStandardMaterial({ map: this.track(chevronTexture('R', '#ffd21f')), roughness: 0.6 })),
    };
    const signGeo = this.track(new THREE.PlaneGeometry(1.6, 0.8));
    const signPostGeo = this.track(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6));
    const greyMat = this.track(new THREE.MeshStandardMaterial({ color: 0x555555 }));
    const up = new THREE.Vector3(0, 1, 0);

    for (const note of st.paceNotes) {
      if (note.kind !== 'corner' || !note.dir) continue;
      const tight = note.severity === 'H' || (typeof note.severity === 'number' && note.severity <= 3);
      // outside of the corner: right corner -> left side (+1), left corner -> right side (-1)
      const side = note.dir === 'R' ? 1 : -1;
      if (tight) {
        const from = note.distance - 10, to = note.distance + note.length + 10;
        let prev: THREE.Vector3 | null = null;
        for (let d = from; d <= to; d += 4) {
          const c = sampleAt(st.samples, d);
          const off = hw + 2.6;
          const x = c.x + Math.cos(c.h) * off * side, z = c.z - Math.sin(c.h) * off * side;
          const y = this.terrain.heightAt(x, z);
          const pt = new THREE.Vector3(x, y, z);
          posts.push(new THREE.Matrix4().makeTranslation(x, y + 0.4, z));
          if (prev) {
            const mid = prev.clone().add(pt).multiplyScalar(0.5);
            const len = prev.distanceTo(pt);
            const yaw = Math.atan2(pt.x - prev.x, pt.z - prev.z);
            const q = new THREE.Quaternion().setFromAxisAngle(up, yaw);
            rails.push(new THREE.Matrix4().compose(mid.clone().setY(mid.y + 0.7), q, new THREE.Vector3(1, 1, len)));
            const body = this.physics.world.createRigidBody(
              R.RigidBodyDesc.fixed().setTranslation(mid.x, mid.y + 0.55, mid.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
            );
            this.physics.world.createCollider(R.ColliderDesc.cuboid(0.12, 0.6, len / 2).setFriction(0.3).setRestitution(0.2), body);
          }
          prev = pt;
        }
      }
      // Chevron sign at corner entry, facing oncoming traffic
      if (tight || note.severity === 4) {
        const c = sampleAt(st.samples, note.distance + Math.min(8, note.length * 0.3));
        const off = hw + 3.4;
        const x = c.x + Math.cos(c.h) * off * side, z = c.z - Math.sin(c.h) * off * side;
        const y = this.terrain.heightAt(x, z);
        const sign = new THREE.Mesh(signGeo, signMats[note.dir]);
        sign.position.set(x, y + 1.6, z);
        sign.rotation.y = c.h + Math.PI; // face the approaching car
        sign.castShadow = true;
        const post = new THREE.Mesh(signPostGeo, greyMat);
        post.position.set(x, y + 0.8, z);
        signs.add(sign, post);
      }
    }
    const postMesh = new THREE.InstancedMesh(postGeo, postMat, Math.max(1, posts.length));
    posts.forEach((m, i) => postMesh.setMatrixAt(i, m));
    postMesh.count = posts.length;
    const railMesh = new THREE.InstancedMesh(railGeo, railMat, Math.max(1, rails.length));
    rails.forEach((m, i) => railMesh.setMatrixAt(i, m));
    railMesh.count = rails.length;
    postMesh.castShadow = railMesh.castShadow = true;
    this.group.add(postMesh, railMesh, signs);
  }

  private gate(distance: number, text: string, color: string, checker = false) {
    const st = this.stage;
    const c = sampleAt(st.samples, distance);
    const hw = st.def.roadWidth / 2 + 1.6;
    const g = new THREE.Group();
    const postMat = this.track(new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.4, roughness: 0.5 }));
    const postGeo = this.track(new THREE.BoxGeometry(0.4, 6, 0.4));
    const R = this.physics.R;
    for (const side of [-1, 1]) {
      const x = c.x + Math.cos(c.h) * hw * side, z = c.z - Math.sin(c.h) * hw * side;
      const y = this.terrain.heightAt(x, z);
      const p = new THREE.Mesh(postGeo, postMat);
      p.position.set(x, y + 3, z);
      p.castShadow = true;
      g.add(p);
      const body = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, y + 3, z));
      this.physics.world.createCollider(R.ColliderDesc.cuboid(0.2, 3, 0.2), body);
    }
    const tex = this.track(bannerTexture(text, color, '#ffffff', checker));
    const mat = this.track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, side: THREE.DoubleSide }));
    const banner = new THREE.Mesh(this.track(new THREE.BoxGeometry(hw * 2 + 0.4, 1.2, 0.2)), mat);
    banner.position.set(c.x, c.y + 5.6, c.z);
    banner.rotation.y = c.h;
    banner.castShadow = true;
    g.add(banner);
    // painted line across the road
    const line = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(st.def.roadWidth, 0.6)),
      this.track(new THREE.MeshStandardMaterial({ color: checker ? 0xffffff : 0xeeeeee, roughness: 0.8 })),
    );
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = c.h;
    line.position.set(c.x, c.y + 0.1, c.z);
    line.receiveShadow = true;
    g.add(line);
    this.group.add(g);
    return mat;
  }

  private buildGates() {
    const st = this.stage;
    this.gate(st.startDistance, 'STAGE START', '#d8261c');
    st.checkpoints.forEach((cp) => this.checkpointMats.push(this.gate(cp.distance, `CHECKPOINT ${cp.index + 1}`, '#ff7a00')));
    this.gate(st.finishDistance, 'FINISH', '#111111', true);
  }

  markCheckpoint(index: number, passed: boolean) {
    const mat = this.checkpointMats[index];
    if (mat) mat.color.setHex(passed ? 0x66ff99 : 0xffffff);
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Minimal geometry merge (positions + normals) to avoid an extra import. */
function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}
