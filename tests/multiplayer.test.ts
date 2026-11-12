/**
 * 4-player lobby test against a real server (npm run dev:server, then
 * `npm run test:multiplayer`). Two drivers, two navigators: roles, ready
 * ticks, host rules, grid, per-driver timing, retire, host hand-over.
 */
import { io, type Socket } from 'socket.io-client';
import { getStage, DEFAULT_STAGE_ID, sampleAt, gridSpot } from '../shared/src/index';
import type { ClientToServerEvents, ServerToClientEvents, Ack, JoinResult, TelemetryPacket, RaceResult, RaceState, RoomSnapshot, RelayedTelemetry } from '../shared/src/index';

type S = Socket<ServerToClientEvents, ClientToServerEvents>;
const URL = process.env.SERVER_URL ?? 'http://localhost:3001';
const stage = getStage(DEFAULT_STAGE_ID)!;
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const connect = () =>
  new Promise<S>((resolve, reject) => {
    const s: S = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const call = <T>(fn: (ack: (r: Ack<T>) => void) => void) => new Promise<Ack<T>>((r) => fn(r));
const waitFor = <T>(s: S, ev: keyof ServerToClientEvents, ms = 5000, pred: (x: T) => boolean = () => true) =>
  new Promise<T | null>((resolve) => {
    const t = setTimeout(() => {
      s.off(ev, h as never);
      resolve(null);
    }, ms);
    const h = (x: T) => {
      if (pred(x)) {
        clearTimeout(t);
        s.off(ev, h as never);
        resolve(x);
      }
    };
    s.on(ev, h as never);
  });
const packet = (runId: number, seq: number, d: number, lateral = 0): TelemetryPacket => {
  const p = sampleAt(stage.samples, d);
  return { runId, seq, t: 0, x: p.x + Math.cos(p.h) * lateral, y: p.y, z: p.z - Math.sin(p.h) * lateral, h: p.h, p: 0, r: 0, v: 30, steer: 0, throttle: 1, brake: 0, handbrake: false, gear: 4, rpm: 6000, dist: d, remain: stage.finishDistance - d, cp: 0, nextNote: 0, toNote: 50, dmg: 0, resets: 0, look: [1, 0x22c55e, 0x111111] };
};

// ---- lobby: host + 3 joiners
const host = await connect();
const created = await call<JoinResult>((a) => host.emit('room:create', { name: 'Alice', config: { aiCount: 2 } }, a));
if (!created.ok) throw new Error('create failed');
const code = created.data.room.code;
const alice = created.data.session.playerId;

const s2 = await connect();
const j2 = await call<JoinResult>((a) => s2.emit('room:join', { code, name: 'Bob' }, a));
check(j2.ok && j2.data.session.role === 'navigator' && j2.data.room.members.find((m) => m.name === 'Bob')?.navFor === alice, 'second player becomes Alice\'s navigator by default');
const s3 = await connect();
const j3 = await call<JoinResult>((a) => s3.emit('room:join', { code, name: 'Cara' }, a));
check(j3.ok && j3.data.session.role === 'driver', 'third player becomes a driver (Alice already has a navigator)');
const cara = j3.ok ? j3.data.session.playerId : '';
const s4 = await connect();
const j4 = await call<JoinResult>((a) => s4.emit('room:join', { code, name: 'Dan' }, a));
check(j4.ok && j4.data.session.role === 'navigator' && j4.data.room.members.find((m) => m.name === 'Dan')?.navFor === cara, 'fourth player navigates for Cara (the driver without one)');
const s5 = await connect();
const j5 = await call<JoinResult>((a) => s5.emit('room:join', { code, name: 'Eve' }, a));
check(!j5.ok && j5.code === 'ROOM_FULL', 'a fifth player is turned away – 4 per lobby');

// ---- roles and ready
const swap = await call<RoomSnapshot>((a) => s2.emit('room:role', { role: 'navigator', navFor: cara }, a));
check(swap.ok && swap.data.members.find((m) => m.name === 'Bob')?.navFor === cara, 'a navigator can pick which driver to navigate for');
await call<RoomSnapshot>((a) => s2.emit('room:role', { role: 'navigator', navFor: alice }, a));
const notHost = await call((a) => s3.emit('room:configure', { weather: 'clear' }, a as never));
check(!notHost.ok, 'only the host picks the stage');
const notHostStart = await call((a) => s3.emit('race:start', a as never));
check(!notHostStart.ok, 'only the host starts the rally');
const notReady = await call((a) => host.emit('race:start', a as never));
check(!notReady.ok && !notReady.ok && /Bob|Cara|Dan/.test(notReady.message), 'host has to wait until everyone ticks ready');
for (const s of [s2, s3, s4]) await call((a) => s.emit('room:ready', true, a));
const lobbyRole = await call<RoomSnapshot>((a) => s3.emit('room:role', { role: 'driver' }, a));
check(lobbyRole.ok, 'staying a driver is fine');

// ---- navigator flips a switch in their own driver's car (and nobody else's)
{
  const aliceGets = waitFor<{ id: string; from: string; down: boolean }>(host, 'car:switch', 2000);
  const caraGets = waitFor(s3, 'car:switch', 800);
  s2.emit('car:switch', { id: 'headlights' });
  const got = await aliceGets;
  check(got?.id === 'headlights' && got.from === 'Bob' && !(await caraGets), "Bob's HEADLIGHTS click reaches Alice's car only");
  const bad = waitFor(host, 'car:switch', 800);
  s2.emit('car:switch', { id: 'ignition' } as never);
  s3.emit('car:switch', { id: 'wipers' });
  check(!(await bad), 'navigators cannot touch the ignition, and drivers cannot send switch clicks');
}

// ---- start: grid of two drivers, AI run by the first on the grid
const racingP = waitFor<RaceState>(s4, 'race:state', 15000, (s) => s.phase === 'racing');
const st = await call<RaceState>((a) => host.emit('race:start', a as never));
check(st.ok && st.data.drivers.map((d) => d.name).join(',') === 'Alice,Cara' && st.data.aiHost === alice, 'grid: Alice then Cara');
const runId = st.ok ? st.data.runId : 1;
const g0 = gridSpot(stage, 0, 2);
const g1 = gridSpot(stage, 1, 2);
check(g0.lateral > 0 && g1.lateral < 0 && g0.distance === g1.distance, 'two cars start side by side');
check(!!(await racingP), 'everybody sees the countdown end');
const lateRole = await call((a) => s4.emit('room:role', { role: 'driver' }, a));
check(!lateRole.ok, 'no seat changes during a stage');

// ---- telemetry relayed to everyone with the sender id (drivers see each other)
const caraSees = waitFor<RelayedTelemetry>(s3, 'telemetry', 2000, (p) => p.pid === alice);
const danSees = waitFor<RelayedTelemetry>(s4, 'telemetry', 2000, (p) => p.pid === alice);
host.emit('telemetry', packet(runId, 1, g0.distance, g0.lateral));
const [ct, dt] = await Promise.all([caraSees, danSees]);
check(!!ct && !!dt && ct.look?.[0] === 1, 'telemetry reaches the other driver and the navigators, tagged with who sent it');
const navTel = waitFor(s3, 'telemetry', 600, (p: RelayedTelemetry) => p.pid !== alice && p.pid !== cara);
s2.emit('telemetry', packet(runId, 1, g0.distance));
check(!(await navTel), 'navigators cannot send telemetry');

// ---- both drive; Alice faster. Per-driver results, stage ends when both are done
console.log('…two drivers on the stage (≈40 s)');
const aliceDone = waitFor<RaceResult>(s3, 'race:finished', 90000, (r) => r.playerId === alice);
const finishedState = waitFor<RaceState>(s2, 'race:state', 120000, (s) => s.phase === 'finished');
let seq = 2;
let dA = g0.distance;
let dC = g1.distance;
let caraRetired = false;
while (dA <= stage.finishDistance + 5) {
  host.emit('telemetry', packet(runId, seq, dA, 0));
  if (!caraRetired) s3.emit('telemetry', packet(runId, seq, dC, 0));
  seq++;
  dA += 3.4;
  dC += 2.6;
  await sleep(50);
  // Cara gives up half way
  if (!caraRetired && dC > (stage.startDistance + stage.finishDistance) / 2) {
    caraRetired = true;
    const r = await call<RaceState>((a) => s3.emit('race:retire', a));
    check(r.ok && r.data.drivers.find((d) => d.playerId === cara)?.retired === true && r.data.phase === 'racing', 'Cara retires; the stage carries on for Alice');
  }
}
const ar = await aliceDone;
check(!!ar && ar.name === 'Alice' && ar.splits.length === stage.checkpoints.length, `Alice's finish is announced to everyone (${ar ? (ar.timeMs / 1000).toFixed(1) : '-'} s)`);
const fs = await finishedState;
check(!!fs && !!fs.drivers.find((d) => d.playerId === alice)?.result && !!fs.drivers.find((d) => d.playerId === cara)?.retired, 'stage is over once every driver finished or retired');

// ---- restart is the host's call; host hand-over
const notHostRestart = await call((a) => s3.emit('race:restart', a as never));
check(!notHostRestart.ok, 'only the host can restart for everyone');
const lobby = await call<RaceState>((a) => host.emit('race:lobby', a as never));
check(lobby.ok && lobby.data.phase === 'lobby' && lobby.data.drivers.length === 0, 'host takes everyone back to the lobby');
const handed = waitFor<RoomSnapshot>(s3, 'room:update', 3000, (r) => r.hostId === cara);
host.emit('room:leave');
const hr = await handed;
check(!!hr && hr.members.length === 3 && hr.members.find((m) => m.name === 'Bob')?.navFor === cara, 'Alice leaves: Cara (the other driver) becomes host, Bob now navigates for her');
const joinAgain = await call<JoinResult>((a) => s5.emit('room:join', { code, name: 'Eve', role: 'driver' }, a));
check(joinAgain.ok && joinAgain.data.session.role === 'driver', 'the free seat can be taken again (Eve joins as a driver)');

for (const s of [host, s2, s3, s4, s5]) s.disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nAll multiplayer checks passed');
process.exit(failures ? 1 : 0);
