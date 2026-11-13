import RAPIER from '@dimforge/rapier3d-compat';

export type Rapier = typeof RAPIER;

let initPromise: Promise<Rapier> | null = null;
/** Loads the Rapier WASM module once. */
export function loadRapier(): Promise<Rapier> {
  if (!initPromise) initPromise = RAPIER.init().then(() => RAPIER);
  return initPromise;
}

/** Fixed-timestep wrapper around a Rapier world. */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly fixedDt = 1 / 60;
  private acc = 0;
  /** How far we are between the last physics step and the next one (0..1) – for smooth drawing. */
  alpha = 0;

  constructor(readonly R: Rapier) {
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.fixedDt;
  }

  /** Advances the simulation in fixed steps; `beforeStep` runs before each one. */
  step(dt: number, beforeStep: (h: number) => void, afterStep?: (h: number) => void): number {
    this.acc += Math.min(dt, 0.1);
    let steps = 0;
    while (this.acc >= this.fixedDt && steps < 6) {
      beforeStep(this.fixedDt);
      this.world.step();
      afterStep?.(this.fixedDt);
      this.acc -= this.fixedDt;
      steps++;
    }
    if (steps === 6) this.acc = 0; // avoid spiral of death on slow devices
    this.alpha = Math.min(1, this.acc / this.fixedDt);
    return steps;
  }

  /** Static triangle-mesh collider (terrain, road). */
  addTrimesh(vertices: Float32Array, indices: Uint32Array, friction = 0.9) {
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    const desc = this.R.ColliderDesc.trimesh(vertices, indices).setFriction(friction);
    const c = this.world.createCollider(desc, body);
    // remember where it is (its centre and reach) so it can be switched off when far away
    let x = 0, z = 0;
    const n = vertices.length / 3;
    for (let i = 0; i < vertices.length; i += 3) {
      x += vertices[i];
      z += vertices[i + 2];
    }
    x /= Math.max(1, n);
    z /= Math.max(1, n);
    let r = 0;
    for (let i = 0; i < vertices.length; i += 3) r = Math.max(r, Math.hypot(vertices[i] - x, vertices[i + 2] - z));
    this.meshCentres.set(c.handle, { x, z, r });
    return c;
  }

  private meshCentres = new Map<number, { x: number; z: number; r: number }>();
  private statics: Array<{ c: RAPIER.Collider; x: number; z: number; r: number; on: boolean }> | null = null;

  /**
   * Long stages have thousands of static colliders (trees, barriers, pieces of
   * road and ground). Only the ones near a car need to take part in the
   * simulation – the rest are switched off, which keeps the physics fast.
   */
  cullStatics(points: Array<{ x: number; z: number }>, radius = 260) {
    if (!this.statics) {
      this.statics = [];
      this.world.forEachCollider((c) => {
        const body = c.parent();
        if (!body || !body.isFixed()) return;
        const m = this.meshCentres.get(c.handle);
        const t = c.translation();
        // remember whether it's switched on right now – after a restart some are still off
        this.statics!.push({ c, x: m ? m.x : t.x, z: m ? m.z : t.z, r: m ? m.r : 3, on: c.isEnabled() });
      });
    }
    for (const st of this.statics) {
      let near = false;
      for (const p of points) {
        const dx = p.x - st.x, dz = p.z - st.z;
        const lim = radius + st.r;
        if (dx * dx + dz * dz < lim * lim) {
          near = true;
          break;
        }
      }
      if (near !== st.on) {
        st.c.setEnabled(near);
        st.on = near;
      }
    }
  }
  /** Call after adding/removing static colliders (new obstacles etc.). */
  resetStatics() {
    this.statics = null;
  }

  dispose() {
    this.world.free();
  }
}
