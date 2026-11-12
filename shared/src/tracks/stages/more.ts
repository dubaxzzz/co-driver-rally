import type { HazardType, SegmentDef, Severity, StageDef, StageScenery } from '../types';
import type { SurfaceId } from '../../surfaces';
import type { WeatherId } from '../../weather';

/**
 * Twelve more stages around the world. Their roads are laid out from a seed:
 * corners alternate so the road always makes progress (it can never cross
 * itself), with crests, jumps, bridges and surface changes sprinkled in.
 */

interface Recipe {
  id: string;
  name: string;
  location: string;
  description: string;
  surface: SurfaceId;
  offroad: SurfaceId;
  roadWidth: number;
  seed: number;
  weather: WeatherId;
  scenery: StageScenery;
  /** Number of corners. */
  corners: number;
  /** Corner tightness range (1 = tightest, 6 = flat out). */
  sev: [number, number];
  /** Straight length range (m). */
  straight: [number, number];
  /** Surfaces mixed into some sections. */
  mix?: SurfaceId[];
  bridges?: number;
  jumps?: boolean;
  /** Seconds per km for the hard AI in clear weather – sets the daily medal targets. */
  secPerKm: number;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function layout(r: Recipe): { segments: SegmentDef[]; lengthM: number } {
  const rand = rng(r.seed * 7919);
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  const segs: SegmentDef[] = [{ kind: 'straight', length: 80 }];
  let len = 80;
  let heading = 0; // degrees, + = left
  let bridgesLeft = r.bridges ?? 0;
  let lastBridge = -10;
  for (let i = 0; i < r.corners; i++) {
    const sev = Math.round(r.sev[0] + rand() * (r.sev[1] - r.sev[0])) as Severity;
    const n = typeof sev === 'number' ? sev : 1;
    // tighter corners turn further
    let angle = Math.round(110 - n * 12 + rand() * 25);
    // keep the road heading broadly the same way: never more than 80° off
    let dir: 'L' | 'R' = heading > 25 ? 'R' : heading < -25 ? 'L' : rand() < 0.5 ? 'L' : 'R';
    const sign = dir === 'L' ? 1 : -1;
    if (Math.abs(heading + sign * angle) > 80) angle = Math.max(25, 80 - Math.abs(heading));
    if (Math.abs(heading + sign * angle) > 80) {
      dir = dir === 'L' ? 'R' : 'L';
    }
    heading += (dir === 'L' ? 1 : -1) * angle;
    const corner: SegmentDef = { kind: 'corner', dir, severity: sev, angle };
    if (rand() < 0.2) corner.modifier = pick(['tightens', 'opens', 'long', 'dontcut'] as const);
    if (r.mix && rand() < 0.25) corner.surface = pick(r.mix);
    segs.push(corner);
    len += angle * 0.6;

    const sl = Math.round(r.straight[0] + rand() * (r.straight[1] - r.straight[0]));
    const st: SegmentDef = { kind: 'straight', length: sl };
    // bridges need long straights, well spread out along the stage
    if (bridgesLeft > 0 && i >= 2 && i - lastBridge >= 5 && i < r.corners - 2) {
      st.bridge = true;
      st.length = Math.max(sl, 100);
      lastBridge = i;
      bridgesLeft--;
    } else if (r.jumps && rand() < 0.2 && sl > 70) {
      st.feature = 'jump';
      st.hazard = 'jump';
    } else if (rand() < 0.2 && sl > 60) {
      st.feature = 'crest';
      st.hazard = 'crest';
    } else if (rand() < 0.12) {
      st.hazard = pick(['rocks', 'narrows', 'bump'] as HazardType[]);
    }
    if (!st.bridge && r.mix && rand() < 0.25) st.surface = pick(r.mix);
    segs.push(st);
    len += sl;
  }
  segs.push({ kind: 'straight', length: 140 });
  return { segments: segs, lengthM: len + 140 };
}

function stage(r: Recipe): StageDef {
  const { segments, lengthM } = layout(r);
  return {
    id: r.id,
    name: r.name,
    location: r.location,
    description: r.description,
    surface: r.surface,
    offroad: r.offroad,
    roadWidth: r.roadWidth,
    seed: r.seed,
    checkpointFractions: [0.25, 0.5, 0.75],
    referenceTimeMs: Math.round((lengthM / 1000) * r.secPerKm * 1000),
    defaultWeather: r.weather,
    scenery: r.scenery,
    segments,
  };
}

const sc = (o: Partial<StageScenery> & Pick<StageScenery, 'trees' | 'grassA' | 'grassB'>): StageScenery => ({
  sunElevationDeg: 35,
  sunAzimuthDeg: 120,
  treeDensity: 1,
  patch: 0x4a4636,
  verge: 0x5b5040,
  rock: 0x77756f,
  hills: 35,
  ...o,
});

export const MORE_STAGES: StageDef[] = [
  stage({
    id: 'highland-pass', name: 'Highland Pass', location: 'Scottish Highlands, UK',
    description: 'Open moorland gravel over a mountain pass. Fast, exposed and soaked in drizzle.',
    surface: 'gravel', offroad: 'grass', roadWidth: 8, seed: 5101, weather: 'rain',
    scenery: sc({ trees: 'pine', treeDensity: 0.55, grassA: 0x55663a, grassB: 0x6f7a46, patch: 0x6b5a7a, hills: 60 }),
    corners: 16, sev: [2, 5], straight: [60, 150], mix: ['mud'], bridges: 1, secPerKm: 34,
  }),
  stage({
    id: 'atlas-dunes', name: 'Atlas Dunes', location: 'Merzouga, Morocco',
    description: 'Hard-packed desert piste between golden dunes. Leave the track and you are in soft sand.',
    surface: 'gravel', offroad: 'sand', roadWidth: 10, seed: 5202, weather: 'clear',
    scenery: sc({ trees: 'scrub', treeDensity: 0.2, grassA: 0xd9a35a, grassB: 0xe8b86d, patch: 0xc98a45, verge: 0xc48d4e, rock: 0xa86f3c, sunElevationDeg: 60, hills: 28 }),
    corners: 14, sev: [3, 6], straight: [90, 200], mix: ['sand'], jumps: true, secPerKm: 34,
  }),
  stage({
    id: 'lapland-night', name: 'Lapland Night', location: 'Rovaniemi, Finland',
    description: 'Ice and snow between snowbanks under the Arctic sky. Lean on the banks – carefully.',
    surface: 'snow', offroad: 'snowbank', roadWidth: 7.5, seed: 5303, weather: 'snow',
    scenery: sc({ trees: 'snowpine', treeDensity: 1.3, grassA: 0xe8eef3, grassB: 0xd6dfe6, patch: 0xc4ced6, verge: 0xdfe6ec, rock: 0x8a9096, sunElevationDeg: 8, hills: 25 }),
    corners: 18, sev: [2, 5], straight: [50, 130], jumps: true, secPerKm: 38,
  }),
  stage({
    id: 'corsica-coast', name: 'Corsican Coast', location: 'Corsica, France',
    description: 'Narrow, twisty tarmac clinging to the cliffs. Ten thousand corners and no room for error.',
    surface: 'tarmac', offroad: 'grass', roadWidth: 6.5, seed: 5404, weather: 'clear',
    scenery: sc({ trees: 'scrub', treeDensity: 0.9, grassA: 0x6b7a3a, grassB: 0x8a8a4a, patch: 0x9a8a6a, verge: 0x8c8574, rock: 0xa49a88, sunElevationDeg: 45, hills: 70 }),
    corners: 22, sev: [1, 4], straight: [40, 100], secPerKm: 35,
  }),
  stage({
    id: 'andes-switchback', name: 'Andes Switchbacks', location: 'Córdoba, Argentina',
    description: 'Rocky mountain gravel with tight hairpin-like bends and big crests near the summit.',
    surface: 'gravel', offroad: 'grass', roadWidth: 7.5, seed: 5505, weather: 'overcast',
    scenery: sc({ trees: 'scrub', treeDensity: 0.6, grassA: 0x7d7a4a, grassB: 0x948b56, patch: 0x7a6e5a, rock: 0x8a8378, hills: 80 }),
    corners: 20, sev: [1, 4], straight: [45, 120], bridges: 1, secPerKm: 37,
  }),
  stage({
    id: 'black-forest', name: 'Black Forest', location: 'Baden-Württemberg, Germany',
    description: 'Wet tarmac through dark firs, with muddy cuts across farm tracks.',
    surface: 'tarmac', offroad: 'grass', roadWidth: 7, seed: 5606, weather: 'rain',
    scenery: sc({ trees: 'pine', treeDensity: 1.45, grassA: 0x2d4a24, grassB: 0x3f5d2c, patch: 0x3a3226, verge: 0x4a4436, hills: 45 }),
    corners: 18, sev: [2, 5], straight: [50, 140], mix: ['mud'], secPerKm: 34,
  }),
  stage({
    id: 'kenya-savannah', name: 'Savannah Sunset', location: 'Naivasha, Kenya',
    description: 'Red earth and fesh-fesh dust across the plains, with a muddy river crossing.',
    surface: 'gravel', offroad: 'grass', roadWidth: 8.5, seed: 5707, weather: 'dusk',
    scenery: sc({ trees: 'eucalyptus', treeDensity: 0.35, grassA: 0x9a8a42, grassB: 0xb39a52, patch: 0x8a4a2a, verge: 0x9a4f2c, rock: 0x7a5a44, sunElevationDeg: 6, sunAzimuthDeg: 260, hills: 30 }),
    corners: 14, sev: [3, 6], straight: [80, 180], mix: ['mud', 'sand'], bridges: 1, jumps: true, secPerKm: 33,
  }),
  stage({
    id: 'otago-gorge', name: 'Otago Gorge', location: 'Central Otago, New Zealand',
    description: 'Flowing gravel along a river gorge, crossing it twice on old wooden bridges.',
    surface: 'gravel', offroad: 'grass', roadWidth: 8, seed: 5808, weather: 'overcast',
    scenery: sc({ trees: 'pine', treeDensity: 0.8, grassA: 0x8a8a4a, grassB: 0xa39a5a, patch: 0x6a6a5a, rock: 0x7b7b74, hills: 75 }),
    corners: 18, sev: [2, 5], straight: [60, 150], bridges: 2, secPerKm: 34,
  }),
  stage({
    id: 'arctic-lake', name: 'Frozen Lake', location: 'Trysil, Norway',
    description: 'A blizzard-blasted run along a frozen lake shore. Grip is a rumour.',
    surface: 'snow', offroad: 'snowbank', roadWidth: 8, seed: 5909, weather: 'storm',
    scenery: sc({ trees: 'snowpine', treeDensity: 0.9, grassA: 0xf0f4f7, grassB: 0xdde5ea, patch: 0xbcc8d2, verge: 0xe4eaee, rock: 0x80878e, sunElevationDeg: 12, hills: 20 }),
    corners: 16, sev: [2, 5], straight: [60, 150], secPerKm: 38,
  }),
  stage({
    id: 'sardinia-ridge', name: 'Sardinia Ridge', location: 'Olbia, Sardinia',
    description: 'Sandy, rutted gravel over rolling ridges – full of jumps.',
    surface: 'gravel', offroad: 'sand', roadWidth: 7.5, seed: 6010, weather: 'clear',
    scenery: sc({ trees: 'scrub', treeDensity: 0.8, grassA: 0x8a8a4e, grassB: 0xa59a5e, patch: 0xc2a46a, verge: 0xb59a6a, rock: 0x9a8f7c, sunElevationDeg: 50, hills: 40 }),
    corners: 18, sev: [2, 5], straight: [50, 140], mix: ['sand'], jumps: true, secPerKm: 36,
  }),
  stage({
    id: 'mojave-run', name: 'Mojave Run', location: 'Mojave Desert, USA',
    description: 'Blisteringly fast desert roads at sundown. Huge speeds, huge jumps.',
    surface: 'gravel', offroad: 'sand', roadWidth: 11, seed: 6111, weather: 'dusk',
    scenery: sc({ trees: 'scrub', treeDensity: 0.25, grassA: 0xc8935a, grassB: 0xd8a46a, patch: 0xa8744a, verge: 0xc08a58, rock: 0x9a6a4a, sunElevationDeg: 5, sunAzimuthDeg: 250, hills: 50 }),
    corners: 12, sev: [3, 6], straight: [120, 240], mix: ['sand'], jumps: true, secPerKm: 32,
  }),
  stage({
    id: 'yorkshire-moor', name: 'Moorland Mud', location: 'North Yorkshire, UK',
    description: 'A storm over the moors turns the forest tracks into a mud bath.',
    surface: 'gravel', offroad: 'grass', roadWidth: 7, seed: 6212, weather: 'storm',
    scenery: sc({ trees: 'pine', treeDensity: 1.1, grassA: 0x3f4a2a, grassB: 0x55603a, patch: 0x5a4a6a, verge: 0x4e4030, hills: 35 }),
    corners: 18, sev: [2, 5], straight: [50, 130], mix: ['mud'], bridges: 1, secPerKm: 35,
  }),
];
