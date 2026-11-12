/** Career economy: upgrades and prize money. Pure functions – shared by every device. */
import type { AiSkill } from './types';
import type { VehicleDef } from './vehicles';
import type { WeatherId } from './weather';

export type UpgradeKind = 'engine' | 'gearbox' | 'tyres' | 'suspension' | 'brakes' | 'armour';
export type UpgradeLevels = Record<UpgradeKind, number>;
export const MAX_UPGRADE_LEVEL = 3;

export const UPGRADES: Array<{ kind: UpgradeKind; name: string; effect: string; baseCost: number }> = [
  { kind: 'engine', name: 'Engine', effect: '+8% power per level', baseCost: 12000 },
  { kind: 'gearbox', name: 'Gearbox', effect: 'Quicker, shorter gear changes', baseCost: 8000 },
  { kind: 'tyres', name: 'Tyres', effect: '+5% grip per level', baseCost: 6000 },
  { kind: 'suspension', name: 'Suspension', effect: 'Steadier over bumps and landings', baseCost: 9000 },
  { kind: 'brakes', name: 'Brakes', effect: '+12% stopping power per level', baseCost: 6000 },
  { kind: 'armour', name: 'Armour', effect: 'Less crash damage – smaller repair bills', baseCost: 7000 },
];

export const noUpgrades = (): UpgradeLevels => ({ engine: 0, gearbox: 0, tyres: 0, suspension: 0, brakes: 0, armour: 0 });

/** Price of buying `level` (1..3) of an upgrade for a car. Faster cars cost more to upgrade. */
export function upgradeCost(car: VehicleDef, kind: UpgradeKind, level: number): number {
  const base = UPGRADES.find((u) => u.kind === kind)!.baseCost;
  const tier = 1 + car.price / 250000;
  const mult = [0, 1, 2.2, 4][level] ?? 4;
  return Math.round((base * tier * mult) / 100) * 100;
}

/** The car's physics with upgrades applied. */
export function applyUpgrades(car: VehicleDef, lv: UpgradeLevels): VehicleDef {
  return {
    ...car,
    enginePowerN: car.enginePowerN * (1 + 0.08 * lv.engine),
    shiftTime: car.shiftTime * (1 - 0.22 * lv.gearbox),
    gearRatios: car.gearRatios.map((r) => r * (1 + 0.025 * lv.gearbox)),
    grip: car.grip * (1 + 0.05 * lv.tyres),
    suspension: car.suspension * (1 + 0.08 * lv.suspension),
    brakeForce: car.brakeForce * (1 + 0.12 * lv.brakes),
    armour: Math.min(0.6, car.armour + 0.1 * lv.armour),
  };
}

export const WEATHER_PAY: Record<WeatherId, number> = { clear: 1, overcast: 1.05, rain: 1.2, storm: 1.4, snow: 1.25, dusk: 1.1 };
export const SKILL_PAY: Record<AiSkill, number> = { easy: 0.5, medium: 1, hard: 1.6 };
/** The navigator earns this share of the crew's prize – on top, the driver keeps everything. */
export const NAVIGATOR_SHARE = 0.4;
export const STARTING_MONEY = 5000;

export interface PrizeInput {
  stageLengthM: number;
  weather: WeatherId;
  aiSkill: AiSkill;
  /** 1-based finishing position and size of the field (1 = no opponents). */
  position: number;
  fieldSize: number;
  /** Damage 0..1 by zone (front, left, right, rear, windscreen, engine). */
  zones: number[];
  /** @deprecated wheels no longer take damage – ignored. */
  wheels?: number[];
  resets: number;
  /** Championship rounds pay repairs at the service park instead. */
  includeRepairs?: boolean;
}

export interface PrizeLine {
  label: string;
  amount: number;
}

/** Damage repair cost – also used by the service park. */
export function repairCost(zones: number[], wheels: number[] = []): number {
  const z = zones.reduce((a, b) => a + b, 0) * 1500;
  const w = wheels.reduce((a, b) => a + Math.min(1, b), 0) * 700 + wheels.filter((b) => b >= 1).length * 1200;
  return Math.round((z + w) / 10) * 10;
}

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'];

export function computePrize(p: PrizeInput): { lines: PrizeLine[]; total: number } {
  const lines: PrizeLine[] = [];
  const base = Math.round((600 * p.stageLengthM) / 1000 / 10) * 10;
  lines.push({ label: `Stage finish (${(p.stageLengthM / 1000).toFixed(1)} km)`, amount: base });
  const w = WEATHER_PAY[p.weather] ?? 1;
  if (w > 1) lines.push({ label: 'Weather bonus', amount: Math.round((base * (w - 1)) / 10) * 10 });
  if (p.fieldSize > 1) {
    const bonus = [1, 0.5, 0.2][p.position - 1] ?? 0;
    const amount = Math.round((base * bonus * SKILL_PAY[p.aiSkill]) / 10) * 10;
    lines.push({ label: `${ORDINAL[p.position - 1] ?? `${p.position}th`} of ${p.fieldSize} (${p.aiSkill} field)`, amount });
  }
  const damageTotal = p.zones.reduce((a, b) => a + b, 0);
  if (p.resets === 0 && damageTotal < 0.1) lines.push({ label: 'Clean run', amount: 400 });
  const repairs = p.includeRepairs === false ? 0 : repairCost(p.zones);
  if (repairs > 0) lines.push({ label: 'Repair bill', amount: -repairs });
  const total = Math.max(0, lines.reduce((a, l) => a + l.amount, 0));
  return { lines, total };
}

export const bestKey = (stageId: string, weather: WeatherId) => `${stageId}|${weather}`;
