import type {
  CheckpointEvent,
  JoinResult,
  NavCall,
  NavCallRequest,
  SharedSwitch,
  PlayerInfo,
  Role,
  RaceResult,
  RaceState,
  RaceWarning,
  RallyConfig,
  RelayedTelemetry,
  RoomSnapshot,
  SessionInfo,
  TelemetryPacket,
} from '@cdr/shared';

export type ConnStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface NetEvents {
  status: ConnStatus;
  room: RoomSnapshot;
  race: RaceState;
  telemetry: RelayedTelemetry;
  call: NavCall;
  checkpoint: CheckpointEvent;
  warning: RaceWarning;
  finished: RaceResult;
  closed: { reason: string };
  resumed: JoinResult;
  resumeFailed: { message: string };
  /** A navigator flipped one of my car's switches. */
  switch: { id: SharedSwitch; down: boolean; from: string };
}

type Handler<T> = (payload: T) => void;

export class NetError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** What every screen uses to talk to the rally server (implemented by SocketNetClient). */
export abstract class NetBase {
  status: ConnStatus = 'connecting';
  session: SessionInfo | null = null;
  room: RoomSnapshot | null = null;
  /** Most recent create/join/resume result (used to seed the navigator view). */
  lastJoin: JoinResult | null = null;
  /** Human-readable reason for the last connection problem (shown in the UI). */
  lastError: string | null = null;
  private handlers = new Map<keyof NetEvents, Set<Handler<unknown>>>();

  on<K extends keyof NetEvents>(event: K, fn: Handler<NetEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn as Handler<unknown>);
    return () => set!.delete(fn as Handler<unknown>);
  }
  protected emit<K extends keyof NetEvents>(event: K, payload: NetEvents[K]) {
    this.handlers.get(event)?.forEach((fn) => fn(payload));
  }
  protected setStatus(s: ConnStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  /** My seat in the current room. */
  me(): PlayerInfo | null {
    const id = this.session?.playerId;
    return this.room?.members.find((m) => m.playerId === id) ?? null;
  }
  get isHost() {
    return !!this.session && this.room?.hostId === this.session.playerId;
  }
  /** The driver whose car I see: myself when driving, or the driver I navigate for. */
  followedDriverId(): string | null {
    const me = this.me();
    if (!me) return null;
    if (me.role === 'driver') return me.playerId;
    return me.navFor ?? this.room?.members.find((m) => m.role === 'driver')?.playerId ?? null;
  }
  member(playerId: string | null | undefined): PlayerInfo | null {
    return this.room?.members.find((m) => m.playerId === playerId) ?? null;
  }

  /** Current time on the server's clock. */
  abstract serverNow(): number;
  abstract get latencyMs(): number | null;
  abstract createRoom(name: string, config?: Partial<RallyConfig>): Promise<JoinResult>;
  /** Driver only, in the lobby: change stage / weather / AI. */
  abstract configure(config: Partial<RallyConfig>): Promise<RaceState>;
  abstract joinRoom(code: string, name: string, role?: Role): Promise<JoinResult>;
  abstract setRole(role: Role, navFor?: string | null): Promise<RoomSnapshot>;
  abstract setReady(ready: boolean): Promise<RoomSnapshot>;
  abstract retire(): Promise<RaceState>;
  abstract resume(): Promise<JoinResult | null>;
  abstract leave(): Promise<void>;
  abstract clearSession(): void;
  abstract startRace(): Promise<RaceState>;
  abstract restartRace(): Promise<RaceState>;
  abstract toLobby(): Promise<RaceState>;
  abstract sendCall(req: NavCallRequest): Promise<NavCall>;
  abstract sendTelemetry(p: TelemetryPacket): void;
  /** Navigator: flip a shared switch in my driver's car. */
  abstract sendSwitch(id: SharedSwitch, down?: boolean): void;
}
