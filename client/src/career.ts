/**
 * Career save: money, cars you own (with their upgrades), the car you drive,
 * personal bests and lifetime stats. Saved in this browser (localStorage).
 */
import './progressReset';
import {
  MAX_UPGRADE_LEVEL,
  STARTER_CAR_ID,
  STARTING_MONEY,
  VEHICLES,
  applyUpgrades,
  noUpgrades,
  upgradeCost,
  vehicleById,
  type UpgradeKind,
  type UpgradeLevels,
  type VehicleDef,
} from '@cdr/shared';

export interface CareerSave {
  money: number;
  owned: Record<string, UpgradeLevels>;
  active: string;
  bests: Record<string, number>;
  /** Runs already paid out (so a refresh can't pay twice). */
  paid: string[];
  stats: { stages: number; wins: number; earned: number };
  /** Today's Daily Challenge progress. */
  daily: { date: string; bestMs: number | null; medal: 'none' | 'bronze' | 'silver' | 'gold'; finished: boolean };
}

const KEY = 'cdr.career';

function fresh(): CareerSave {
  return {
    money: STARTING_MONEY,
    owned: { [STARTER_CAR_ID]: noUpgrades() },
    active: STARTER_CAR_ID,
    bests: {},
    paid: [],
    stats: { stages: 0, wins: 0, earned: 0 },
    daily: { date: '', bestMs: null, medal: 'none', finished: false },
  };
}

function load(): CareerSave {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const s = { ...fresh(), ...JSON.parse(raw) } as CareerSave;
    if (!s.owned[s.active]) s.active = Object.keys(s.owned)[0] ?? STARTER_CAR_ID;
    return s;
  } catch {
    return fresh();
  }
}

type Listener = (s: CareerSave) => void;
let save = load();
const listeners = new Set<Listener>();

function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    /* storage unavailable – keep in memory */
  }
  listeners.forEach((l) => l(save));
}

export type CareerResult = { ok: true } | { ok: false; reason: string };

export const career = {
  get: () => save,
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  owns: (carId: string) => !!save.owned[carId],
  upgrades: (carId: string): UpgradeLevels => save.owned[carId] ?? noUpgrades(),
  /** The car you drive, with its upgrades applied. */
  activeDef(): VehicleDef {
    return applyUpgrades(vehicleById(save.active), career.upgrades(save.active));
  },
  setActive(carId: string) {
    if (!save.owned[carId]) return;
    save = { ...save, active: carId };
    commit();
  },
  buyCar(carId: string): CareerResult {
    const car = VEHICLES.find((v) => v.id === carId);
    if (!car) return { ok: false, reason: 'Unknown car.' };
    if (save.owned[carId]) return { ok: false, reason: 'You already own this car.' };
    if (save.money < car.price) return { ok: false, reason: `You need $${(car.price - save.money).toLocaleString()} more.` };
    save = { ...save, money: save.money - car.price, owned: { ...save.owned, [carId]: noUpgrades() }, active: carId };
    commit();
    return { ok: true };
  },
  /** Admin panel: every car in the dealership, for free. */
  adminGiveAllCars(): number {
    const owned = { ...save.owned };
    let added = 0;
    for (const v of VEHICLES) if (!owned[v.id]) (owned[v.id] = noUpgrades(), added++);
    save = { ...save, owned };
    commit();
    return added;
  },
  /** Admin panel: free money. */
  adminAddMoney(amount: number) {
    save = { ...save, money: save.money + Math.round(amount) };
    commit();
  },
  /** Limited events pay their prize once per event. */
  limitedDone(id: string): boolean {
    try {
      return (JSON.parse(localStorage.getItem('cdr.limitedDone') ?? '[]') as string[]).includes(id);
    } catch {
      return false;
    }
  },
  markLimitedDone(id: string) {
    try {
      const list = JSON.parse(localStorage.getItem('cdr.limitedDone') ?? '[]') as string[];
      localStorage.setItem('cdr.limitedDone', JSON.stringify([...list.slice(-50), id]));
    } catch {
      /* ignore */
    }
  },
  nextUpgradeCost(carId: string, kind: UpgradeKind): number | null {
    const level = career.upgrades(carId)[kind];
    if (level >= MAX_UPGRADE_LEVEL) return null;
    return upgradeCost(vehicleById(carId), kind, level + 1);
  },
  buyUpgrade(carId: string, kind: UpgradeKind): CareerResult {
    if (!save.owned[carId]) return { ok: false, reason: 'Buy the car first.' };
    const cost = career.nextUpgradeCost(carId, kind);
    if (cost === null) return { ok: false, reason: 'Already fully upgraded.' };
    if (save.money < cost) return { ok: false, reason: `You need $${(cost - save.money).toLocaleString()} more.` };
    const lv = { ...save.owned[carId], [kind]: save.owned[carId][kind] + 1 };
    save = { ...save, money: save.money - cost, owned: { ...save.owned, [carId]: lv } };
    commit();
    return { ok: true };
  },
  /** Adds prize money once per run. Returns false if this run was already paid. */
  credit(runKey: string, amount: number, won = false): boolean {
    if (save.paid.includes(runKey)) return false;
    save = {
      ...save,
      money: save.money + Math.max(0, Math.round(amount)),
      paid: [...save.paid.slice(-40), runKey],
      stats: { stages: save.stats.stages + 1, wins: save.stats.wins + (won ? 1 : 0), earned: save.stats.earned + Math.max(0, Math.round(amount)) },
    };
    commit();
    return true;
  },
  /** Pays for something outside the garage (e.g. service-park repairs). */
  spend(amount: number): boolean {
    if (amount <= 0) return true;
    if (save.money < amount) return false;
    save = { ...save, money: save.money - Math.round(amount) };
    commit();
    return true;
  },
  /** Records a stage time; returns true if it's a new personal best. */
  recordBest(key: string, ms: number): boolean {
    const prev = save.bests[key];
    if (prev !== undefined && prev <= ms) return false;
    save = { ...save, bests: { ...save.bests, [key]: ms } };
    commit();
    return true;
  },
  best: (key: string): number | null => save.bests[key] ?? null,
  setDaily(daily: CareerSave['daily']) {
    save = { ...save, daily };
    commit();
  },
  /** Wipes the career (Settings). */
  reset() {
    save = fresh();
    commit();
  },
};

export const money = (n: number) => `$${Math.round(n).toLocaleString('en-AU')}`;
