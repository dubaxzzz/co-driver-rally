import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailyKey, isLimitedKey, limitedEndsAt, limitedKey } from '@cdr/shared';

export interface DailyEntry {
  name: string;
  timeMs: number;
  at: number;
}

/** Where the boards are saved (set DATA_DIR to a folder that survives restarts, e.g. a mounted disk). */
const DATA_DIR = process.env.DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data');
const FILE = path.join(DATA_DIR, 'leaderboards.json');
/** Old days and events stay on the board this long. */
const KEEP_MS = 60 * 24 * 3600_000;

/** When a board's day or event ended – used to forget the really old ones. */
const endedAt = (key: string) => (isLimitedKey(key) ? limitedEndsAt(key) : Date.parse(key) + 86_400_000);

/**
 * Daily Challenge and limited event leaderboards. Times come from the server's own race timing,
 * never from the client. Saved to a file, so a server restart does not wipe the times; every
 * day and event keeps its board for 60 days (the previous one is shown next to the current one).
 */
class DailyBoard {
  private boards = new Map<string, DailyEntry[]>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  private load() {
    try {
      const saved = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, DailyEntry[]>;
      for (const [key, list] of Object.entries(saved)) {
        if (Array.isArray(list)) this.boards.set(key, list.filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.timeMs)));
      }
    } catch {
      /* no saved boards yet */
    }
  }

  /** Writes the boards now (a temp file first, so a crash half way never leaves a broken file). */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.boards)));
      renameSync(tmp, FILE);
    } catch (e) {
      console.warn('[leaderboards] could not save:', (e as Error).message);
    }
  }

  private scheduleSave() {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.flush(), 1000);
  }

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
    // forget only the really old boards
    for (const key of this.boards.keys()) if (endedAt(key) < Date.now() - KEEP_MS) this.boards.delete(key);
    this.scheduleSave();
  }

  top(date: string, n = 20) {
    return (this.boards.get(date) ?? []).slice(0, n).map(({ name, timeMs }) => ({ name, timeMs }));
  }
}

export const dailyBoard = new DailyBoard();

// save on shutdown (Render stops the server with SIGTERM on every deploy and when it spins down)
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    dailyBoard.flush();
    if (process.listenerCount(sig) === 0) process.exit(0);
  });
}
