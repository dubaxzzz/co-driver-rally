/**
 * Championship career save + rules. A season is six rounds against the
 * FIELD of 11 AI drivers. Three of your closest rivals race you on track;
 * the rest get simulated times based on how fast the on-track AI really were.
 */
import {
  CHAMPION_BONUS,
  FIELD,
  SKILL_TIME_FACTOR,
  TEAMS,
  bestOffer,
  classify,
  computePrize,
  getStage,
  noUpgrades,
  pointsFor,
  repairCost,
  seasonSchedule,
  simulateTimes,
  skillForPace,
  type Classified,
  type PrizeLine,
  type Round,
  type TeamId,
  type UpgradeLevels,
} from '@cdr/shared';
import { career } from '../career';
import type { AiEntrantCtx } from '../events/context';

export interface RoundRecord {
  round: number;
  stageId: string;
  weather: Round['weather'];
  classification: Classified[];
  playerPosition: number | null;
}

export interface ChampSave {
  season: number;
  round: number; // next round to run (0-based); === schedule.length when the season is over
  schedule: Round[];
  points: Record<string, number>;
  results: RoundRecord[];
  team: TeamId;
  misses: number;
  offer: TeamId | null;
  carry: { zones: number[]; wheels: number[] };
  inProgress: boolean;
  lastSummary: RoundSummary | null;
  titles: number;
}

export interface RoundSummary {
  round: number;
  position: number | null;
  pointsGained: number;
  prize: { lines: PrizeLine[]; total: number };
  offer: TeamId | null;
  dropped: boolean;
  seasonDone: boolean;
  championPosition: number | null;
}

const KEY = 'cdr.championship';
const noDamage = () => ({ zones: [0, 0, 0, 0, 0, 0], wheels: [0, 0, 0, 0] });

function load(): ChampSave | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

let save: ChampSave | null = load();
function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    /* ignore */
  }
}

export interface StandingRow {
  id: string;
  name: string;
  team: TeamId;
  points: number;
  you: boolean;
}

export const champ = {
  get: () => save,

  /** Starts season 1, or the next season once one is finished. */
  startSeason() {
    const season = save ? save.season + 1 : 1;
    const points: Record<string, number> = { player: 0 };
    for (const e of FIELD) points[e.id] = 0;
    save = {
      season,
      round: 0,
      schedule: seasonSchedule(season),
      points,
      results: [],
      team: save?.team ?? 'privateer',
      misses: 0,
      offer: null,
      carry: noDamage(),
      inProgress: false,
      lastSummary: null,
      titles: save?.titles ?? 0,
    };
    commit();
    return save;
  },

  standings(): StandingRow[] {
    if (!save) return [];
    const s = save;
    const rows: StandingRow[] = [
      { id: 'player', name: 'You', team: s.team, points: s.points.player ?? 0, you: true },
      ...FIELD.map((e) => ({ id: e.id, name: e.name, team: e.team, points: s.points[e.id] ?? 0, you: false })),
    ];
    // ties broken by best finishes (count of wins etc.) – simple: alphabetical by pace order
    return rows.sort((a, b) => b.points - a.points);
  },

  standingsPosition(): number {
    return champ.standings().findIndex((r) => r.you) + 1;
  },

  /** The car you drive this round: the team's car, or your own as a privateer. */
  carForRound(): { carId: string; upgrades: UpgradeLevels } {
    const team = TEAMS[save?.team ?? 'privateer'];
    if (team.carId) return { carId: team.carId, upgrades: { ...noUpgrades(), ...team.upgrades } };
    const own = career.get().active;
    return { carId: own, upgrades: career.upgrades(own) };
  },

  /** Picks the three rivals closest to you in the standings to race on track. */
  onTrackRivals(): AiEntrantCtx[] {
    const table = champ.standings();
    const me = table.findIndex((r) => r.you);
    const near = table
      .map((r, i) => ({ r, d: Math.abs(i - me) }))
      .filter((x) => !x.r.you)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map((x) => x.r);
    // first round: line up against the middle of the field
    const picks = save && save.round === 0 ? FIELD.slice(4, 7) : near.map((r) => FIELD.find((e) => e.id === r.id)!);
    return picks.map((e) => {
      const t = TEAMS[e.team];
      return { entrantId: e.id, name: e.name, skill: skillForPace(e.pace), paint: { id: e.id, name: t.name, body: t.colour, accent: t.accent } };
    });
  },

  markStarted() {
    if (!save) return;
    save = { ...save, inProgress: true };
    commit();
  },

  /**
   * Scores a finished (or retired) round.
   * @param playerMs your time, or null if you retired
   * @param onTrack times of the AI that raced you (finished or projected)
   */
  finishRound(
    playerMs: number | null,
    onTrack: Array<{ entrantId: string; timeMs: number | null }>,
    damage: { zones: number[]; wheels: number[] },
    resets: number,
  ): RoundSummary | null {
    if (!save || save.round >= save.schedule.length) return null;
    const s = save;
    const roundIdx = s.round;
    const round = s.schedule[roundIdx];
    const stage = getStage(round.stageId)!;

    // Reference "hard AI" time for this round from the AI that really drove it
    const refs = onTrack
      .filter((o) => o.timeMs !== null)
      .map((o) => {
        const e = FIELD.find((f) => f.id === o.entrantId)!;
        return o.timeMs! / SKILL_TIME_FACTOR[skillForPace(e.pace)];
      })
      .sort((a, b) => a - b);
    const hardRef = refs.length ? refs[Math.floor(refs.length / 2)] : stage.def.referenceTimeMs * 1.08;
    // AI that raced you but have no usable time (you retired early) get a simulated time too
    const onTrackIds = new Set(onTrack.filter((o) => o.timeMs !== null).map((o) => o.entrantId));
    const simulated = simulateTimes(
      FIELD.filter((e) => !onTrackIds.has(e.id)),
      hardRef,
      s.season * 1000 + roundIdx * 17 + Math.round(playerMs ?? 0),
    );
    const rows: Classified[] = [
      { id: 'player', name: 'You', team: s.team, timeMs: playerMs },
      ...FIELD.map((e) => ({
        id: e.id,
        name: e.name,
        team: e.team,
        timeMs: onTrackIds.has(e.id) ? onTrack.find((o) => o.entrantId === e.id)!.timeMs : simulated.get(e.id) ?? null,
      })),
    ];
    const classification = classify(rows);
    const points = { ...s.points };
    classification.forEach((r, i) => {
      if (r.timeMs !== null) points[r.id] = (points[r.id] ?? 0) + pointsFor(i + 1);
    });
    const position = playerMs === null ? null : classification.findIndex((r) => r.id === 'player') + 1;

    // prize money (repairs are paid at the service park instead) + salary
    const team = TEAMS[s.team];
    const prize =
      position === null
        ? { lines: [] as PrizeLine[], total: 0 }
        : computePrize({
            stageLengthM: stage.finishDistance - stage.startDistance,
            weather: round.weather,
            aiSkill: 'hard',
            position,
            fieldSize: classification.length,
            zones: damage.zones,
            wheels: damage.wheels,
            resets,
            includeRepairs: false,
          });
    if (team.salary) {
      prize.lines.push({ label: `${team.name} salary`, amount: team.salary });
      prize.total += team.salary;
    }

    // contract goals
    let misses = s.misses;
    let newTeam = s.team;
    let dropped = false;
    if (s.team !== 'privateer') {
      misses = position !== null && position <= team.goal ? 0 : misses + 1;
      if (misses >= 2) {
        newTeam = 'privateer';
        dropped = true;
        misses = 0;
      }
    }

    save = { ...s, points, round: roundIdx + 1, team: newTeam, misses, inProgress: false };
    save.results = [...s.results, { round: roundIdx, stageId: round.stageId, weather: round.weather, classification, playerPosition: position }];
    // body damage carries to the service park
    save.carry = { zones: [...damage.zones], wheels: [0, 0, 0, 0] };
    const standingsPos = champ.standingsPosition();
    save.offer = dropped || position === null ? null : bestOffer(newTeam, position, standingsPos, roundIdx + 1);

    // season finale
    const seasonDone = save.round >= save.schedule.length;
    let championPosition: number | null = null;
    if (seasonDone) {
      championPosition = standingsPos;
      const bonus = CHAMPION_BONUS[championPosition - 1] ?? 0;
      if (bonus) {
        prize.lines.push({ label: championPosition === 1 ? 'CHAMPION bonus' : `Championship P${championPosition} bonus`, amount: bonus });
        prize.total += bonus;
      }
      if (championPosition === 1) save.titles += 1;
      save.offer = null;
    }

    career.credit(`champ:${s.season}:${roundIdx}`, prize.total, position === 1);
    const summary: RoundSummary = { round: roundIdx, position, pointsGained: position ? pointsFor(position) : 0, prize, offer: save.offer, dropped, seasonDone, championPosition };
    save.lastSummary = summary;
    commit();
    return summary;
  },

  /** Repair cost for the carried damage (free when a team pays). */
  repairQuote(): { cost: number; teamPays: boolean } {
    if (!save) return { cost: 0, teamPays: false };
    return { cost: repairCost(save.carry.zones), teamPays: save.team !== 'privateer' };
  },

  /** Repairs the bodywork ('body' and 'all' do the same now that wheels can't be damaged). */
  repair(_what: 'body' | 'all'): { ok: boolean; reason?: string } {
    if (!save) return { ok: false };
    const zones = [0, 0, 0, 0, 0, 0];
    const wheels = [0, 0, 0, 0];
    const cost = repairCost(save.carry.zones);
    const teamPays = save.team !== 'privateer';
    if (!teamPays && cost > 0) {
      if (career.get().money < cost) return { ok: false, reason: `Repairs cost $${cost.toLocaleString()} – not enough in the bank.` };
      career.spend(cost);
    }
    save = { ...save, carry: { zones, wheels } };
    commit();
    return { ok: true };
  },

  acceptOffer() {
    if (!save?.offer) return;
    save = { ...save, team: save.offer, offer: null, misses: 0, carry: noDamage() };
    commit();
  },

  declineOffer() {
    if (!save) return;
    save = { ...save, offer: null };
    commit();
  },

  /** Abandons the current season (Settings / new career). */
  reset() {
    save = null;
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};
