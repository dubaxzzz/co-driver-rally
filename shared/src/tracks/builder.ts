import type {
  BuiltStage,
  CenterlineSample,
  Checkpoint,
  PaceNote,
  SegmentDef,
  StageDef,
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
  const leadIn = 40; // road behind the start line
  let d = 0;
  spans.push({ from: 0, to: leadIn, k0: 0, k1: 0 });
  d = leadIn;

  for (const seg of def.segments) {
    if (seg.kind === 'straight') {
      spans.push({ from: d, to: d + seg.length, k0: 0, k1: 0 });
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
      d += len;
    }
  }
  const length = d;

  // 2. Integrate heading and position.
  const samples: CenterlineSample[] = [];
  let x = 0;
  let z = 0;
  let h = 0;
  let spanIdx = 0;
  const count = Math.floor(length / STEP) + 1;
  for (let i = 0; i < count; i++) {
    const s = i * STEP;
    while (spanIdx < spans.length - 1 && s >= spans[spanIdx].to) spanIdx++;
    const sp = spans[spanIdx];
    const u = sp.to > sp.from ? Math.min(1, Math.max(0, (s - sp.from) / (sp.to - sp.from))) : 0;
    // smooth curvature transitions slightly to avoid kinks
    const k = sp.k0 + (sp.k1 - sp.k0) * u;
    const y = baseElevation(s) + featureElevation(s, features);
    samples.push({ d: s, x, y, z, h, k });
    h += k * STEP;
    x += Math.sin(h) * STEP;
    z += Math.cos(h) * STEP;
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

  return {
    def,
    samples,
    step: STEP,
    length,
    startDistance,
    spawnDistance,
    finishDistance,
    checkpoints,
    paceNotes: notes,
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
  return {
    distance: Math.max(0, Math.min(stage.length, a.d + u * STEP)),
    lateral,
    roadY: a.y + (b.y - a.y) * Math.max(0, Math.min(1, u)),
    index: best,
  };
}
