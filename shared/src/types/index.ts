/** Shared data model for rooms, race state, telemetry and navigator calls. */
import type { WeatherId } from '../weather';

export type AiSkill = 'easy' | 'medium' | 'hard';

/** What the driver picks in the lobby. */
export interface RallyConfig {
  stageId: string;
  weather: WeatherId;
  /** Number of AI opponents (0–3). */
  aiCount: number;
  aiSkill: AiSkill;
  /** Set for the Daily Challenge (UTC date) – the server fixes stage/weather and records the time. */
  daily?: string;
  /** Single-driver event (championship round / daily): other people can only join as navigator. */
  soloEvent?: boolean;
}

export type Role = 'driver' | 'navigator';

export interface PlayerInfo {
  playerId: string;
  name: string;
  role: Role;
  connected: boolean;
  /** Ticked "ready" in the lobby. */
  ready: boolean;
  /** For navigators: the driver they call for. */
  navFor: string | null;
}

export type RacePhase = 'lobby' | 'countdown' | 'racing' | 'finished';

export interface CheckpointSplit {
  index: number;
  timeMs: number;
}

export interface RaceResult {
  playerId: string;
  name: string;
  stageId: string;
  timeMs: number;
  splits: CheckpointSplit[];
  topSpeedKmh: number;
  avgSpeedKmh: number;
  resets: number;
  distanceM: number;
  finishedAt: number;
}

/** One driver's run inside a stage. */
export interface DriverRace {
  playerId: string;
  name: string;
  /** Grid slot (0 = front left). */
  slot: number;
  checkpointsPassed: number;
  splits: CheckpointSplit[];
  result: RaceResult | null;
  retired: boolean;
}

export interface RaceState extends RallyConfig {
  phase: RacePhase;
  /** Increments on every (re)start so stale packets/events can be ignored. */
  runId: number;
  /** Server timestamp at which the countdown ends and the timer starts. */
  startAt: number | null;
  /** Server timestamp when the last driver finished/retired (phase 'finished'). */
  finishedAt: number | null;
  /** Every driver in this run, in grid order. */
  drivers: DriverRace[];
  /** The driver whose game simulates the AI cars for everybody. */
  aiHost: string | null;
}

export interface RoomSnapshot {
  code: string;
  createdAt: number;
  /** The player who picks the stage and starts the rally. */
  hostId: string;
  members: PlayerInfo[];
  race: RaceState;
}

export interface SessionInfo {
  token: string;
  playerId: string;
  role: Role;
  roomCode: string;
}

/** Compact telemetry packet sent by the driver (~20 Hz). */
export interface TelemetryPacket {
  runId: number;
  seq: number;
  /** Driver-side race clock in ms (0 before start). */
  t: number;
  /** Position. */
  x: number;
  y: number;
  z: number;
  /** Yaw / heading (radians, 0 = +Z, left turn increases). */
  h: number;
  /** Pitch and roll (radians). */
  p: number;
  r: number;
  /** Speed (m/s, signed: negative while reversing). */
  v: number;
  steer: number; // -1..1 (positive = left)
  throttle: number; // 0..1
  brake: number; // 0..1
  handbrake: boolean;
  gear: number; // -1 reverse, 0 neutral, 1..6
  rpm: number;
  /** Distance travelled along the stage centreline (m). */
  dist: number;
  /** Distance remaining to finish line (m). */
  remain: number;
  /** Number of checkpoints passed according to the driver. */
  cp: number;
  /** Index of the next pace note and distance until it. */
  nextNote: number;
  toNote: number;
  /** 0..1 cosmetic damage level. */
  dmg: number;
  /** Total vehicle resets – lets the server accept a reset reposition. */
  resets: number;
  /**
   * AI opponents, 6 numbers each: x, y, z, heading, distance, finish time (ms, -1 = running).
   * Simulated on the driver's device and shown to the navigator.
   */
  ai?: number[];
  /** Damage 0..1: front, left, right, rear, windscreen, engine, then wheels FL, FR, RL, RR (1 = wheel gone). */
  dz?: number[];
  /** Cockpit switch state (see shared/src/switches.ts). */
  sw?: number;
  /** What the car looks like for other players: [vehicle index, body colour, accent colour]. */
  look?: number[];
  /** Prize the driver earned this run (sent after the finish so the navigator gets their share). */
  prize?: number;
}

/** Telemetry as relayed by the server (server timestamp + sender added). */
export interface RelayedTelemetry extends TelemetryPacket {
  serverTime: number;
  /** playerId of the driver who sent it. */
  pid: string;
}

export type NavCallKind = 'pacenote' | 'caution' | 'repeat' | 'custom';

export interface NavCallRequest {
  kind: NavCallKind;
  /** Text for pacenote/caution/custom. Ignored for 'repeat'. */
  text?: string;
  /** Optional index of the stage pace note this call refers to. */
  noteIndex?: number;
}

export interface NavCall {
  id: number;
  kind: NavCallKind;
  text: string;
  noteIndex: number | null;
  serverTime: number;
  /** True when the call is a repeat of the previous one. */
  repeated: boolean;
}

export type ErrorCode =
  | 'INVALID_CODE'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'SEAT_RESERVED'
  | 'SESSION_INVALID'
  | 'NOT_IN_ROOM'
  | 'NOT_ALLOWED'
  | 'BAD_PAYLOAD'
  | 'RATE_LIMITED'
  | 'SERVER_FULL'
  | 'WRONG_PHASE';

export type Ack<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string };

export interface JoinResult {
  session: SessionInfo;
  room: RoomSnapshot;
  /** Latest telemetry of every driver so a (re)joining player can render immediately. */
  lastTelemetry: RelayedTelemetry[];
  callLog: NavCall[];
}

export type RaceWarning =
  | { type: 'missed-checkpoint'; checkpoint: number }
  | { type: 'wrong-way' }
  | { type: 'telemetry-rejected'; reason: string };

export interface CheckpointEvent {
  runId: number;
  playerId: string;
  index: number;
  timeMs: number;
}
