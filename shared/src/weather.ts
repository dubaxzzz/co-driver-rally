/** Selectable weather. Weather controls light, fog, precipitation and grip. */

export type WeatherId = 'clear' | 'overcast' | 'rain' | 'storm' | 'snow' | 'dusk';

export interface WeatherDef {
  id: WeatherId;
  name: string;
  description: string;
  night: boolean;
  rain: number; // 0..1 rain intensity (streaks + windscreen drops)
  snow: number; // 0..1 snowfall intensity
  fogColor: number;
  fogDensity: number;
  skyTop: number;
  skyBottom: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** Multiplies tyre grip on every surface (wet/icy weather < 1). */
  grip: number;
  /** Headlights on by default. */
  headlights: boolean;
}

export const WEATHER: Record<WeatherId, WeatherDef> = {
  clear: {
    id: 'clear', name: 'Clear', description: 'Bright sun, dry roads, long sight lines',
    night: false, rain: 0, snow: 0,
    fogColor: 0xb9c6c9, fogDensity: 0.0035, skyTop: 0x4f86c6, skyBottom: 0xd4dcd8,
    sunColor: 0xfff0d6, sunIntensity: 2.6, hemiSky: 0xcfe3ff, hemiGround: 0x3a4a2a, hemiIntensity: 0.95,
    grip: 1, headlights: false,
  },
  overcast: {
    id: 'overcast', name: 'Overcast', description: 'Flat grey light, damp in places',
    night: false, rain: 0, snow: 0,
    fogColor: 0x8d979b, fogDensity: 0.008, skyTop: 0x6c767c, skyBottom: 0x9aa3a6,
    sunColor: 0xdfe6ea, sunIntensity: 1.1, hemiSky: 0xb7c2c8, hemiGround: 0x3a4237, hemiIntensity: 1.1,
    grip: 0.96, headlights: false,
  },
  rain: {
    id: 'rain', name: 'Rain', description: 'Steady rain – wipers on, grip down',
    night: false, rain: 0.7, snow: 0,
    fogColor: 0x6f787d, fogDensity: 0.013, skyTop: 0x4a5257, skyBottom: 0x737c80,
    sunColor: 0xc8d2d8, sunIntensity: 0.7, hemiSky: 0x9aa6ad, hemiGround: 0x2c332a, hemiIntensity: 1.0,
    grip: 0.85, headlights: true,
  },
  storm: {
    id: 'storm', name: 'Night storm', description: 'Night, heavy rain and fog – trust your co-driver',
    night: true, rain: 0.95, snow: 0,
    fogColor: 0x0a0e12, fogDensity: 0.03, skyTop: 0x05070b, skyBottom: 0x10161c,
    sunColor: 0x7f95c0, sunIntensity: 0.25, hemiSky: 0x3a4a66, hemiGround: 0x0a0d08, hemiIntensity: 0.35,
    grip: 0.8, headlights: true,
  },
  snow: {
    id: 'snow', name: 'Snowfall', description: 'Falling snow, icy patches, low visibility',
    night: false, rain: 0, snow: 0.85,
    fogColor: 0xc9d2d8, fogDensity: 0.016, skyTop: 0x9eabb5, skyBottom: 0xd9e0e4,
    sunColor: 0xe8eef4, sunIntensity: 0.9, hemiSky: 0xdfe8f0, hemiGround: 0x8a949a, hemiIntensity: 1.2,
    grip: 0.78, headlights: true,
  },
  dusk: {
    id: 'dusk', name: 'Dusk', description: 'Low orange sun, long shadows, lights on',
    night: false, rain: 0, snow: 0,
    fogColor: 0x8a6f63, fogDensity: 0.007, skyTop: 0x34406b, skyBottom: 0xe0905a,
    sunColor: 0xffa66b, sunIntensity: 1.6, hemiSky: 0x9a8aa8, hemiGround: 0x2e2a20, hemiIntensity: 0.6,
    grip: 1, headlights: true,
  },
};

export const WEATHER_IDS = Object.keys(WEATHER) as WeatherId[];
export const DEFAULT_WEATHER: WeatherId = 'storm';

// ------------------------------------------------------------------ changing conditions
/**
 * What changes along a stage on a given run: rain showers drifting over
 * sections, fog banks in the dips, and things on the road (a fallen tree,
 * a rock slide, animals crossing). It's worked out from the stage and the
 * run number, so every player in the room – and the co-driver's tablet –
 * gets exactly the same stage.
 */
export interface Zone {
  from: number;
  to: number;
  /** 0..1 how much rain / fog at the heart of the zone. */
  amount: number;
}

export type ObstacleKind = 'tree' | 'rocks' | 'animals';

export interface Obstacle {
  kind: ObstacleKind;
  /** Stage distance (m). */
  distance: number;
  /** Which half of the road it blocks: +1 left, −1 right (the gap is on the other side). */
  side: 1 | -1;
}

export interface StageConditions {
  wet: Zone[];
  fog: Zone[];
  obstacles: Obstacle[];
}

function rngFor(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stageConditions(
  stage: { def: { seed: number; surface: string }; startDistance: number; finishDistance: number; bridges: Array<{ distance: number; length: number }> },
  runId: number,
  weather: WeatherId,
): StageConditions {
  const rand = rngFor(stage.def.seed * 7919 + runId * 104729);
  const len = stage.finishDistance - stage.startDistance;
  const at = (lo: number, hi: number) => stage.startDistance + len * (lo + rand() * (hi - lo));
  const out: StageConditions = { wet: [], fog: [], obstacles: [] };
  const w = WEATHER[weather];
  // a passing shower on a dry day (not when it's already raining, or snowing)
  if (w.rain === 0 && w.snow === 0 && rand() < 0.55) {
    const from = at(0.15, 0.6);
    out.wet.push({ from, to: from + 350 + rand() * 600, amount: 0.5 + rand() * 0.4 });
  }
  // fog banks (thicker in bad weather)
  const fogs = rand() < (w.fogDensity > 0.01 ? 0.7 : 0.4) ? 1 + (rand() < 0.3 ? 1 : 0) : 0;
  for (let i = 0; i < fogs; i++) {
    const from = at(0.1, 0.85);
    out.fog.push({ from, to: from + 200 + rand() * 350, amount: 0.5 + rand() * 0.5 });
  }
  // something on the road (never on or right next to a bridge)
  const kinds: ObstacleKind[] = ['tree', 'rocks', 'animals'];
  const n = rand() < 0.75 ? 1 + (rand() < 0.35 ? 1 : 0) : 0;
  for (let i = 0; i < n; i++) {
    let d = at(0.2, 0.9);
    for (let tries = 0; tries < 5 && stage.bridges.some((b) => Math.abs(b.distance - d) < b.length / 2 + 60); tries++) d = at(0.2, 0.9);
    if (out.obstacles.some((o) => Math.abs(o.distance - d) < 250)) continue;
    out.obstacles.push({ kind: kinds[Math.floor(rand() * kinds.length)], distance: d, side: rand() < 0.5 ? 1 : -1 });
  }
  out.obstacles.sort((a, b) => a.distance - b.distance);
  return out;
}

/** How much of a zone list applies at a stage distance (ramps in/out over 60 m). */
export function zoneAmount(zones: Zone[], d: number): number {
  let v = 0;
  for (const z of zones) {
    if (d < z.from - 60 || d > z.to + 60) continue;
    const edge = Math.min(1, (d - (z.from - 60)) / 120, ((z.to + 60) - d) / 120);
    v = Math.max(v, z.amount * Math.max(0, edge));
  }
  return v;
}
