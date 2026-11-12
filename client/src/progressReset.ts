/**
 * Progress resets. Saves live in each player's browser, so to reset everyone
 * the game carries a "progress epoch": when a browser's saved epoch is older,
 * its career, championship and event progress are wiped on the next load.
 * Name and settings are kept.
 *
 * Bump PROGRESS_EPOCH to reset everyone again in a future update.
 */
export const PROGRESS_EPOCH = 2; // 2 = new economy (Nov 2026)

const EPOCH_KEY = 'cdr.progressEpoch';
const PROGRESS_KEYS = ['cdr.career', 'cdr.championship'];

/** Must run before the career/championship stores load. Returns true if progress was wiped. */
export function applyProgressReset(): boolean {
  try {
    const seen = Number(localStorage.getItem(EPOCH_KEY) ?? '0');
    if (seen >= PROGRESS_EPOCH) return false;
    const hadProgress = PROGRESS_KEYS.some((k) => localStorage.getItem(k) !== null);
    PROGRESS_KEYS.forEach((k) => localStorage.removeItem(k));
    sessionStorage.removeItem('cdr.event');
    localStorage.setItem(EPOCH_KEY, String(PROGRESS_EPOCH));
    return hadProgress;
  } catch {
    return false;
  }
}

/** Runs at import time so it happens before any store reads its save. */
export const progressWasReset = applyProgressReset();
