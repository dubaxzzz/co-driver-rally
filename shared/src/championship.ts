/**
 * Championship career + Daily Challenge rules. Pure functions so the
 * client, the server and the tests all agree.
 */
import { STAGE_DEFS } from './tracks';
import type { UpgradeLevels } from './career';
import { VEHICLES } from './vehicles';
import { WEATHER_IDS, type WeatherId } from './weather';
import type { AiSkill } from './types';

// ------------------------------------------------------------------ teams
export type TeamId = 'privateer' | 'kallio' | 'northern' | 'vortex';

export interface TeamDef {
  id: TeamId;
  name: string;
  tier: number; // 0 = privateer … 3 = works team
  /** Short tag for tables. */
  short: string;
  colour: number;
  accent: number;
  carId: string | null; // null = drive your own car
  upgrades: Partial<UpgradeLevels>;
  salary: number; // paid every round
  /** Contract goal: finish this position or better. */
  goal: number;
  /** What earns you an offer from this team. */
  offer: { roundPosition: number; standingsPosition: number; minRound: number };
  blurb: string;
}

export const TEAMS: Record<TeamId, TeamDef> = {
  privateer: {
    id: 'privateer', short: 'PRV', name: 'Privateer', tier: 0, colour: 0x777777, accent: 0xffffff, carId: null, upgrades: {}, salary: 0, goal: 12,
    offer: { roundPosition: 0, standingsPosition: 0, minRound: 99 }, blurb: 'Your own car, your own money. Every repair comes out of your pocket.',
  },
  kallio: {
    id: 'kallio', short: 'KAL', name: 'Kallio Motorsport', tier: 1, colour: 0x1f8a4c, accent: 0xffffff, carId: 'kestrel-r5', upgrades: { engine: 1, tyres: 1, suspension: 1 }, salary: 800, goal: 8,
    offer: { roundPosition: 6, standingsPosition: 6, minRound: 1 }, blurb: 'A friendly Finnish team. Free repairs, a tuned Kestrel R5 and a small salary.',
  },
  northern: {
    id: 'northern', short: 'NLR', name: 'Northern Lights Rally', tier: 2, colour: 0x1e5bc6, accent: 0xffd400, carId: 'bruno-300', upgrades: { engine: 1, tyres: 2, brakes: 1, suspension: 1 }, salary: 1500, goal: 5,
    offer: { roundPosition: 4, standingsPosition: 4, minRound: 2 }, blurb: 'Fast and flamboyant – they run the wild Bruno 300. Expect top-5 finishes.',
  },
  vortex: {
    id: 'vortex', short: 'VTX', name: 'Vortex Works Team', tier: 3, colour: 0xd8261c, accent: 0x111111, carId: 'vortex-rx', upgrades: { engine: 2, tyres: 2, gearbox: 2, suspension: 2, brakes: 2, armour: 1 }, salary: 3000, goal: 3,
    offer: { roundPosition: 2, standingsPosition: 2, minRound: 3 }, blurb: 'The factory team. A works Vortex RX, big salary – podiums or you are out.',
  },
};

// ------------------------------------------------------------------ the field
export interface Entrant {
  id: string;
  name: string;
  team: TeamId;
  /** 1.00 = as fast as the hard AI, bigger = slower. */
  pace: number;
}

export const FIELD: Entrant[] = [
  { id: 'e1', name: 'S. Virtanen', team: 'vortex', pace: 1.0 },
  { id: 'e2', name: 'A. Moreau', team: 'vortex', pace: 1.012 },
  { id: 'e3', name: 'E. Lindqvist', team: 'northern', pace: 1.025 },
  { id: 'e4', name: 'K. Tanaka', team: 'northern', pace: 1.035 },
  { id: 'e5', name: 'M. Dubois', team: 'kallio', pace: 1.05 },
  { id: 'e6', name: 'J. Okafor', team: 'kallio', pace: 1.06 },
  { id: 'e7', name: 'L. Ferreira', team: 'privateer', pace: 1.075 },
  { id: 'e8', name: 'R. Kowalski', team: 'privateer', pace: 1.09 },
  { id: 'e9', name: 'H. Byrne', team: 'privateer', pace: 1.105 },
  { id: 'e10', name: 'P. Nakamura', team: 'privateer', pace: 1.12 },
  { id: 'e11', name: 'D. Walsh', team: 'privateer', pace: 1.14 },
];

/** Which on-track AI skill matches an entrant's pace. */
export const skillForPace = (pace: number): AiSkill => (pace <= 1.03 ? 'hard' : pace <= 1.08 ? 'medium' : 'easy');
/** How much slower each AI skill is than hard (measured on the stages). */
export const SKILL_TIME_FACTOR: Record<AiSkill, number> = { hard: 1, medium: 1.06, easy: 1.125 };

export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const pointsFor = (position: number) => POINTS[position - 1] ?? 0;
export const CHAMPION_BONUS = [25000, 10000, 5000];

export interface Round {
  stageId: string;
  weather: WeatherId;
}

export const ROUNDS_PER_SEASON = 6;

/** The season: six stages in their signature weather – each season visits the next six on the calendar. */
export function seasonSchedule(season: number): Round[] {
  const n = STAGE_DEFS.length;
  const start = ((season - 1) * ROUNDS_PER_SEASON) % n;
  const out: Round[] = [];
  for (let i = 0; i < Math.min(ROUNDS_PER_SEASON, n); i++) {
    const d = STAGE_DEFS[(start + i) % n];
    out.push({ stageId: d.id, weather: d.defaultWeather });
  }
  return out;
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Classified {
  id: string; // entrant id or 'player'
  name: string;
  team: TeamId;
  timeMs: number | null; // null = DNF
}

/**
 * Times for the entrants who weren't on track: their pace × the hard-AI
 * reference for this round (taken from the AI cars that really drove), with
 * a little random variation and a small chance of retiring.
 */
export function simulateTimes(entrants: Entrant[], hardRefMs: number, seed: number): Map<string, number | null> {
  const rnd = mulberry(seed);
  const out = new Map<string, number | null>();
  for (const e of entrants) {
    if (rnd() < 0.03) {
      out.set(e.id, null); // retired
      continue;
    }
    const noise = 1 + (rnd() + rnd() + rnd() - 1.5) * 0.02;
    out.set(e.id, Math.round(hardRefMs * e.pace * noise));
  }
  return out;
}

/** Sorts a round: fastest first, retirements last. */
export function classify(rows: Classified[]): Classified[] {
  return [...rows].sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity));
}

/** The best team that wants you after this round (or null). */
export function bestOffer(current: TeamId, roundPosition: number, standingsPosition: number, roundsDone: number): TeamId | null {
  const tier = TEAMS[current].tier;
  const candidates = (Object.values(TEAMS) as TeamDef[])
    .filter((t) => t.tier > tier && roundsDone >= t.offer.minRound)
    .filter((t) => roundPosition <= t.offer.roundPosition || standingsPosition <= t.offer.standingsPosition)
    .sort((a, b) => b.tier - a.tier);
  return candidates[0]?.id ?? null;
}

/** Team car: a dealership car with the team's upgrades. */
export function teamCar(team: TeamId) {
  const t = TEAMS[team];
  return t.carId ? VEHICLES.find((v) => v.id === t.carId) ?? null : null;
}

// ------------------------------------------------------------------ daily challenge
export type Medal = 'none' | 'bronze' | 'silver' | 'gold';
export const MEDAL_PAY: Record<Medal, number> = { none: 0, bronze: 1000, silver: 2000, gold: 4000 };
export const DAILY_FINISH_PAY = 200;

/** Today's key, the same for every player in the world (UTC date). */
export const dailyKey = (d = new Date()) => d.toISOString().slice(0, 10);

const hashString = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const WEATHER_TIME: Record<WeatherId, number> = { clear: 1, overcast: 1.02, rain: 1.07, storm: 1.12, snow: 1.1, dusk: 1.01 };
const CAR_TIME: Record<string, number> = { 'sparrow-r2': 1.1, 'kestrel-r5': 1.0, 'dune-raider': 1.06, 'bruno-300': 0.99, 'vortex-rx': 0.95 };

export interface DailyChallenge {
  date: string;
  stageId: string;
  weather: WeatherId;
  carId: string;
  /** Medal target times (ms). */
  targets: { gold: number; silver: number; bronze: number };
}

/** The challenge for a date: stage, weather and a loan car – no upgrades, no AI. */
export function dailyChallenge(date: string): DailyChallenge {
  const rnd = mulberry(hashString(`cdr-daily-${date}`));
  const stage = STAGE_DEFS[Math.floor(rnd() * STAGE_DEFS.length)];
  const weather = WEATHER_IDS[Math.floor(rnd() * WEATHER_IDS.length)];
  const car = VEHICLES[Math.floor(rnd() * VEHICLES.length)];
  const ref = stage.referenceTimeMs * WEATHER_TIME[weather] * (CAR_TIME[car.id] ?? 1);
  const round = (ms: number) => Math.round(ms / 100) * 100;
  return { date, stageId: stage.id, weather, carId: car.id, targets: { gold: round(ref * 1.1), silver: round(ref * 1.22), bronze: round(ref * 1.38) } };
}

export function medalFor(ms: number, t: DailyChallenge['targets']): Medal {
  return ms <= t.gold ? 'gold' : ms <= t.silver ? 'silver' : ms <= t.bronze ? 'bronze' : 'none';
}

export const MEDAL_RANK: Record<Medal, number> = { none: 0, bronze: 1, silver: 2, gold: 3 };
