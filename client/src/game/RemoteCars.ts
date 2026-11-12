/**
 * Other players' cars shown as solid physics bodies. Each one is a *dynamic*
 * body with the real car's mass that is steered towards the positions sent over
 * the network (slightly in the past). Because it has a real mass, a crash
 * shares the momentum like two real cars: you shove the car you hit instead of
 * bouncing off it as if it were a wall. Each player's own game handles their
 * side of the crash, so both cars take damage.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { INTERPOLATION_DELAY_MS, VEHICLES, WHEELS, type PaintOption } from '@cdr/shared';
import type { PhysicsWorld } from './physics/PhysicsWorld';
import { bakeCarModel, createCarModel, type CarModel } from './vehicle/CarModel';

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
  private readonly collider: RAPIER.Collider;
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
    this.body = physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(0, -500, 0).setGravityScale(0).setCcdEnabled(true).setLinearDamping(0).setAngularDamping(2),
    );
    const def = VEHICLES[carIndex] ?? VEHICLES[0];
    // same footprint and mass as a real car's chassis
    const hw = 0.86 * def.body.width;
    const hl = 1.95 * def.body.length;
    this.collider = physics.world.createCollider(
      R.ColliderDesc.cuboid(hw, 0.45, hl)
        .setTranslation(0, 0.2, 0)
        .setMass(def.massKg)
        .setFriction(0.3)
        .setRestitution(0) // crashes don't bounce: the cars push and scrape
        .setRestitutionCombineRule(R.CoefficientCombineRule.Min)
        // only touches cars (the real car follows its own ground; this one just follows the network)
        .setCollisionGroups((0x2 << 16) | 0x2),
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

  private e = new THREE.Euler();

  private tq = new THREE.Quaternion();
  private cq = new THREE.Quaternion();
  private parked = true;

  /**
   * Steers the body towards where the network says the car is (call every
   * fixed step). It drives with velocities rather than teleporting, so a crash
   * can nudge it for a moment, but it always settles back onto the real path.
   */
  stepBody(serverNow: number, dt = 1 / 60) {
    const s = this.active ? this.sample(serverNow) : null;
    if (!s) {
      if (!this.parked) {
        this.body.setTranslation({ x: 0, y: -500, z: 0 }, false);
        this.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        this.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
        this.body.sleep();
        this.parked = true;
      }
      return;
    }
    this.tq.setFromEuler(this.e.set(s.p, s.h, s.r, 'YXZ'));
    const pos = this.body.translation();
    const ex = s.x - pos.x, ey = s.y - pos.y, ez = s.z - pos.z;
    // far off (first packet, reset, or knocked well away): just put it there
    if (this.parked || ex * ex + ey * ey + ez * ez > 9) {
      this.body.setTranslation({ x: s.x, y: s.y, z: s.z }, true);
      this.body.setRotation({ x: this.tq.x, y: this.tq.y, z: this.tq.z, w: this.tq.w }, true);
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.parked = false;
      return;
    }
    this.body.wakeUp();
    // while it's touching another car, follow the network gently: the crash
    // itself decides how the cars move apart, not a rigid wall
    let touching = false;
    this.physics.world.contactPairsWith(this.collider, () => (touching = true));
    const k = (touching ? 0.25 : 0.6) / dt;
    const lv = this.body.linvel();
    const blend = touching ? 0.12 : 0.5;
    this.body.setLinvel({ x: lv.x + (ex * k - lv.x) * blend, y: lv.y + (ey * k - lv.y) * blend, z: lv.z + (ez * k - lv.z) * blend }, true);
    // same for the rotation
    const r = this.body.rotation();
    this.cq.set(r.x, r.y, r.z, r.w).invert().premultiply(this.tq); // q_err = target * current⁻¹
    if (this.cq.w < 0) this.cq.set(-this.cq.x, -this.cq.y, -this.cq.z, -this.cq.w);
    const angle = 2 * Math.acos(Math.min(1, this.cq.w));
    const sn = Math.sqrt(Math.max(1e-9, 1 - this.cq.w * this.cq.w));
    const w = angle < 1e-4 ? 0 : (angle * 0.6) / dt / sn;
    const av = this.body.angvel();
    this.body.setAngvel({ x: av.x + (this.cq.x * w - av.x) * blend, y: av.y + (this.cq.y * w - av.y) * blend, z: av.z + (this.cq.z * w - av.z) * blend }, true);
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
