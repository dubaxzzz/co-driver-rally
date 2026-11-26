import { ghostPose, ghostTimeAt, ghostStore, packSamples, GHOST_STRIDE } from '../client/src/timeattack/ghosts';
/** Time attack ghosts: where the ghost is at a time, how far ahead you are, and the storage limits. */
const store: Record<string, string> = {};
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => void (store[k] = v),
  removeItem: (k: string) => void delete store[k],
};

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

// a run at 20 m/s along +x, sampled every 100 ms: [t, x, y, z, heading, distance]
const run: number[] = [];
for (let i = 0; i <= 100; i++) run.push(i * 100, i * 2, 0, 0, 0, i * 2);
check(run.length === 101 * GHOST_STRIDE, 'a 10 s run has 101 samples');

const p = ghostPose(run, 5050)!;
check(Math.abs(p.x - 101) < 1e-6, 'the ghost is between two samples at 5.05 s (x = 101 m)');
check(ghostPose(run, -50)!.x === 0, 'before the start the ghost waits at the start');
check(ghostPose([], 0) === null, 'no samples, no ghost');

check(Math.abs(ghostTimeAt(run, 100)! - 5000) < 1e-6, 'the ghost passed 100 m at 5.0 s');
check(ghostTimeAt(run, 250) === null, 'past the ghost finish there is no time to compare with');
const delta = 5400 - ghostTimeAt(run, 100)!;
check(delta === 400, 'reaching 100 m at 5.4 s means 0.4 s behind the ghost');

// heading wraps the short way round
const turn = [0, 0, 0, 0, 3.1, 0, 100, 1, 0, 0, -3.1, 1];
const h = ghostPose(turn, 50)!.h;
check(Math.abs(Math.abs(h) - Math.PI) < 0.05, 'the heading turns the short way across ±π');

check(packSamples([1234.6, 1.23456, 2, 3, 0.123456, 99.999]).join() === '1235,1.23,2,3,0.12,100', 'samples are rounded to save space');

const realNow = Date.now;
let clock = realNow();
Date.now = () => (clock += 1000); // each ghost is saved a second after the last
for (let i = 0; i < 12; i++) ghostStore.set(`stage-${i}`, 1000 + i, run.slice(0, 12));
Date.now = realNow;
const kept = Object.keys(JSON.parse(store['cdr.ghosts']));
check(kept.length === 8, 'only the 8 newest ghosts are kept');
check(ghostStore.get('stage-11')?.timeMs === 1011 && ghostStore.get('stage-0') === null, 'the oldest ghost went first');

console.log(failures ? `\n${failures} check(s) failed` : '\nTime attack ghost maths OK');
process.exit(failures ? 1 : 0);
