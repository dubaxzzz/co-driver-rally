/**
 * Driving surfaces. `grip` multiplies tyre friction; `rolling` (N) and
 * `drag` (N per m/s) slow the car down – sand, mud, deep snow and grass
 * cost a lot of speed, tarmac almost none.
 */

export type SurfaceId = 'tarmac' | 'gravel' | 'mud' | 'snow' | 'sand' | 'wood' | 'grass' | 'snowbank' | 'water';

export interface SurfaceDef {
  id: SurfaceId;
  name: string;
  grip: number;
  rolling: number;
  drag: number;
  /** Sound character for the tyre noise. */
  sound: 'tarmac' | 'gravel' | 'soft' | 'snow' | 'wood' | 'water';
}

export const SURFACES: Record<SurfaceId, SurfaceDef> = {
  tarmac: { id: 'tarmac', name: 'Tarmac', grip: 1.12, rolling: 60, drag: 2, sound: 'tarmac' },
  gravel: { id: 'gravel', name: 'Gravel', grip: 0.95, rolling: 160, drag: 9, sound: 'gravel' },
  mud: { id: 'mud', name: 'Mud', grip: 0.68, rolling: 650, drag: 38, sound: 'soft' },
  snow: { id: 'snow', name: 'Snow', grip: 0.62, rolling: 280, drag: 16, sound: 'snow' },
  sand: { id: 'sand', name: 'Sand', grip: 0.78, rolling: 750, drag: 44, sound: 'soft' },
  wood: { id: 'wood', name: 'Bridge', grip: 1.0, rolling: 90, drag: 4, sound: 'wood' },
  grass: { id: 'grass', name: 'Grass', grip: 0.74, rolling: 900, drag: 48, sound: 'soft' },
  snowbank: { id: 'snowbank', name: 'Snowbank', grip: 0.5, rolling: 1500, drag: 75, sound: 'snow' },
  water: { id: 'water', name: 'River', grip: 0.45, rolling: 2600, drag: 160, sound: 'water' },
};
