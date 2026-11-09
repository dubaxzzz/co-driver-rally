/** Championship + Daily Challenge rules: a full simulated season, contracts, repairs, medals. */
const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
};
(globalThis as Record<string, unknown>).localStorage = mem();
(globalThis as Record<string, unknown>).sessionStorage = mem();

const shared = await import('../shared/src/index');
const { champ } = await import('../client/src/championship/state');
const { career } = await import('../client/src/career');
const { FIELD, TEAMS, POINTS, dailyChallenge, medalFor, seasonSchedule, simulateTimes, getStage, STAGE_DEFS } = shared;

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const clean = { zones: [0, 0, 0, 0, 0, 0], wheels: [0, 0, 0, 0] };

// ---- schedule + simulation are deterministic
const a = seasonSchedule(1);
const b = seasonSchedule(1);
check(a.length === 6 && JSON.stringify(a) === JSON.stringify(b), 'season schedule has 6 rounds and is the same every time');
check(new Set(a.map((r) => r.stageId)).size === 6, 'every stage appears once per season');
const t1 = simulateTimes(FIELD, 70000, 42);
const t2 = simulateTimes(FIELD, 70000, 42);
check(JSON.stringify([...t1]) === JSON.stringify([...t2]), 'simulated field times are deterministic for a seed');
const finished = [...t1.values()].filter((x): x is number => x !== null);
check(finished.every((t) => t > 60000 && t < 90000), 'simulated times are near the reference');

// ---- a whole season where the player wins every round
champ.startSeason();
check(champ.get()?.team === 'privateer' && champ.standingsPosition() >= 1, 'new career starts as a privateer');
const rivals = champ.onTrackRivals();
check(rivals.length === 3 && rivals.every((r) => FIELD.some((f) => f.id === r.entrantId)), 'three real rivals race you on the stage');
const money0 = career.get().money;
let firstOffer: string | null = null;
for (let i = 0; i < 6; i++) {
  const s = champ.get()!;
  const stage = getStage(s.schedule[s.round].stageId)!;
  const ref = stage.def.referenceTimeMs;
  const onTrack = champ.onTrackRivals().map((r, k) => ({ entrantId: r.entrantId, timeMs: Math.round(ref * (1.04 + k * 0.02)) }));
  champ.markStarted();
  const sum = champ.finishRound(Math.round(ref * 0.9), onTrack, i === 0 ? { zones: [0.5, 0, 0, 0, 0.3, 0], wheels: [1, 0, 0, 0] } : clean, 0)!;
  check(sum.position === 1, `round ${i + 1}: fastest time wins (P${sum.position}, +${sum.pointsGained} pts)`);
  if (i === 0) {
    const q = champ.repairQuote();
    check(q.cost > 0 && !q.teamPays, `privateer pays for repairs ($${q.cost})`);
    check(champ.get()!.carry.wheels[0] === 1, 'a lost wheel is carried to the service park');
    const before = career.get().money;
    check(champ.repair('all').ok && career.get().money === before - q.cost && champ.repairQuote().cost === 0, 'repairing everything clears the damage and charges the bank');
  }
  if (sum.offer && !firstOffer) {
    firstOffer = sum.offer;
    champ.acceptOffer();
  }
}
const end = champ.get()!;
check(end.points.player === POINTS[0] * 6, `six wins = ${POINTS[0] * 6} points`);
check(champ.standingsPosition() === 1 && end.titles === 1, 'champion at the end of the season');
check(firstOffer === 'kallio', `first offer comes from a tier-1 team (${firstOffer})`);
check(end.team !== 'privateer', `signed for ${TEAMS[end.team].name}`);
check(career.get().money > money0 + 50000, `season earnings incl. champion bonus: $${career.get().money - money0}`);
check(champ.finishRound(60000, [], clean, 0) === null, 'no more rounds once the season is done');

// ---- next season keeps the team; dropped after two missed goals
champ.startSeason();
const team = champ.get()!.team;
check(champ.get()!.season === 2 && team === end.team && champ.get()!.points.player === 0, 'season 2 starts with zero points and the same team');
check(champ.repairQuote().teamPays, 'team pays for repairs');
champ.finishRound(null, [], clean, 0);
check(champ.get()!.team === team && champ.get()!.misses === 1, 'retiring once misses the goal (1 strike)');
champ.finishRound(null, [], clean, 0);
check(champ.get()!.team === 'privateer' && champ.get()!.lastSummary?.dropped === true, 'second miss in a row: dropped back to privateer');

// ---- daily challenge
const d1 = dailyChallenge('2026-11-09');
const d2 = dailyChallenge('2026-11-09');
const d3 = dailyChallenge('2026-11-10');
check(JSON.stringify(d1) === JSON.stringify(d2), 'daily challenge is the same for everyone on a date');
check(STAGE_DEFS.some((s) => s.id === d1.stageId) && JSON.stringify(d1) !== JSON.stringify(d3), 'a new challenge each day');
check(d1.targets.gold < d1.targets.silver && d1.targets.silver < d1.targets.bronze, 'gold is faster than silver, silver faster than bronze');
check(medalFor(d1.targets.gold - 1, d1.targets) === 'gold' && medalFor(d1.targets.bronze + 1, d1.targets) === 'none', 'medals by target time');

console.log(failures ? `\n${failures} FAILED` : '\nAll championship checks passed');
process.exit(failures ? 1 : 0);
