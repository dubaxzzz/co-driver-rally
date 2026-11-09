import * as THREE from 'three';
import { sampleAt, type BuiltStage, type TreeStyle } from '@cdr/shared';
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
    /** null on the navigator's device: scenery is visual only there. */
    private physics: PhysicsWorld | null,
    quality: 'high' | 'low',
  ) {
    const rand = mulberry32(stage.def.seed + 7);
    const density = stage.def.scenery.treeDensity;
    this.buildTrees(rand, Math.round((quality === 'high' ? 4200 : 1500) * density));
    this.buildRocks(rand, quality === 'high' ? 500 : 220);
    if (quality === 'high') this.buildGrass(rand, 5000);
    this.buildBarriersAndSigns();
    this.buildGates();
    this.buildBridges();
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
      if (this.terrain.riverDistanceAt(x, z) < 14) continue; // keep the river banks clear
      return { x, z, y: this.terrain.heightAt(x, z), rd };
    }
    return null;
  }

  private buildTrees(rand: () => number, count: number) {
    if (count <= 0) return;
    const style = this.stage.def.scenery.trees;
    const { trunkGeo, merged, trunkColor, leafHue } = treeGeometry(style);
    this.track(trunkGeo);
    this.track(merged);
    const trunkMat = this.track(new THREE.MeshStandardMaterial({ color: trunkColor, roughness: 1 }));
    const leafMat = this.track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true, vertexColors: true }));
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const leaves = new THREE.InstancedMesh(merged, leafMat, count);
    trunks.castShadow = leaves.castShadow = true;
    leaves.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    const R = this.physics?.R;
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
      // vertex colours carry the base colour (incl. snow caps); instances vary it slightly
      col.setHSL(leafHue, 0.15 + rand() * 0.15, 0.82 + rand() * 0.18);
      leaves.setColorAt(placed, col);
      placed++;
      if (this.physics && R && p.rd < 26 && colliders < 900) {
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
    const mat = this.track(new THREE.MeshStandardMaterial({ color: this.stage.def.scenery.rock, roughness: 1, flatShading: true }));
    const rocks = new THREE.InstancedMesh(geo, mat, count + 40);
    rocks.castShadow = rocks.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const R = this.physics?.R;
    let placed = 0;
    const place = (x: number, y: number, z: number, s: number, collide: boolean) => {
      q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s * 0.6, s * (0.8 + rand() * 0.4)));
      rocks.setMatrixAt(placed++, m);
      if (collide && this.physics && R) {
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
    const mat = this.track(new THREE.MeshStandardMaterial({ color: new THREE.Color(this.stage.def.scenery.grassB).multiplyScalar(1.2), roughness: 1 }));
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
    const R = this.physics?.R;
    const postGeo = this.track(new THREE.BoxGeometry(0.14, 1.0, 0.14));
    const railGeo = this.track(new THREE.BoxGeometry(0.08, 0.28, 1));
    const postMat = this.track(new THREE.MeshStandardMaterial({ color: 0x6b4b2e, roughness: 1 }));
    const railMat = this.track(new THREE.MeshStandardMaterial({ color: 0xd9d9d9, roughness: 0.6, metalness: 0.3 }));
    const posts: THREE.Matrix4[] = [];
    const rails: THREE.Matrix4[] = [];
    const signs = new THREE.Group();
    const signMats = {
      // retro-reflective look: a little emissive so they glow in the headlights/fog
      L: this.track(new THREE.MeshStandardMaterial({ map: this.track(chevronTexture('L', '#ffd21f')), roughness: 0.4, emissive: 0x3a2e00, emissiveMap: null })),
      R: this.track(new THREE.MeshStandardMaterial({ map: this.track(chevronTexture('R', '#ffd21f')), roughness: 0.4, emissive: 0x3a2e00 })),
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
            if (this.physics && R) {
            const body = this.physics.world.createRigidBody(
              R.RigidBodyDesc.fixed().setTranslation(mid.x, mid.y + 0.55, mid.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
            );
            this.physics.world.createCollider(R.ColliderDesc.cuboid(0.12, 0.6, len / 2).setFriction(0.3).setRestitution(0.2), body);
            }
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
    const R = this.physics?.R;
    for (const side of [-1, 1]) {
      const x = c.x + Math.cos(c.h) * hw * side, z = c.z - Math.sin(c.h) * hw * side;
      const y = this.terrain.heightAt(x, z);
      const p = new THREE.Mesh(postGeo, postMat);
      p.position.set(x, y + 3, z);
      p.castShadow = true;
      g.add(p);
      if (this.physics && R) {
        const body = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, y + 3, z));
        this.physics.world.createCollider(R.ColliderDesc.cuboid(0.2, 3, 0.2), body);
      }
    }
    const tex = this.track(bannerTexture(text, color, '#ffffff', checker));
    const mat = this.track(
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, side: THREE.DoubleSide, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35 }),
    );
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

  /** Timber bridges: side beams, railings (solid), piers down into the river, stone abutments. */
  private buildBridges() {
    const st = this.stage;
    if (!st.bridges.length) return;
    const R = this.physics?.R;
    const wood = this.track(new THREE.MeshStandardMaterial({ color: 0x5e4129, roughness: 0.9 }));
    const darkWood = this.track(new THREE.MeshStandardMaterial({ color: 0x3e2a1a, roughness: 0.95 }));
    const stone = this.track(new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 1, flatShading: true }));
    const hw = st.def.roadWidth / 2;
    const up = new THREE.Vector3(0, 1, 0);
    for (const b of st.bridges) {
      const river = st.rivers[b.index];
      const g = new THREE.Group();
      g.position.set(b.x, b.y, b.z);
      g.quaternion.setFromAxisAngle(up, b.h); // local +Z along the road, +X = left
      const box = (w: number, hgt: number, d: number, m: THREE.Material, x: number, y: number, z: number, collide = false) => {
        const mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, hgt, d)), m);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        g.add(mesh);
        if (collide && this.physics && R) {
          const wp = new THREE.Vector3(x, y, z).applyQuaternion(g.quaternion).add(g.position);
          const body = this.physics.world.createRigidBody(
            R.RigidBodyDesc.fixed().setTranslation(wp.x, wp.y, wp.z).setRotation({ x: g.quaternion.x, y: g.quaternion.y, z: g.quaternion.z, w: g.quaternion.w }),
          );
          this.physics.world.createCollider(R.ColliderDesc.cuboid(w / 2, hgt / 2, d / 2).setFriction(0.4), body);
        }
        return mesh;
      };
      const L = b.length + 2;
      const depth = b.y - (river?.bedY ?? b.y - 4);
      // deck underside + edge beams
      box(st.def.roadWidth + 1.2, 0.5, L, darkWood, 0, -0.3, 0);
      for (const side of [-1, 1]) {
        box(0.35, 0.5, L, wood, side * (hw + 0.6), 0.05, 0);
        // railing: posts + two rails (solid – you can hit them)
        for (let z = -L / 2; z <= L / 2 + 0.01; z += 2.2) box(0.16, 1.1, 0.16, wood, side * (hw + 0.6), 0.75, z);
        box(0.12, 0.14, L, wood, side * (hw + 0.6), 1.25, 0, true);
        box(0.1, 0.12, L, wood, side * (hw + 0.6), 0.8, 0);
        // piers down to the river bed
        for (const z of [-L / 4, L / 4]) box(0.5, depth, 0.5, darkWood, side * (hw - 0.4), -depth / 2 - 0.4, z);
        // stone abutments at each end
        for (const end of [-1, 1]) box(st.def.roadWidth + 3, depth * 0.8, 3, stone, 0, -depth * 0.4 - 0.4, end * (L / 2 + 1.2));
      }
      // cross bracing between the piers
      for (const z of [-L / 4, L / 4]) {
        const brace = box(st.def.roadWidth - 0.5, 0.2, 0.2, darkWood, 0, -depth * 0.55, z);
        brace.rotation.z = 0.35;
      }
      this.group.add(g);
    }
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
  const col = new Float32Array(total * 3).fill(1);
  let o = 0;
  for (const g of parts) {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/** Geometry + colours for each tree style (vertex-coloured foliage). */
function treeGeometry(style: TreeStyle) {
  const colorize = (geo: THREE.BufferGeometry, color: number) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const c = new THREE.Color(color);
    const arr = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = c.r;
      arr[i + 1] = c.g;
      arr[i + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  };
  let trunkGeo: THREE.BufferGeometry;
  let parts: THREE.BufferGeometry[];
  let trunkColor = 0x4a3626;
  let leafHue = 0.3;
  switch (style) {
    case 'snowpine': {
      trunkGeo = new THREE.CylinderGeometry(0.18, 0.3, 3, 6).translate(0, 1.5, 0);
      const green = 0x23402a, snow = 0xf4f8fb;
      parts = [
        colorize(new THREE.ConeGeometry(2.4, 5, 7).translate(0, 4.2, 0), green),
        colorize(new THREE.ConeGeometry(2.0, 1.4, 7).translate(0, 6.0, 0), snow),
        colorize(new THREE.ConeGeometry(1.9, 4.2, 7).translate(0, 6.6, 0), green),
        colorize(new THREE.ConeGeometry(1.4, 1.2, 7).translate(0, 8.2, 0), snow),
        colorize(new THREE.ConeGeometry(1.3, 3.4, 7).translate(0, 8.8, 0), snow),
      ];
      leafHue = 0.55;
      break;
    }
    case 'eucalyptus': {
      trunkGeo = new THREE.CylinderGeometry(0.16, 0.32, 9, 6).translate(0, 4.5, 0);
      trunkColor = 0xcfc6b8; // pale gum bark
      const leaf = 0x6f8060;
      parts = [
        colorize(new THREE.IcosahedronGeometry(2.4, 0).scale(1, 0.7, 1).translate(0.8, 9.5, 0.3), leaf),
        colorize(new THREE.IcosahedronGeometry(2.0, 0).scale(1, 0.7, 1).translate(-1.2, 8.4, -0.6), leaf),
        colorize(new THREE.IcosahedronGeometry(1.7, 0).scale(1, 0.7, 1).translate(0.2, 11.2, -0.8), leaf),
      ];
      leafHue = 0.25;
      break;
    }
    case 'scrub': {
      trunkGeo = new THREE.CylinderGeometry(0.05, 0.08, 0.6, 5).translate(0, 0.3, 0);
      const bush = 0x8a8a4a;
      parts = [
        colorize(new THREE.IcosahedronGeometry(1.0, 0).scale(1, 0.6, 1).translate(0, 0.6, 0), bush),
        colorize(new THREE.IcosahedronGeometry(0.7, 0).scale(1, 0.6, 1).translate(0.8, 0.5, 0.3), bush),
      ];
      leafHue = 0.16;
      break;
    }
    default: {
      trunkGeo = new THREE.CylinderGeometry(0.18, 0.3, 3, 6).translate(0, 1.5, 0);
      const green = 0x2a4a26;
      parts = [
        colorize(new THREE.ConeGeometry(2.4, 5, 7).translate(0, 4.2, 0), green),
        colorize(new THREE.ConeGeometry(1.9, 4.2, 7).translate(0, 6.6, 0), green),
        colorize(new THREE.ConeGeometry(1.3, 3.4, 7).translate(0, 8.8, 0), green),
      ];
    }
  }
  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return { trunkGeo, merged, trunkColor, leafHue };
}
