import type { SurfaceId } from '../surfaces';
import type {
  Bridge,
  BuiltStage,
  CenterlineSample,
  Checkpoint,
  CrowdZone,
  ServiceZone,
  StageSplit,
  PaceNote,
  River,
  SegmentDef,
  StageDef,
  SurfaceSpan,
} from './types';

/** Corner radius (m) for each severity. */
export const SEVERITY_RADIUS: Record<string, number> = {
  H: 11,
  '1': 17,
  '2': 26,
  '3': 40,
  '4': 62,
  '5': 95,
  '6': 150,
};

const STEP = 1; // metres between centreline samples
const DEG = Math.PI / 180;

interface ElevationFeature {
  center: number;
  type: 'crest' | 'jump';
}

function baseElevation(d: number): number {
  return 8 * Math.sin(d / 310) + 5 * Math.sin(d / 137 + 1.3) + 2.5 * Math.sin(d / 61 + 0.7);
}

function featureElevation(d: number, features: ElevationFeature[]): number {
  let y = 0;
  for (const f of features) {
    const u = d - f.center;
    if (f.type === 'crest') {
      const half = 35;
      if (Math.abs(u) < half) y += 3.2 * 0.5 * (1 + Math.cos((Math.PI * u) / half));
    } else {
      // Kicker: long ramp up, short sharp drop – launches the car.
      const up = 30;
      const down = 10;
      if (u > -up && u <= 0) {
        const s = (u + up) / up;
        y += 1.8 * s * s;
      } else if (u > 0 && u < down) {
        const s = 1 - u / down;
        y += 1.8 * s * s * s;
      }
    }
  }
  return y;
}

function noteText(seg: Extract<SegmentDef, { kind: 'corner' }>): { text: string; spoken: string } {
  const dir = seg.dir === 'L' ? 'LEFT' : 'RIGHT';
  const mod: Record<string, string> = {
    tightens: 'TIGHTENS',
    opens: 'OPENS',
    long: 'LONG',
    dontcut: "DON'T CUT",
    overcrest: 'OVER CREST',
  };
  let text = seg.severity === 'H' ? `HAIRPIN ${dir}` : `${dir} ${seg.severity}`;
  if (seg.modifier) text += ` ${mod[seg.modifier]}`;
  if (seg.hazard === 'rocks') text += ' – ROCKS';
  return { text, spoken: text.replace('–', ',').toLowerCase() };
}

const HAZARD_TEXT: Record<string, string> = {
  jump: 'CAUTION: JUMP',
  crest: 'OVER CREST',
  rocks: 'CAUTION: ROCKS',
  narrows: 'CAUTION: NARROWS',
  bump: 'CAUTION: BUMP',
};

/** Generates the full centreline, checkpoints and pace notes for a stage. */
export function buildStage(def: StageDef): BuiltStage {
  // 1. Lay out curvature along distance.
  type Span = { from: number; to: number; k0: number; k1: number };
  const spans: Span[] = [];
  const features: ElevationFeature[] = [];
  const notes: PaceNote[] = [];
  const surfaceSpans: SurfaceSpan[] = [];
  const bridgeAt: Array<{ d: number; length: number }> = [];
  /** Climb (%) per span of road, integrated into the elevation below. */
  const grades: Array<{ from: number; to: number; g: number }> = [];
  const crowdAt: Array<{ d: number; length: number; side: 1 | -1 }> = [];
  let service: ServiceZone | null = null;
  const addSurface = (from: number, to: number, surface: SurfaceId) => {
    const last = surfaceSpans[surfaceSpans.length - 1];
    if (last && last.surface === surface && Math.abs(last.to - from) < 1e-6) last.to = to;
    else surfaceSpans.push({ from, to, surface });
  };
  const leadIn = 40; // road behind the start line
  let d = 0;
  spans.push({ from: 0, to: leadIn, k0: 0, k1: 0 });
  addSurface(0, leadIn, def.surface);
  d = leadIn;

  for (const seg of def.segments) {
    const segSurface = seg.surface ?? def.surface;
    const segStart = d;
    if (seg.kind === 'straight') {
      if (seg.service) {
        const len = Math.max(40, seg.length - 50);
        const mid = d + 25 + len / 2;
        const hw = def.roadWidth / 2;
        service = { distance: d + 25, length: len, side: -1, apronFrom: mid - 70, apronTo: mid + 70, lat0: hw - 0.4, lat1: hw + 15, boxD: mid, boxLat: hw + 8.5, boxLen: 9, boxWid: 4.6 };
      }
      // jumps draw a crowd on one side
      if (seg.feature === 'jump') crowdAt.push({ d: d + seg.length / 2 - 30, length: 50, side: (Math.round(d) % 2 ? 1 : -1) as 1 | -1 });
      spans.push({ from: d, to: d + seg.length, k0: 0, k1: 0 });
      if (seg.bridge) {
        const bl = Math.min(26, seg.length * 0.6);
        const c = d + seg.length / 2;
        addSurface(d, c - bl / 2, segSurface);
        addSurface(c - bl / 2, c + bl / 2, 'wood');
        addSurface(c + bl / 2, d + seg.length, segSurface);
        bridgeAt.push({ d: c, length: bl });
      } else {
        addSurface(d, d + seg.length, segSurface);
      }
      if (seg.feature) features.push({ center: d + seg.length / 2, type: seg.feature });
      if (seg.hazard) {
        const at = seg.feature ? d + seg.length / 2 - 20 : d;
        notes.push({
          index: 0,
          distance: at,
          length: 30,
          kind: 'hazard',
          dir: null,
          severity: null,
          modifiers: [],
          hazard: seg.hazard,
          into: false,
          text: HAZARD_TEXT[seg.hazard],
          spoken: HAZARD_TEXT[seg.hazard].replace('CAUTION: ', 'caution, ').toLowerCase(),
        });
      }
      d += seg.length;
    } else {
      const r = SEVERITY_RADIUS[String(seg.severity)];
      const sign = seg.dir === 'L' ? 1 : -1;
      let r0 = r;
      let r1 = r;
      if (seg.modifier === 'tightens') {
        r0 = r * 1.35;
        r1 = r * 0.7;
      } else if (seg.modifier === 'opens') {
        r0 = r * 0.7;
        r1 = r * 1.35;
      }
      const k0 = sign / r0;
      const k1 = sign / r1;
      const angle = seg.angle * DEG;
      // arc length for a linearly varying curvature: angle = L * (k0+k1)/2
      const len = angle / ((Math.abs(k0) + Math.abs(k1)) / 2);
      if (seg.modifier === 'overcrest') features.push({ center: d + 5, type: 'crest' });
      if (seg.severity === 'H') {
        notes.push({
          index: 0,
          distance: Math.max(0, d - 60),
          length: 10,
          kind: 'hazard',
          dir: null,
          severity: null,
          modifiers: [],
          hazard: null,
          into: false,
          text: 'BRAKE FOR HAIRPIN',
          spoken: 'brake for hairpin',
        });
      }
      const t = noteText(seg);
      notes.push({
        index: 0,
        distance: d,
        length: len,
        kind: 'corner',
        dir: seg.dir,
        severity: seg.severity,
        modifiers: seg.modifier ? [seg.modifier] : [],
        hazard: seg.hazard ?? null,
        into: false,
        text: t.text,
        spoken: t.spoken,
      });
      spans.push({ from: d, to: d + len, k0, k1 });
      addSurface(d, d + len, segSurface);
      // hairpins and the tightest corners draw a crowd on the outside
      if (seg.severity === 'H' || seg.severity === 1) crowdAt.push({ d: d - 10, length: len + 20, side: (seg.dir === 'L' ? -1 : 1) as 1 | -1 });
      d += len;
    }
    if (seg.grade) grades.push({ from: segStart, to: d, g: seg.grade });
  }
  const length = d;
  // run-off after the last segment keeps the last surface
  surfaceSpans[surfaceSpans.length - 1].to = length + 1;

  // 2. Integrate heading and position.
  const samples: CenterlineSample[] = [];
  let x = 0;
  let z = 0;
  let h = 0;
  let spanIdx = 0;
  // exact heading at any distance (integrated per span, so a 180° hairpin really turns 180°)
  const spanH: number[] = [0];
  for (const sp of spans) spanH.push(spanH[spanH.length - 1] + (sp.to - sp.from) * (sp.k0 + sp.k1) / 2);
  let hIdx = 0;
  const headingAt = (dist: number) => {
    while (hIdx < spans.length - 1 && dist >= spans[hIdx].to) hIdx++;
    const sp = spans[hIdx];
    const L = Math.max(1e-6, sp.to - sp.from);
    const t = Math.min(L, Math.max(0, dist - sp.from));
    return spanH[hIdx] + sp.k0 * t + ((sp.k1 - sp.k0) * t * t) / (2 * L);
  };
  const count = Math.floor(length / STEP) + 1;
  // climb profile: integrate the grade, eased between segments (no kinks)
  const climb = new Float32Array(count);
  {
    const raw = new Float32Array(count);
    for (const g of grades) for (let i = Math.max(0, Math.ceil(g.from / STEP)); i < Math.min(count, g.to / STEP); i++) raw[i] = g.g / 100;
    const win = 40; // moving average over ±40 m
    let acc = 0;
    let y = 0;
    for (let i = 0; i < Math.min(count, win); i++) acc += raw[i];
    for (let i = 0; i < count; i++) {
      const add = i + win < count ? raw[i + win] : 0;
      const drop = i - win - 1 >= 0 ? raw[i - win - 1] : 0;
      acc += add - drop;
      const n = Math.min(count - 1, i + win) - Math.max(0, i - win) + 1;
      y += (acc / n) * STEP;
      climb[i] = y;
    }
  }
  const baseK = def.flatBase ? 0.25 : 1;
  for (let i = 0; i < count; i++) {
    const s = i * STEP;
    while (spanIdx < spans.length - 1 && s >= spans[spanIdx].to) spanIdx++;
    const sp = spans[spanIdx];
    const u = sp.to > sp.from ? Math.min(1, Math.max(0, (s - sp.from) / (sp.to - sp.from))) : 0;
    // smooth curvature transitions slightly to avoid kinks
    const k = sp.k0 + (sp.k1 - sp.k0) * u;
    const y = baseElevation(s) * baseK + climb[i] + featureElevation(s, features);
    samples.push({ d: s, x, y, z, h, k });
    const hm = headingAt(s + STEP / 2);
    x += Math.sin(hm) * STEP;
    z += Math.cos(hm) * STEP;
    h = headingAt(s + STEP);
  }
  // light curvature smoothing pass on positions for nicer corner entries
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < samples.length - 1; i++) {
      const a = samples[i - 1];
      const c = samples[i + 1];
      samples[i].x = (a.x + samples[i].x * 2 + c.x) / 4;
      samples[i].z = (a.z + samples[i].z * 2 + c.z) / 4;
    }
  }
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)];
    const c = samples[Math.min(samples.length - 1, i + 1)];
    samples[i].h = Math.atan2(c.x - a.x, c.z - a.z);
  }

  // 3. Notes: index + "into" links.
  notes.sort((a, b) => a.distance - b.distance);
  notes.forEach((n, i) => {
    n.index = i;
    const next = notes[i + 1];
    if (n.kind === 'corner' && next && next.kind === 'corner' && next.distance - (n.distance + n.length) < 25) {
      n.into = true;
    }
  });

  const startDistance = leadIn;
  const spawnDistance = leadIn - 6;
  const finishDistance = length - 40;

  const checkpoints: Checkpoint[] = def.checkpointFractions.map((f, index) => {
    const cd = startDistance + (finishDistance - startDistance) * f;
    const s = sampleAt(samples, cd);
    return { index, distance: cd, x: s.x, y: s.y, z: s.z, h: s.h };
  });

  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const s of samples) {
    bounds.minX = Math.min(bounds.minX, s.x);
    bounds.maxX = Math.max(bounds.maxX, s.x);
    bounds.minZ = Math.min(bounds.minZ, s.z);
    bounds.maxZ = Math.max(bounds.maxZ, s.z);
    bounds.minY = Math.min(bounds.minY, s.y);
    bounds.maxY = Math.max(bounds.maxY, s.y);
  }

  const bridges: Bridge[] = bridgeAt.map((b, index) => {
    const c = sampleAt(samples, b.d);
    return { index, distance: b.d, length: b.length, x: c.x, y: c.y, z: c.z, h: c.h };
  });
  const rivers: River[] = bridges.map((b) => {
    // The river runs across the road at the bridge and meanders away on both sides.
    const lx = Math.cos(b.h), lz = -Math.sin(b.h); // left (across the road)
    const fx = Math.sin(b.h), fz = Math.cos(b.h); // along the road
    const points: Array<{ x: number; z: number }> = [];
    for (let t = -380; t <= 380; t += 8) {
      const wobble = 16 * Math.sin(t / 57 + b.index) + 6 * Math.sin(t / 21);
      const fade = Math.min(1, Math.abs(t) / 40); // straight under the bridge
      points.push({ x: b.x + lx * t + fx * wobble * fade, z: b.z + lz * t + fz * wobble * fade });
    }
    return { bridgeIndex: b.index, points, halfWidth: 7, waterY: b.y - 3.2, bedY: b.y - 4.8 };
  });

  // crowds: not too many, and never two on top of each other
  const crowds: CrowdZone[] = [];
  for (const c of crowdAt.sort((a, b) => a.d - b.d)) {
    if (c.d < startDistance + 60 || c.d > finishDistance - 40) continue;
    const last = crowds[crowds.length - 1];
    if (last && c.d - last.distance < 350) continue;
    if (service && Math.abs(c.d - service.distance) < 200) continue;
    crowds.push({ index: crowds.length, distance: c.d, length: c.length, side: c.side });
  }

  const splits = findSplits(def, samples, startDistance, finishDistance, checkpoints, bridgeAt, service, crowds, rivers);

  return {
    def,
    crowds,
    service,
    splits,
    samples,
    step: STEP,
    length,
    startDistance,
    spawnDistance,
    finishDistance,
    checkpoints,
    paceNotes: notes,
    surfaceSpans,
    bridges,
    rivers,
    bounds,
  };
}

/** Interpolated sample at a distance along the centreline. */
export function sampleAt(samples: CenterlineSample[], d: number): CenterlineSample {
  const max = samples.length - 1;
  const f = Math.min(max, Math.max(0, d / STEP));
  const i = Math.min(max - 1, Math.floor(f));
  const u = f - i;
  const a = samples[i];
  const b = samples[i + 1] ?? a;
  let dh = b.h - a.h;
  if (dh > Math.PI) dh -= Math.PI * 2;
  if (dh < -Math.PI) dh += Math.PI * 2;
  return {
    d,
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
    h: a.h + dh * u,
    k: a.k + (b.k - a.k) * u,
  };
}

export interface ProgressResult {
  /** Distance along centreline (m). */
  distance: number;
  /** Signed lateral offset (m), positive = left of centreline. */
  lateral: number;
  /** Height of the road centre at that point. */
  roadY: number;
  index: number;
  /** Which short cut the car is on (-1 = the main road). */
  branch: number;
}

/**
 * Projects a world position onto the centreline. `hint` is the previous
 * sample index; searching a window around it keeps progress continuous
 * through hairpins where the two legs are close together.
 */
export function projectOnStage(
  stage: BuiltStage,
  x: number,
  z: number,
  hint = -1,
  window = 80,
): ProgressResult {
  const s = stage.samples;
  let lo = 0;
  let hi = s.length - 1;
  if (hint >= 0) {
    lo = Math.max(0, hint - window);
    hi = Math.min(s.length - 1, hint + window);
  }
  let best = -1;
  let bestD2 = Infinity;
  for (let i = lo; i <= hi; i++) {
    const dx = s[i].x - x;
    const dz = s[i].z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  // Lost track of the car (went far off-road)? fall back to a global search.
  if (hint >= 0 && bestD2 > 45 * 45) return projectOnStage(stage, x, z, -1);

  // refine onto the segment between neighbouring samples
  const i0 = Math.max(0, Math.min(s.length - 2, best));
  const a = s[i0];
  const b = s[i0 + 1];
  const ex = b.x - a.x;
  const ez = b.z - a.z;
  const len2 = ex * ex + ez * ez || 1;
  let u = ((x - a.x) * ex + (z - a.z) * ez) / len2;
  u = Math.max(-1, Math.min(2, u));
  const px = a.x + ex * u;
  const pz = a.z + ez * u;
  // left vector = (cos h, -sin h)
  const lateral = (x - px) * Math.cos(a.h) + (z - pz) * -Math.sin(a.h);
  const main: ProgressResult = {
    distance: Math.max(0, Math.min(stage.length, a.d + u * STEP)),
    lateral,
    roadY: a.y + (b.y - a.y) * Math.max(0, Math.min(1, u)),
    index: best,
    branch: -1,
  };
  // on a short cut? its progress counts as the stretch of main road it skips
  // (while you're still on the main road's own width, you're on the main road)
  if (Math.abs(lateral) < stage.def.roadWidth / 2 + 0.6) return main;
  for (const sp of stage.splits ?? []) {
    const bs = sp.samples;
    const lim = Math.abs(lateral);
    let bi = -1;
    let bd2 = lim * lim;
    for (let i = 0; i < bs.length; i += 2) {
      const dx = bs[i].x - x, dz = bs[i].z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd2) {
        bd2 = d2;
        bi = i;
      }
    }
    if (bi < 0) continue;
    for (let i = Math.max(0, bi - 2); i <= Math.min(bs.length - 1, bi + 2); i++) {
      const dx = bs[i].x - x, dz = bs[i].z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bd2) {
        bd2 = d2;
        bi = i;
      }
    }
    const c = bs[bi];
    const f = c.d / sp.length;
    // the very ends are shared with the main road
    if (f < 0.03 || f > 0.97) continue;
    const dist = sp.from + f * (sp.to - sp.from);
    return {
      distance: dist,
      lateral: (x - c.x) * Math.cos(c.h) + (z - c.z) * -Math.sin(c.h),
      roadY: c.y,
      index: Math.round(dist / STEP),
      branch: sp.index,
    };
  }
  return main;
}

/** Road surface at a distance along the stage. */
export function surfaceAt(stage: BuiltStage, d: number): SurfaceId {
  const spans = stage.surfaceSpans;
  let lo = 0, hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].to <= d) lo = mid + 1;
    else hi = mid;
  }
  return spans[lo]?.surface ?? stage.def.surface;
}

/** Distance from a point to the nearest river centre line (and that river). */
export function riverDistance(stage: BuiltStage, x: number, z: number): { dist: number; river: River | null; dirX: number; dirZ: number } {
  let best = Infinity;
  let bestRiver: River | null = null;
  let dirX = 0, dirZ = 0;
  for (const r of stage.rivers) {
    const p = r.points;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i].x, az = p[i].z, bx = p[i + 1].x, bz = p[i + 1].z;
      const ex = bx - ax, ez = bz - az;
      const len2 = ex * ex + ez * ez || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
      const dx = ax + ex * u - x, dz = az + ez * u - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        bestRiver = r;
        const l = Math.sqrt(len2);
        dirX = ex / l; // downstream = along the point order
        dirZ = ez / l;
      }
    }
  }
  return { dist: Math.sqrt(best), river: bestRiver, dirX, dirZ };
}


/**
 * Finds places where the road makes a big loop and lays a rough short cut
 * across the inside of it: narrower, muddy or loose, but shorter. They keep
 * well clear of the rest of the road, checkpoints, bridges and the service zone.
 */
function findSplits(
  def: StageDef,
  samples: CenterlineSample[],
  start: number,
  finish: number,
  checkpoints: Checkpoint[],
  bridges: Array<{ d: number; length: number }>,
  service: ServiceZone | null,
  crowds: CrowdZone[],
  rivers: River[],
): StageSplit[] {
  const hw = def.roadWidth / 2;
  const want = Math.max(1, Math.min(3, Math.round((finish - start) / 3500)));
  // spatial hash of the main road for clearance checks
  const B = 50;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < samples.length; i += 2) {
    const k = `${Math.floor(samples[i].x / B)},${Math.floor(samples[i].z / B)}`;
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(i);
  }
  const nearestOther = (x: number, z: number, skipFrom: number, skipTo: number) => {
    let best = Infinity;
    const cx = Math.floor(x / B), cz = Math.floor(z / B);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) {
        const l = grid.get(`${cx + a},${cz + b}`);
        if (!l) continue;
        for (const i of l) {
          const d = samples[i].d;
          if (d >= skipFrom && d <= skipTo) continue;
          const dx = samples[i].x - x, dz = samples[i].z - z;
          best = Math.min(best, dx * dx + dz * dz);
        }
      }
    return Math.sqrt(best);
  };
  const riverNear = (x: number, z: number) =>
    rivers.some((r) => r.points.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 30 * 30));
  // the fork and the join must be clear of checkpoints, bridges, crowds and the service zone
  // (a checkpoint on the stretch a short cut skips is counted when you pass its point on the cut)
  const nearEnds = (d: number, d0: number, d1: number, m: number) => Math.abs(d - d0) < m || Math.abs(d - d1) < m;
  const blocked = (d0: number, d1: number) =>
    checkpoints.some((c) => nearEnds(c.distance, d0, d1, 70)) ||
    bridges.some((b) => nearEnds(b.d, d0, d1, 90)) ||
    (!!service && service.distance + service.length > d0 - 150 && service.distance < d1 + 150) ||
    crowds.some((c) => c.distance < d0 + 40 && c.distance + c.length > d0 - 40) ||
    crowds.some((c) => c.distance < d1 + 40 && c.distance + c.length > d1 - 40);
  const rough: SurfaceId = def.surface === 'tarmac' ? 'gravel' : def.surface === 'snow' ? 'snow' : 'mud';
  const out: StageSplit[] = [];
  let d0 = start + 350;
  const rand = (() => {
    let a = (def.seed * 2654435761) >>> 0 || 1;
    return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  })();
  while (d0 < finish - 500 && out.length < want) {
    let found = null as StageSplit | null;
    for (const L of [320, 420, 520, 650]) for (const bowSide of [0, 1, -1]) {
      if (found) break;
      const d1 = d0 + L;
      if (d1 > finish - 250) continue;
      if (blocked(d0, d1)) continue;
      const p0 = sampleAt(samples, d0), p1 = sampleAt(samples, d1);
      const chord = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      if (chord < 140 || chord > L * 0.9) continue;
      // Hermite curve leaving along the road at the fork, arriving along it at the join
      const k = chord * 0.55;
      const t0x = Math.sin(p0.h) * k, t0z = Math.cos(p0.h) * k;
      const t1x = Math.sin(p1.h) * k, t1z = Math.cos(p1.h) * k;
      // a bowed route swings wide of the main road's wiggles (left or right of the chord)
      let bow = 0;
      const cx = (p1.x - p0.x) / chord, cz = (p1.z - p0.z) / chord;
      const nx = -cz, nz = cx; // left of the chord
      if (bowSide) {
        let dev = 0;
        for (let d = d0; d <= d1; d += 10) {
          const q = sampleAt(samples, d);
          dev = Math.max(dev, ((q.x - p0.x) * nx + (q.z - p0.z) * nz) * bowSide);
        }
        bow = bowSide * (dev + hw * 2 + 22);
      }
      const pts: Array<{ x: number; z: number }> = [];
      const N = 400;
      for (let i = 0; i <= N; i++) {
        const u = i / N, u2 = u * u, u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
        const sw = bow * Math.sin(Math.PI * u) ** 2;
        pts.push({ x: h00 * p0.x + h10 * t0x + h01 * p1.x + h11 * t1x + nx * sw, z: h00 * p0.z + h10 * t0z + h01 * p1.z + h11 * t1z + nz * sw });
      }
      // resample every metre
      const branch: CenterlineSample[] = [];
      let acc = 0;
      let next = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        while (next <= acc + seg) {
          const u = (next - acc) / (seg || 1);
          branch.push({ d: next, x: a.x + (b.x - a.x) * u, y: 0, z: a.z + (b.z - a.z) * u, h: 0, k: 0 });
          next += STEP;
        }
        acc += seg;
      }
      const lenB = acc;
      if (lenB > L * 1.15) continue;
      // shorter = a rough short cut; about as long or longer = a fast, smooth bypass
      const cut = lenB < L * 0.97;
      // clear of the rest of the road (and not too sharp), and away from rivers
      let ok = true;
      for (let i = 0; i < branch.length && ok; i += 3) {
        const u = branch[i].d / lenB;
        const b = branch[i];
        const edge = u < 0.12 || u > 0.88;
        const clear = edge ? nearestOther(b.x, b.z, d0 - 40, d1 + 40) : nearestOther(b.x, b.z, -1, -1);
        if (clear < (edge ? hw * 2 + 6 : hw * 2 + 14)) ok = false;
        else if (riverNear(b.x, b.z)) ok = false;
      }
      if (!ok) continue;
      // headings, curvature and a bumpy height profile between the two ends
      for (let i = 0; i < branch.length; i++) {
        const a = branch[Math.max(0, i - 1)], c = branch[Math.min(branch.length - 1, i + 1)];
        branch[i].h = Math.atan2(c.x - a.x, c.z - a.z);
      }
      let tooSharp = false;
      for (let i = 4; i < branch.length - 4; i++) {
        let dh = branch[i + 4].h - branch[i - 4].h;
        if (dh > Math.PI) dh -= Math.PI * 2;
        if (dh < -Math.PI) dh += Math.PI * 2;
        branch[i].k = dh / 8;
        if (Math.abs(branch[i].k) > 1 / 22) tooSharp = true;
      }
      if (tooSharp) continue;
      const seed = rand() * 100;
      for (const b of branch) {
        const u = b.d / lenB;
        const e = u * u * (3 - 2 * u);
        const bumps = cut ? Math.sin(b.d / 9 + seed) * 0.25 + Math.sin(b.d / 3.7 + seed * 2) * 0.08 : 0;
        b.y = p0.y + (p1.y - p0.y) * e + bumps * Math.min(1, u * 8, (1 - u) * 8) + Math.sin(u * Math.PI) * 1.5 * Math.sin(seed);
      }
      // which way it turns off at the fork
      const mid = branch[Math.min(branch.length - 1, 40)];
      const lx = Math.cos(p0.h), lz = -Math.sin(p0.h);
      const side: 'L' | 'R' = (mid.x - p0.x) * lx + (mid.z - p0.z) * lz > 0 ? 'L' : 'R';
      found = cut
        ? { index: out.length, from: d0, to: d1, side, kind: 'cut', surface: rough, width: Math.max(4.6, def.roadWidth - 2.2), samples: branch, length: lenB }
        : { index: out.length, from: d0, to: d1, side, kind: 'fast', surface: def.surface === 'snow' ? 'snow' : def.surface === 'tarmac' ? 'tarmac' : 'gravel', width: def.roadWidth + 1.5, samples: branch, length: lenB };
    }
    if (found) {
      out.push(found);
      d0 = found.to + Math.max(900, ((finish - start) / want) * 0.6);
    } else d0 += 40;
  }
  return out;
}
