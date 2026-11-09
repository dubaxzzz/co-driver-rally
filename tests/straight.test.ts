/**
 * Straight-line test – real Vehicle class, headless. Full throttle, hands off
 * the wheel: the car must not drift or turn to either side.
 *   npx tsx tests/straight.test.ts
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
  for (const throttle of [1, 0.5]) {
    const physics = new PhysicsWorld(R);
    const ground = physics.world.createCollider(R.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, -0.5, 0));
    const v = new Vehicle(physics, car, WHEELS[0], stub);
    v.roadColliders.add(ground.handle);
    v.place(0, 1, 0, 0);
    v.frozen = false;
    for (let f = 0; f < 60 * 10; f++) {
      v.step(1 / 60, { throttle, brake: 0, steer: 0, handbrake: false });
      physics.world.step();
      v.afterStep();
    }
    const p = v.position;
    const headingDeg = THREE.MathUtils.radToDeg(v.heading);
    const bad = Math.abs(p.x) > 1.5 || Math.abs(headingDeg) > 1.5;
    if (bad) failures++;
    console.log(`${bad ? 'FAIL' : 'PASS'}  ${car.name.padEnd(12)} throttle ${throttle}  sideways ${p.x.toFixed(2)} m (+ = left)  heading ${headingDeg.toFixed(2)}°  after ${p.z.toFixed(0)} m`);
  }
}
process.exit(failures ? 1 : 0);
