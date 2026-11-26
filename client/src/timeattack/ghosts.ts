/**
 * Time attack ghosts: your best run on each stage + weather, kept in this
 * browser. A run is a list of samples, 6 numbers each: time (ms), x, y, z,
 * heading, distance along the stage.
 */
export const GHOST_STRIDE = 6;

export interface GhostRun {
  timeMs: number;
  samples: number[];
  at: number;
}

const KEY = 'cdr.ghosts';
const MAX_GHOSTS = 8; // oldest ones go first, so the browser's storage never fills up

const read = (): Record<string, GhostRun> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
};

export const ghostStore = {
  get: (key: string): GhostRun | null => read()[key] ?? null,

  set(key: string, timeMs: number, samples: number[]) {
    const all = read();
    all[key] = { timeMs, samples, at: Date.now() };
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
    for (const old of keys.slice(MAX_GHOSTS)) delete all[old];
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      /* storage full or unavailable – the time is still saved, only the ghost is lost */
    }
  },
};

/** Rounds a recorded run so it takes little space. */
export const packSamples = (s: number[]) => s.map((n, i) => (i % GHOST_STRIDE === 0 ? Math.round(n) : Math.round(n * 100) / 100));

/** Interpolates a ghost's pose at a race time (ms). */
export function ghostPose(samples: number[], tMs: number): { x: number; y: number; z: number; h: number } | null {
  const n = Math.floor(samples.length / GHOST_STRIDE);
  if (n < 2) return null;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid * GHOST_STRIDE] <= tMs) lo = mid;
    else hi = mid;
  }
  const a = lo * GHOST_STRIDE;
  const b = hi * GHOST_STRIDE;
  const span = samples[b] - samples[a];
  const f = span > 0 ? Math.min(1, Math.max(0, (tMs - samples[a]) / span)) : 0;
  let dh = samples[b + 4] - samples[a + 4];
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  return {
    x: samples[a + 1] + (samples[b + 1] - samples[a + 1]) * f,
    y: samples[a + 2] + (samples[b + 2] - samples[a + 2]) * f,
    z: samples[a + 3] + (samples[b + 3] - samples[a + 3]) * f,
    h: samples[a + 4] + dh * f,
  };
}

/** The time (ms) the ghost reached a distance along the stage – to show how far ahead or behind you are. */
export function ghostTimeAt(samples: number[], distance: number): number | null {
  const n = Math.floor(samples.length / GHOST_STRIDE);
  if (n < 2) return null;
  let lo = 0;
  let hi = n - 1;
  if (distance <= samples[5]) return samples[0];
  if (distance >= samples[hi * GHOST_STRIDE + 5]) return null; // the ghost has already finished
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid * GHOST_STRIDE + 5] <= distance) lo = mid;
    else hi = mid;
  }
  const a = lo * GHOST_STRIDE;
  const b = hi * GHOST_STRIDE;
  const span = samples[b + 5] - samples[a + 5];
  const f = span > 0 ? (distance - samples[a + 5]) / span : 0;
  return samples[a] + (samples[b] - samples[a]) * f;
}
