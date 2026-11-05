import type {
  CheckpointEvent,
  JoinResult,
  NavCall,
  NavCallRequest,
  RaceResult,
  RaceState,
  RaceWarning,
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
}

type Handler<T> = (payload: T) => void;

export class NetError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * What every screen uses to talk to the other player. Two implementations:
 * - SocketNetClient: Node.js server with Socket.IO (npm run dev / npm start)
 * - P2PNetClient: no server – the driver's browser hosts the room and the
 *   navigator connects to it directly (the Live Server build in /play)
 */
export abstract class NetBase {
  abstract readonly mode: 'online' | 'p2p';
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

  /** Current time on the authoritative clock (server, or the driver's browser in P2P). */
  abstract serverNow(): number;
  abstract get latencyMs(): number | null;
  abstract createRoom(name: string): Promise<JoinResult>;
  abstract joinRoom(code: string, name: string): Promise<JoinResult>;
  abstract resume(): Promise<JoinResult | null>;
  abstract leave(): Promise<void>;
  abstract clearSession(): void;
  abstract startRace(): Promise<RaceState>;
  abstract restartRace(): Promise<RaceState>;
  abstract toLobby(): Promise<RaceState>;
  abstract sendCall(req: NavCallRequest): Promise<NavCall>;
  abstract sendTelemetry(p: TelemetryPacket): void;
}
