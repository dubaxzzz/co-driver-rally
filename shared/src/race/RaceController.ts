import { COUNTDOWN_MS, MAX_PLAUSIBLE_SPEED_MS, MAX_TELEPORT_SLACK_M } from '../constants';
import { getStage, projectOnStage, type BuiltStage } from '../tracks';
import type { CheckpointEvent, RaceResult, RaceState, RaceWarning, TelemetryPacket } from '../types';

export interface RaceEvents {
  onState: (state: RaceState) => void;
  onCheckpoint: (evt: CheckpointEvent) => void;
  onWarning: (w: RaceWarning) => void;
  onFinished: (r: RaceResult) => void;
}

const GATE_HALF_WIDTH = 13;

/**
 * Authoritative race state for one room. Runs on the Node server (online
 * mode) or inside the driver's browser (peer-to-peer mode). The server decides when the
 * countdown ends, which checkpoints were passed and when the stage is
 * finished – the driver's client cannot simply claim a finish.
 */
export class RaceController {
  readonly stage: BuiltStage;
  state: RaceState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hint = -1;
  private progress = 0;
  private lastPos: { x: number; z: number; t: number } | null = null;
  private lastResets = 0;
  private topSpeed = 0;
  private warnedCheckpoint = -1;
  private warnedFinish = false;

  constructor(stageId: string, private readonly events: RaceEvents) {
    const stage = getStage(stageId);
    if (!stage) throw new Error(`Unknown stage ${stageId}`);
    this.stage = stage;
    this.state = {
      phase: 'lobby',
      stageId,
      runId: 0,
      startAt: null,
      finishedAt: null,
      checkpointsPassed: 0,
      splits: [],
      result: null,
    };
  }

  /** Begins (or restarts) a run with a countdown. */
  start(now = Date.now()): RaceState {
    this.clearTimer();
    this.resetTracking();
    this.state = {
      ...this.state,
      phase: 'countdown',
      runId: this.state.runId + 1,
      startAt: now + COUNTDOWN_MS,
      finishedAt: null,
      checkpointsPassed: 0,
      splits: [],
      result: null,
    };
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state.phase === 'countdown') {
        this.state = { ...this.state, phase: 'racing' };
        this.events.onState(this.state);
      }
    }, COUNTDOWN_MS);
    this.events.onState(this.state);
    return this.state;
  }

  toLobby(): RaceState {
    this.clearTimer();
    this.resetTracking();
    this.state = {
      ...this.state,
      phase: 'lobby',
      startAt: null,
      finishedAt: null,
      checkpointsPassed: 0,
      splits: [],
      result: null,
    };
    this.events.onState(this.state);
    return this.state;
  }

  /**
   * Validates a telemetry packet against race rules.
   * Returns false if the packet must not be relayed.
   */
  handleTelemetry(p: TelemetryPacket, now = Date.now()): boolean {
    if (p.runId !== this.state.runId) return false; // stale packet from an old run
    if (this.state.phase !== 'racing') return true; // countdown / lobby / finished: relay only

    // --- plausibility (anti-teleport) ---
    if (this.lastPos) {
      const dt = Math.max(0.001, (now - this.lastPos.t) / 1000);
      const moved = Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z);
      const allowed = MAX_PLAUSIBLE_SPEED_MS * dt + MAX_TELEPORT_SLACK_M;
      if (moved > allowed) {
        const isReset = p.resets > this.lastResets;
        const proj = projectOnStage(this.stage, p.x, p.z, -1);
        // A reset may only put the car back onto the road at (or behind) its progress.
        if (!isReset || proj.distance > this.progress + 12) {
          this.events.onWarning({ type: 'telemetry-rejected', reason: 'implausible movement' });
          return false;
        }
        this.hint = proj.index;
      }
    }
    this.lastResets = Math.max(this.lastResets, p.resets);
    this.lastPos = { x: p.x, z: p.z, t: now };
    this.topSpeed = Math.max(this.topSpeed, Math.abs(p.v));

    const proj = projectOnStage(this.stage, p.x, p.z, this.hint);
    this.hint = proj.index;
    const prev = this.progress;
    const cur = proj.distance;
    this.progress = cur;
    const onRoadWidth = Math.abs(proj.lateral) < GATE_HALF_WIDTH;

    // --- checkpoints (must be passed in order) ---
    const cps = this.stage.checkpoints;
    const nextCp = cps[this.state.checkpointsPassed];
    if (nextCp) {
      if (prev < nextCp.distance && cur >= nextCp.distance && onRoadWidth) {
        const timeMs = now - (this.state.startAt ?? now);
        const split = { index: nextCp.index, timeMs };
        this.state = {
          ...this.state,
          checkpointsPassed: this.state.checkpointsPassed + 1,
          splits: [...this.state.splits, split],
        };
        this.events.onCheckpoint({ runId: this.state.runId, index: nextCp.index, timeMs });
        this.events.onState(this.state);
      } else if (cur > nextCp.distance + 30 && this.warnedCheckpoint !== nextCp.index) {
        this.warnedCheckpoint = nextCp.index;
        this.events.onWarning({ type: 'missed-checkpoint', checkpoint: nextCp.index });
      }
    }

    // --- finish ---
    const fd = this.stage.finishDistance;
    if (prev < fd && cur >= fd && onRoadWidth) {
      if (this.state.checkpointsPassed >= cps.length) {
        this.finish(now);
      } else if (!this.warnedFinish) {
        this.warnedFinish = true;
        this.events.onWarning({ type: 'missed-checkpoint', checkpoint: this.state.checkpointsPassed });
      }
    } else if (cur < fd - 50) {
      this.warnedFinish = false;
    }
    return true;
  }

  private finish(now: number) {
    const startAt = this.state.startAt ?? now;
    const timeMs = now - startAt;
    const distanceM = this.stage.finishDistance - this.stage.startDistance;
    const result: RaceResult = {
      stageId: this.state.stageId,
      timeMs,
      splits: this.state.splits,
      topSpeedKmh: Math.round(this.topSpeed * 3.6),
      avgSpeedKmh: Math.round((distanceM / Math.max(1, timeMs / 1000)) * 3.6 * 10) / 10,
      resets: this.lastResets,
      distanceM: Math.round(distanceM),
      finishedAt: now,
    };
    this.state = { ...this.state, phase: 'finished', finishedAt: now, result };
    this.events.onState(this.state);
    this.events.onFinished(result);
  }

  private resetTracking() {
    this.hint = -1;
    this.progress = this.stage.spawnDistance;
    this.lastPos = null;
    this.lastResets = 0;
    this.topSpeed = 0;
    this.warnedCheckpoint = -1;
    this.warnedFinish = false;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose() {
    this.clearTimer();
  }
}
