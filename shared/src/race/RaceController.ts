import { decodeSwitches } from '../switches';
import { ENGINE_WAIT_MS, COUNTDOWN_MS, GRID_ROW_GAP_M, GRID_SIDE_OFFSET_M, MAX_PLAUSIBLE_SPEED_MS, MAX_TELEPORT_SLACK_M } from '../constants';
import { getStage, projectOnStage, type BuiltStage } from '../tracks';
import type { CheckpointEvent, DriverRace, RaceResult, RaceState, RaceWarning, RallyConfig, TelemetryPacket } from '../types';
import { DEFAULT_STAGE_ID } from '../tracks';
import { DEFAULT_WEATHER } from '../weather';

export const DEFAULT_CONFIG: RallyConfig = { stageId: DEFAULT_STAGE_ID, weather: DEFAULT_WEATHER, aiCount: 0, aiSkill: 'medium' };

export interface RaceEvents {
  onState: (state: RaceState) => void;
  onCheckpoint: (evt: CheckpointEvent) => void;
  onWarning: (playerId: string, w: RaceWarning) => void;
  onFinished: (r: RaceResult) => void;
}

const GATE_HALF_WIDTH = 13;

/**
 * Where a grid slot starts: distance along the stage and sideways offset
 * (+ = left). A lone driver starts in the middle of the road; with more,
 * cars line up two abreast, rows behind each other.
 */
export function gridSpot(stage: BuiltStage, slot: number, driverCount: number): { distance: number; lateral: number } {
  if (driverCount <= 1) return { distance: stage.spawnDistance, lateral: 0 };
  const row = Math.floor(slot / 2);
  const side = slot % 2 === 0 ? 1 : -1;
  const lastSingle = driverCount % 2 === 1 && slot === driverCount - 1;
  return { distance: stage.spawnDistance - row * GRID_ROW_GAP_M, lateral: lastSingle ? 0 : side * GRID_SIDE_OFFSET_M };
}

/** How far behind the start the AI line up (behind every player row). */
export function aiGridOffset(aiIndex: number, driverCount: number) {
  const playerRows = Math.ceil(Math.max(1, driverCount) / 2);
  return (playerRows - 1) * GRID_ROW_GAP_M + 9 * (aiIndex + 1);
}

/** Per-driver tracking for anti-teleport, checkpoints and finish. */
class Tracker {
  hint = -1;
  progress: number;
  lastPos: { x: number; z: number; t: number } | null = null;
  lastResets = 0;
  topSpeed = 0;
  warnedCheckpoint = -1;
  warnedFinish = false;
  /** Time penalties (s) the driver has picked up this run. */
  penalty = 0;
  constructor(start: number) {
    this.progress = start;
  }
}

/**
 * Authoritative race state for one room (runs on the Node server). Up to four
 * drivers race the same stage at once; the server decides when the countdown
 * ends, which checkpoints each driver passed and when they finished – a client
 * cannot simply claim a finish.
 */
export class RaceController {
  stage: BuiltStage;
  state: RaceState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private trackers = new Map<string, Tracker>();

  constructor(config: Partial<RallyConfig>, private readonly events: RaceEvents) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const stage = getStage(cfg.stageId);
    if (!stage) throw new Error(`Unknown stage ${cfg.stageId}`);
    this.stage = stage;
    this.state = { ...cfg, phase: 'lobby', runId: 0, startAt: null, finishedAt: null, drivers: [], aiHost: null };
  }

  driver(playerId: string): DriverRace | null {
    return this.state.drivers.find((d) => d.playerId === playerId) ?? null;
  }

  /** Begins (or restarts) a run with a countdown for the given drivers, in grid order. */
  start(drivers: Array<{ playerId: string; name: string }>, now = Date.now()): RaceState {
    this.clearTimer();
    this.trackers.clear();
    const list: DriverRace[] = drivers.map((d, slot) => ({ playerId: d.playerId, name: d.name, slot, checkpointsPassed: 0, splits: [], result: null, retired: false }));
    for (const d of list) this.trackers.set(d.playerId, new Tracker(gridSpot(this.stage, d.slot, list.length).distance));
    // The countdown doesn't run yet: every driver has to start their car first
    // (startAt stays null until they have – or until the wait runs out).
    this.enginesOn.clear();
    this.state = {
      ...this.state,
      phase: 'countdown',
      runId: this.state.runId + 1,
      startAt: null,
      finishedAt: null,
      drivers: list,
      aiHost: list[0]?.playerId ?? null,
    };
    this.timer = setTimeout(() => {
      this.timer = null;
      this.beginCountdown(Date.now());
    }, ENGINE_WAIT_MS);
    this.events.onState(this.state);
    return this.state;
  }

  private enginesOn = new Set<string>();

  /** A driver's engine is running: once every driver's is, the countdown starts. */
  engineStarted(playerId: string, now = Date.now()) {
    if (this.state.phase !== 'countdown' || this.state.startAt !== null || !this.driver(playerId)) return;
    this.enginesOn.add(playerId);
    const waiting = this.state.drivers.filter((d) => !d.retired && !this.enginesOn.has(d.playerId));
    if (!waiting.length) this.beginCountdown(now);
  }

  /** Who still has to start their car (for the "waiting for…" message). */
  waitingForEngines(): string[] {
    return this.state.drivers.filter((d) => !d.retired && !this.enginesOn.has(d.playerId)).map((d) => d.playerId);
  }

  private beginCountdown(now: number) {
    if (this.state.phase !== 'countdown' || this.state.startAt !== null) return;
    this.clearTimer();
    this.state = { ...this.state, startAt: now + COUNTDOWN_MS };
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state.phase === 'countdown') {
        this.state = { ...this.state, phase: 'racing' };
        this.events.onState(this.state);
      }
    }, COUNTDOWN_MS);
    this.events.onState(this.state);
  }

  /** Changes stage / weather / AI. Only allowed in the lobby. */
  configure(cfg: Partial<RallyConfig>): RaceState {
    if (this.state.phase !== 'lobby') return this.state;
    if (cfg.stageId && cfg.stageId !== this.state.stageId) {
      const stage = getStage(cfg.stageId);
      if (!stage) return this.state;
      this.stage = stage;
    }
    this.state = { ...this.state, ...cfg };
    this.events.onState(this.state);
    return this.state;
  }

  toLobby(): RaceState {
    this.clearTimer();
    this.trackers.clear();
    this.state = { ...this.state, phase: 'lobby', startAt: null, finishedAt: null, drivers: [], aiHost: null };
    this.events.onState(this.state);
    return this.state;
  }

  /** A driver gives up (or left the room). */
  retire(playerId: string, now = Date.now()): boolean {
    const d = this.driver(playerId);
    if (!d || d.result || d.retired || this.state.phase === 'lobby' || this.state.phase === 'finished') return false;
    this.patchDriver(playerId, { retired: true });
    // someone left while the start was waiting for engines: maybe everyone left is ready now
    if (this.state.phase === 'countdown' && this.state.startAt === null && !this.waitingForEngines().length) this.beginCountdown(now);
    if (this.state.aiHost === playerId) {
      const next = this.state.drivers.find((x) => !x.retired && !x.result && x.playerId !== playerId);
      if (next) this.state = { ...this.state, aiHost: next.playerId };
    }
    if (!this.checkAllDone(now)) this.events.onState(this.state);
    return true;
  }

  /**
   * Validates a driver's telemetry packet against race rules.
   * Returns false if the packet must not be relayed.
   */
  handleTelemetry(playerId: string, p: TelemetryPacket, now = Date.now()): boolean {
    if (p.runId !== this.state.runId) return false; // stale packet from an old run
    const tr = this.trackers.get(playerId);
    const d = this.driver(playerId);
    if (!tr || !d) return this.state.phase === 'lobby'; // not in this run
    // waiting at the start for everyone to fire their engine up
    if (this.state.phase === 'countdown' && this.state.startAt === null && p.sw !== undefined && decodeSwitches(p.sw).engine) this.engineStarted(playerId, now);
    if (this.state.phase !== 'racing' || d.result || d.retired) return true; // relay only

    // --- plausibility (anti-teleport) ---
    if (tr.lastPos) {
      const dt = Math.max(0.001, (now - tr.lastPos.t) / 1000);
      const moved = Math.hypot(p.x - tr.lastPos.x, p.z - tr.lastPos.z);
      const allowed = MAX_PLAUSIBLE_SPEED_MS * dt + MAX_TELEPORT_SLACK_M;
      if (moved > allowed) {
        const isReset = p.resets > tr.lastResets;
        const proj = projectOnStage(this.stage, p.x, p.z, -1);
        // A reset may only put the car back onto the road at (or behind) its progress.
        if (!isReset || proj.distance > tr.progress + 12) {
          this.events.onWarning(playerId, { type: 'telemetry-rejected', reason: 'implausible movement' });
          return false;
        }
        tr.hint = proj.index;
      }
    }
    tr.lastResets = Math.max(tr.lastResets, p.resets);
    if (p.pen !== undefined) tr.penalty = Math.max(tr.penalty, p.pen); // penalties never go back down
    tr.lastPos = { x: p.x, z: p.z, t: now };
    tr.topSpeed = Math.max(tr.topSpeed, Math.abs(p.v));

    const proj = projectOnStage(this.stage, p.x, p.z, tr.hint);
    tr.hint = proj.index;
    const prev = tr.progress;
    const cur = proj.distance;
    tr.progress = cur;
    const onRoadWidth = Math.abs(proj.lateral) < GATE_HALF_WIDTH;

    // --- checkpoints (must be passed in order) ---
    const cps = this.stage.checkpoints;
    const nextCp = cps[d.checkpointsPassed];
    if (nextCp) {
      if (prev < nextCp.distance && cur >= nextCp.distance && onRoadWidth) {
        const timeMs = now - (this.state.startAt ?? now);
        const split = { index: nextCp.index, timeMs };
        this.patchDriver(playerId, { checkpointsPassed: d.checkpointsPassed + 1, splits: [...d.splits, split] });
        this.events.onCheckpoint({ runId: this.state.runId, playerId, index: nextCp.index, timeMs });
        this.events.onState(this.state);
      } else if (cur > nextCp.distance + 30 && tr.warnedCheckpoint !== nextCp.index) {
        tr.warnedCheckpoint = nextCp.index;
        this.events.onWarning(playerId, { type: 'missed-checkpoint', checkpoint: nextCp.index });
      }
    }

    // --- finish ---
    const fd = this.stage.finishDistance;
    if (prev < fd && cur >= fd && onRoadWidth) {
      const dNow = this.driver(playerId)!;
      if (dNow.checkpointsPassed >= cps.length) {
        this.finish(playerId, tr, now);
      } else if (!tr.warnedFinish) {
        tr.warnedFinish = true;
        this.events.onWarning(playerId, { type: 'missed-checkpoint', checkpoint: dNow.checkpointsPassed });
      }
    } else if (cur < fd - 50) {
      tr.warnedFinish = false;
    }
    return true;
  }

  private finish(playerId: string, tr: Tracker, now: number) {
    const d = this.driver(playerId)!;
    const startAt = this.state.startAt ?? now;
    const penaltyMs = tr.penalty * 1000;
    const timeMs = now - startAt + penaltyMs;
    const distanceM = this.stage.finishDistance - this.stage.startDistance;
    const result: RaceResult = {
      playerId,
      name: d.name,
      stageId: this.state.stageId,
      timeMs,
      splits: d.splits,
      topSpeedKmh: Math.round(tr.topSpeed * 3.6),
      avgSpeedKmh: Math.round((distanceM / Math.max(1, (timeMs - penaltyMs) / 1000)) * 3.6 * 10) / 10,
      resets: tr.lastResets,
      distanceM: Math.round(distanceM),
      finishedAt: now,
      ...(penaltyMs ? { penaltyMs } : {}),
    };
    this.patchDriver(playerId, { result });
    this.events.onFinished(result);
    if (!this.checkAllDone(now)) this.events.onState(this.state);
  }

  /** Once every driver finished or retired the stage is over. Returns true if it emitted state. */
  private checkAllDone(now: number) {
    const all = this.state.drivers.length > 0 && this.state.drivers.every((d) => d.result || d.retired);
    if (!all || this.state.phase === 'finished') return false;
    this.clearTimer();
    this.state = { ...this.state, phase: 'finished', finishedAt: now };
    this.events.onState(this.state);
    return true;
  }

  private patchDriver(playerId: string, patch: Partial<DriverRace>) {
    this.state = { ...this.state, drivers: this.state.drivers.map((d) => (d.playerId === playerId ? { ...d, ...patch } : d)) };
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose() {
    this.clearTimer();
  }
}
