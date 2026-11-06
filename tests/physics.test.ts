/**
 * Headless Rapier check of the vehicle setup: the car accelerates forward
 * (+Z), positive steer turns left, and braking stops it. Uses the same
 * Rapier calls and parameters as client/src/game/vehicle/Vehicle.ts.
 */
import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 60;
world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(0, -0.5, 0).setFriction(0.9));

const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setCanSleep(false).setAngularDamping(0.6));
const m = 1230;
world.createCollider(
  RAPIER.ColliderDesc.cuboid(0.86, 0.32, 1.95).setTranslation(0, 0.1, 0)
    .setMassProperties(m, { x: 0, y: -0.36, z: 0.05 }, { x: 1600, y: 1800, z: 400 }, { x: 0, y: 0, z: 0, w: 1 }),
  body,
);
const c = world.createVehicleController(body);
c.indexUpAxis = 1;
c.setIndexForwardAxis = 2;
const pts: Array<[number, number]> = [[0.8, 1.28], [-0.8, 1.28], [0.8, -1.22], [-0.8, -1.22]];
pts.forEach(([x, z], i) => {
  c.addWheel({ x, y: -0.12, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, 0.3, 0.34);
  c.setWheelSuspensionStiffness(i, 26);
  c.setWheelSuspensionCompression(i, 2.3);
  c.setWheelSuspensionRelaxation(i, 3.1);
  c.setWheelMaxSuspensionTravel(i, 0.22);
  c.setWheelMaxSuspensionForce(i, 70000);
  c.setWheelFrictionSlip(i, 2.1);
  c.setWheelSideFrictionStiffness(i, 1);
});

const run = (frames: number, force: number, steer: number, brake: number) => {
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < 4; i++) {
      c.setWheelEngineForce(i, force / 4);
      c.setWheelBrake(i, brake);
      if (i < 2) c.setWheelSteering(i, steer);
    }
    c.updateVehicle(world.timestep);
    world.step();
  }
};

let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

run(90, 0, 0, 0);
const rest = body.translation();
check(rest.y > 0.2 && rest.y < 1.2, `car settles on its suspension (y=${rest.y.toFixed(2)})`);
run(180, 8000, 0, 0);
const p1 = body.translation();
const v1 = body.linvel();
check(p1.z > 5 && Math.abs(p1.x) < 1, `engine force drives the car forward along +Z (z=${p1.z.toFixed(1)}, speed ${(Math.hypot(v1.x, v1.z) * 3.6).toFixed(0)} km/h)`);
run(120, 3000, 0.4, 0);
const p2 = body.translation();
check(p2.x > p1.x + 1, `positive steering turns left toward +X (dx=${(p2.x - p1.x).toFixed(1)})`);
run(240, 0, 0, 30);
const v3 = body.linvel();
check(Math.hypot(v3.x, v3.z) < 1.5, `brakes stop the car (speed ${Math.hypot(v3.x, v3.z).toFixed(2)} m/s)`);
if (fails) process.exit(1);
