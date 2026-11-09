/**
 * Handling test – runs the REAL Vehicle class (client/src/game/vehicle/Vehicle.ts)
 * headless with Rapier and measures how far the back of the car steps out
 * (body slip angle) in gentle, medium and full-lock turns under throttle.
 * A car that spins (slip > 60°) fails; gentle turns must stay tidy.
 *
 *   npm run test:handling
 */
import * as THREE from 'three';
import { VEHICLES, WHEELS, type VehicleDef } from '../shared/src/vehicles';
import { applyUpgrades, noUpgrades } from '../shared/src/career';
import { loadRapier, PhysicsWorld } from '../client/src/game/physics/PhysicsWorld';
import { Vehicle } from '../client/src/game/vehicle/Vehicle';
import type { CarModel } from '../client/src/game/vehicle/CarModel';

import { CHASSIS, SUSPENSION } from '../client/src/game/vehicle/setup';
// Experiments: CHASSIS='{"yawDamping":5000}' npx tsx tests/handling.test.ts
Object.assign(CHASSIS, JSON.parse(process.env.CHASSIS ?? '{}'));
Object.assign(SUSPENSION, JSON.parse(process.env.SUSPENSION ?? '{}'));
if (process.env.GRIP) VEHICLES[0].grip = Number(process.env.GRIP);

const R = await loadRapier();

// The physics never touches the model during step(), so a stub is enough.
const stubModel = { root: new THREE.Group(), body: new THREE.Group(), wheels: [] } as unknown as CarModel;

interface Scenario {
  name: string;
  steer: number; // keyboard steer target (-1..1), like holding A
  throttle: number;
  maxSlipDeg: number; // pass threshold
  pulse?: boolean; // tap the key (0.3 s on / 0.3 s off) instead of holding
  handbrake?: boolean; // pull the handbrake for 0.6 s at the start of the turn
  minSlipDeg?: number; // the back MUST step out at least this much
}

let CAR: VehicleDef = VEHICLES[0];
function run(sc: Scenario) {
  const physics = new PhysicsWorld(R);
  const ground = physics.world.createCollider(R.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, -0.5, 0));
  const v = new Vehicle(physics, CAR, WHEELS[0], stubModel);
  v.roadColliders.add(ground.handle);
  v.place(0, 1.0, 0, 0);
  v.frozen = false;
  const input = { throttle: 1, brake: 0, steer: 0, handbrake: false };
  let steerValue = 0;
  let maxSlip = 0, maxSpeed = 0, spun = false;
  const dt = physics.fixedDt;
  for (let f = 0; f < 60 * 13; f++) {
    const t = f / 60;
    const speed = v.telemetry.speed;
    // same speed-sensitive, rate-limited steering as client/src/game/input/Input.ts
    let target = 0;
    if (t > 5) {
      const on = !sc.pulse || Math.floor((t - 5) / 0.3) % 2 === 0;
      target = on ? sc.steer : 0;
    }
    const limit = 1 / (1 + Math.abs(speed) / 22);
    const tgt = target * Math.max(0.3, limit);
    const rate = target === 0 || Math.sign(tgt) !== Math.sign(steerValue) ? 6 : 3.2;
    const diff = tgt - steerValue;
    steerValue += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    input.steer = steerValue;
    input.throttle = t > 5 ? sc.throttle : 1;
    input.handbrake = !!sc.handbrake && t > 5 && t < 5.6;
    v.step(dt, input);
    physics.world.step();

    const lv = v.body.linvel();
    const vel = new THREE.Vector3(lv.x, 0, lv.z);
    const sp = vel.length();
    maxSpeed = Math.max(maxSpeed, sp);
    if (t > 5 && sp > 4) {
      const h = v.heading;
      const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
      const slip = (Math.acos(Math.max(-1, Math.min(1, fwd.dot(vel.normalize())))) * 180) / Math.PI;
      maxSlip = Math.max(maxSlip, slip);
      if (slip > Math.max(60, sc.maxSlipDeg)) spun = true;
    }
  }
  const ok = !spun && maxSlip <= sc.maxSlipDeg && maxSlip >= (sc.minSlipDeg ?? 0);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${sc.name}: max slip ${maxSlip.toFixed(1)}° (limit ${sc.maxSlipDeg}°), top ${(maxSpeed * 3.6).toFixed(0)} km/h${spun ? ' – SPUN OUT' : ''}`);
  physics.dispose();
  return ok;
}

const scenarios: Scenario[] = [
  { name: 'tap steering at speed', steer: 1, throttle: 1, maxSlipDeg: 12, pulse: true },
  { name: 'gentle turn (25% steer) on throttle', steer: 0.25, throttle: 1, maxSlipDeg: 10 },
  { name: 'medium turn (50% steer) on throttle', steer: 0.5, throttle: 1, maxSlipDeg: 20 },
  { name: 'full lock on throttle', steer: 1, throttle: 1, maxSlipDeg: 45 },
  { name: 'full lock, lifting off', steer: 1, throttle: 0, maxSlipDeg: 45 },
  { name: 'handbrake turn still slides the back out', steer: 1, throttle: 0.6, maxSlipDeg: 180, minSlipDeg: 12, handbrake: true },
];
const results: boolean[] = [];
const maxed = { engine: 3, gearbox: 3, tyres: 3, suspension: 3, brakes: 3, armour: 3 };
for (const car of VEHICLES) {
  for (const [label, lv] of [['stock', noUpgrades()], ['fully upgraded', maxed]] as const) {
    CAR = applyUpgrades(car, lv);
    console.log(`\n${car.name} (${car.drive}, ${label})`);
    for (const sc of scenarios) {
      // rear-drive cars are allowed to step out more on full-lock power – that's their character
      const tuned = car.drive === 'RWD' && sc.name.startsWith('full lock on') ? { ...sc, maxSlipDeg: 55 } : sc;
      results.push(run(tuned));
    }
  }
}
if (results.some((r) => !r)) process.exit(1);
