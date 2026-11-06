import type { Server, Socket } from 'socket.io';
import {
  NAV_CALL_MAX_PER_SECOND,
  TELEMETRY_MAX_PER_SECOND,
  normaliseRoomCode,
  sanitiseName,
  validateNavCall,
  validateTelemetry,
  validateConfig,
  type Ack,
  type ClientToServerEvents,
  type ErrorCode,
  type RaceState,
  type ServerToClientEvents,
} from '@cdr/shared';
import { config } from '../config';
import { RoomManager, type Room } from '../rooms/RoomManager';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

const err = (code: ErrorCode, message: string) => ({ ok: false as const, code, message });
const safeAck = <T>(ack: unknown): ((res: Ack<T>) => void) =>
  typeof ack === 'function' ? (ack as (res: Ack<T>) => void) : () => {};

/** Simple per-socket sliding one-second rate limiter. */
class RateLimiter {
  private hits: number[] = [];
  constructor(private readonly perSecond: number) {}
  allow(now = Date.now()) {
    while (this.hits.length && now - this.hits[0] > 1000) this.hits.shift();
    if (this.hits.length >= this.perSecond) return false;
    this.hits.push(now);
    return true;
  }
}

export function registerHandlers(io: IO) {
  const rooms: RoomManager = new RoomManager((code) => ({
    onState: (state) => io.to(code).emit('race:state', state),
    onCheckpoint: (evt) => io.to(code).emit('race:checkpoint', evt),
    onWarning: (w) => io.to(code).emit('race:warning', w),
    onFinished: (r) => io.to(code).emit('race:finished', r),
  }));

  const broadcastRoom = (room: Room) => io.to(room.code).emit('room:update', rooms.snapshot(room));

  setInterval(() => {
    const { closed, released } = rooms.sweep();
    for (const code of closed) {
      io.to(code).emit('room:closed', { reason: 'The rally was closed after the players disconnected.' });
      io.in(code).socketsLeave(code);
      console.log(`[rooms] cleaned up ${code} (${rooms.size} active)`);
    }
    for (const code of released) {
      const room = rooms.get(code);
      if (room) broadcastRoom(room);
    }
  }, config.cleanupIntervalMs).unref();

  io.on('connection', (socket: Sock) => {
    const telemetryLimiter = new RateLimiter(TELEMETRY_MAX_PER_SECOND);
    const callLimiter = new RateLimiter(NAV_CALL_MAX_PER_SECOND);

    const currentRoom = () => {
      const b = rooms.binding(socket.id);
      const room = b ? rooms.get(b.code) : null;
      return b && room ? { b, room } : null;
    };

    socket.on('time:sync', (_clientTime, ack) => {
      if (typeof ack === 'function') ack(Date.now());
    });

    socket.on('room:create', (payload, ackFn) => {
      const ack = safeAck(ackFn);
      const name = sanitiseName(payload && (payload as { name?: unknown }).name, 'Driver');
      const config = payload?.config === undefined ? {} : validateConfig(payload.config);
      if (!config) return ack(err('BAD_PAYLOAD', 'Invalid stage, weather or AI settings.'));
      leaveCurrent();
      const res = rooms.createRoom(socket.id, name, config);
      if (res.ok) {
        socket.join(res.data.session.roomCode);
        console.log(`[rooms] ${res.data.session.roomCode} created (${rooms.size} active)`);
      }
      ack(res);
    });

    socket.on('room:join', (payload, ackFn) => {
      const ack = safeAck(ackFn);
      const code = normaliseRoomCode(payload?.code);
      if (!code) return ack(err('INVALID_CODE', 'Room codes are 4 letters/numbers, e.g. R7K2.'));
      const name = sanitiseName(payload?.name, 'Navigator');
      const res = rooms.joinAsNavigator(socket.id, code, name);
      if (!res.ok) return ack(res);
      socket.join(code);
      ack(res);
      const room = rooms.get(code);
      if (room) broadcastRoom(room);
    });

    socket.on('session:resume', (payload, ackFn) => {
      const ack = safeAck(ackFn);
      const token = typeof payload?.token === 'string' ? payload.token : '';
      if (!/^[a-f0-9]{48}$/.test(token)) return ack(err('SESSION_INVALID', 'Invalid session.'));
      const { result, previousSocketId } = rooms.resume(socket.id, token);
      if (!result.ok) return ack(result);
      if (previousSocketId) {
        const old = io.sockets.sockets.get(previousSocketId);
        old?.emit('room:closed', { reason: 'This seat was taken over by another tab or device.' });
        old?.leave(result.data.session.roomCode);
      }
      socket.join(result.data.session.roomCode);
      ack(result);
      const room = rooms.get(result.data.session.roomCode);
      if (room) broadcastRoom(room);
    });

    const leaveCurrent = () => {
      const left = rooms.leave(socket.id);
      if (!left) return;
      socket.leave(left.room.code);
      if (left.closed) {
        io.to(left.room.code).emit('room:closed', { reason: 'The driver closed the rally.' });
        io.in(left.room.code).socketsLeave(left.room.code);
      } else {
        broadcastRoom(left.room);
      }
    };

    socket.on('room:leave', (ackFn) => {
      leaveCurrent();
      safeAck<null>(ackFn)({ ok: true, data: null });
    });

    const raceAction = (action: 'start' | 'restart' | 'lobby', ackFn: unknown) => {
      const ack = safeAck<RaceState>(ackFn);
      const ctx = currentRoom();
      if (!ctx) return ack(err('NOT_IN_ROOM', 'You are not in a rally.'));
      const { b, room } = ctx;
      const phase = room.race.state.phase;
      if (action === 'start') {
        if (b.role !== 'driver') return ack(err('NOT_ALLOWED', 'Only the driver can start the stage.'));
        if (phase !== 'lobby') return ack(err('WRONG_PHASE', 'The stage has already started.'));
        return ack({ ok: true, data: room.race.start() });
      }
      if (action === 'restart') {
        if (phase === 'lobby') return ack(err('WRONG_PHASE', 'The stage has not started yet.'));
        room.lastTelemetry = null;
        return ack({ ok: true, data: room.race.start() });
      }
      room.lastTelemetry = null;
      ack({ ok: true, data: room.race.toLobby() });
    };
    socket.on('room:configure', (payload, ackFn) => {
      const ack = safeAck<RaceState>(ackFn);
      const ctx = currentRoom();
      if (!ctx) return ack(err('NOT_IN_ROOM', 'You are not in a rally.'));
      if (ctx.b.role !== 'driver') return ack(err('NOT_ALLOWED', 'Only the driver can choose the stage.'));
      if (ctx.room.race.state.phase !== 'lobby') return ack(err('WRONG_PHASE', 'Return to the lobby to change the stage.'));
      const cfg = validateConfig(payload);
      if (!cfg) return ack(err('BAD_PAYLOAD', 'Invalid stage, weather or AI settings.'));
      ack({ ok: true, data: ctx.room.race.configure(cfg) });
    });
    socket.on('race:start', (ack) => raceAction('start', ack));
    socket.on('race:restart', (ack) => raceAction('restart', ack));
    socket.on('race:lobby', (ack) => raceAction('lobby', ack));

    socket.on('telemetry', (raw) => {
      const ctx = currentRoom();
      if (!ctx || ctx.b.role !== 'driver') return; // only the room's driver may send telemetry
      if (!telemetryLimiter.allow()) return;
      const packet = validateTelemetry(raw);
      if (!packet) return;
      const { room } = ctx;
      if (!room.race.handleTelemetry(packet)) return;
      const relayed = { ...packet, serverTime: Date.now() };
      room.lastTelemetry = relayed;
      room.lastActivity = relayed.serverTime;
      // volatile: if the navigator is lagging, drop stale packets instead of queueing
      socket.to(room.code).volatile.emit('telemetry', relayed);
    });

    socket.on('nav:call', (raw, ackFn) => {
      const ack = safeAck(ackFn);
      const ctx = currentRoom();
      if (!ctx) return ack(err('NOT_IN_ROOM', 'You are not in a rally.'));
      if (ctx.b.role !== 'navigator') return ack(err('NOT_ALLOWED', 'Only the navigator can send calls.'));
      if (!callLimiter.allow()) return ack(err('RATE_LIMITED', 'Slow down – too many calls.'));
      const req = validateNavCall(raw);
      if (!req) return ack(err('BAD_PAYLOAD', 'That call could not be sent.'));
      const { room } = ctx;
      let text = req.text ?? '';
      let kind = req.kind;
      let noteIndex = req.noteIndex ?? null;
      let repeated = false;
      if (req.kind === 'repeat') {
        const prev = [...room.callLog].reverse().find((c) => c.kind !== 'repeat') ?? room.callLog[room.callLog.length - 1];
        if (!prev) return ack(err('BAD_PAYLOAD', 'There is no previous call to repeat.'));
        text = prev.text;
        kind = prev.kind;
        noteIndex = prev.noteIndex;
        repeated = true;
      }
      const call = rooms.addCall(room, { kind, text, noteIndex, serverTime: Date.now(), repeated });
      io.to(room.code).emit('nav:call', call);
      ack({ ok: true, data: call });
    });

    socket.on('disconnect', () => {
      const room = rooms.disconnect(socket.id);
      if (room) broadcastRoom(room);
    });
  });

  return rooms;
}
