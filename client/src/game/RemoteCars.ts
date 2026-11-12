/**
 * Other players' cars (and AI cars simulated on another player's machine)
 * shown as solid kinematic bodies. They follow the positions sent over the
 * network slightly in the past, and your car bounces off them – each player's
 * own game handles their side of the crash, so both cars take damage.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { INTERPOLATION_DELAY_MS, VEHICLES, WHEELS, type PaintOption } from '@cdr/shared';
import type { PhysicsWorld } from './physics/PhysicsWorld';
import { bakeCarModel, createCarModel, type CarModel } from './vehicle/CarModel';
import { CAR_GROUPS } from './vehicle/Vehicle';

interface Pose {
  t: number; // server time
  x: number;
  y: number;
  z: number;
  h: number;
  p: number;
  r: number;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerpAngle = (a: number, b: number, u: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * u;
};

/** Paints for players whose telemetry hasn't said what they drive yet. */
const FALLBACK: PaintOption[] = [
  { id: 'p1', name: 'P1', body: 0x1f6fff, accent: 0xffffff },
  { id: 'p2', name: 'P2', body: 0x22c55e, accent: 0x111111 },
  { id: 'p3', name: 'P3', body: 0xf59e0b, accent: 0x111111 },
  { id: 'p4', name: 'P4', body: 0xe11d48, accent: 0xffffff },
];

export class RemoteCar {
  readonly model: CarModel;
  readonly body: RAPIER.RigidBody;
  private buf: Pose[] = [];
  private look = '';
  name: string;
  /** Distance along the stage and finish time (ms) from the last packet. */
  distance = 0;
  finishMs: number | null = null;
  active = true;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
    readonly id: string,
    name: string,
    paint: PaintOption,
    carIndex = 0,
  ) {
    this.name = name;
    this.model = this.buildModel(paint, carIndex);
    const R = physics.R;
    this.body = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -500, 0));
    const def = VEHICLES[carIndex] ?? VEHICLES[0];
    // same footprint as a real car's chassis, scaled by the body
    const hw = 0.86 * def.body.width;
    const hl = 1.95 * def.body.length;
    physics.world.createCollider(
      R.ColliderDesc.cuboid(hw, 0.45, hl).setTranslation(0, 0.2, 0).setFriction(0.4).setRestitution(0.15).setCollisionGroups(CAR_GROUPS),
      this.body,
    );
  }

  private buildModel(paint: PaintOption, carIndex: number) {
    const def = VEHICLES[carIndex] ?? VEHICLES[0];
    const m = createCarModel(paint, WHEELS[0], def.body);
    bakeCarModel(m); // a handful of draw calls instead of hundreds
    this.scene.add(m.root);
    m.root.visible = false;
    return m;
  }

  /** Repaints / swaps the body when the player's telemetry says what they drive. */
  setLook(carIndex: number, body: number, accent: number) {
    const key = `${carIndex}:${body}:${accent}`;
    if (key === this.look) return;
    const first = this.look === '';
    this.look = key;
    if (first && carIndex === 0) {
      this.model.setPaint({ id: this.id, name: this.name, body, accent });
      return;
    }
    const old = this.model;
    const fresh = this.buildModel({ id: this.id, name: this.name, body, accent }, carIndex);
    fresh.root.visible = old.root.visible;
    fresh.root.position.copy(old.root.position);
    fresh.root.quaternion.copy(old.root.quaternion);
    this.scene.remove(old.root);
    old.dispose();
    (this as { model: CarModel }).model = fresh;
  }

  push(p: Pose) {
    const last = this.buf[this.buf.length - 1];
    if (last && p.t <= last.t) return;
    // a jump of more than 40 m is a reset/teleport: don't sweep through everything in between
    if (last && Math.hypot(p.x - last.x, p.z - last.z) > 40) this.buf = [];
    this.buf.push(p);
    if (this.buf.length > 40) this.buf.shift();
  }

  clear() {
    this.buf = [];
  }

  private sample(serverNow: number): Pose | null {
    const b = this.buf;
    if (!b.length) return null;
    const t = serverNow - INTERPOLATION_DELAY_MS;
    if (t <= b[0].t) return b[0];
    for (let i = b.length - 1; i > 0; i--) {
      const a = b[i - 1];
      const c = b[i];
      if (a.t <= t && t <= c.t) {
        const u = (t - a.t) / Math.max(1, c.t - a.t);
        return { t, x: lerp(a.x, c.x, u), y: lerp(a.y, c.y, u), z: lerp(a.z, c.z, u), h: lerpAngle(a.h, c.h, u), p: lerpAngle(a.p, c.p, u), r: lerpAngle(a.r, c.r, u) };
      }
    }
    // a little extrapolation (max 150 ms) when packets are late
    const last = b[b.length - 1];
    const prev = b[b.length - 2];
    if (!prev) return last;
    const ahead = Math.min(150, t - last.t) / Math.max(1, last.t - prev.t);
    return { ...last, x: last.x + (last.x - prev.x) * ahead, z: last.z + (last.z - prev.z) * ahead, y: last.y + (last.y - prev.y) * ahead };
  }

  private q = new THREE.Quaternion();
  private e = new THREE.Euler();

  /** Moves the physics body (call every fixed step). */
  stepBody(serverNow: number) {
    const s = this.active ? this.sample(serverNow) : null;
    if (!s) {
      this.body.setNextKinematicTranslation({ x: 0, y: -500, z: 0 });
      return;
    }
    this.q.setFromEuler(this.e.set(s.p, s.h, s.r, 'YXZ'));
    this.body.setNextKinematicTranslation({ x: s.x, y: s.y, z: s.z });
    this.body.setNextKinematicRotation({ x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w });
  }

  /** Moves the visible model to where the body is. */
  syncVisual(camera: THREE.Vector3) {
    const t = this.body.translation();
    const r = this.body.rotation();
    const visible = this.active && t.y > -400 && Math.hypot(t.x - camera.x, t.z - camera.z) < 450;
    this.model.root.visible = visible;
    if (!visible) return;
    this.model.root.position.set(t.x, t.y, t.z);
    this.model.root.quaternion.set(r.x, r.y, r.z, r.w);
  }

  dispose() {
    this.scene.remove(this.model.root);
    this.model.dispose();
    this.physics.world.removeRigidBody(this.body);
  }
}

export function fallbackPaint(i: number) {
  return FALLBACK[i % FALLBACK.length];
}
