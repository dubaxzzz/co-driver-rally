/**
 * Typed Socket.IO event contract. Both the server (`Server<C2S, S2C>`) and the
 * client (`Socket<S2C, C2S>`) are parameterised with these maps, so a renamed or
 * mistyped event fails to compile on both sides.
 */
import type {
  Ack,
  CheckpointEvent,
  JoinResult,
  NavCall,
  NavCallRequest,
  RaceResult,
  RaceState,
  RaceWarning,
  RallyConfig,
  RelayedTelemetry,
  Role,
  RoomSnapshot,
  TelemetryPacket,
} from '../types';
import type { SharedSwitch } from '../switches';

export interface ClientToServerEvents {
  'room:create': (payload: { name?: string; config?: Partial<RallyConfig> }, ack: (res: Ack<JoinResult>) => void) => void;
  /** Driver changes stage / weather / AI in the lobby. */
  'room:configure': (payload: Partial<RallyConfig>, ack?: (res: Ack<RaceState>) => void) => void;
  'room:join': (payload: { code: string; name?: string; role?: Role }, ack: (res: Ack<JoinResult>) => void) => void;
  /** Lobby: switch between driver and navigator (and pick which driver to navigate for). */
  'room:role': (payload: { role: Role; navFor?: string | null }, ack?: (res: Ack<RoomSnapshot>) => void) => void;
  'room:ready': (ready: boolean, ack?: (res: Ack<RoomSnapshot>) => void) => void;
  /** Driver gives up the current stage (championship retire / quit mid-race). */
  'race:retire': (ack?: (res: Ack<RaceState>) => void) => void;
  'session:resume': (payload: { token: string }, ack: (res: Ack<JoinResult>) => void) => void;
  'room:leave': (ack?: (res: Ack<null>) => void) => void;
  'race:start': (ack?: (res: Ack<RaceState>) => void) => void;
  'race:restart': (ack?: (res: Ack<RaceState>) => void) => void;
  'race:lobby': (ack?: (res: Ack<RaceState>) => void) => void;
  telemetry: (packet: TelemetryPacket) => void;
  'nav:call': (payload: NavCallRequest, ack?: (res: Ack<NavCall>) => void) => void;
  /** Navigator flips a shared switch in their driver's car. */
  'car:switch': (payload: { id: SharedSwitch; down?: boolean }) => void;
  'time:sync': (clientTime: number, ack: (serverTime: number) => void) => void;
}

export interface ServerToClientEvents {
  'room:update': (room: RoomSnapshot) => void;
  'room:closed': (payload: { reason: string }) => void;
  'race:state': (state: RaceState) => void;
  'race:checkpoint': (evt: CheckpointEvent) => void;
  'race:warning': (warning: RaceWarning) => void;
  'race:finished': (result: RaceResult) => void;
  telemetry: (packet: RelayedTelemetry) => void;
  'nav:call': (call: NavCall) => void;
  /** A navigator flipped one of your switches. */
  'car:switch': (payload: { id: SharedSwitch; down: boolean; from: string }) => void;
}
