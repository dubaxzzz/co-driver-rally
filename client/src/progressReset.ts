/**
 * Progress resets. Saves live in each player's browser, so to reset everyone
 * the game remembers which build (deploy) it last ran: whenever the game is
 * updated, the build id changes and everyone's career, cars, money and
 * championship start fresh on their next visit – and the same happens every
 * week (Monday 00:00 UTC). Name and settings are kept.
 */
declare const __BUILD_ID__: string;
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

const BUILD_KEY = 'cdr.build';
const WEEK_KEY = 'cdr.week';
/** Everything you've earned: money, cars, upgrades, liveries/paint, championship, event results. */
const PROGRESS_KEYS = ['cdr.career', 'cdr.championship', 'cdr.garage', 'cdr.limitedDone', 'cdr.admin'];

/** The week number (weeks start Monday 00:00 UTC) – everyone starts fresh each week. */
export function weekIndex(now = Date.now()) {
  return Math.floor((now + 3 * 86400000) / (7 * 86400000));
}

/** Must run before the career/championship stores load. Returns why progress was wiped (or null). */
export function applyProgressReset(): 'update' | 'week' | null {
  try {
    const week = String(weekIndex());
    const newBuild = localStorage.getItem(BUILD_KEY) !== BUILD_ID;
    const storedWeek = localStorage.getItem(WEEK_KEY);
    const newWeek = storedWeek !== null && storedWeek !== week;
    localStorage.setItem(WEEK_KEY, week);
    if (!newBuild && !newWeek) return null;
    const hadProgress = PROGRESS_KEYS.some((k) => localStorage.getItem(k) !== null);
    PROGRESS_KEYS.forEach((k) => localStorage.removeItem(k));
    localStorage.removeItem('cdr.progressEpoch');
    sessionStorage.removeItem('cdr.event');
    localStorage.setItem(BUILD_KEY, BUILD_ID);
    return hadProgress ? (newBuild ? 'update' : 'week') : null;
  } catch {
    return null;
  }
}

/** Runs at import time so it happens before any store reads its save. */
export const progressWasReset = applyProgressReset();
