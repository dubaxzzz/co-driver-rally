import { randomBytes, randomUUID } from 'node:crypto';
import type { PlayerInfo, Role } from '@cdr/shared';

/** A seat in a room. The token lets the same player reclaim it after a disconnect. */
export interface Seat {
  playerId: string;
  token: string;
  name: string;
  role: Role;
  socketId: string | null;
  connected: boolean;
  disconnectedAt: number | null;
}

export function createSeat(role: Role, name: string, socketId: string): Seat {
  return {
    playerId: randomUUID(),
    token: randomBytes(24).toString('hex'),
    name,
    role,
    socketId,
    connected: true,
    disconnectedAt: null,
  };
}

export function seatInfo(seat: Seat | null): PlayerInfo | null {
  if (!seat) return null;
  return { playerId: seat.playerId, name: seat.name, role: seat.role, connected: seat.connected };
}
