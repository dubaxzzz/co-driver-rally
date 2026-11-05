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
    }
  | {
      kind: 'corner';
      dir: CornerDir;
      severity: Severity;
      /** Total direction change in degrees. */
      angle: number;
      modifier?: CornerModifier;
      hazard?: HazardType;
    };

export interface StageDef {
  id: string;
  name: string;
  location: string;
  surface: 'gravel' | 'tarmac' | 'snow';
  roadWidth: number;
  segments: SegmentDef[];
  /** Fractions of the stage length at which checkpoints are placed. */
  checkpointFractions: number[];
  /** Seed for deterministic scenery. */
  seed: number;
  environment: {
    fogColor: number;
    fogDensity: number;
    skyTop: number;
    skyBottom: number;
    sunElevationDeg: number;
    sunAzimuthDeg: number;
    treeDensity: number;
  };
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
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };
}
