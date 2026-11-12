import { randomBytes } from 'node:crypto';
import { dailyKey, type LimitedEvent, type LimitedEventInput, type LimitedEventWithBoard } from '@cdr/shared';

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

/**
 * Limited-time events made in the admin panel. Everybody sees the active ones
 * on their menu until they end. Times come from the server's race timing.
 * Kept in memory: a server restart (or a new deploy) clears them.
 */
class LimitedEvents {
  private events = new Map<string, LimitedEvent>();
  private boards = new Map<string, DailyEntry[]>();

  create(input: LimitedEventInput): LimitedEvent {
    this.prune();
    const now = Date.now();
    const id = `ev-${randomBytes(4).toString('hex')}`;
    const ev: LimitedEvent = { id, name: input.name, stageId: input.stageId, weather: input.weather, carId: input.carId, prize: input.prize, createdAt: now, endsAt: now + input.hours * 3_600_000 };
    this.events.set(id, ev);
    // keep the list small
    if (this.events.size > 20) {
      const oldest = [...this.events.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      this.remove(oldest.id);
    }
    return ev;
  }

  remove(id: string) {
    this.boards.delete(id);
    return this.events.delete(id);
  }

  /** The event if it is still running. */
  active(id: string): LimitedEvent | null {
    const ev = this.events.get(id);
    return ev && ev.endsAt > Date.now() ? ev : null;
  }

  list(): LimitedEventWithBoard[] {
    this.prune();
    return [...this.events.values()]
      .sort((a, b) => a.endsAt - b.endsAt)
      .map((e) => ({ ...e, board: (this.boards.get(e.id) ?? []).slice(0, 20).map(({ name, timeMs }) => ({ name, timeMs })) }));
  }

  addResult(id: string, name: string, timeMs: number) {
    if (!this.active(id)) return;
    const list = this.boards.get(id) ?? [];
    const existing = list.find((e) => e.name === name);
    if (existing) existing.timeMs = Math.min(existing.timeMs, timeMs);
    else list.push({ name, timeMs, at: Date.now() });
    list.sort((a, b) => a.timeMs - b.timeMs);
    this.boards.set(id, list.slice(0, 50));
  }

  private prune() {
    const now = Date.now();
    for (const [id, e] of this.events) if (e.endsAt < now - 3_600_000) this.remove(id); // ended over an hour ago
  }
}

export const limitedEvents = new LimitedEvents();
