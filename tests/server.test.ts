/**
 * Multiplayer integration test against a real server process.
 * Usage: start the server (npm run dev:server) then `npm run test:server`,
 * or set SERVER_URL. Uses real Socket.IO clients – nothing is mocked.
 */
import { io, type Socket } from 'socket.io-client';
import { getStage, DEFAULT_STAGE_ID, sampleAt } from '../shared/src/index';
import type { ClientToServerEvents, ServerToClientEvents, Ack, JoinResult, TelemetryPacket, RaceResult } from '../shared/src/index';

type S = Socket<ServerToClientEvents, ClientToServerEvents>;
const URL = process.env.SERVER_URL ?? 'http://localhost:3001';
const stage = getStage(DEFAULT_STAGE_ID)!;
let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const connect = () => new Promise<S>((resolve, reject) => {
  const s: S = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
});
const call = <T>(fn: (ack: (r: Ack<T>) => void) => void) => new Promise<Ack<T>>((r) => fn(r));
const waitFor = <T>(s: S, ev: keyof ServerToClientEvents, ms = 5000, pred: (x: T) => boolean = () => true) =>
  new Promise<T | null>((resolve) => {
    const t = setTimeout(() => { s.off(ev, h as never); resolve(null); }, ms);
    const h = (x: T) => { if (pred(x)) { clearTimeout(t); s.off(ev, h as never); resolve(x); } };
    s.on(ev, h as never);
  });

const packet = (runId: number, seq: number, d: number, resets = 0): TelemetryPacket => {
  const p = sampleAt(stage.samples, d);
  return { runId, seq, t: 0, x: p.x, y: p.y, z: p.z, h: p.h, p: 0, r: 0, v: 30, steer: 0, throttle: 1, brake: 0, handbrake: false, gear: 4, rpm: 6000, dist: d, remain: stage.finishDistance - d, cp: 0, nextNote: 0, toNote: 50, dmg: 0, resets, dz: [0.1, 0, 0, 0, 0.2, 0], ai: [1, 2, 3, 0.5, 100, -1] };
};

const driver = await connect();
const created = await call<JoinResult>((a) => driver.emit('room:create', { name: 'Tester' }, a));
check(created.ok && /^[A-Z2-9]{4}$/.test(created.ok ? created.data.room.code : ''), `driver creates a room with a 4-char code (${created.ok ? created.data.room.code : '-'})`);
if (!created.ok) process.exit(1);
const code = created.data.room.code;

const nav = await connect();
const bad = await call<JoinResult>((a) => nav.emit('room:join', { code: 'ZZ!!' }, a));
check(!bad.ok && bad.code === 'INVALID_CODE', 'malformed code rejected');
const missing = await call<JoinResult>((a) => nav.emit('room:join', { code: code === 'AAAA' ? 'BBBB' : 'AAAA' }, a));
check(!missing.ok && missing.code === 'ROOM_NOT_FOUND', 'unknown room rejected');
const joined = await call<JoinResult>((a) => nav.emit('room:join', { code: code.toLowerCase(), name: 'Nav' }, a));
check(joined.ok && joined.ok && joined.data.session.role === 'navigator', 'navigator joins with the code (case-insensitive)');
const third = await connect();
const full = await call<JoinResult>((a) => third.emit('room:join', { code }, a));
check(!full.ok && full.code === 'ROOM_FULL', 'second navigator rejected – room full');

// independent second room
const driver2 = await connect();
const created2 = await call<JoinResult>((a) => driver2.emit('room:create', {}, a));
check(created2.ok && created2.data.room.code !== code, 'second room gets a different code');

// lobby configuration (stage / weather / AI) – on the second room
const cfg = await call<{ stageId: string; weather: string; aiCount: number }>((a) => driver2.emit('room:configure', { stageId: 'snow-varmland', weather: 'snow', aiCount: 2 }, a as never));
check(cfg.ok && cfg.data.stageId === 'snow-varmland' && cfg.data.weather === 'snow' && cfg.data.aiCount === 2, 'driver can choose stage, weather and AI opponents');
const badCfg = await call((a) => driver2.emit('room:configure', { stageId: 'nope' }, a as never));
check(!badCfg.ok && !badCfg.ok && badCfg.code === 'BAD_PAYLOAD', 'unknown stage rejected');
const badAi = await call((a) => driver2.emit('room:configure', { aiCount: 9 }, a as never));
check(!badAi.ok, 'too many AI opponents rejected');
const created3 = await call<JoinResult>((a) => driver2.emit('room:create', { config: { stageId: 'tarmac-turini', weather: 'dusk' } }, a));
check(created3.ok && created3.data.room.race.stageId === 'tarmac-turini' && created3.data.room.race.weather === 'dusk', 'room can be created with a chosen stage and weather');

// daily challenge: the server forces today's stage + weather and no AI, and refuses other dates
{
  const { dailyChallenge, dailyKey } = await import('../shared/src/index');
  const today = dailyChallenge(dailyKey());
  const d = await call<{ stageId: string; weather: string; aiCount: number; daily?: string }>((a) => driver2.emit('room:configure', { daily: today.date, stageId: 'forest-kallio', aiCount: 3 }, a as never));
  check(d.ok && d.data.stageId === today.stageId && d.data.weather === today.weather && d.data.aiCount === 0, `daily config is forced by the server (${today.stageId}, ${today.weather}, no AI)`);
  const old = await call((a) => driver2.emit('room:create', { config: { daily: '2020-01-01' } }, a));
  check(!old.ok, "an old day's challenge is rejected");
  const res = await fetch('http://localhost:3001/api/daily').then((r) => r.json());
  check(res.challenge?.date === today.date && Array.isArray(res.board), '/api/daily returns today\'s challenge and leaderboard');
}

// navigator cannot start / send telemetry; driver can't send calls
const navCfg = await call((a) => nav.emit('room:configure', { weather: 'clear' }, a as never));
check(!navCfg.ok, 'navigator cannot change the stage or weather');
const navStart = await call((a) => nav.emit('race:start', a));
check(!navStart.ok, 'navigator cannot start the stage');
const drvCall = await call((a) => driver.emit('nav:call', { kind: 'custom', text: 'hi' }, a));
check(!drvCall.ok, 'driver cannot send navigator calls');
const malformed = await call((a) => nav.emit('nav:call', { kind: 'nope' } as never, a));
check(!malformed.ok && !malformed.ok && malformed.code === 'BAD_PAYLOAD', 'malformed call rejected');

// start race
const st = await call<{ runId: number }>((a) => driver.emit('race:start', a as never));
const runId = st.ok ? st.data.runId : 1;
const racing = await waitFor<{ phase: string }>(nav, 'race:state', 5000, (s) => s.phase === 'racing');
check(!!racing, 'countdown ends and both see phase "racing"');
const lateCfg = await call((a) => driver.emit('room:configure', { weather: 'clear' }, a as never));
check(!lateCfg.ok, 'stage/weather cannot be changed mid-stage');

// telemetry relay + navigator call relay
const gotTel = waitFor<TelemetryPacket>(nav, 'telemetry', 3000);
driver.emit('telemetry', packet(runId, 1, stage.spawnDistance));
check(!!(await gotTel), 'navigator receives driver telemetry');
const room2Leak = waitFor(driver2, 'telemetry', 800);
driver.emit('telemetry', packet(runId, 2, stage.spawnDistance + 1));
check(!(await room2Leak), 'telemetry does not leak into another room');
const gotCall = waitFor<{ text: string }>(driver, 'nav:call', 3000);
await call((a) => nav.emit('nav:call', { kind: 'pacenote', text: 'LEFT 3 TIGHTENS' }, a));
check((await gotCall)?.text === 'LEFT 3 TIGHTENS', 'driver receives navigator pace note');
const rep = waitFor<{ text: string; repeated: boolean }>(driver, 'nav:call', 3000);
await call((a) => nav.emit('nav:call', { kind: 'repeat' }, a));
const r = await rep;
check(r?.repeated === true && r.text === 'LEFT 3 TIGHTENS', 'repeat resends previous call');

// navigator disconnect + reconnect with session token
const token = joined.ok ? joined.data.session.token : '';
const navLeft = waitFor<{ navigator: { connected: boolean } | null }>(driver, 'room:update', 3000, (x) => x.navigator?.connected === false);
nav.disconnect();
check(!!(await navLeft), 'driver is told the navigator disconnected');
driver.emit('telemetry', packet(runId, 3, stage.spawnDistance + 2));
const nav2 = await connect();
const steal = await call<JoinResult>((a) => third.emit('room:join', { code }, a));
check(!steal.ok && steal.code === 'SEAT_RESERVED', 'seat is reserved for the reconnecting navigator');
const resumed = await call<JoinResult>((a) => nav2.emit('session:resume', { token }, a));
check(resumed.ok && !!resumed.data.lastTelemetry && resumed.data.callLog.length >= 2, 'navigator resumes session with race state, telemetry and call log restored');

// teleport protection
const warn = waitFor<{ type: string }>(driver, 'race:warning', 1500, (w) => w.type === 'telemetry-rejected');
driver.emit('telemetry', packet(runId, 4, stage.finishDistance - 5));
check(!!(await warn), 'implausible teleport to the finish is rejected');

// drive the full stage at ~70 m/s (fastest plausible) and finish
console.log('…driving the stage (≈45 s)');
const finished = waitFor<RaceResult>(nav2, 'race:finished', 90000);
const driverFinished = waitFor<RaceResult>(driver, 'race:finished', 90000);
let seq = 10;
for (let d = stage.spawnDistance + 2; d <= stage.finishDistance + 5; d += 3.4) {
  driver.emit('telemetry', packet(runId, seq++, d));
  await sleep(50);
}
const [rn, rd] = await Promise.all([finished, driverFinished]);
check(!!rn && !!rd && rn.timeMs === rd.timeMs && rn.splits.length === 3, `both players receive the same result (${rn ? (rn.timeMs / 1000).toFixed(2) : '-'} s, ${rn?.splits.length} splits)`);

// leaving closes room
const closed = waitFor(nav2, 'room:closed', 3000);
driver.emit('room:leave');
check(!!(await closed), 'driver leaving closes the room for the navigator');

for (const s of [driver, nav2, third, driver2]) s.disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nAll server tests passed');
process.exit(failures ? 1 : 0);
