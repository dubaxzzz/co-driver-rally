/** What kind of event the next stage is: a quick stage, a championship round or the daily challenge. */
import '../progressReset';
import type { AiSkill, PaintOption, UpgradeLevels } from '@cdr/shared';

export interface AiEntrantCtx {
  entrantId: string;
  name: string;
  skill: AiSkill;
  paint: PaintOption;
}

export type EventContext =
  | { kind: 'quick' }
  | {
      kind: 'championship';
      season: number;
      round: number;
      entrants: AiEntrantCtx[];
      carId: string;
      upgrades: UpgradeLevels;
      /** Damage carried over from the last round (zones ×6, wheels ×4). */
      carry: { zones: number[]; wheels: number[] };
    }
  | { kind: 'daily'; date: string; carId: string };

const KEY = 'cdr.event';
let ctx: EventContext = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') ?? { kind: 'quick' };
  } catch {
    return { kind: 'quick' };
  }
})();

export const eventCtx = {
  get: () => ctx,
  set(next: EventContext) {
    ctx = next;
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  },
  clear() {
    eventCtx.set({ kind: 'quick' });
  },
};
