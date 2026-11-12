/**
 * Progress resets. Saves live in each player's browser, so to reset everyone
 * the game remembers which build (deploy) it last ran: whenever the game is
 * updated, the build id changes and everyone's career, cars, money and
 * championship start fresh on their next visit. Name and settings are kept.
 */
declare const __BUILD_ID__: string;
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

const BUILD_KEY = 'cdr.build';
const PROGRESS_KEYS = ['cdr.career', 'cdr.championship', 'cdr.limitedDone', 'cdr.admin'];

/** Must run before the career/championship stores load. Returns true if progress was wiped. */
export function applyProgressReset(): boolean {
  try {
    if (localStorage.getItem(BUILD_KEY) === BUILD_ID) return false;
    const hadProgress = PROGRESS_KEYS.some((k) => localStorage.getItem(k) !== null);
    PROGRESS_KEYS.forEach((k) => localStorage.removeItem(k));
    localStorage.removeItem('cdr.progressEpoch');
    sessionStorage.removeItem('cdr.event');
    localStorage.setItem(BUILD_KEY, BUILD_ID);
    return hadProgress;
  } catch {
    return false;
  }
}

/** Runs at import time so it happens before any store reads its save. */
export const progressWasReset = applyProgressReset();
