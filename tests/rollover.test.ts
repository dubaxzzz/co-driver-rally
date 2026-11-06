/**
 * Roll-over test: drives the car hard into full-lock turns and a slalom on
 * flat ground and reports the maximum body roll. A car that flips fails.
 * Mirrors the chassis/suspension set-up in client/src/game/vehicle/Vehicle.ts.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { SUSPENSION, CHASSIS } from '../client/src/game/vehicle/setup';
import { VEHICLES } from '../shared/src/vehicles';
const GRIP = Number(process.env.GRIP ?? VEHICLES[0].grip);

await RAPIER.init();

function run(label: string, steerPattern: (t: number) => number, throttle = 1) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setTranslation(0, -0.5, 0).setFriction(0.9));
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1.2, 0).setCanSleep(false).setAngularDamping(CHASSIS.angularDamping));
  const m = 1230, hx = 0.86, hy = 0.32, hz = 1.95;
  const inertia = { x: (m / 12) * (4 * hy * hy + 4 * hz * hz), y: (m / 12) * (4 * hx * hx + 4 * hz * hz), z: (m / 12) * (4 * hx * hx + 4 * hy * hy) };
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(0, 0.1, 0).setMassProperties(m, { x: 0, y: CHASSIS.comY, z: 0.05 }, inertia, { x: 0, y: 0, z: 0, w: 1 }), body);
  const c = world.createVehicleController(body);
  c.indexUpAxis = 1;
  c.setIndexForwardAxis = 2;
  const pts: Array<[number, number]> = [[0.8, 1.28], [-0.8, 1.28], [0.8, -1.22], [-0.8, -1.22]];
  pts.forEach(([x, z], i) => {
    c.addWheel({ x, y: CHASSIS.wheelY, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, SUSPENSION.restLength, 0.34);
    c.setWheelSuspensionStiffness(i, SUSPENSION.stiffness);
    c.setWheelSuspensionCompression(i, SUSPENSION.compression);
    c.setWheelSuspensionRelaxation(i, SUSPENSION.relaxation);
    c.setWheelMaxSuspensionTravel(i, SUSPENSION.maxTravel);
    c.setWheelMaxSuspensionForce(i, SUSPENSION.maxForce);
    c.setWheelFrictionSlip(i, GRIP);
    c.setWheelSideFrictionStiffness(i, 1);
  });
  let maxRoll = 0, topSpeed = 0, flipped = false, maxLatG = 0;
  let prevV = { x: 0, y: 0, z: 0 };
  for (let f = 0; f < 60 * 14; f++) {
    const t = f / 60;
    const r = body.rotation();
    const q = { x: r.x, y: r.y, z: r.z, w: r.w };
    // vectors from quaternion
    const rot = (vx: number, vy: number, vz: number) => {
      const ix = q.w * vx + q.y * vz - q.z * vy, iy = q.w * vy + q.z * vx - q.x * vz, iz = q.w * vz + q.x * vy - q.y * vx, iw = -q.x * vx - q.y * vy - q.z * vz;
      return { x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x };
    };
    const fwd = rot(0, 0, 1), up = rot(0, 1, 0);
    const lv = body.linvel();
    const speed = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    topSpeed = Math.max(topSpeed, speed);
    const steer = steerPattern(t) * 0.55 / (1 + Math.abs(speed) / 22);
    for (let i = 0; i < 4; i++) {
      c.setWheelEngineForce(i, t > 3 ? throttle * 8200 * 0.25 * (speed > 28 ? 0 : 1) : 8200 * 0.25);
      c.setWheelBrake(i, 0);
      if (i < 2) c.setWheelSteering(i, t > 3 ? steer : 0);
    }
    c.updateVehicle(world.timestep);
    body.resetForces(false);
    body.resetTorques(false);
    body.addForce({ x: 0, y: -Math.min(6000, 1.6 * speed * speed), z: 0 }, true);
    // anti-roll bars + roll stabiliser (same maths as Vehicle.ts)
    for (const [l, rr, k] of [[0, 1, SUSPENSION.antiRollFront], [2, 3, SUSPENSION.antiRollRear]] as const) {
      if (!c.wheelIsInContact(l) || !c.wheelIsInContact(rr)) continue;
      const cl = SUSPENSION.restLength - (c.wheelSuspensionLength(l) ?? SUSPENSION.restLength);
      const cr = SUSPENSION.restLength - (c.wheelSuspensionLength(rr) ?? SUSPENSION.restLength);
      const fz = (cl - cr) * k * 0.5;
      const pl = c.wheelHardPoint(l)!, pr = c.wheelHardPoint(rr)!;
      body.addForceAtPoint({ x: up.x * fz, y: up.y * fz, z: up.z * fz }, pl, true);
      body.addForceAtPoint({ x: -up.x * fz, y: -up.y * fz, z: -up.z * fz }, pr, true);
    }
    // roll stabiliser: torque about the forward axis that pulls "up" back toward world up
    const side = { x: up.y * fwd.z - up.z * fwd.y, y: up.z * fwd.x - up.x * fwd.z, z: up.x * fwd.y - up.y * fwd.x }; // up × fwd (= left)
    const rollSin = side.y; // >0 when the car leans right
    const av = body.angvel();
    const rollRate = av.x * fwd.x + av.y * fwd.y + av.z * fwd.z;
    const tq = (-rollSin * CHASSIS.rollStabiliser - rollRate * CHASSIS.rollDamping);
    body.addTorque({ x: fwd.x * tq, y: fwd.y * tq, z: fwd.z * tq }, true);
    world.step();
    // true sideways acceleration (change of velocity along the car's left axis)
    const left = { x: up.y * fwd.z - up.z * fwd.y, y: up.z * fwd.x - up.x * fwd.z, z: up.x * fwd.y - up.y * fwd.x };
    const ax = (lv.x - prevV.x) * 60, ay = (lv.y - prevV.y) * 60, az = (lv.z - prevV.z) * 60;
    prevV = { x: lv.x, y: lv.y, z: lv.z };
    if (t > 4) maxLatG = Math.max(maxLatG, Math.abs(ax * left.x + ay * left.y + az * left.z) / 9.81);
    const roll = Math.asin(Math.max(-1, Math.min(1, side.y))) * 57.3;
    maxRoll = Math.max(maxRoll, Math.abs(roll));
    if (up.y < 0.2) flipped = true;
  }
  console.log(`${flipped ? 'FAIL' : 'PASS'}  ${label}: max roll ${maxRoll.toFixed(1)}°, cornering ${maxLatG.toFixed(2)} g, top speed ${(topSpeed * 3.6).toFixed(0)} km/h${flipped ? ' – FLIPPED' : ''}`);
  return !flipped;
}

const results = [
  run('full-lock left at speed', () => 1),
  run('full-lock right at speed', () => -1),
  run('fast slalom (lock-to-lock every 0.8 s)', (t) => (Math.floor(t / 0.8) % 2 ? 1 : -1)),
  run('quick flick (lock-to-lock every 0.4 s)', (t) => (Math.floor(t / 0.4) % 2 ? 1 : -1)),
];
if (results.some((r) => !r)) process.exit(1);
