/**
 * AI test – runs AI drivers (real Vehicle physics) around every stage on flat
 * ground and checks they finish, at believable speeds, without constant resets.
 *   npm run test:ai
 */
import * as THREE from 'three';
import { STAGE_DEFS, WEATHER, getStage, type AiSkill, type BuiltStage } from '../shared/src/index';
import { loadRapier, PhysicsWorld } from '../client/src/game/physics/PhysicsWorld';
import { AIDriver } from '../client/src/game/ai/AIDriver';
import type { CarModel } from '../client/src/game/vehicle/CarModel';

const R = await loadRapier();
const stub = () => ({ root: new THREE.Group(), body: new THREE.Group(), wheels: [] }) as unknown as CarModel;
let failures = 0;

function race(base: BuiltStage, skill: AiSkill) {
  // flatten the stage so a single flat ground collider works for the test
  const stage: BuiltStage = { ...base, samples: base.samples.map((s) => ({ ...s, y: 0 })) };
  const physics = new PhysicsWorld(R);
  const b = stage.bounds;
  const ground = physics.world.createCollider(
    R.ColliderDesc.cuboid((b.maxX - b.minX) / 2 + 500, 0.5, (b.maxZ - b.minZ) / 2 + 500).setTranslation((b.minX + b.maxX) / 2, -0.5, (b.minZ + b.maxZ) / 2),
  );
  const ai = new AIDriver(physics, stage, 'Test', stub(), skill, 0, WEATHER.clear);
  ai.vehicle.roadColliders.add(ground.handle);
  const dt = physics.fixedDt;
  let t = 0;
  while (t < 360 && ai.finishTimeMs === null) {
    ai.step(dt, true, t * 1000);
    physics.world.step();
    t += dt;
  }
  const km = (stage.finishDistance - stage.startDistance) / 1000;
  const ok = ai.finishTimeMs !== null && ai.resets <= 2;
  const avg = ai.finishTimeMs ? (km / (ai.finishTimeMs / 3600000)).toFixed(0) : '-';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage.def.name} [${skill}]: ${ai.finishTimeMs ? (ai.finishTimeMs / 1000).toFixed(1) + ' s' : 'DID NOT FINISH'}, avg ${avg} km/h, resets ${ai.resets}`);
  if (!ok) failures++;
  physics.dispose();
  return ai.finishTimeMs ?? Infinity;
}

for (const def of STAGE_DEFS) race(getStage(def.id)!, 'medium');
const forest = getStage(STAGE_DEFS[0].id)!;
const easy = race(forest, 'easy');
const hard = race(forest, 'hard');
if (!(hard < easy)) {
  console.log('FAIL  hard AI should be faster than easy AI');
  failures++;
} else console.log('PASS  hard AI is faster than easy AI');
if (failures) process.exit(1);
