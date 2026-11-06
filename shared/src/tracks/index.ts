import { buildStage } from './builder';
import { AUSTRALIA_STAGE } from './stages/australia';
import { FOREST_STAGE } from './stages/forest';
import { FRANCE_STAGE } from './stages/france';
import { SWEDEN_STAGE } from './stages/sweden';
import { TASMANIA_STAGE } from './stages/tasmania';
import { WALES_STAGE } from './stages/wales';
import type { BuiltStage, StageDef } from './types';

export * from './types';
export * from './builder';

/** Register new stages here – both client and server pick them up. */
export const STAGE_DEFS: StageDef[] = [FOREST_STAGE, SWEDEN_STAGE, FRANCE_STAGE, AUSTRALIA_STAGE, WALES_STAGE, TASMANIA_STAGE];
export const DEFAULT_STAGE_ID = FOREST_STAGE.id;

const cache = new Map<string, BuiltStage>();

export function getStage(id: string): BuiltStage | null {
  const cached = cache.get(id);
  if (cached) return cached;
  const def = STAGE_DEFS.find((s) => s.id === id);
  if (!def) return null;
  const built = buildStage(def);
  cache.set(id, built);
  return built;
}
