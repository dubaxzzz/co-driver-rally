/**
 * Career save: money, cars you own (with their upgrades), the car you drive,
 * personal bests and lifetime stats. Saved in this browser (localStorage).
 */
import './progressReset';
import {
  MAX_UPGRADE_LEVEL,
  PAINTS,
  STARTER_CAR_ID,
  STARTING_MONEY,
  VEHICLES,
  WHEELS,
  applyUpgrades,
  noUpgrades,
  codeActive,
  codeByText,
  upgradeCost,
  vehicleById,
  type UpgradeKind,
  type UpgradeLevels,
  type VehicleDef,
} from '@cdr/shared';

/** What redeem codes gave you – all of it runs out. */
export interface Perks {
  /** Codes already used. */
  redeemed: string[];
  /** Prize money is multiplied until this time. */
  boostUntil: number;
  boostMult: number;
  /** Borrowed cars: car id → time it goes back. */
  loans: Record<string, number>;
  /** Code-only paints: paint id → time it runs out. */
  paints: Record<string, number>;
}

export interface CareerSave {
  money: number;
  /** Paints and wheels you bought (the first of each is free). */
  cosmetics: { paints: string[]; wheels: string[] };
  perks: Perks;
  owned: Record<string, UpgradeLevels>;
  active: string;
  bests: Record<string, number>;
  /** Runs already paid out (so a refresh can't pay twice). */
  paid: string[];
  stats: { stages: number; wins: number; earned: number };
  /** Today's Daily Challenge progress. */
  daily: { date: string; bestMs: number | null; medal: 'none' | 'bronze' | 'silver' | 'gold'; finished: boolean };
  /** The current limited event (date = its key). */
  limited?: { date: string; bestMs: number | null; medal: 'none' | 'bronze' | 'silver' | 'gold'; finished: boolean };
}

const KEY = 'cdr.career';
/**
 * What codes gave you (boosts, loan cars, special paints, used codes) is saved apart from the
 * career. The career is wiped on every game update and every week, but a code's reward keeps
 * running for its own time – and a used code stays used.
 */
const PERKS_KEY = 'cdr.perks';
const noPerks = (): Perks => ({ redeemed: [], boostUntil: 0, boostMult: 1, loans: {}, paints: {} });
function storedPerks(): Perks | null {
  try {
    const p = JSON.parse(localStorage.getItem(PERKS_KEY) ?? 'null');
    return p ? { ...noPerks(), ...p } : null;
  } catch {
    return null;
  }
}
/** A borrowed car is in the garage for as long as its loan lasts (also after a wipe). */
function withLoans(s: CareerSave): CareerSave {
  const now = Date.now();
  const owned = { ...s.owned };
  for (const [id, until] of Object.entries(s.perks.loans)) if (until > now && !owned[id]) owned[id] = noUpgrades();
  return { ...s, owned };
}

function fresh(): CareerSave {
  return withLoans({
    money: STARTING_MONEY,
    cosmetics: { paints: [PAINTS[0].id], wheels: [WHEELS[0].id] },
    perks: storedPerks() ?? noPerks(),
    owned: { [STARTER_CAR_ID]: noUpgrades() },
    active: STARTER_CAR_ID,
    bests: {},
    paid: [],
    stats: { stages: 0, wins: 0, earned: 0 },
    daily: { date: '', bestMs: null, medal: 'none', finished: false },
  });
}

function load(): CareerSave {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    let s = { ...fresh(), ...JSON.parse(raw) } as CareerSave;
    s = withLoans({ ...s, perks: storedPerks() ?? s.perks ?? noPerks() });
    if (!s.owned[s.active]) s.active = Object.keys(s.owned)[0] ?? STARTER_CAR_ID;
    return sweep(s);
  } catch {
    return fresh();
  }
}

/** Takes away whatever a code gave you once its time is up (loan cars go back, boosts and paints end). */
function sweep(s: CareerSave): CareerSave {
  const now = Date.now();
  const gone = Object.entries(s.perks.loans).filter(([, until]) => until <= now).map(([id]) => id);
  const oldPaints = Object.entries(s.perks.paints).filter(([, until]) => until <= now).map(([id]) => id);
  if (!gone.length && !oldPaints.length && !(s.perks.boostUntil && s.perks.boostUntil <= now)) return s;
  const owned = { ...s.owned };
  for (const id of gone) delete owned[id];
  const loans = Object.fromEntries(Object.entries(s.perks.loans).filter(([id]) => !gone.includes(id)));
  const paints = Object.fromEntries(Object.entries(s.perks.paints).filter(([id]) => !oldPaints.includes(id)));
  const boosting = s.perks.boostUntil > now;
  const active = owned[s.active] ? s.active : Object.keys(owned)[0] ?? STARTER_CAR_ID;
  return { ...s, owned, active, perks: { ...s.perks, loans, paints, boostUntil: boosting ? s.perks.boostUntil : 0, boostMult: boosting ? s.perks.boostMult : 1 } };
}

/** Codes you have used. Kept apart from the career because the career is wiped every week – a used code stays used. */
const USED_KEY = 'cdr.codesUsed';
const usedCodes = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(USED_KEY) ?? '[]');
  } catch {
    return [];
  }
};

type Listener = (s: CareerSave) => void;
let save = load();
const listeners = new Set<Listener>();

function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
    localStorage.setItem(PERKS_KEY, JSON.stringify(save.perks));
  } catch {
    /* storage unavailable – keep in memory */
  }
  listeners.forEach((l) => l(save));
}

export type CareerResult = { ok: true } | { ok: false; reason: string };

export const career = {
  get: () => {
    const next = sweep(save);
    if (next !== save) {
      save = next;
      commit();
    }
    return save;
  },
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
  /** Prize money is multiplied while a code's boost lasts. */
  prizeMultiplier: () => (career.get().perks.boostUntil > Date.now() ? career.get().perks.boostMult : 1),
  /** Adds prize money once per run. Returns false if this run was already paid. */
  credit(runKey: string, amount: number, won = false): boolean {
    if (save.paid.includes(runKey)) return false;
    const paid = Math.max(0, Math.round(amount * (amount > 0 ? career.prizeMultiplier() : 1)));
    save = {
      ...save,
      money: save.money + paid,
      paid: [...save.paid.slice(-40), runKey],
      stats: { stages: save.stats.stages + 1, wins: save.stats.wins + (won ? 1 : 0), earned: save.stats.earned + paid },
    };
    commit();
    return true;
  },
  // ---------------------------------------------------------------- paint & wheels
  ownsPaint(id: string): boolean {
    const p = PAINTS.find((x) => x.id === id);
    if (!p) return false;
    if (p.codeOnly) return (career.get().perks.paints[id] ?? 0) > Date.now();
    return !p.price || save.cosmetics.paints.includes(id);
  },
  ownsWheel(id: string): boolean {
    const w = WHEELS.find((x) => x.id === id);
    return !!w && (w.price === 0 || save.cosmetics.wheels.includes(id));
  },
  buyPaint(id: string): CareerResult {
    const p = PAINTS.find((x) => x.id === id);
    if (!p || p.codeOnly) return { ok: false, reason: 'That paint is not for sale.' };
    if (career.ownsPaint(id)) return { ok: true };
    const price = p.price ?? 0;
    if (save.money < price) return { ok: false, reason: `You need $${(price - save.money).toLocaleString()} more.` };
    save = { ...save, money: save.money - price, cosmetics: { ...save.cosmetics, paints: [...save.cosmetics.paints, id] } };
    commit();
    return { ok: true };
  },
  buyWheel(id: string): CareerResult {
    const w = WHEELS.find((x) => x.id === id);
    if (!w) return { ok: false, reason: 'Unknown wheels.' };
    if (career.ownsWheel(id)) return { ok: true };
    if (save.money < w.price) return { ok: false, reason: `You need $${(w.price - save.money).toLocaleString()} more.` };
    save = { ...save, money: save.money - w.price, cosmetics: { ...save.cosmetics, wheels: [...save.cosmetics.wheels, id] } };
    commit();
    return { ok: true };
  },
  // ---------------------------------------------------------------- codes
  /** Redeems a code (Settings → Codes). */
  redeem(text: string): CareerResult & { message?: string } {
    const def = codeByText(text);
    if (!def) return { ok: false, reason: 'That code is not valid.' };
    if (!codeActive(def)) return { ok: false, reason: 'That code has expired.' };
    if (save.perks.redeemed.includes(def.code) || usedCodes().includes(def.code)) return { ok: false, reason: 'You have already used that code.' };
    const r = def.reward;
    const until = (hours: number) => Date.now() + hours * 3600_000;
    let perks: Perks = { ...save.perks, redeemed: [...save.perks.redeemed, def.code] };
    let next: CareerSave = save;
    if (r.kind === 'cash') next = { ...save, money: save.money + r.amount };
    else if (r.kind === 'boost') perks = { ...perks, boostUntil: until(r.hours), boostMult: r.mult };
    else if (r.kind === 'paint') perks = { ...perks, paints: { ...perks.paints, [r.paintId]: until(r.hours) } };
    else {
      if (save.owned[r.carId] && !save.perks.loans[r.carId]) return { ok: false, reason: 'You already own that car.' };
      next = { ...save, owned: { ...save.owned, [r.carId]: save.owned[r.carId] ?? noUpgrades() } };
      perks = { ...perks, loans: { ...perks.loans, [r.carId]: until(r.hours) } };
    }
    save = { ...next, perks };
    commit();
    try {
      localStorage.setItem(USED_KEY, JSON.stringify([...usedCodes(), def.code]));
    } catch {
      /* storage unavailable – the career copy above still blocks a second use this week */
    }
    return { ok: true, message: def.description };
  },
  /** What the codes are giving you right now, with when it ends. */
  activePerks(): Array<{ label: string; until: number }> {
    const p = career.get().perks;
    const out: Array<{ label: string; until: number }> = [];
    if (p.boostUntil > Date.now()) out.push({ label: `${p.boostMult}× prize money`, until: p.boostUntil });
    for (const [id, until] of Object.entries(p.loans)) out.push({ label: `Loan car: ${vehicleById(id).name}`, until });
    for (const [id, until] of Object.entries(p.paints)) out.push({ label: `Paint: ${PAINTS.find((x) => x.id === id)?.name ?? id}`, until });
    return out;
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
  setLimited(limited: CareerSave['daily']) {
    save = { ...save, limited };
    commit();
  },
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
