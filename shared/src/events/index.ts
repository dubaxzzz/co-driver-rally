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
  RelayedTelemetry,
  RoomSnapshot,
  TelemetryPacket,
} from '../types';

export interface ClientToServerEvents {
  'room:create': (payload: { name?: string; stageId?: string }, ack: (res: Ack<JoinResult>) => void) => void;
  'room:join': (payload: { code: string; name?: string }, ack: (res: Ack<JoinResult>) => void) => void;
  'session:resume': (payload: { token: string }, ack: (res: Ack<JoinResult>) => void) => void;
  'room:leave': (ack?: (res: Ack<null>) => void) => void;
  'race:start': (ack?: (res: Ack<RaceState>) => void) => void;
  'race:restart': (ack?: (res: Ack<RaceState>) => void) => void;
  'race:lobby': (ack?: (res: Ack<RaceState>) => void) => void;
  telemetry: (packet: TelemetryPacket) => void;
  'nav:call': (payload: NavCallRequest, ack?: (res: Ack<NavCall>) => void) => void;
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
}
