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

  constructor(readonly R: Rapier) {
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.fixedDt;
  }

  /** Advances the simulation in fixed steps; `beforeStep` runs before each one. */
  step(dt: number, beforeStep: (h: number) => void): number {
    this.acc += Math.min(dt, 0.1);
    let steps = 0;
    while (this.acc >= this.fixedDt && steps < 6) {
      beforeStep(this.fixedDt);
      this.world.step();
      this.acc -= this.fixedDt;
      steps++;
    }
    if (steps === 6) this.acc = 0; // avoid spiral of death on slow devices
    return steps;
  }

  /** Static triangle-mesh collider (terrain, road). */
  addTrimesh(vertices: Float32Array, indices: Uint32Array, friction = 0.9) {
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    const desc = this.R.ColliderDesc.trimesh(vertices, indices).setFriction(friction);
    return this.world.createCollider(desc, body);
  }

  dispose() {
    this.world.free();
  }
}
