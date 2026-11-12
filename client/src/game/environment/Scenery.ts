import * as THREE from 'three';
import { sampleAt, type BuiltStage, type TreeStyle, type Obstacle } from '@cdr/shared';
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
type RAPIER_Shape = { kind: 'box'; hx: number; hy: number; hz: number } | { kind: 'ball'; r: number } | { kind: 'capsule'; hh: number; r: number };

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
    this.buildRoadsideDetail(rand, quality);
  }

  /**
   * The little things that make a rally road look real: marker posts along the
   * edges (tall orange snow poles on snow stages), hay bales and tyre walls on
   * the outside of tight corners, and telegraph poles with wires along the way.
   */
  private buildRoadsideDetail(rand: () => number, quality: 'high' | 'low') {
    const st = this.stage;
    const hw = st.def.roadWidth / 2;
    const snow = st.def.surface === 'snow';
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const at = (d: number, off: number) => {
      const c = sampleAt(st.samples, d);
      const x = c.x + Math.cos(c.h) * off, z = c.z - Math.sin(c.h) * off;
      return { x, z, y: this.terrain.heightAt(x, z), h: c.h };
    };
    const onBridge = (d: number) => st.bridges.some((b) => Math.abs(b.distance - d) < b.length / 2 + 25);
    const inRiver = (x: number, z: number) => this.terrain.riverDistanceAt(x, z) < 16;

    // ---- marker posts: white with a reflector band (or tall orange snow poles) ----
    const postH = snow ? 2.6 : 1.0;
    const postGeo = this.track(new THREE.CylinderGeometry(snow ? 0.03 : 0.05, snow ? 0.03 : 0.06, postH, 6));
    postGeo.translate(0, postH / 2, 0);
    const postMat = this.track(new THREE.MeshStandardMaterial({ color: snow ? 0xff6a00 : 0xf2f2ee, roughness: 0.6 }));
    const bandGeo = this.track(new THREE.CylinderGeometry(snow ? 0.035 : 0.062, snow ? 0.035 : 0.062, 0.12, 6));
    bandGeo.translate(0, postH - (snow ? 0.15 : 0.18), 0);
    const bandMat = this.track(new THREE.MeshStandardMaterial({ color: snow ? 0x111111 : 0xff3b1f, emissive: snow ? 0x000000 : 0x400800, roughness: 0.4 }));
    const step = snow ? 25 : 50;
    const count = Math.ceil((st.finishDistance - st.startDistance) / step) * 2 + 4;
    const posts = new THREE.InstancedMesh(postGeo, postMat, count);
    const bands = new THREE.InstancedMesh(bandGeo, bandMat, count);
    let n = 0;
    for (let d = st.startDistance; d < st.finishDistance && n < count - 1; d += step) {
      if (onBridge(d)) continue;
      for (const side of [-1, 1]) {
        const p = at(d, side * (hw + 1.6));
        if (inRiver(p.x, p.z)) continue;
        m.compose(v.set(p.x, p.y, p.z), q.identity(), one);
        posts.setMatrixAt(n, m);
        bands.setMatrixAt(n, m);
        n++;
      }
    }
    posts.count = bands.count = n;
    posts.castShadow = true;
    this.addChunked(posts);
    this.addChunked(bands);

    // ---- hay bales / tyre walls on the outside of tight corners ----
    const baleGeo = this.track(new THREE.CylinderGeometry(0.6, 0.6, 1.2, 12));
    baleGeo.rotateZ(Math.PI / 2);
    const baleMat = this.track(new THREE.MeshStandardMaterial({ color: snow ? 0xd9c38a : 0xc9a85a, roughness: 1 }));
    const tyreGeo = this.track(new THREE.TorusGeometry(0.33, 0.13, 6, 12));
    tyreGeo.rotateX(Math.PI / 2);
    const tyreMat = this.track(new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }));
    const tight = st.paceNotes.filter((pn) => pn.kind === 'corner' && (pn.severity === 'H' || (typeof pn.severity === 'number' && pn.severity <= 3)));
    const bales = new THREE.InstancedMesh(baleGeo, baleMat, tight.length * 4 + 1);
    const tyres = new THREE.InstancedMesh(tyreGeo, tyreMat, tight.length * 6 + 1);
    let nb = 0, nt = 0;
    const R = this.physics?.R;
    for (const pn of tight) {
      const mid = pn.distance + pn.length * 0.6;
      if (onBridge(mid)) continue;
      const outside = pn.dir === 'L' ? -1 : 1; // the car runs wide to the outside
      const useTyres = st.def.surface === 'tarmac';
      for (let k = 0; k < (useTyres ? 3 : 4); k++) {
        const p = at(mid + (k - 1.5) * 1.4, outside * (hw + 2.4));
        if (inRiver(p.x, p.z)) continue;
        if (useTyres) {
          for (let s = 0; s < 2; s++) {
            m.compose(v.set(p.x, p.y + 0.13 + s * 0.26, p.z), q.identity(), one);
            tyres.setMatrixAt(nt++, m);
          }
        } else {
          q.setFromAxisAngle(up, p.h + (rand() - 0.5) * 0.2);
          m.compose(v.set(p.x, p.y + 0.55, p.z), q, one);
          bales.setMatrixAt(nb++, m);
        }
        if (this.physics && R) {
          const body = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(p.x, p.y + 0.5, p.z));
          this.physics.world.createCollider(R.ColliderDesc.cylinder(0.5, 0.6).setFriction(0.8).setRestitution(0.05), body);
        }
      }
    }
    bales.count = nb;
    tyres.count = nt;
    bales.castShadow = tyres.castShadow = true;
    if (nb) this.addChunked(bales);
    if (nt) this.addChunked(tyres);

    // ---- telegraph poles with sagging wires along one side ----
    if (quality === 'high') {
      const poleGeo = this.track(new THREE.CylinderGeometry(0.11, 0.14, 7.5, 7));
      poleGeo.translate(0, 3.75, 0);
      const armGeo = this.track(new THREE.BoxGeometry(1.4, 0.1, 0.1));
      armGeo.translate(0, 6.9, 0);
      const poleMat = this.track(new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 }));
      const poleCount = Math.ceil((st.finishDistance - st.startDistance) / 45) + 2;
      const poles = new THREE.InstancedMesh(poleGeo, poleMat, poleCount);
      const arms = new THREE.InstancedMesh(armGeo, poleMat, poleCount);
      const wirePts: number[] = [];
      let np = 0;
      let prev: THREE.Vector3[] | null = null;
      for (let d = st.startDistance + 20; d < st.finishDistance - 20; d += 45) {
        const p = at(d, hw + 9 + rand() * 3);
        if (onBridge(d) || inRiver(p.x, p.z) || this.terrain.roadDistanceAt(p.x, p.z) < hw + 5) {
          prev = null;
          continue;
        }
        q.setFromAxisAngle(up, p.h);
        m.compose(v.set(p.x, p.y, p.z), q, one);
        poles.setMatrixAt(np, m);
        arms.setMatrixAt(np, m);
        np++;
        const tips = [-0.6, 0.6].map((o) => new THREE.Vector3(p.x + Math.cos(p.h) * o, p.y + 6.9, p.z - Math.sin(p.h) * o));
        if (prev) {
          for (let w = 0; w < 2; w++) {
            const a = prev[w], b = tips[w];
            // sag in the middle
            for (let k = 0; k < 6; k++) {
              const t0 = k / 6, t1 = (k + 1) / 6;
              const sag = (t: number) => -Math.sin(t * Math.PI) * 0.9;
              wirePts.push(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0 + sag(t0), a.z + (b.z - a.z) * t0);
              wirePts.push(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1 + sag(t1), a.z + (b.z - a.z) * t1);
            }
          }
        }
        prev = tips;
      }
      poles.count = arms.count = np;
      poles.castShadow = true;
      this.addChunked(poles);
      this.addChunked(arms);
      if (wirePts.length) {
        const wg = this.track(new THREE.BufferGeometry());
        wg.setAttribute('position', new THREE.Float32BufferAttribute(wirePts, 3));
        const wires = new THREE.LineSegments(wg, this.track(new THREE.LineBasicMaterial({ color: 0x1a1a1a })));
        this.group.add(wires);
      }
    }
  }

  /** Chunks of instanced scenery, for frustum + distance culling. */
  private chunks: THREE.InstancedMesh[] = [];

  /**
   * Splits an instanced mesh into 200 m grid cells, each with its own bounds, so
   * the GPU only draws the trees/rocks/grass near and in front of the camera
   * (one mesh for the whole stage was drawn in full every frame).
   */
  private addChunked(src: THREE.InstancedMesh) {
    const CELL = 200;
    const cells = new Map<string, number[]>();
    const m = new THREE.Matrix4();
    for (let i = 0; i < src.count; i++) {
      src.getMatrixAt(i, m);
      const key = `${Math.floor(m.elements[12] / CELL)},${Math.floor(m.elements[14] / CELL)}`;
      let list = cells.get(key);
      if (!list) cells.set(key, (list = []));
      list.push(i);
    }
    const col = new THREE.Color();
    for (const list of cells.values()) {
      const c = new THREE.InstancedMesh(src.geometry, src.material, list.length);
      c.castShadow = src.castShadow;
      c.receiveShadow = src.receiveShadow;
      list.forEach((idx, j) => {
        src.getMatrixAt(idx, m);
        c.setMatrixAt(j, m);
        if (src.instanceColor) {
          src.getColorAt(idx, col);
          c.setColorAt(j, col);
        }
      });
      c.instanceMatrix.needsUpdate = true;
      if (c.instanceColor) c.instanceColor.needsUpdate = true;
      c.computeBoundingSphere();
      this.group.add(c);
      this.chunks.push(c);
    }
    src.dispose();
  }

  // ---- things on the road this run: fallen tree, rock slide, animals crossing ----
  private obstacleGroup = new THREE.Group();
  private obstacleBodies: number[] = [];
  private herds: Array<{ distance: number; animals: Array<{ mesh: THREE.Object3D; body: number | null; from: THREE.Vector3; to: THREE.Vector3; delay: number; legs: THREE.Object3D[] }>; t: number; started: boolean }> = [];

  /** Puts this run's obstacles on the road (replacing the last run's). */
  setObstacles(list: Obstacle[]) {
    const st = this.stage;
    const R = this.physics?.R;
    // clear the old ones
    for (const h of this.obstacleBodies) {
      const b = this.physics?.world.getRigidBody(h);
      if (b) this.physics!.world.removeRigidBody(b);
    }
    this.obstacleBodies = [];
    this.herds = [];
    this.obstacleGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.obstacleGroup.clear();
    if (!this.obstacleGroup.parent) this.group.add(this.obstacleGroup);
    const hw = st.def.roadWidth / 2;
    const bark = this.obsMat(0x4a3424, 1);
    const leaf = this.obsMat(st.def.surface === 'snow' ? 0x4f6a52 : 0x2f5a2a, 0.9);
    const rockM = this.obsMat(st.def.scenery.rock, 1, true);
    const fixed = (x: number, y: number, z: number, q: THREE.Quaternion, shape: RAPIER_Shape) => {
      if (!this.physics || !R) return null;
      const body = this.physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
      const desc = shape.kind === 'box' ? R.ColliderDesc.cuboid(shape.hx, shape.hy, shape.hz) : shape.kind === 'ball' ? R.ColliderDesc.ball(shape.r) : R.ColliderDesc.capsule(shape.hh, shape.r);
      this.physics.world.createCollider(desc.setFriction(0.7).setRestitution(0.05), body);
      this.obstacleBodies.push(body.handle);
      return body.handle;
    };
    for (const ob of list) {
      const c = sampleAt(st.samples, ob.distance);
      const lx = Math.cos(c.h), lz = -Math.sin(c.h);
      const fx = Math.sin(c.h), fz = Math.cos(c.h);
      const pt = (lat: number, fwd = 0) => new THREE.Vector3(c.x + lx * lat + fx * fwd, 0, c.z + lz * lat + fz * fwd);
      if (ob.kind === 'tree') {
        // a big tree down across most of the road; the gap is on the other side
        const len = st.def.roadWidth * 0.8 + 6;
        const base = pt(ob.side * (hw + 5));
        const tip = pt(ob.side * (hw + 5) - ob.side * len, 3);
        base.y = this.terrain.heightAt(base.x, base.z) + 0.35;
        tip.y = c.y + 0.35;
        const dir = tip.clone().sub(base);
        const mid = base.clone().addScaledVector(dir, 0.5);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, dir.length(), 10), bark);
        trunk.position.copy(mid);
        trunk.quaternion.copy(q);
        trunk.castShadow = true;
        this.obstacleGroup.add(trunk);
        fixed(mid.x, mid.y, mid.z, q, { kind: 'capsule', hh: dir.length() / 2, r: 0.38 });
        // root plate + broken branches + leafy crown at the tip
        const root = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.4, 10), this.obsMat(0x3d3226, 1));
        root.position.copy(base).addScaledVector(dir.clone().normalize(), -0.3);
        root.quaternion.copy(q);
        this.obstacleGroup.add(root);
        for (let k = 0; k < 7; k++) {
          const p = base.clone().addScaledVector(dir, 0.35 + k * 0.09);
          const br = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 1.6 + Math.random(), 5), bark);
          br.position.copy(p).add(new THREE.Vector3(0, 0.5, 0));
          br.rotation.set(Math.random() * 2 - 1, Math.random() * 6, Math.random() * 2 - 1);
          this.obstacleGroup.add(br);
        }
        for (let k = 0; k < 5; k++) {
          const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1 + Math.random() * 0.6, 0), leaf);
          blob.position.copy(tip).add(new THREE.Vector3((Math.random() - 0.5) * 2.5, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 2.5));
          blob.castShadow = true;
          this.obstacleGroup.add(blob);
        }
      } else if (ob.kind === 'rocks') {
        // a rock slide spilling across one half of the road
        for (let k = 0; k < 9; k++) {
          const lat = ob.side * (hw * 0.15 + Math.random() * (hw + 2));
          const p = pt(lat, (Math.random() - 0.5) * 9);
          const r = 0.35 + Math.random() * (k < 3 ? 0.9 : 0.45);
          p.y = (Math.abs(lat) < hw ? c.y : this.terrain.heightAt(p.x, p.z)) + r * 0.5;
          const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), rockM);
          rock.position.copy(p);
          rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
          rock.castShadow = true;
          this.obstacleGroup.add(rock);
          if (r > 0.45) fixed(p.x, p.y, p.z, new THREE.Quaternion(), { kind: 'ball', r: r * 0.85 });
        }
      } else {
        // animals wandering across: sheep (moose on snow, kangaroos on red-earth stages)
        const kind = st.def.surface === 'snow' ? 'moose' : st.def.offroad === 'sand' || st.def.id.startsWith('aus') ? 'roo' : 'sheep';
        const herd = { distance: ob.distance, animals: [] as Array<{ mesh: THREE.Object3D; body: number | null; from: THREE.Vector3; to: THREE.Vector3; delay: number; legs: THREE.Object3D[] }>, t: 0, started: false };
        const count = kind === 'moose' ? 2 : kind === 'roo' ? 3 : 6;
        for (let k = 0; k < count; k++) {
          const fwd = (Math.random() - 0.5) * 10;
          const from = pt(ob.side * (hw + 6 + Math.random() * 4), fwd);
          const to = pt(-ob.side * (hw + 8 + Math.random() * 4), fwd + (Math.random() - 0.5) * 4);
          from.y = this.terrain.heightAt(from.x, from.z);
          to.y = this.terrain.heightAt(to.x, to.z);
          const { mesh, legs, size } = this.animal(kind);
          mesh.position.copy(from);
          mesh.lookAt(to.x, from.y, to.z);
          this.obstacleGroup.add(mesh);
          let body: number | null = null;
          if (this.physics && R) {
            const b = this.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(from.x, from.y + size, from.z));
            this.physics.world.createCollider(R.ColliderDesc.ball(size).setFriction(0.5), b);
            body = b.handle;
            this.obstacleBodies.push(body);
          }
          herd.animals.push({ mesh, body, from, to, delay: k * 0.6 + Math.random() * 0.8, legs });
        }
        this.herds.push(herd);
      }
    }
  }

  /** Animals start crossing when the car gets near (call every frame). */
  updateObstacles(dt: number, carDistance: number) {
    for (const h of this.herds) {
      if (!h.started && carDistance > h.distance - 160 && carDistance < h.distance + 40) h.started = true;
      if (!h.started) continue;
      h.t += dt;
      for (const a of h.animals) {
        const u = Math.min(1, Math.max(0, (h.t - a.delay) / 9)); // ~9 s to cross
        const p = a.from.clone().lerp(a.to, u);
        p.y = this.terrain.heightAt(p.x, p.z);
        a.mesh.position.copy(p);
        const walking = u > 0 && u < 1;
        a.legs.forEach((l, i) => (l.rotation.x = walking ? Math.sin(h.t * 9 + i * Math.PI) * 0.5 : 0));
        if (a.body !== null) this.physics?.world.getRigidBody(a.body)?.setNextKinematicTranslation({ x: p.x, y: p.y + 0.5, z: p.z });
      }
    }
  }

  private obsMats = new Map<string, THREE.MeshStandardMaterial>();
  private obsMat(color: number, rough: number, flat = false) {
    const k = `${color}|${rough}|${flat}`;
    let m = this.obsMats.get(k);
    if (!m) this.obsMats.set(k, (m = this.track(new THREE.MeshStandardMaterial({ color, roughness: rough, flatShading: flat }))));
    return m;
  }

  /** A simple low-poly animal: body, head, four legs (that swing as it walks). */
  private animal(kind: 'sheep' | 'moose' | 'roo') {
    const g = new THREE.Group();
    const legs: THREE.Object3D[] = [];
    const S = kind === 'moose' ? 1.8 : kind === 'roo' ? 1.0 : 0.8;
    const bodyCol = kind === 'sheep' ? 0xeae6dc : kind === 'moose' ? 0x4a3526 : 0xa86f45;
    const bodyM = this.obsMat(bodyCol, 1, true);
    const darkM = this.obsMat(kind === 'sheep' ? 0x2a2622 : 0x2e2016, 1, true);
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = g) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    if (kind === 'roo') {
      add(new THREE.SphereGeometry(0.35 * S, 7, 6), bodyM, 0, 0.75 * S, 0).scale.set(0.8, 1.3, 1);
      add(new THREE.SphereGeometry(0.16 * S, 6, 5), bodyM, 0, 1.3 * S, 0.12 * S);
      add(new THREE.ConeGeometry(0.06 * S, 0.22 * S, 4), bodyM, 0.08 * S, 1.48 * S, 0.1 * S);
      add(new THREE.ConeGeometry(0.06 * S, 0.22 * S, 4), bodyM, -0.08 * S, 1.48 * S, 0.1 * S);
      const tail = add(new THREE.CylinderGeometry(0.03 * S, 0.1 * S, 0.9 * S, 5), bodyM, 0, 0.35 * S, -0.45 * S);
      tail.rotation.x = 1.1;
      for (const sx of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(sx * 0.15 * S, 0.5 * S, 0);
        add(new THREE.BoxGeometry(0.12 * S, 0.5 * S, 0.45 * S), bodyM, 0, -0.25 * S, 0.1 * S, leg);
        g.add(leg);
        legs.push(leg);
      }
    } else {
      const bh = kind === 'moose' ? 1.25 : 0.55;
      add(new THREE.BoxGeometry(0.55 * S, 0.5 * S, 1.0 * S), bodyM, 0, bh * S, 0);
      const head = add(new THREE.BoxGeometry(0.25 * S, 0.28 * S, 0.38 * S), kind === 'sheep' ? darkM : bodyM, 0, (bh + 0.22) * S, 0.62 * S);
      if (kind === 'moose') {
        for (const sx of [-1, 1]) {
          const antler = add(new THREE.BoxGeometry(0.45 * S, 0.04 * S, 0.22 * S), this.obsMat(0xd8c9a8, 0.8), sx * 0.3 * S, 0.22 * S, -0.05 * S, head);
          antler.rotation.z = sx * 0.4;
        }
      }
      for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
        const leg = new THREE.Group();
        leg.position.set(sx * 0.18 * S, (bh - 0.2) * S, sz * 0.36 * S);
        add(new THREE.BoxGeometry(0.1 * S, bh * S, 0.1 * S), darkM, 0, -bh * 0.5 * S, 0, leg);
        g.add(leg);
        legs.push(leg);
      }
    }
    return { mesh: g, legs, size: kind === 'moose' ? 0.9 : kind === 'roo' ? 0.45 : 0.4 };
  }

  /** Hides scenery chunks far beyond what fog lets you see. */
  cull(camera: THREE.Vector3, maxDist = 650) {
    for (const c of this.chunks) {
      const b = c.boundingSphere;
      if (b) c.visible = b.center.distanceTo(camera) - b.radius < maxDist;
    }
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
    this.addChunked(trunks);
    this.addChunked(leaves);
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
    this.addChunked(rocks);
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
    grass.instanceMatrix.needsUpdate = true;
    this.addChunked(grass);
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
    const tarmac = st.def.surface === 'tarmac';
    // textures: weathered planks for the deck, dressed stone for the abutments
    const tex = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, rx: number, ry: number) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      draw(c.getContext('2d')!);
      const t = this.track(new THREE.CanvasTexture(c));
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rx, ry);
      t.anisotropy = 4;
      return t;
    };
    const plankTex = tex(256, 256, (g) => {
      for (let i = 0; i < 16; i++) {
        const l = 30 + Math.random() * 14;
        g.fillStyle = `hsl(28, ${25 + Math.random() * 12}%, ${l}%)`;
        g.fillRect(0, i * 16, 256, 16);
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(0, i * 16 + 14.5, 256, 1.5); // gap between planks
        g.strokeStyle = 'rgba(0,0,0,0.12)';
        for (let k = 0; k < 4; k++) {
          g.beginPath();
          const y = i * 16 + 3 + Math.random() * 10;
          g.moveTo(0, y);
          g.bezierCurveTo(80, y + 2, 170, y - 2, 256, y + 1);
          g.stroke();
        }
        g.fillStyle = '#2a2a2a';
        for (const x of [20, 236]) g.fillRect(x, i * 16 + 6, 3, 3); // nail heads
      }
    }, 1, 1);
    const stoneTex = tex(256, 256, (g) => {
      g.fillStyle = '#5d5953';
      g.fillRect(0, 0, 256, 256);
      for (let row = 0; row < 8; row++) {
        const off = row % 2 ? 24 : 0;
        for (let x = -48; x < 256; x += 48) {
          const l = 42 + Math.random() * 16;
          g.fillStyle = `hsl(35, 6%, ${l}%)`;
          g.fillRect(x + off + 2, row * 32 + 2, 44, 28);
        }
      }
    }, 2, 1);
    const deckMat = this.track(new THREE.MeshStandardMaterial({ map: plankTex, roughness: 0.9 }));
    const wood = this.track(new THREE.MeshStandardMaterial({ color: 0x5e4129, roughness: 0.9 }));
    const darkWood = this.track(new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.95 }));
    const steel = this.track(new THREE.MeshStandardMaterial({ color: 0x55606a, roughness: 0.55, metalness: 0.6 }));
    const galv = this.track(new THREE.MeshStandardMaterial({ color: 0xb8bdc2, roughness: 0.4, metalness: 0.8 }));
    const concrete = this.track(new THREE.MeshStandardMaterial({ color: 0x8c8a85, roughness: 1 }));
    const stone = this.track(new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 1 }));
    const foam = this.track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }));
    const signMat = this.track(new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.6 }));
    const reflector = this.track(new THREE.MeshStandardMaterial({ color: 0xff3b1f, emissive: 0x551100, roughness: 0.4 }));
    const hw = st.def.roadWidth / 2;
    const up = new THREE.Vector3(0, 1, 0);
    for (const b of st.bridges) {
      const river = st.rivers[b.index];
      const g = new THREE.Group();
      g.position.set(b.x, b.y, b.z);
      g.quaternion.setFromAxisAngle(up, b.h); // local +Z along the road, +X = left
      const collide = (w: number, hgt: number, d: number, x: number, y: number, z: number) => {
        if (!this.physics || !R) return;
        const wp = new THREE.Vector3(x, y, z).applyQuaternion(g.quaternion).add(g.position);
        const body = this.physics.world.createRigidBody(
          R.RigidBodyDesc.fixed().setTranslation(wp.x, wp.y, wp.z).setRotation({ x: g.quaternion.x, y: g.quaternion.y, z: g.quaternion.z, w: g.quaternion.w }),
        );
        this.physics.world.createCollider(R.ColliderDesc.cuboid(w / 2, hgt / 2, d / 2).setFriction(0.4), body);
      };
      const box = (w: number, hgt: number, d: number, m: THREE.Material, x: number, y: number, z: number, solid = false) => {
        const mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, hgt, d)), m);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        g.add(mesh);
        if (solid) collide(w, hgt, d, x, y, z);
        return mesh;
      };
      const L = b.length + 2;
      const water = river ? river.waterY - b.y : -3.2;
      const bed = river ? river.bedY - b.y : -4.8;
      const W = st.def.roadWidth;

      // ---- deck: planks on top of the road surface, timber/steel girders below ----
      const deckTex = plankTex.clone();
      deckTex.needsUpdate = true;
      deckTex.repeat.set(W / 4, L / 4);
      this.track(deckTex);
      const deck = new THREE.Mesh(this.track(new THREE.PlaneGeometry(W + 0.6, L)), tarmac ? concrete : this.track(new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.9 })));
      deck.rotation.x = -Math.PI / 2;
      deck.position.y = 0.035; // just above the road so it never flickers
      deck.receiveShadow = true;
      g.add(deck);
      if (tarmac) {
        // painted edge lines on the concrete deck
        for (const side of [-1, 1]) {
          const line = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.15, L)), galv);
          line.rotation.x = -Math.PI / 2;
          line.position.set(side * (hw - 0.3), 0.04, 0);
          g.add(line);
        }
      }
      box(W + 1.4, 0.35, L, tarmac ? concrete : darkWood, 0, -0.22, 0); // deck slab
      for (const x of [-hw + 0.6, -hw / 3, hw / 3, hw - 0.6]) {
        // girders: steel I-beams (web + flanges)
        box(0.08, 0.7, L, steel, x, -0.75, 0);
        box(0.4, 0.06, L, steel, x, -0.43, 0);
        box(0.4, 0.06, L, steel, x, -1.08, 0);
      }
      // kerbs (solid) so you bump them before the railing
      for (const side of [-1, 1]) {
        box(0.3, 0.25, L, tarmac ? concrete : wood, side * (hw + 0.45), 0.12, 0, true);
        box(0.06, 0.62, L, deckMat, side * (W / 2 + 0.72), -0.25, 0); // fascia board
      }

      // ---- railings: steel guardrail on tarmac stages, timber on the rest ----
      for (const side of [-1, 1]) {
        const x = side * (hw + 0.55);
        for (let z = -L / 2; z <= L / 2 + 0.01; z += 2) {
          if (tarmac) box(0.1, 0.9, 0.1, galv, x, 0.65, z);
          else {
            box(0.18, 1.05, 0.18, wood, x, 0.72, z);
            box(0.2, 0.05, 0.2, darkWood, x, 1.26, z); // post caps
          }
        }
        if (tarmac) {
          box(0.06, 0.32, L, galv, x - side * 0.08, 0.8, 0, true); // W-beam
          box(0.06, 0.06, L, galv, x, 1.12, 0);
        } else {
          box(0.12, 0.14, L, wood, x, 1.18, 0, true);
          box(0.1, 0.12, L, wood, x, 0.72, 0);
          // diagonal braces between posts
          for (let z = -L / 2; z < L / 2 - 1; z += 4) {
            const br = box(0.08, 0.08, 2.4, darkWood, x, 0.95, z + 1);
            br.rotation.x = 0.2 * side;
          }
        }
        // reflectors on the end posts
        for (const end of [-1, 1]) box(0.04, 0.12, 0.06, reflector, x - side * 0.1, 1.0, end * (L / 2));
      }

      // ---- piers: concrete columns + cap beam, down to the river bed ----
      const pierH = -0.4 - bed;
      for (const z of [-L / 4, L / 4]) {
        box(W + 0.8, 0.5, 0.8, concrete, 0, -1.35, z); // cap beam under the girders
        for (const x of [-hw + 0.8, hw - 0.8]) {
          const col = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.42, 0.5, pierH, 14)), concrete);
          col.position.set(x, -1.35 - pierH / 2, z);
          col.castShadow = col.receiveShadow = true;
          g.add(col);
          // foam ring where the current hits the pier
          const ring = new THREE.Mesh(this.track(new THREE.RingGeometry(0.5, 1.1, 18)), foam);
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(x, water + 0.04, z);
          g.add(ring);
        }
        // X bracing between the columns (steel rods)
        const span = W - 1.6;
        const hgt = Math.max(0.5, -1.6 - (water + 0.3));
        const diag = Math.hypot(span, hgt);
        for (const sgn of [-1, 1]) {
          const rod = box(0.08, diag, 0.08, steel, 0, -1.6 - hgt / 2, z);
          rod.rotation.z = sgn * Math.atan2(span, hgt);
        }
      }

      // ---- stone abutments with wing walls, once at each end ----
      for (const end of [-1, 1]) {
        // kept well below the ground beside the road, so only the face towards the river shows
        const top = -1.5;
        const ah = top - bed + 0.3;
        const ab = box(W + 0.6, ah, 1.6, stone, 0, top - ah / 2, end * (L / 2 + 0.6));
        ab.castShadow = false;
        // "narrow bridge" warning sign before each end
        const sx = -(hw + 2.2);
        const z = end * (L / 2 + 18);
        box(0.08, 1.6, 0.08, galv, sx, 0.8, z);
        const sign = box(0.05, 0.75, 0.75, signMat, sx, 1.75, z);
        sign.rotation.x = Math.PI / 4;
        // rocks piled round the abutment where it meets the water
        for (let k = 0; k < 6; k++) {
          const r = new THREE.Mesh(this.track(new THREE.DodecahedronGeometry(0.5 + Math.random() * 0.6, 0)), stone);
          r.position.set((Math.random() - 0.5) * (W + 4), water + 0.1, end * (L / 2 - 0.5 - Math.random() * 1.5));
          r.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
          r.castShadow = true;
          g.add(r);
        }
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
