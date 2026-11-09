import { dailyKey } from '@cdr/shared';

export interface DailyEntry {
  name: string;
  timeMs: number;
  at: number;
}

/**
 * Daily Challenge leaderboard. Times come from the server's own race timing,
 * never from the client. Kept in memory (a server restart clears it).
 */
class DailyBoard {
  private boards = new Map<string, DailyEntry[]>();

  add(date: string, name: string, timeMs: number) {
    if (date !== dailyKey()) return; // only today's challenge counts
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
    for (const key of this.boards.keys()) if (key < date && this.boards.size > 3) this.boards.delete(key);
  }

  top(date: string, n = 20) {
    return (this.boards.get(date) ?? []).slice(0, n).map(({ name, timeMs }) => ({ name, timeMs }));
  }
}

export const dailyBoard = new DailyBoard();
