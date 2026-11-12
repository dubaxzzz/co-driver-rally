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
check(VEHICLES.filter((v) => v.price === 0).length === 1 && VEHICLES.length === 25, '25 cars, one free starter');

if (failures) process.exit(1);

// ---- car systems (co-driver jobs) model
{
  const { defaultSystems, systemsTargetTemp, systemsPower, systemsGrip, encodeSystems, decodeSystems } = await import('../shared/src/switches');
  const s = defaultSystems();
  const flatOut = { load: 1, speed: 25, ambient: 15, engineOn: true };
  s.map = 2;
  s.flaps = true;
  const openT = systemsTargetTemp(s, flatOut);
  s.flaps = false;
  const shutT = systemsTargetTemp(s, flatOut);
  check(openT < 104 && shutT > 112, `attack map flat out: radiator open ${openT.toFixed(0)}°C is fine, shut ${shutT.toFixed(0)}°C overheats`);
  const snow = { load: 0.6, speed: 15, ambient: -5, engineOn: true };
  s.map = 1;
  s.flaps = true;
  const cold = systemsTargetTemp(s, snow);
  s.flaps = false;
  check(cold < 62 && systemsTargetTemp(s, snow) > 62, 'in the snow the engine runs cold unless the radiator is shut');
  s.temp = 90;
  check(Math.abs(systemsPower({ ...s, map: 2, als: true }) / systemsPower({ ...s, map: 1, als: false }) - 1.1235) < 0.01, 'attack + anti-lag gives ~12% more power');
  check(systemsGrip({ ...s, tyres: 0 }, 'gravel') > systemsGrip({ ...s, tyres: 2 }, 'gravel') && systemsGrip({ ...s, tyres: 2 }, 'tarmac') > systemsGrip({ ...s, tyres: 0 }, 'tarmac'), 'low pressures for gravel, high for tarmac');
  const enc = decodeSystems(encodeSystems({ flaps: true, als: false, map: 2, tyres: 0, fuse: 3, temp: 0 }), 99);
  check(enc.flaps && !enc.als && enc.map === 2 && enc.tyres === 0 && enc.fuse === 3 && enc.temp === 99, 'systems survive the telemetry round trip');
}
