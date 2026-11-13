import type { SurfaceId } from '../surfaces';
import type { WeatherId } from '../weather';

export type CornerDir = 'L' | 'R';
/** 1 = slowest (near-hairpin) ... 6 = nearly flat. 'H' = hairpin. */
export type Severity = 1 | 2 | 3 | 4 | 5 | 6 | 'H';
export type CornerModifier = 'tightens' | 'opens' | 'long' | 'dontcut' | 'overcrest';
export type HazardType = 'jump' | 'crest' | 'rocks' | 'narrows' | 'bump';

export type SegmentDef =
  | {
      kind: 'straight';
      length: number;
      /** Elevation feature placed at the middle of the straight. */
      feature?: 'crest' | 'jump';
      hazard?: HazardType;
      /** A wooden bridge over a fast river in the middle of this straight. */
      bridge?: boolean;
      /** Road surface for this segment (defaults to the stage surface). */
      surface?: SurfaceId;
      /** Climb in % (negative = downhill) – mountain stages. */
      grade?: number;
      /** The mid-stage service zone is on this straight (long stages only). */
      service?: boolean;
    }
  | {
      kind: 'corner';
      dir: CornerDir;
      severity: Severity;
      /** Total direction change in degrees. */
      angle: number;
      modifier?: CornerModifier;
      hazard?: HazardType;
      surface?: SurfaceId;
      /** Climb in % (negative = downhill) – mountain stages. */
      grade?: number;
    };

export type TreeStyle = 'pine' | 'snowpine' | 'eucalyptus' | 'scrub';

export interface StageScenery {
  sunElevationDeg: number;
  sunAzimuthDeg: number;
  trees: TreeStyle;
  /** 0..1.5 – how dense the roadside vegetation is. */
  treeDensity: number;
  grassA: number;
  grassB: number;
  /** Patches mixed into the ground colour (moss, rock, snow…). */
  patch: number;
  /** Colour of the road shoulders / verge. */
  verge: number;
  rock: number;
  /** Height of the surrounding hills (m). */
  hills: number;
}

export interface StageDef {
  id: string;
  name: string;
  location: string;
  description: string;
  /** Default road surface (segments can override). */
  surface: SurfaceId;
  /** What you drive on if you leave the road. */
  offroad: SurfaceId;
  roadWidth: number;
  segments: SegmentDef[];
  /** Fractions of the stage length at which checkpoints are placed. */
  checkpointFractions: number[];
  /** Seed for deterministic scenery. */
  seed: number;
  /** Hard-AI time in clear weather (ms) – used for medal targets. */
  referenceTimeMs: number;
  /** Weather picked when this stage is selected (players can change it). */
  defaultWeather: WeatherId;
  scenery: StageScenery;
  /** Mountain stages: the road follows its own climb, without the usual rolling hills. */
  flatBase?: boolean;
  /** The light fades from day to night along the stage. */
  nightfall?: boolean;
}

/** Spectators behind tape at a hairpin or jump. Crossing the tape = time penalty. */
export interface CrowdZone {
  index: number;
  /** Where the crowd starts and how long it lines the road (m). */
  distance: number;
  length: number;
  /** +1 = on the left of the road, -1 = right. */
  side: 1 | -1;
}

/**
 * A fork in the road: a rough short cut that leaves the stage at `from` and
 * rejoins it at `to`. Progress along it counts as the main road it skips.
 */
export interface StageSplit {
  index: number;
  from: number;
  to: number;
  /** Which way the short cut turns off at the fork. */
  side: 'L' | 'R';
  /** cut = shorter but rough and narrow; fast = longer but wide, smooth and flowing. */
  kind: 'cut' | 'fast';
  surface: SurfaceId;
  width: number;
  /** Centreline of the short cut (d = metres along the short cut). */
  samples: CenterlineSample[];
  length: number;
}

/** The mid-stage service zone (long stages only). */
export interface ServiceZone {
  distance: number;
  length: number;
  /**
   * The pit area beside the road: a flat concrete apron you drive onto, with a
   * marked box where you stop to service the car. `side` +1 = left, -1 = right.
   */
  side: 1 | -1;
  /** Apron: along the road from..to (stage distance), out from lat0 to lat1 metres from the centre line. */
  apronFrom: number;
  apronTo: number;
  lat0: number;
  lat1: number;
  /** The pit box: centre (stage distance, metres out from the centre line) and size. */
  boxD: number;
  boxLat: number;
  boxLen: number;
  boxWid: number;
}

export interface CenterlineSample {
  d: number;
  x: number;
  y: number;
  z: number;
  /** Heading (radians). Forward = (sin h, 0, cos h). Left turn increases h. */
  h: number;
  /** Signed curvature (1/m), positive = turning left. */
  k: number;
}

export interface PaceNote {
  index: number;
  /** Distance from start at which the feature begins (m). */
  distance: number;
  /** Length of the feature (m). */
  length: number;
  kind: 'corner' | 'hazard';
  dir: CornerDir | null;
  severity: Severity | null;
  modifiers: CornerModifier[];
  hazard: HazardType | null;
  /** Links into the next note ("into"). */
  into: boolean;
  /** Ready-made call text, e.g. "LEFT 3 TIGHTENS". */
  text: string;
  /** Short spoken form. */
  spoken: string;
}

export interface Checkpoint {
  index: number;
  distance: number;
  x: number;
  y: number;
  z: number;
  h: number;
}

export interface SurfaceSpan {
  from: number;
  to: number;
  surface: SurfaceId;
}

export interface Bridge {
  index: number;
  /** Distance of the bridge centre along the stage. */
  distance: number;
  length: number;
  x: number;
  y: number;
  z: number;
  h: number;
}

export interface River {
  bridgeIndex: number;
  /** Centre line of the river (crosses the road at its bridge). */
  points: Array<{ x: number; z: number }>;
  halfWidth: number;
  /** Water surface height. */
  waterY: number;
  /** River bed height. */
  bedY: number;
}


export interface BuiltStage {
  def: StageDef;
  samples: CenterlineSample[];
  /** Sample spacing in metres. */
  step: number;
  length: number;
  startDistance: number;
  spawnDistance: number;
  finishDistance: number;
  checkpoints: Checkpoint[];
  paceNotes: PaceNote[];
  surfaceSpans: SurfaceSpan[];
  bridges: Bridge[];
  /** Rivers running under the bridges. */
  rivers: River[];
  /** Crowds at hairpins and jumps. */
  crowds: CrowdZone[];
  service: ServiceZone | null;
  /** Forks: short cuts through the inside of big loops of road. */
  splits: StageSplit[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };
}
