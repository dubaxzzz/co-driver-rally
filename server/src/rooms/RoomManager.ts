import {
  CALL_LOG_LENGTH,
  type RallyConfig,
  type Ack,
  type ErrorCode,
  type JoinResult,
  type NavCall,
  type RelayedTelemetry,
  type Role,
  type RoomSnapshot,
} from '@cdr/shared';
import { config } from '../config';
import { createSeat, seatInfo, type Seat } from '../players/sessions';
import { RaceController, type RaceEvents } from '../race/RaceController';
import { generateRoomCode } from './codes';

export interface Room {
  code: string;
  createdAt: number;
  lastActivity: number;
  driver: Seat | null;
  navigator: Seat | null;
  race: RaceController;
  lastTelemetry: RelayedTelemetry | null;
  callLog: NavCall[];
  callSeq: number;
}

export type RoomError = { ok: false; code: ErrorCode; message: string };
const fail = (code: ErrorCode, message: string): RoomError => ({ ok: false, code, message });

export interface SocketBinding {
  code: string;
  role: Role;
}

/**
 * Owns every room, seat and session token. All membership decisions happen
 * here so they can be unit-tested without sockets.
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private bySocket = new Map<string, SocketBinding>();
  private byToken = new Map<string, SocketBinding>();

  constructor(private readonly raceEventsFor: (code: string) => RaceEvents) {}

  get size() {
    return this.rooms.size;
  }

  get(code: string) {
    return this.rooms.get(code) ?? null;
  }

  binding(socketId: string) {
    return this.bySocket.get(socketId) ?? null;
  }

  createRoom(socketId: string, name: string, rally: Partial<RallyConfig> = {}): Ack<JoinResult> {
    if (this.bySocket.has(socketId)) this.leave(socketId);
    if (this.rooms.size >= config.maxRooms) return fail('SERVER_FULL', 'The server has reached its room limit. Try again shortly.');
    const code = generateRoomCode((c) => this.rooms.has(c));
    if (!code) return fail('SERVER_FULL', 'No room codes available.');
    const now = Date.now();
    const seat = createSeat('driver', name, socketId);
    const room: Room = {
      code,
      createdAt: now,
      lastActivity: now,
      driver: seat,
      navigator: null,
      race: new RaceController(rally, this.raceEventsFor(code)),
      lastTelemetry: null,
      callLog: [],
      callSeq: 0,
    };
    this.rooms.set(code, room);
    this.bind(socketId, seat.token, code, 'driver');
    return { ok: true, data: this.joinResult(room, seat) };
  }

  joinAsNavigator(socketId: string, code: string, name: string): Ack<JoinResult> {
    const room = this.rooms.get(code);
    if (!room) return fail('ROOM_NOT_FOUND', `No rally found with code ${code}. Check the code on the driver's screen.`);
    if (room.driver?.socketId === socketId) return fail('NOT_ALLOWED', 'You are already the driver of this rally.');
    const nav = room.navigator;
    if (nav) {
      if (nav.connected) return fail('ROOM_FULL', 'This rally already has a navigator.');
      const reservedFor = Date.now() - (nav.disconnectedAt ?? 0);
      if (reservedFor < config.navigatorGraceMs) {
        const secs = Math.ceil((config.navigatorGraceMs - reservedFor) / 1000);
        return fail('SEAT_RESERVED', `The navigator seat is reserved for a reconnecting player (${secs}s).`);
      }
      this.byToken.delete(nav.token);
    }
    if (this.bySocket.has(socketId)) this.leave(socketId);
    const seat = createSeat('navigator', name, socketId);
    room.navigator = seat;
    room.lastActivity = Date.now();
    this.bind(socketId, seat.token, code, 'navigator');
    return { ok: true, data: this.joinResult(room, seat) };
  }

  /** Re-binds a seat to a new socket. Returns the previous socket id so it can be kicked. */
  resume(socketId: string, token: string): { result: Ack<JoinResult>; previousSocketId: string | null } {
    const b = this.byToken.get(token);
    const room = b ? this.rooms.get(b.code) : null;
    const seat = room && b ? (b.role === 'driver' ? room.driver : room.navigator) : null;
    if (!b || !room || !seat || seat.token !== token) {
      return { result: fail('SESSION_INVALID', 'That session has expired.'), previousSocketId: null };
    }
    const previousSocketId = seat.socketId && seat.socketId !== socketId ? seat.socketId : null;
    if (previousSocketId) this.bySocket.delete(previousSocketId);
    const existing = this.bySocket.get(socketId);
    if (existing && (existing.code !== b.code || existing.role !== b.role)) this.leave(socketId);
    seat.socketId = socketId;
    seat.connected = true;
    seat.disconnectedAt = null;
    room.lastActivity = Date.now();
    this.bySocket.set(socketId, { code: b.code, role: b.role });
    return { result: { ok: true, data: this.joinResult(room, seat) }, previousSocketId };
  }

  /** Socket dropped – keep the seat reserved for reconnection. */
  disconnect(socketId: string): Room | null {
    const b = this.bySocket.get(socketId);
    this.bySocket.delete(socketId);
    if (!b) return null;
    const room = this.rooms.get(b.code);
    if (!room) return null;
    const seat = b.role === 'driver' ? room.driver : room.navigator;
    if (seat && seat.socketId === socketId) {
      seat.connected = false;
      seat.socketId = null;
      seat.disconnectedAt = Date.now();
    }
    return room;
  }

  /**
   * Player deliberately leaves. Driver leaving closes the room;
   * navigator leaving frees the seat.
   */
  leave(socketId: string): { room: Room; closed: boolean } | null {
    const b = this.bySocket.get(socketId);
    if (!b) return null;
    this.bySocket.delete(socketId);
    const room = this.rooms.get(b.code);
    if (!room) return null;
    if (b.role === 'driver') {
      this.closeRoom(room.code);
      return { room, closed: true };
    }
    if (room.navigator) this.byToken.delete(room.navigator.token);
    room.navigator = null;
    room.lastActivity = Date.now();
    return { room, closed: false };
  }

  closeRoom(code: string) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.race.dispose();
    for (const seat of [room.driver, room.navigator]) {
      if (!seat) continue;
      this.byToken.delete(seat.token);
      if (seat.socketId) this.bySocket.delete(seat.socketId);
    }
    this.rooms.delete(code);
  }

  addCall(room: Room, call: Omit<NavCall, 'id'>): NavCall {
    const full: NavCall = { ...call, id: ++room.callSeq };
    room.callLog.push(full);
    if (room.callLog.length > CALL_LOG_LENGTH) room.callLog.shift();
    room.lastActivity = Date.now();
    return full;
  }

  /**
   * Periodic cleanup. Returns rooms that were removed (to notify sockets)
   * and rooms whose navigator seat was released.
   */
  sweep(now = Date.now()): { closed: string[]; released: string[] } {
    const closed: string[] = [];
    const released: string[] = [];
    for (const room of this.rooms.values()) {
      const seats = [room.driver, room.navigator].filter((s): s is Seat => !!s);
      const anyConnected = seats.some((s) => s.connected);
      const lastDisconnect = Math.max(0, ...seats.map((s) => s.disconnectedAt ?? 0));
      const driverGoneFor = room.driver && !room.driver.connected ? now - (room.driver.disconnectedAt ?? now) : 0;
      if (
        (!anyConnected && now - lastDisconnect > config.roomAbandonMs) ||
        driverGoneFor > config.roomAbandonMs ||
        now - room.lastActivity > config.roomIdleMaxMs
      ) {
        closed.push(room.code);
        continue;
      }
      const nav = room.navigator;
      if (nav && !nav.connected && now - (nav.disconnectedAt ?? now) > config.navigatorGraceMs) {
        this.byToken.delete(nav.token);
        room.navigator = null;
        released.push(room.code);
      }
    }
    for (const code of closed) this.closeRoom(code);
    return { closed, released };
  }

  snapshot(room: Room): RoomSnapshot {
    return {
      code: room.code,
      createdAt: room.createdAt,
      driver: seatInfo(room.driver),
      navigator: seatInfo(room.navigator),
      navigatorSeatReserved: !!room.navigator && !room.navigator.connected,
      race: room.race.state,
    };
  }

  private bind(socketId: string, token: string, code: string, role: Role) {
    this.bySocket.set(socketId, { code, role });
    this.byToken.set(token, { code, role });
  }

  private joinResult(room: Room, seat: Seat): JoinResult {
    return {
      session: { token: seat.token, playerId: seat.playerId, role: seat.role, roomCode: room.code },
      room: this.snapshot(room),
      lastTelemetry: room.lastTelemetry,
      callLog: room.callLog,
    };
  }
}
