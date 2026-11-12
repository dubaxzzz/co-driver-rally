import {
  CALL_LOG_LENGTH,
  MAX_DRIVERS,
  MAX_MEMBERS,
  MAX_SPECTATORS,
  type RallyConfig,
  type Ack,
  type ErrorCode,
  type JoinResult,
  type NavCall,
  type RelayedTelemetry,
  type Role,
  type RoomSnapshot,
  RaceController,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type RaceEvents,
} from '@cdr/shared';
import { config } from '../config';
import { createSeat, seatInfo, type Seat } from '../players/sessions';
import { randomInt } from 'node:crypto';

export interface Room {
  code: string;
  createdAt: number;
  lastActivity: number;
  hostId: string;
  /** Everyone in the lobby, in the order they joined (max 4). */
  members: Seat[];
  race: RaceController;
  lastTelemetry: Map<string, RelayedTelemetry>;
  callLog: NavCall[];
  callSeq: number;
}

export type RoomError = { ok: false; code: ErrorCode; message: string };
const fail = (code: ErrorCode, message: string): RoomError => ({ ok: false, code, message });

export interface SocketBinding {
  code: string;
  playerId: string;
}

/**
 * Owns every room, seat and session token. All membership decisions happen
 * here so they can be unit-tested without sockets.
 *
 * A room holds up to four people. Each is a driver (own car on the stage) or
 * a navigator (rides along with one driver and sees their telemetry). The
 * host – whoever created the room, or the next person in line if they leave –
 * picks the stage and starts the rally once everyone has ticked "ready".
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

  seat(room: Room, playerId: string) {
    return room.members.find((m) => m.playerId === playerId) ?? null;
  }

  drivers(room: Room) {
    return room.members.filter((m) => m.role === 'driver');
  }

  /** Members in one of the 4 player seats (not spectators). */
  private players(room: Room) {
    return room.members.filter((m) => m.role !== 'spectator');
  }

  createRoom(socketId: string, name: string, rally: Partial<RallyConfig> = {}): Ack<JoinResult> {
    if (this.bySocket.has(socketId)) this.leave(socketId);
    if (this.rooms.size >= config.maxRooms) return fail('SERVER_FULL', 'The server has reached its room limit. Try again shortly.');
    const code = generateRoomCode((c) => this.rooms.has(c));
    if (!code) return fail('SERVER_FULL', 'No room codes available.');
    const now = Date.now();
    const seat = createSeat('driver', name, socketId);
    seat.ready = true;
    const room: Room = {
      code,
      createdAt: now,
      lastActivity: now,
      hostId: seat.playerId,
      members: [seat],
      race: new RaceController(rally, this.raceEventsFor(code)),
      lastTelemetry: new Map(),
      callLog: [],
      callSeq: 0,
    };
    this.rooms.set(code, room);
    this.bind(socketId, seat.token, code, seat.playerId);
    return { ok: true, data: this.joinResult(room, seat) };
  }

  /** Joins a room. `wantRole` is a preference; the server picks a sensible default. */
  join(socketId: string, code: string, name: string, wantRole?: Role): Ack<JoinResult> {
    const room = this.rooms.get(code);
    if (!room) return fail('ROOM_NOT_FOUND', `No rally found with code ${code}. Check the code on the host's screen.`);
    const already = this.bySocket.get(socketId);
    if (already?.code === code) return fail('NOT_ALLOWED', 'You are already in this rally.');
    // watching: any time, doesn't take a player seat
    if (wantRole === 'spectator') {
      if (room.members.filter((m) => m.role === 'spectator').length >= MAX_SPECTATORS) return fail('ROOM_FULL', `This rally already has ${MAX_SPECTATORS} spectators.`);
      if (already) this.leave(socketId);
      const seat = createSeat('spectator', name, socketId);
      seat.ready = true;
      room.members.push(seat);
      room.lastActivity = Date.now();
      this.bind(socketId, seat.token, code, seat.playerId);
      return { ok: true, data: this.joinResult(room, seat) };
    }
    if (this.players(room).length >= MAX_MEMBERS) {
      // free seats whose reconnect window has run out
      const now = Date.now();
      for (const m of [...room.members]) {
        if (!m.connected && now - (m.disconnectedAt ?? now) > config.navigatorGraceMs) this.removeSeat(room, m);
      }
      if (this.players(room).length >= MAX_MEMBERS) {
        const reserved = room.members.find((m) => !m.connected && m.role !== 'spectator');
        if (reserved) {
          const secs = Math.ceil((config.navigatorGraceMs - (now - (reserved.disconnectedAt ?? now))) / 1000);
          return fail('SEAT_RESERVED', `The rally is full – a seat is reserved for a reconnecting player (${secs}s).`);
        }
        return fail('ROOM_FULL', `This rally is full (${MAX_MEMBERS} players).`);
      }
    }
    if (already) this.leave(socketId);

    const drivers = this.drivers(room);
    const solo = !!room.race.state.soloEvent;
    const inLobby = room.race.state.phase === 'lobby';
    const canDrive = inLobby && !solo && drivers.length < MAX_DRIVERS;
    const needsNav = drivers.some((d) => !room.members.some((m) => m.role === 'navigator' && m.navFor === d.playerId));
    let role: Role = wantRole === 'driver' && canDrive ? 'driver' : wantRole === 'navigator' ? 'navigator' : needsNav || !canDrive ? 'navigator' : 'driver';
    if (role === 'navigator' && drivers.length === 0 && canDrive) role = 'driver';
    const seat = createSeat(role, name, socketId);
    if (role === 'navigator') seat.navFor = this.pickDriverFor(room);
    room.members.push(seat);
    room.lastActivity = Date.now();
    this.bind(socketId, seat.token, code, seat.playerId);
    return { ok: true, data: this.joinResult(room, seat) };
  }

  /** Lobby only: switch role, or pick which driver to navigate for. */
  setRole(socketId: string, role: Role, navFor?: string | null): Ack<RoomSnapshot> {
    const ctx = this.ctx(socketId);
    if (!ctx) return fail('NOT_IN_ROOM', 'You are not in a rally.');
    const { room, seat } = ctx;
    if (room.race.state.phase !== 'lobby') return fail('WRONG_PHASE', 'Wait for the stage to end before changing seats.');
    if (role === 'spectator') {
      if (seat.playerId === room.hostId) return fail('NOT_ALLOWED', 'The host runs the rally – hand over or leave to spectate.');
      const wasDriver = seat.role === 'driver';
      seat.role = 'spectator';
      seat.navFor = null;
      seat.ready = true;
      if (wasDriver) this.reassignNavigators(room, seat.playerId);
      room.lastActivity = Date.now();
      return { ok: true, data: this.snapshot(room) };
    }
    if (seat.role === 'spectator' && this.players(room).length >= MAX_MEMBERS) return fail('ROOM_FULL', `All ${MAX_MEMBERS} seats are taken.`);
    if (role === 'driver') {
      if (room.race.state.soloEvent && seat.playerId !== room.hostId) return fail('NOT_ALLOWED', 'This is a single-driver event – you can only navigate.');
      if (seat.role !== 'driver' && this.drivers(room).length >= MAX_DRIVERS) return fail('ROOM_FULL', `There are already ${MAX_DRIVERS} drivers.`);
      const wasNav = seat.role === 'navigator';
      seat.role = 'driver';
      seat.navFor = null;
      if (wasNav) seat.ready = seat.playerId === room.hostId;
    } else {
      if (room.race.state.soloEvent && seat.playerId === room.hostId) return fail('NOT_ALLOWED', 'You are the driver of this event.');
      if (navFor) {
        const target = this.seat(room, navFor);
        if (!target || target.role !== 'driver' || target.playerId === seat.playerId) return fail('BAD_PAYLOAD', 'That player is not a driver.');
      }
      const wasDriver = seat.role === 'driver';
      seat.role = 'navigator';
      seat.navFor = navFor ?? this.pickDriverFor(room, seat.playerId);
      if (wasDriver) this.reassignNavigators(room, seat.playerId);
    }
    room.lastActivity = Date.now();
    return { ok: true, data: this.snapshot(room) };
  }

  setReady(socketId: string, ready: boolean): Ack<RoomSnapshot> {
    const ctx = this.ctx(socketId);
    if (!ctx) return fail('NOT_IN_ROOM', 'You are not in a rally.');
    ctx.seat.ready = ready;
    ctx.room.lastActivity = Date.now();
    return { ok: true, data: this.snapshot(ctx.room) };
  }

  /**
   * Can this socket start the rally? Returns the grid (drivers in join order)
   * or a reason why not.
   */
  checkStart(socketId: string): { ok: true; room: Room; grid: Array<{ playerId: string; name: string }> } | RoomError {
    const ctx = this.ctx(socketId);
    if (!ctx) return fail('NOT_IN_ROOM', 'You are not in a rally.');
    const { room, seat } = ctx;
    if (seat.playerId !== room.hostId) return fail('NOT_ALLOWED', 'Only the host can start the rally.');
    if (room.race.state.phase !== 'lobby') return fail('WRONG_PHASE', 'The stage has already started.');
    const drivers = this.drivers(room).filter((d) => d.connected);
    if (!drivers.length) return fail('NOT_ALLOWED', 'Someone needs to be a driver.');
    const waiting = room.members.filter((m) => m.connected && m.playerId !== room.hostId && !m.ready);
    if (waiting.length) return fail('NOT_ALLOWED', `Waiting for ${waiting.map((w) => w.name).join(', ')} to tick ready.`);
    return { ok: true, room, grid: drivers.map((d) => ({ playerId: d.playerId, name: d.name })) };
  }

  /** Re-binds a seat to a new socket. Returns the previous socket id so it can be kicked. */
  resume(socketId: string, token: string): { result: Ack<JoinResult>; previousSocketId: string | null } {
    const b = this.byToken.get(token);
    const room = b ? this.rooms.get(b.code) : null;
    const seat = room && b ? this.seat(room, b.playerId) : null;
    if (!b || !room || !seat || seat.token !== token) {
      return { result: fail('SESSION_INVALID', 'That session has expired.'), previousSocketId: null };
    }
    const previousSocketId = seat.socketId && seat.socketId !== socketId ? seat.socketId : null;
    if (previousSocketId) this.bySocket.delete(previousSocketId);
    const existing = this.bySocket.get(socketId);
    if (existing && (existing.code !== b.code || existing.playerId !== b.playerId)) this.leave(socketId);
    seat.socketId = socketId;
    seat.connected = true;
    seat.disconnectedAt = null;
    room.lastActivity = Date.now();
    this.bySocket.set(socketId, { code: b.code, playerId: b.playerId });
    return { result: { ok: true, data: this.joinResult(room, seat) }, previousSocketId };
  }

  /** Socket dropped – keep the seat reserved for reconnection. */
  disconnect(socketId: string): Room | null {
    const b = this.bySocket.get(socketId);
    this.bySocket.delete(socketId);
    if (!b) return null;
    const room = this.rooms.get(b.code);
    if (!room) return null;
    const seat = this.seat(room, b.playerId);
    if (seat && seat.socketId === socketId) {
      seat.connected = false;
      seat.socketId = null;
      seat.disconnectedAt = Date.now();
      if (room.hostId === seat.playerId) this.passHost(room);
    }
    return room;
  }

  /** Player deliberately leaves. The room closes when the last person leaves. */
  leave(socketId: string): { room: Room; closed: boolean } | null {
    const b = this.bySocket.get(socketId);
    if (!b) return null;
    this.bySocket.delete(socketId);
    const room = this.rooms.get(b.code);
    if (!room) return null;
    const seat = this.seat(room, b.playerId);
    if (seat) this.removeSeat(room, seat);
    if (!room.members.length) {
      this.closeRoom(room.code);
      return { room, closed: true };
    }
    return { room, closed: false };
  }

  closeRoom(code: string) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.race.dispose();
    for (const seat of room.members) {
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
   * and rooms whose membership changed.
   */
  sweep(now = Date.now()): { closed: string[]; changed: string[] } {
    const closed: string[] = [];
    const changed: string[] = [];
    for (const room of this.rooms.values()) {
      const anyConnected = room.members.some((s) => s.connected);
      const lastDisconnect = Math.max(0, ...room.members.map((s) => s.disconnectedAt ?? 0));
      if ((!anyConnected && now - lastDisconnect > config.roomAbandonMs) || now - room.lastActivity > config.roomIdleMaxMs) {
        closed.push(room.code);
        continue;
      }
      let touched = false;
      for (const m of [...room.members]) {
        if (!m.connected && now - (m.disconnectedAt ?? now) > config.navigatorGraceMs) {
          this.removeSeat(room, m);
          touched = true;
        }
      }
      if (!room.members.length) closed.push(room.code);
      else if (touched) changed.push(room.code);
    }
    for (const code of closed) this.closeRoom(code);
    return { closed, changed };
  }

  snapshot(room: Room): RoomSnapshot {
    return {
      code: room.code,
      createdAt: room.createdAt,
      hostId: room.hostId,
      members: room.members.map(seatInfo),
      race: room.race.state,
    };
  }

  // ------------------------------------------------------------------ internals
  private ctx(socketId: string) {
    const b = this.bySocket.get(socketId);
    const room = b ? this.rooms.get(b.code) : null;
    const seat = room && b ? this.seat(room, b.playerId) : null;
    return room && seat ? { room, seat } : null;
  }

  private removeSeat(room: Room, seat: Seat) {
    room.members = room.members.filter((m) => m !== seat);
    this.byToken.delete(seat.token);
    if (seat.socketId) this.bySocket.delete(seat.socketId);
    room.lastTelemetry.delete(seat.playerId);
    if (seat.role === 'driver') {
      room.race.retire(seat.playerId);
      this.reassignNavigators(room, seat.playerId);
    }
    if (room.hostId === seat.playerId) this.passHost(room);
    room.lastActivity = Date.now();
  }

  /** Host moves to the next connected person (drivers first). */
  private passHost(room: Room) {
    const next =
      room.members.find((m) => m.connected && m.role === 'driver') ??
      room.members.find((m) => m.connected && m.role !== 'spectator') ??
      room.members.find((m) => m.connected) ??
      room.members[0];
    if (next) {
      room.hostId = next.playerId;
      next.ready = true;
    }
  }

  /** Driver with the fewest navigators (prefers one with none). */
  private pickDriverFor(room: Room, exclude?: string): string | null {
    const drivers = this.drivers(room).filter((d) => d.playerId !== exclude);
    if (!drivers.length) return null;
    const count = (id: string) => room.members.filter((m) => m.role === 'navigator' && m.navFor === id).length;
    return [...drivers].sort((a, b) => count(a.playerId) - count(b.playerId))[0].playerId;
  }

  private reassignNavigators(room: Room, formerDriver: string) {
    for (const m of room.members) {
      if (m.role === 'navigator' && m.navFor === formerDriver) m.navFor = this.pickDriverFor(room, formerDriver);
    }
  }

  private bind(socketId: string, token: string, code: string, playerId: string) {
    this.bySocket.set(socketId, { code, playerId });
    this.byToken.set(token, { code, playerId });
  }

  private joinResult(room: Room, seat: Seat): JoinResult {
    return {
      session: { token: seat.token, playerId: seat.playerId, role: seat.role, roomCode: room.code },
      room: this.snapshot(room),
      lastTelemetry: [...room.lastTelemetry.values()],
      callLog: room.callLog,
    };
  }
}

/** Generates a 4-character code that is not currently in use. */
function generateRoomCode(isTaken: (code: string) => boolean): string | null {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    if (!isTaken(code)) return code;
  }
  return null; // code space exhausted (practically never with MAX_ROOMS)
}
