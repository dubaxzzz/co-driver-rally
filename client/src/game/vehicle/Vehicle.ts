import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { SURFACES, type SurfaceDef, type VehicleDef, type WheelOption } from '@cdr/shared';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { DriveInput } from '../input/Input';
import { WHEEL_LAYOUT, type CarModel } from './CarModel';
import { CHASSIS, SUSPENSION } from './setup';

export { SUSPENSION } from './setup';

const RPM_PER_MS = 142; // engine rpm per (m/s × gear ratio)


/** Collision groups are packed as (membership << 16) | filter. */
/** Car bodies: collide with the world AND with other cars. */
export const CAR_GROUPS = (0x0002 << 16) | 0x0003;
/** Wheel ray queries: see only the world (never ride on another car's roof). */
export const RAY_GROUPS = (0x0002 << 16) | 0x0001;
const WHEEL_NAMES = ['front-left', 'front-right', 'rear-left', 'rear-right'];

/** A pothole the game passes in each frame (only the ones near the car). */
export interface NearbyPothole {
  x: number;
  z: number;
  radius: number;
  severity: number;
}

/** Damage per zone, 0 (fine) .. 1 (wrecked). */
export interface DamageZones {
  front: number;
  left: number;
  right: number;
  rear: number;
  windscreen: number;
  engine: number;
}
export const DAMAGE_KEYS: Array<keyof DamageZones> = ['front', 'left', 'right', 'rear', 'windscreen', 'engine'];
export const noDamage = (): DamageZones => ({ front: 0, left: 0, right: 0, rear: 0, windscreen: 0, engine: 0 });

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
  onImpact: ((strength: number, zone: keyof DamageZones) => void) | null = null;
  /** Fired when a wheel breaks off (index 0 FL, 1 FR, 2 RL, 3 RR). */
  onWheelLost: ((index: number, name: string) => void) | null = null;
  /** A wheel hit a pothole or landed hard. */
  onWheelHit: ((index: number, strength: number) => void) | null = null;
  /** Wheel damage 0..1 (1 = the wheel comes off). */
  readonly wheelDamage = [0, 0, 0, 0];
  readonly wheelLost = [false, false, false, false];
  /** Potholes near the car, set by the game each frame. */
  nearbyPotholes: NearbyPothole[] = [];
  private potholeCooldown = [0, 0, 0, 0];
  private wobble = 0;
  private wasTipped = false;
  /** Damage by zone – drives the visuals (cracked glass, bent bonnet…) and performance. */
  readonly damage: DamageZones = noDamage();
  /** Surface under the wheels that touch the road / everything else. Set by the game each frame. */
  roadSurface: SurfaceDef = SURFACES.gravel;
  offroadSurface: SurfaceDef = SURFACES.grass;
  /** True when the car is down in a river. */
  inWater = false;
  /** Weather grip multiplier (rain, snow…). */
  weatherGrip = 1;
  /** Name of the surface most wheels are on (for sound/HUD). */
  surfaceName: SurfaceDef = SURFACES.gravel;
  /** Collider handles considered "road" (gravel). Others = grass/verge. */
  roadColliders = new Set<number>();
  frozen = true;

  private gear = 1;
  private shiftTimer = 0;
  private lastVel = new THREE.Vector3();
  private impactCooldown = 0;
  private gripBase: number;
  private stiffness: number;
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
    this.stiffness = SUSPENSION.stiffness * def.suspension;

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
        .setCollisionGroups(CAR_GROUPS)
        .setTranslation(0, 0.1, 0)
        .setMassProperties(m, { x: 0, y: CHASSIS.comY, z: 0.05 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.4)
        .setRestitution(0.1),
      this.body,
    );
    // A cabin collider so rolling onto the roof behaves sensibly
    world.createCollider(R.ColliderDesc.cuboid(0.72, 0.22, 0.95).setTranslation(0, 0.65, -0.25).setDensity(0).setFriction(0.5).setCollisionGroups(CAR_GROUPS), this.body);

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
      this.controller.setWheelSuspensionStiffness(i, this.stiffness);
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
    for (const k of DAMAGE_KEYS) this.damage[k] = 0;
    // refit any wheels that came off
    for (let i = 0; i < 4; i++) {
      this.wheelDamage[i] = 0;
      if (this.wheelLost[i]) {
        this.wheelLost[i] = false;
        this.controller.setWheelRadius(i, WHEEL_LAYOUT.radius);
        this.controller.setWheelSuspensionRestLength(i, SUSPENSION.restLength);
        this.model.wheels[i].visible = this.model.body.visible;
      }
    }
  }

  /** Starts with damage carried over (championship). Lost wheels come back fitted but battered. */
  setDamage(zones: number[], wheels: number[]) {
    this.resetDamage();
    DAMAGE_KEYS.forEach((k, i) => (this.damage[k] = Math.max(0, Math.min(1, zones[i] ?? 0))));
    for (let i = 0; i < 4; i++) this.wheelDamage[i] = Math.max(0, Math.min(0.95, wheels[i] ?? 0));
    this.telemetry.damage = Math.max(...DAMAGE_KEYS.map((k) => this.damage[k]));
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
        this.shiftTimer = def.shiftTime;
        this.onGearChange?.(true);
      } else if (this.gear > 1 && absSpeed * ratios[this.gear - 2] * RPM_PER_MS < def.maxRpm * 0.6) {
        this.gear--;
        this.shiftTimer = def.shiftTime * 0.7;
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
    // engine damage costs power; a smashed front end chokes the radiator too
    const damageLoss = 1 - this.damage.engine * 0.45 - this.damage.front * 0.1;
    let force = def.enginePowerN * curve * (ratio / ratios[0]) * throttle * limiter * shiftCut * damageLoss;
    if (this.gear === -1) force = -def.enginePowerN * 0.45 * throttle;
    if (this.frozen) force = 0;

    // drivetrain split (FWD / RWD / 4WD); a missing wheel can't put power down
    const front = (force * def.frontDriveShare) / 2;
    const rear = (force * (1 - def.frontDriveShare)) / 2;
    c.setWheelEngineForce(0, this.wheelLost[0] ? 0 : front);
    c.setWheelEngineForce(1, this.wheelLost[1] ? 0 : front);
    c.setWheelEngineForce(2, this.wheelLost[2] ? 0 : rear);
    c.setWheelEngineForce(3, this.wheelLost[3] ? 0 : rear);

    // --- Brakes ---
    const brake = brakeIn * def.brakeForce * 0.5;
    c.setWheelBrake(0, brake * 0.6);
    c.setWheelBrake(1, brake * 0.6);
    const hb = handbrake ? def.brakeForce * 0.6 : 0;
    c.setWheelBrake(2, brake * 0.4 + hb);
    c.setWheelBrake(3, brake * 0.4 + hb);

    // --- Steering (speed sensitive) ---
    // bent steering arms after side impacts make the car pull to that side
    // a damaged front wheel pulls to its side and makes the steering shimmy
    this.wobble += dt * (8 + absSpeed * 0.6);
    const wheelPull = (this.wheelDamage[0] - this.wheelDamage[1]) * 0.09 + (this.wheelLost[0] ? 0.08 : 0) - (this.wheelLost[1] ? 0.08 : 0);
    const shimmy = Math.sin(this.wobble) * Math.max(this.wheelDamage[0], this.wheelDamage[1]) * 0.05 * Math.min(1, absSpeed / 15);
    const pull = (this.damage.left - this.damage.right) * 0.07 + wheelPull + shimmy;
    const steerAngle = (input.steer * def.maxSteerRad + pull) * (this.frozen ? 0 : 1);
    c.setWheelSteering(0, steerAngle);
    c.setWheelSteering(1, steerAngle);

    // --- Tyre grip: gravel vs verge, handbrake slides the rear ---
    let onGravel = 0;
    let grounded = 0;
    const wheelSurfaces: SurfaceDef[] = [];
    for (let i = 0; i < 4; i++) {
      const ground = c.wheelGroundObject(i);
      const isRoad = !!ground && this.roadColliders.has(ground.handle);
      if (c.wheelIsInContact(i)) grounded++;
      if (isRoad) onGravel++;
      const rearWheel = i >= 2;
      const surf = this.inWater ? SURFACES.water : isRoad ? this.roadSurface : this.offroadSurface;
      wheelSurfaces[i] = surf;
      let grip = this.gripBase * surf.grip * this.weatherGrip * (rearWheel ? CHASSIS.rearGripBias : 1) * (1 - this.wheelDamage[i] * 0.45);
      if (this.wheelLost[i]) grip = 0.35; // dragging on the hub
      if (rearWheel && handbrake) grip *= 0.45;
      c.setWheelFrictionSlip(i, grip);
      const side = rearWheel ? CHASSIS.sideFrictionRear : CHASSIS.sideFrictionFront;
      c.setWheelSideFrictionStiffness(i, rearWheel && handbrake ? side * 0.55 : side);
    }

    // Safety: when the car is tipped well over, the wheels must not keep pushing
    // (a ray-cast suspension on its side would shove the car along by itself).
    const tipped = new THREE.Vector3(0, 1, 0).applyQuaternion(this.tmpQ).y < 0.55;
    if (tipped !== this.wasTipped) {
      for (let i = 0; i < 4; i++) c.setWheelMaxSuspensionForce(i, tipped ? 0 : SUSPENSION.maxForce);
      this.wasTipped = tipped;
    }
    c.updateVehicle(dt, undefined, RAY_GROUPS);
    this.checkWheelHits(dt, absSpeed);

    // Downforce + mild aero drag (forces persist in Rapier, so clear last step's first)
    // Rapier keeps user forces AND torques until cleared – clear both every step,
    // otherwise the anti-roll/stabiliser torques pile up and spin the car.
    this.body.resetForces(false);
    this.body.resetTorques(false);
    const down = Math.min(6000, 1.6 * speed * speed);
    // Surface resistance: sand, mud, snow, grass and water slow the car a lot.
    let rolling = 0;
    let surfDrag = 0;
    let contacts = 0;
    let main = this.roadSurface;
    for (let i = 0; i < 4; i++) {
      if (!c.wheelIsInContact(i)) continue;
      const sf = wheelSurfaces[i] ?? this.roadSurface;
      rolling += sf.rolling;
      surfDrag += sf.drag;
      contacts++;
      if (i === 0) main = sf;
    }
    this.surfaceName = contacts ? main : this.surfaceName;
    let resist = 0;
    if (contacts && absSpeed > 0.3) resist = ((rolling + surfDrag * absSpeed) / 4) * Math.sign(speed);
    if (this.inWater) resist += 900 * Math.sign(speed) + 60 * speed; // wading through the river
    const drag = -0.42 * speed * Math.abs(speed) - resist;
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
    // Yaw damping: resists the car rotating faster than its steering asks for
    // (stops small steering inputs turning into spins; the handbrake bypasses it).
    if (CHASSIS.yawDamping > 0 && !handbrake) {
      const yawRate = av.x * up.x + av.y * up.y + av.z * up.z;
      const expected = absSpeed > 1 ? (speed * Math.tan(steerAngle)) / 2.5 : 0; // kinematic bicycle model
      const yq = -(yawRate - expected) * CHASSIS.yawDamping;
      this.body.addTorque({ x: up.x * yq, y: up.y * yq, z: up.z * yq }, true);
    }

    for (let i = 0; i < 4; i++) {
      const len = c.wheelSuspensionLength(i) ?? SUSPENSION.restLength;
      const rate = (this.lastSusp[i] - len) / dt; // compression speed
      bump += Math.abs(rate);
      // slamming into the bump stop (big landings, kerbs, rocks) bends the wheel
      if (!this.wheelLost[i] && rate > 3.2 && len < SUSPENSION.restLength - SUSPENSION.maxTravel * 0.8) {
        this.damageWheel(i, (rate - 3.2) * 0.06);
      }
      this.lastSusp[i] = len;
    }
    this.bump = Math.min(2, bump * 0.08);

    // --- Impact detection (sudden change in velocity) ---
    this.impactCooldown -= dt;
    const dvWorld = vel.clone().sub(this.lastVel);
    const dv = dvWorld.length();
    if (dv > 4.5 && this.impactCooldown <= 0) {
      const strength = Math.min(1, (dv - 4.5) / 10);
      // which side took the hit? (velocity change in the car's frame: +x left, +z forward)
      const local = dvWorld.clone().applyQuaternion(this.tmpQ.clone().invert());
      const d = this.damage;
      const absorb = 1 - this.def.armour;
      const add = (k: keyof DamageZones, v: number) => (d[k] = Math.min(1, d[k] + v * absorb));
      let zone: keyof DamageZones;
      const upsideDown = up.y < 0.3;
      const landing = !upsideDown && Math.abs(local.y) > Math.max(Math.abs(local.x), Math.abs(local.z));
      if (landing) {
        zone = 'engine'; // a heavy landing jars the engine a little; the wheels take the rest via the suspension
        add('engine', strength * 0.08);
      } else if (upsideDown) {
        zone = 'windscreen'; // roof/pillar hit while rolling
        add('windscreen', 0.25 + strength * 0.5);
        add('front', strength * 0.15);
      } else if (Math.abs(local.z) >= Math.abs(local.x)) {
        zone = local.z < 0 ? 'front' : 'rear';
        add(zone, 0.12 + strength * 0.45);
        if (zone === 'front') {
          add('engine', strength * 0.35);
          if (strength > 0.15) add('windscreen', 0.1 + strength * 0.5);
        }
      } else {
        zone = local.x > 0 ? 'right' : 'left'; // pushed left = hit on the right
        add(zone, 0.12 + strength * 0.45);
        if (strength > 0.35) add('windscreen', strength * 0.25);
      }
      if (zone === 'left') this.damageWheel(strength > 0.5 ? 0 : 2, strength * 0.5);
      if (zone === 'right') this.damageWheel(strength > 0.5 ? 1 : 3, strength * 0.5);
      if (zone === 'front' && strength > 0.4) this.damageWheel(local.x > 0 ? 1 : 0, strength * 0.35);
      this.telemetry.damage = Math.min(1, (d.front + d.left + d.right + d.rear + d.engine) / 3.2);
      this.impactCooldown = 0.35;
      this.onImpact?.(strength, zone);
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

  /** Potholes: a wheel dropping into one jolts the car and damages the wheel. */
  private checkWheelHits(dt: number, absSpeed: number) {
    const c = this.controller;
    for (let i = 0; i < 4; i++) {
      this.potholeCooldown[i] -= dt;
      if (this.wheelLost[i] || this.potholeCooldown[i] > 0 || !c.wheelIsInContact(i)) continue;
      const cp = c.wheelContactPoint(i);
      if (!cp) continue;
      for (const p of this.nearbyPotholes) {
        const dx = cp.x - p.x, dz = cp.z - p.z;
        if (dx * dx + dz * dz > p.radius * p.radius) continue;
        this.potholeCooldown[i] = 0.4;
        const speedFactor = Math.min(1.6, absSpeed / 22);
        if (speedFactor < 0.15) break;
        // the edge of the hole kicks the wheel up and scrubs speed
        const kick = 170 * p.severity * speedFactor; // a sharp jolt, not a launch
        const lv = this.body.linvel();
        const sp = Math.hypot(lv.x, lv.z) || 1;
        this.body.applyImpulseAtPoint({ x: (-lv.x / sp) * kick * 0.35, y: kick, z: (-lv.z / sp) * kick * 0.35 }, cp, true);
        // suspension upgrades + armour soften the blow
        const soften = Math.max(0.35, 1 - (this.def.suspension - 1) * 2.5 - this.def.armour * 0.4);
        const dmg = p.severity * speedFactor * 0.32 * soften;
        this.damageWheel(i, dmg);
        this.onWheelHit?.(i, Math.min(1, p.severity * speedFactor));
        break;
      }
    }
  }

  /** Adds damage to a wheel; at 100% it breaks off. */
  damageWheel(i: number, amount: number) {
    if (this.wheelLost[i] || amount <= 0) return;
    this.wheelDamage[i] = Math.min(1, this.wheelDamage[i] + amount);
    if (this.wheelDamage[i] >= 1) {
      this.wheelLost[i] = true;
      // the corner drops onto the hub: tiny "wheel", no spring
      this.controller.setWheelRadius(i, 0.06);
      this.controller.setWheelSuspensionRestLength(i, 0.06);
      this.model.wheels[i].visible = false;
      this.onWheelLost?.(i, WHEEL_NAMES[i]);
    }
  }

  /** Must be called after world.step() to clear accumulated user forces. */
  afterStep() {
    this.body.resetForces(true);
    this.body.resetTorques(true);
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
      // bent wheels lean and wobble
      const wd = this.wheelDamage[i];
      w.rotation.z = wd * 0.22 * (i % 2 ? -1 : 1) + Math.sin(this.wobble + i) * wd * 0.05;
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
