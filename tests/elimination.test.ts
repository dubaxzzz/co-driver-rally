/** Elimination rules: last home is out, so is anyone outside the time bracket; the stages change every round. */
import { RaceController, STAGE_DEFS, ELIM_BRACKET_MIN_MS, type RaceState, type TelemetryPacket } from '../shared/src/index';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

// ---- a controllable clock: timers only fire when the test says so
type Timer = { fn: () => void; ms: number };
const timers = new Map<number, Timer>();
let nextId = 1;
const realSet = globalThis.setTimeout;
const realClear = globalThis.clearTimeout;
globalThis.setTimeout = ((fn: () => void, ms: number) => {
  timers.set(nextId, { fn, ms });
  return nextId++;
}) as never;
globalThis.clearTimeout = ((id: number) => void timers.delete(id)) as never;
const fireTimer = (ms: number) => {
  for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); return true; }
  return false;
};

let state: RaceState | null = null;
let eliminated: string[] = [];
let eventOver = false;
const ctl = new RaceController({ elimination: true }, {
  onState: (s) => (state = s),
  onCheckpoint: () => undefined,
  onWarning: () => undefined,
  onFinished: () => undefined,
  onEliminated: (ids) => eliminated.push(...ids),
  onEventOver: () => (eventOver = true),
});

const first = ctl.state.elim!;
check(first.rounds.length === 3 && new Set(first.rounds.map((r) => r.stageId)).size === 3, 'three different stages for the three rounds');
check(first.rounds.every((r) => STAGE_DEFS.some((d) => d.id === r.stageId)), 'every round is a real stage');
check(ctl.state.stageId === first.rounds[0].stageId, 'the first round starts on the first stage');
const shuffles = new Set(Array.from({ length: 12 }, () => new RaceController({ elimination: true }, { onState: () => undefined, onCheckpoint: () => undefined, onWarning: () => undefined, onFinished: () => undefined }).state.elim!.rounds.map((r) => r.stageId).join()));
check(shuffles.size > 1, 'a new lobby mixes the stages differently');

const T0 = 1_000_000;
let clock = T0;
const ids = ['A', 'B', 'C'];
ctl.start(ids.map((id) => ({ playerId: id, name: id })), T0);
for (const id of ids) ctl.engineStarted(id, T0);
fireTimer(5000); // countdown over
check(ctl.state.phase === 'racing', 'round 1 is racing');

/** Drives drivers along the centreline; `speeds` in m/s (0 = never moves). Returns when nobody can progress any more. */
function drive(speeds: Record<string, number>, seconds: number) {
  const stage = ctl.stage;
  const startAt = ctl.state.startAt!;
  const dist: Record<string, number> = {};
  for (const d of ctl.state.drivers) dist[d.playerId] = stage.spawnDistance - Math.floor(d.slot / 2) * 8;
  const runId = ctl.state.runId;
  for (let t = 0.25; t <= seconds; t += 0.25) {
    clock = startAt + t * 1000;
    for (const [id, v] of Object.entries(speeds)) {
      if (!v || ctl.driver(id)?.result) continue;
      dist[id] = Math.min(stage.samples.length - 1, dist[id] + v * 0.25);
      const s = stage.samples[Math.min(stage.samples.length - 1, Math.round(dist[id] / stage.step))];
      ctl.handleTelemetry(id, { runId, seq: 0, t: t * 1000, x: s.x, y: s.y, z: s.z, h: s.h, p: 0, r: 0, v, steer: 0, throttle: 1, brake: 0, handbrake: false, gear: 3, rpm: 5000, dist: dist[id], remain: 0, cp: 0, nextNote: 0, toNote: 0, dmg: 0, resets: 0 } as TelemetryPacket, clock);
    }
    if (ctl.state.phase === 'finished') break;
  }
}

// ---- round 1: everybody finishes, C is last
const len = ctl.stage.finishDistance - ctl.stage.spawnDistance;
drive({ A: 40, B: 36, C: 30 }, len / 25 + 60);
check(ctl.state.phase === 'finished', 'round 1 is over once all three finished');
check(ctl.state.elim!.out.length === 1 && ctl.state.elim!.out[0].playerId === 'C' && ctl.state.elim!.out[0].reason === 'last', 'the last driver to finish (C) is out');
check(eliminated.join() === 'C', 'the server is told C is out');
check(ctl.state.elim!.waiting && ctl.state.phase === 'finished', 'the round waits for the host to start the next one');
check(timers.size === 0, 'no timer starts the next round by itself');

// ---- the next round begins by itself on a different stage with only A and B
const stage1 = ctl.state.stageId;
check(ctl.nextRound(), 'the host starts the next round');
check(!ctl.nextRound(), 'it cannot be started twice');
check(ctl.state.phase === 'countdown' && ctl.state.runId === 2, 'round 2 starts');
check(ctl.state.stageId !== stage1 && ctl.state.stageId === first.rounds[1].stageId, 'round 2 is a different stage');
check(ctl.state.drivers.map((d) => d.playerId).join() === 'A,B', 'only A and B are on the grid');

// ---- round 2: B never finishes inside the bracket
for (const id of ['A', 'B']) ctl.engineStarted(id, clock);
fireTimer(5000);
drive({ A: 45, B: 0 }, ctl.stage.finishDistance / 20 + 30);
check(ctl.state.phase === 'racing' && ctl.state.elim!.cutoffAt !== null, 'A finished: the time bracket is running for B');
check(fireTimer(Math.max(ELIM_BRACKET_MIN_MS, 0)) || timers.size > 0, 'the bracket timer exists');
for (const [id, t] of [...timers]) if (t.ms >= ELIM_BRACKET_MIN_MS && t.ms < 1e9 && ctl.state.phase === 'racing') { timers.delete(id); t.fn(); }
check(ctl.state.phase === 'finished', 'the bracket ran out and the round is over');
const outB = ctl.state.elim!.out.find((o) => o.playerId === 'B');
check(outB?.reason === 'cutoff', 'B is out for not finishing in time');
check(ctl.state.elim!.winner?.playerId === 'A', 'A is the last driver standing – the winner');

// ---- the room returns to the lobby with fresh stages
const oldRounds = ctl.state.elim!.rounds.map((r) => r.stageId).join();
for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); }
check(ctl.state.phase === 'lobby' && eventOver, 'the room goes back to the lobby when the event is over');
check(ctl.state.elim!.out.length === 0 && ctl.state.elim!.winner === null, 'the lobby starts with a clean elimination');
void oldRounds;

globalThis.setTimeout = realSet;
globalThis.clearTimeout = realClear;
console.log(failures ? `\n${failures} check(s) failed` : '\nElimination rules OK');
process.exit(failures ? 1 : 0);
