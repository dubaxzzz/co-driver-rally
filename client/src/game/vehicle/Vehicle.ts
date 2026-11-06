import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { VehicleDef, WheelOption } from '@cdr/shared';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { DriveInput } from '../input/Input';
import { WHEEL_LAYOUT, type CarModel } from './CarModel';
import { CHASSIS, SUSPENSION } from './setup';

export { SUSPENSION } from './setup';

const RPM_PER_MS = 142; // engine rpm per (m/s × gear ratio)
const FRONT_DRIVE_SHARE = 0.42;


export interface VehicleTelemetry {
  speed: number; // signed m/s along forward axis
  rpm: number;
  gear: number; // -1 R, 0 N, 1..n
  slip: number; // 0..1+ lateral slip estimate
  grounded: boolean;
  onGravel: boolean;
  damage: number;
  throttle: number;
  brake: number;
}

/**
 * Rapier ray-cast vehicle: real suspension, tyre friction and 4WD drive.
 * The car physically travels through the world – nothing is faked.
 */
export class Vehicle {
  readonly body: RAPIER.RigidBody;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly telemetry: VehicleTelemetry = {
    speed: 0,
    rpm: 900,
    gear: 1,
    slip: 0,
    grounded: false,
    onGravel: true,
    damage: 0,
    throttle: 0,
    brake: 0,
  };
  /** Smoothed acceleration in the car frame (x = left, y = up, z = forward), m/s². */
  readonly accelLocal = new THREE.Vector3();
  /** Suspension activity (0..1+) – drives head shake in the cockpit. */
  bump = 0;
  private lastSusp = [0, 0, 0, 0];
  onGearChange: ((up: boolean) => void) | null = null;
  onImpact: ((strength: number) => void) | null = null;
  /** Collider handles considered "road" (gravel). Others = grass/verge. */
  roadColliders = new Set<number>();
  frozen = true;

  private gear = 1;
  private shiftTimer = 0;
  private lastVel = new THREE.Vector3();
  private impactCooldown = 0;
  private gripBase: number;
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();

  constructor(
    private readonly physics: PhysicsWorld,
    readonly def: VehicleDef,
    wheelOpt: WheelOption,
    readonly model: CarModel,
  ) {
    const R = physics.R;
    const world = physics.world;
    this.gripBase = def.grip * wheelOpt.gripMultiplier;

    this.body = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(0, 2, 0)
        .setLinearDamping(0.05)
        .setAngularDamping(CHASSIS.angularDamping)
        .setCanSleep(false)
        .setCcdEnabled(true),
    );
    const hx = 0.86, hy = 0.32, hz = 1.95;
    const m = def.massKg;
    const inertia = {
      x: (m / 12) * (4 * hy * hy + 4 * hz * hz),
      y: (m / 12) * (4 * hx * hx + 4 * hz * hz),
      z: (m / 12) * (4 * hx * hx + 4 * hy * hy),
    };
    world.createCollider(
      R.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(0, 0.1, 0)
        .setMassProperties(m, { x: 0, y: CHASSIS.comY, z: 0.05 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.4)
        .setRestitution(0.1),
      this.body,
    );
    // A cabin collider so rolling onto the roof behaves sensibly
    world.createCollider(R.ColliderDesc.cuboid(0.72, 0.22, 0.95).setTranslation(0, 0.65, -0.25).setDensity(0).setFriction(0.5), this.body);

    this.controller = world.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;

    const L = WHEEL_LAYOUT;
    const pts: Array<[number, number]> = [
      [L.halfTrack, L.frontZ],
      [-L.halfTrack, L.frontZ],
      [L.halfTrack, L.rearZ],
      [-L.halfTrack, L.rearZ],
    ];
    pts.forEach(([x, z], i) => {
      const S = SUSPENSION;
      this.controller.addWheel({ x, y: CHASSIS.wheelY, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, S.restLength, L.radius);
      this.controller.setWheelSuspensionStiffness(i, S.stiffness);
      this.controller.setWheelSuspensionCompression(i, S.compression);
      this.controller.setWheelSuspensionRelaxation(i, S.relaxation);
      this.controller.setWheelMaxSuspensionTravel(i, S.maxTravel);
      this.controller.setWheelMaxSuspensionForce(i, S.maxForce);
      this.controller.setWheelFrictionSlip(i, this.gripBase);
      this.controller.setWheelSideFrictionStiffness(i, 1.0);
    });
  }

  get position() {
    const t = this.body.translation();
    return this.tmpV.set(t.x, t.y, t.z);
  }

  /** Heading (yaw) using the shared convention: forward = (sin h, 0, cos h). */
  get heading() {
    const r = this.body.rotation();
    this.tmpQ.set(r.x, r.y, r.z, r.w);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(this.tmpQ);
    return Math.atan2(f.x, f.z);
  }

  /** Pitch and roll (approximate) for telemetry. */
  get pitchRoll() {
    const r = this.body.rotation();
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w), 'YXZ');
    return { pitch: e.x, roll: e.z };
  }

  get upright() {
    const r = this.body.rotation();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    return up.y;
  }

  /** Teleports the car (used for spawn and reset). */
  place(x: number, y: number, z: number, heading: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.lastVel.set(0, 0, 0);
    this.gear = 1;
  }

  resetDamage() {
    this.telemetry.damage = 0;
  }

  /** One fixed physics step. */
  step(dt: number, input: DriveInput) {
    const c = this.controller;
    const def = this.def;
    const rot = this.body.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.tmpQ);
    const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(this.tmpQ);
    const lv = this.body.linvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    const speed = vel.dot(fwd);
    const lateral = vel.dot(right);

    let throttle = this.frozen ? 0 : input.throttle;
    let brakeIn = this.frozen ? 1 : input.brake;
    const handbrake = this.frozen ? true : input.handbrake;

    // --- Gearbox (automatic, with reverse) ---
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    let reverseDrive = false;
    if (!this.frozen) {
      if (this.gear >= 1 && brakeIn > 0.1 && throttle < 0.1 && speed < 0.8) {
        this.gear = -1;
      } else if (this.gear === -1 && throttle > 0.1 && speed > -0.8) {
        this.gear = 1;
      }
      if (this.gear === -1) {
        reverseDrive = brakeIn > 0.1;
        // In reverse: brake pedal = reverse throttle, throttle = brake.
        const t = throttle;
        throttle = reverseDrive ? brakeIn : 0;
        brakeIn = t;
      }
    }
    const ratios = def.gearRatios;
    const absSpeed = Math.abs(speed);
    if (this.gear >= 1 && this.shiftTimer <= 0) {
      const rpmNow = absSpeed * ratios[this.gear - 1] * RPM_PER_MS;
      if (rpmNow > def.maxRpm * 0.93 && this.gear < ratios.length) {
        this.gear++;
        this.shiftTimer = 0.28;
        this.onGearChange?.(true);
      } else if (this.gear > 1 && absSpeed * ratios[this.gear - 2] * RPM_PER_MS < def.maxRpm * 0.6) {
        this.gear--;
        this.shiftTimer = 0.2;
        this.onGearChange?.(false);
      }
    }
    const ratio = this.gear === -1 ? 3.0 : ratios[Math.max(0, this.gear - 1)];
    const wheelRpm = absSpeed * ratio * RPM_PER_MS;
    const targetRpm = Math.max(def.idleRpm + throttle * 1800 * (this.telemetry.grounded ? 0.3 : 1), wheelRpm);
    this.telemetry.rpm += (Math.min(def.maxRpm, targetRpm) - this.telemetry.rpm) * Math.min(1, dt * 12);
    const rpm = this.telemetry.rpm;

    // Torque curve: peak in the mid range, falls off at redline
    const n = (rpm - def.idleRpm) / (def.maxRpm - def.idleRpm);
    const curve = 0.62 + 0.38 * Math.sin(Math.min(1, Math.max(0, n)) * Math.PI * 0.9);
    const limiter = rpm >= def.maxRpm - 20 ? 0.15 : 1;
    const shiftCut = this.shiftTimer > 0.1 ? 0.2 : 1;
    const damageLoss = 1 - this.telemetry.damage * 0.15;
    let force = def.enginePowerN * curve * (ratio / ratios[0]) * throttle * limiter * shiftCut * damageLoss;
    if (this.gear === -1) force = -def.enginePowerN * 0.45 * throttle;
    if (this.frozen) force = 0;

    const front = (force * FRONT_DRIVE_SHARE) / 2;
    const rear = (force * (1 - FRONT_DRIVE_SHARE)) / 2;
    c.setWheelEngineForce(0, front);
    c.setWheelEngineForce(1, front);
    c.setWheelEngineForce(2, rear);
    c.setWheelEngineForce(3, rear);

    // --- Brakes ---
    const brake = brakeIn * def.brakeForce * 0.5;
    c.setWheelBrake(0, brake * 0.6);
    c.setWheelBrake(1, brake * 0.6);
    const hb = handbrake ? def.brakeForce * 0.6 : 0;
    c.setWheelBrake(2, brake * 0.4 + hb);
    c.setWheelBrake(3, brake * 0.4 + hb);

    // --- Steering (speed sensitive) ---
    const steerAngle = input.steer * def.maxSteerRad * (this.frozen ? 0 : 1);
    c.setWheelSteering(0, steerAngle);
    c.setWheelSteering(1, steerAngle);

    // --- Tyre grip: gravel vs verge, handbrake slides the rear ---
    let onGravel = 0;
    let grounded = 0;
    for (let i = 0; i < 4; i++) {
      const ground = c.wheelGroundObject(i);
      const isRoad = !!ground && this.roadColliders.has(ground.handle);
      if (c.wheelIsInContact(i)) grounded++;
      if (isRoad) onGravel++;
      let grip = this.gripBase * (isRoad ? 1 : 0.82);
      if (i >= 2 && handbrake) grip *= 0.45;
      c.setWheelFrictionSlip(i, grip);
      c.setWheelSideFrictionStiffness(i, i >= 2 && handbrake ? 0.55 : 1.0);
    }

    c.updateVehicle(dt);

    // Downforce + mild aero drag (forces persist in Rapier, so clear last step's first)
    this.body.resetForces(false);
    const down = Math.min(6000, 1.6 * speed * speed);
    const drag = -0.42 * speed * Math.abs(speed);
    this.body.addForce({ x: fwd.x * drag, y: -down + fwd.y * drag, z: fwd.z * drag }, true);

    // Anti-roll bars: resist body roll by pushing up the compressed side and
    // pulling down the extended side of each axle.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.tmpQ);
    let bump = 0;
    for (const [l, r, k] of [[0, 1, SUSPENSION.antiRollFront], [2, 3, SUSPENSION.antiRollRear]] as const) {
      if (!c.wheelIsInContact(l) || !c.wheelIsInContact(r)) continue;
      const compL = SUSPENSION.restLength - (c.wheelSuspensionLength(l) ?? SUSPENSION.restLength);
      const compR = SUSPENSION.restLength - (c.wheelSuspensionLength(r) ?? SUSPENSION.restLength);
      const f = (compL - compR) * k * 0.5;
      const pl = c.wheelHardPoint(l);
      const pr = c.wheelHardPoint(r);
      if (pl && pr) {
        this.body.addForceAtPoint({ x: up.x * f, y: up.y * f, z: up.z * f }, pl, true);
        this.body.addForceAtPoint({ x: -up.x * f, y: -up.y * f, z: -up.z * f }, pr, true);
      }
    }
    // Roll stabiliser: gently pulls the car back upright when it leans,
    // so hard cornering slides the car instead of rolling it over.
    const left = new THREE.Vector3().crossVectors(up, fwd);
    const av = this.body.angvel();
    const rollRate = av.x * fwd.x + av.y * fwd.y + av.z * fwd.z;
    const tq = -left.y * CHASSIS.rollStabiliser - rollRate * CHASSIS.rollDamping;
    this.body.addTorque({ x: fwd.x * tq, y: fwd.y * tq, z: fwd.z * tq }, true);

    for (let i = 0; i < 4; i++) {
      const len = c.wheelSuspensionLength(i) ?? SUSPENSION.restLength;
      bump += Math.abs(len - this.lastSusp[i]) / dt;
      this.lastSusp[i] = len;
    }
    this.bump = Math.min(2, bump * 0.08);

    // --- Impact detection (sudden change in velocity) ---
    this.impactCooldown -= dt;
    const dv = vel.clone().sub(this.lastVel).length();
    if (dv > 4.5 && this.impactCooldown <= 0) {
      const strength = Math.min(1, (dv - 4.5) / 10);
      this.telemetry.damage = Math.min(1, this.telemetry.damage + strength * 0.08);
      this.impactCooldown = 0.35;
      this.onImpact?.(strength);
    }
    // acceleration in the car's own frame (for G-force head movement)
    const accWorld = vel.clone().sub(this.lastVel).divideScalar(dt);
    const inv = this.tmpQ.clone().invert();
    const accLocal = accWorld.applyQuaternion(inv);
    // local axes: car +X is left, +Z forward – same as the model
    this.accelLocal.lerp(accLocal, Math.min(1, dt * 8));
    this.lastVel.copy(vel);

    const t = this.telemetry;
    t.speed = speed;
    t.gear = this.gear;
    t.slip = Math.min(1.5, Math.abs(lateral) / Math.max(4, absSpeed * 0.5) + (handbrake && absSpeed > 3 ? 0.3 : 0));
    t.grounded = grounded >= 2;
    t.onGravel = onGravel >= 2;
    t.throttle = input.throttle;
    t.brake = input.brake;
  }

  /** Must be called after world.step() to clear accumulated user forces. */
  afterStep() {
    this.body.resetForces(true);
  }

  /** Syncs the Three.js model with the physics body and wheel states. */
  syncVisuals() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.model.root.position.set(t.x, t.y, t.z);
    this.model.root.quaternion.set(r.x, r.y, r.z, r.w);
    const c = this.controller;
    for (let i = 0; i < 4; i++) {
      const w = this.model.wheels[i];
      const susp = c.wheelSuspensionLength(i) ?? 0.3;
      w.position.y = WHEEL_LAYOUT.connectionY - susp;
      w.rotation.y = c.wheelSteering(i) ?? 0;
      const spin = w.children[0];
      spin.rotation.x = c.wheelRotation(i) ?? 0;
    }
    this.model.setBrakeLights(this.telemetry.brake > 0.1);
  }

  dispose() {
    this.physics.world.removeVehicleController(this.controller);
    this.physics.world.removeRigidBody(this.body);
  }
}
