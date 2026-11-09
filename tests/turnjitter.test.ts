/**
 * Turn smoothness test – real Vehicle class, headless. Holds a steady turn and
 * measures high-frequency wobble in roll, pitch and yaw rate (step-to-step
 * changes). A smooth car changes these gradually; jitter = glitchy view.
 *   npx tsx tests/turnjitter.test.ts
 */
import * as THREE from 'three';
import { VEHICLES, WHEELS } from '../shared/src/vehicles';
import { loadRapier, PhysicsWorld } from '../client/src/game/physics/PhysicsWorld';
import { Vehicle } from '../client/src/game/vehicle/Vehicle';
import type { CarModel } from '../client/src/game/vehicle/CarModel';

const R = await loadRapier();
const stub = { root: new THREE.Group(), body: new THREE.Group(), wheels: [] } as unknown as CarModel;
let failures = 0;
for (const car of VEHICLES) {
  for (const steer of [0.3, 0.7, 1]) {
    const physics = new PhysicsWorld(R);
    const ground = physics.world.createCollider(R.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, -0.5, 0));
    const v = new Vehicle(physics, car, WHEELS[0], stub);
    v.roadColliders.add(ground.handle);
    v.place(0, 1, 0, 0);
    v.frozen = false;
    let s = 0;
    const rolls: number[] = [], yawr: number[] = [], pitches: number[] = [];
    for (let f = 0; f < 60 * 12; f++) {
      const t = f / 60;
      const tgt = t > 5 ? steer * Math.max(0.3, 1 / (1 + Math.abs(v.telemetry.speed) / 22)) : 0;
      s += Math.sign(tgt - s) * Math.min(Math.abs(tgt - s), 3.2 / 60);
      v.step(1 / 60, { throttle: t < 4 ? 1 : 0.55, brake: 0, steer: s, handbrake: false });
      physics.world.step();
      v.afterStep();
      if (t > 7) {
        const q = v.body.rotation();
        const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w), 'YXZ');
        rolls.push(e.z); pitches.push(e.x); yawr.push(v.body.angvel().y);
      }
    }
    // jitter = RMS of second difference (removes steady lean and slow changes)
    const jit = (a: number[]) => { let sum = 0; for (let i = 2; i < a.length; i++) { const d = a[i] - 2 * a[i - 1] + a[i - 2]; sum += d * d; } return Math.sqrt(sum / (a.length - 2)); };
    const jr = jit(rolls) * 1000, jp = jit(pitches) * 1000, jy = jit(yawr) * 1000;
    const bad = jr > 1.5 || jp > 1.5 || jy > 15;
    if (bad) failures++;
    console.log(`${bad ? 'FAIL' : 'PASS'}  ${car.name.padEnd(12)} steer ${steer}  roll-jitter ${jr.toFixed(2)}  pitch-jitter ${jp.toFixed(2)}  yawrate-jitter ${jy.toFixed(2)}  speed ${v.telemetry.speed.toFixed(1)}`);
  }
}
process.exit(failures ? 1 : 0);
