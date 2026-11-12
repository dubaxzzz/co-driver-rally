/** Career economy checks: prize money, repair bills, upgrade prices and effects. */
import { NAVIGATOR_SHARE, VEHICLES, applyUpgrades, computePrize, noUpgrades, repairCost, upgradeCost, vehicleById } from '../shared/src/index';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const clean = { zones: [0, 0, 0, 0, 0, 0], wheels: [0, 0, 0, 0] };

const solo = computePrize({ stageLengthM: 3000, weather: 'clear', aiSkill: 'medium', position: 1, fieldSize: 1, resets: 0, ...clean });
check(solo.total === 1800 + 400, `solo 3 km clean run in clear weather pays $${solo.total} (base + clean bonus)`);

const storm = computePrize({ stageLengthM: 3000, weather: 'storm', aiSkill: 'medium', position: 1, fieldSize: 1, resets: 0, ...clean });
check(storm.total > solo.total, `night storm pays more ($${storm.total})`);

const win = computePrize({ stageLengthM: 3000, weather: 'clear', aiSkill: 'hard', position: 1, fieldSize: 4, resets: 0, ...clean });
const fourth = computePrize({ stageLengthM: 3000, weather: 'clear', aiSkill: 'hard', position: 4, fieldSize: 4, resets: 0, ...clean });
check(win.total > fourth.total * 2, `beating 3 hard AI pays far more ($${win.total}) than finishing last ($${fourth.total})`);

const crashed = computePrize({ stageLengthM: 3000, weather: 'clear', aiSkill: 'medium', position: 1, fieldSize: 1, resets: 2, zones: [0.8, 0.3, 0, 0, 0.6, 0.5], wheels: [1, 0.4, 0, 0] });
check(crashed.lines.some((l) => l.label === 'Repair bill' && l.amount < 0) && crashed.total < solo.total, `crash damage comes off the prize (repairs $${repairCost([0.8, 0.3, 0, 0, 0.6, 0.5], [1, 0.4, 0, 0])}, paid $${crashed.total})`);
const wrecked = computePrize({ stageLengthM: 1000, weather: 'clear', aiSkill: 'easy', position: 1, fieldSize: 1, resets: 5, zones: [1, 1, 1, 1, 1, 1], wheels: [1, 1, 1, 1] });
check(wrecked.total === 0, 'a wrecked car never pays a negative prize');
check(Math.round(win.total * NAVIGATOR_SHARE) === Math.round(win.total * 0.4), 'navigator share is 40%');

const kestrel = vehicleById('kestrel-r5');
const vortex = vehicleById('vortex-rx');
check(upgradeCost(vortex, 'engine', 1) > upgradeCost(kestrel, 'engine', 1), 'upgrading a faster car costs more');
check(upgradeCost(kestrel, 'engine', 3) > upgradeCost(kestrel, 'engine', 2) && upgradeCost(kestrel, 'engine', 2) > upgradeCost(kestrel, 'engine', 1), 'each upgrade level costs more than the last');
const maxed = applyUpgrades(kestrel, { engine: 3, gearbox: 3, tyres: 3, suspension: 3, brakes: 3, armour: 3 });
check(maxed.enginePowerN > kestrel.enginePowerN * 1.2 && maxed.grip > kestrel.grip && maxed.brakeForce > kestrel.brakeForce && maxed.armour > kestrel.armour && maxed.shiftTime < kestrel.shiftTime, 'upgrades improve power, grip, brakes, armour and shift time');
check(JSON.stringify(applyUpgrades(kestrel, noUpgrades())) === JSON.stringify(kestrel), 'no upgrades = stock car');
check(VEHICLES.filter((v) => v.price === 0).length === 1 && VEHICLES.length === 5, 'five cars, one free starter');

if (failures) process.exit(1);
