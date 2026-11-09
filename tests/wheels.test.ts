/**
 * Wheel damage test – real Vehicle class, headless:
 *  - a normal stage jump only bruises the wheels
 *  - potholes hurt at speed, barely at walking pace
 *  - repeated big hits knock a wheel off, and the car can still limp on
 *   npm run test:wheels
 */
import * as THREE from 'three';
import { VEHICLES, WHEELS } from '../shared/src/vehicles';
import { loadRapier, PhysicsWorld } from '../client/src/game/physics/PhysicsWorld';
import { Vehicle, type NearbyPothole } from '../client/src/game/vehicle/Vehicle';
import type { CarModel } from '../client/src/game/vehicle/CarModel';

import { CHASSIS, SUSPENSION } from '../client/src/game/vehicle/setup';
Object.assign(CHASSIS, JSON.parse(process.env.CHASSIS ?? '{}'));
Object.assign(SUSPENSION, JSON.parse(process.env.SUSPENSION ?? '{}'));
const R = await loadRapier();
const stub = () => ({ root: new THREE.Group(), body: new THREE.Group(), wheels: [0, 1, 2, 3].map(() => new THREE.Group()) }) as unknown as CarModel;
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

function world(withRamp: boolean) {
  const physics = new PhysicsWorld(R);
  const ground = physics.world.createCollider(R.ColliderDesc.cuboid(2000, 0.5, 3000).setTranslation(0, -0.5, 1000));
  if (withRamp) {
    // the same kicker shape the stages use: 1.8 m up over 30 m, then a short drop
    const ramp = new Float32Array([-6, 0, 300, 6, 0, 300, -6, 1.8, 330, 6, 1.8, 330, -6, 0, 340, 6, 0, 340]);
    const idx = new Uint32Array([0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5]);
    physics.world.createCollider(R.ColliderDesc.trimesh(ramp, idx));
  }
  const v = new Vehicle(physics, VEHICLES[0], WHEELS[0], stub());
  v.roadColliders.add(ground.handle);
  v.place(0, 1, 0, 0);
  v.frozen = false;
  return { physics, v };
}

function drive(v: Vehicle, physics: PhysicsWorld, seconds: number, targetKmh: number) {
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  for (let f = 0; f < seconds * 60; f++) {
    const kmh = v.telemetry.speed * 3.6;
    // hold a straight line along +Z like a driver would (counter the pull of a damaged wheel)
    const x = v.body.translation().x;
    input.steer = Math.max(-1, Math.min(1, -v.heading * 3 - x * 0.05));
    input.throttle = kmh < targetKmh ? 1 : 0;
    input.brake = kmh > targetKmh + 8 ? 0.4 : 0;
    v.step(physics.fixedDt, input);
    physics.world.step();
  }
}

// 1. jump
{
  const { physics, v } = world(true);
  drive(v, physics, 22, 95);
  const worst = Math.max(...v.wheelDamage);
  check(v.body.translation().z > 360 && worst < 0.4 && !v.wheelLost.some(Boolean), `normal jump at ~95 km/h: worst wheel ${(worst * 100).toFixed(0)}%, none lost`);
  physics.dispose();
}

// 2. pothole at speed vs walking pace
const hole = (z: number): NearbyPothole => ({ x: 0.8, z, radius: 0.7, severity: 1 });
{
  const { physics, v } = world(false);
  v.nearbyPotholes = [hole(200)];
  drive(v, physics, 12, 100);
  const fast = v.wheelDamage[0] + v.wheelDamage[2];
  physics.dispose();
  const slow = world(false);
  slow.v.nearbyPotholes = [hole(20)];
  drive(slow.v, slow.physics, 12, 18);
  const crawl = slow.v.wheelDamage[0] + slow.v.wheelDamage[2];
  slow.physics.dispose();
  check(fast > 0.2, `deep pothole at 100 km/h damages the left wheels (${(fast * 100).toFixed(0)}%)`);
  check(crawl < fast * 0.3, `same pothole at 18 km/h barely hurts (${(crawl * 100).toFixed(0)}%)`);
}

// 3. repeated hits -> wheel comes off, car limps on and pulls
{
  const { physics, v } = world(false);
  let lostName = '';
  v.onWheelLost = (_i, name) => (lostName = name);
  drive(v, physics, 8, 105);
  for (let k = 0; k < 8 && !v.wheelLost.some(Boolean); k++) {
    // drop a deep pothole right in the path of the left wheels, 25 m ahead
    const p = v.body.translation();
    const h = v.heading;
    const fx = Math.sin(h), fz = Math.cos(h), lx = Math.cos(h), lz = -Math.sin(h);
    v.nearbyPotholes = [{ x: p.x + fx * 25 + lx * 0.8, z: p.z + fz * 25 + lz * 0.8, radius: 0.8, severity: 1 }];
    drive(v, physics, 2.5, 105);
    if (process.env.DEBUG) console.log('   hit', k, 'wheels', v.wheelDamage.map((w) => w.toFixed(2)).join(' '), 'speed', (v.telemetry.speed * 3.6).toFixed(0), 'upright', v.upright.toFixed(2));
  }
  check(v.wheelLost.some(Boolean), `a string of deep potholes knocks a wheel off (${lostName || 'none'})`);
  const z0 = v.body.translation().z;
  v.nearbyPotholes = [];
  drive(v, physics, 8, 60);
  const moved = v.body.translation().z - z0;
  check(moved > 20, `car still limps on without the wheel (${moved.toFixed(0)} m in 8 s)`);
  v.resetDamage();
  check(!v.wheelLost.some(Boolean) && v.wheelDamage.every((w) => w === 0), 'restarting the stage refits and repairs the wheels');
  physics.dispose();
}

if (failures) process.exit(1);
