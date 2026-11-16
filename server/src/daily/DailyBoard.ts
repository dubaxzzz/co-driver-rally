import { dailyKey, isLimitedKey, limitedKey } from '@cdr/shared';

export interface DailyEntry {
  name: string;
  timeMs: number;
  at: number;
}

/**
 * Daily Challenge and limited event leaderboards. Times come from the server's own race timing,
 * never from the client. Kept in memory (a server restart clears it).
 */
class DailyBoard {
  private boards = new Map<string, DailyEntry[]>();

  add(date: string, name: string, timeMs: number) {
    if (date !== dailyKey() && date !== limitedKey()) return; // only today's challenge / the current event counts
    const list = this.boards.get(date) ?? [];
    const existing = list.find((e) => e.name === name);
    if (existing) {
      if (timeMs < existing.timeMs) {
        existing.timeMs = timeMs;
        existing.at = Date.now();
      }
    } else {
      list.push({ name, timeMs, at: Date.now() });
    }
    list.sort((a, b) => a.timeMs - b.timeMs);
    this.boards.set(date, list.slice(0, 50));
    // forget old days
    for (const key of this.boards.keys()) if (isLimitedKey(key) === isLimitedKey(date) && key !== date && this.boards.size > 3) this.boards.delete(key);
  }

  top(date: string, n = 20) {
    return (this.boards.get(date) ?? []).slice(0, n).map(({ name, timeMs }) => ({ name, timeMs }));
  }
}

export const dailyBoard = new DailyBoard();
