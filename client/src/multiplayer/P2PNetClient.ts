import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import {
  CALL_LOG_LENGTH,
  DEFAULT_NAVIGATOR_RECONNECT_GRACE_MS,
  NAV_CALL_MAX_PER_SECOND,
  RaceController,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SESSION_STORAGE_KEY,
  normaliseRoomCode,
  sanitiseName,
  validateConfig,
  validateNavCall,
  type Ack,
  type ErrorCode,
  type JoinResult,
  type NavCall,
  type NavCallRequest,
  type RaceState,
  type RallyConfig,
  type RelayedTelemetry,
  type RoomSnapshot,
  type SessionInfo,
  type TelemetryPacket,
} from '@cdr/shared';
import { NetBase, NetError } from './types';

/**
 * Serverless multiplayer. The DRIVER's browser hosts the room: it owns the
 * room code, the navigator seat, session tokens and the authoritative
 * RaceController (the same code the Node server uses). The NAVIGATOR's
 * browser connects to it directly over WebRTC. PeerJS's free public broker
 * is only used so the two browsers can find each other; it is configurable
 * through VITE_PEER_* variables.
 *
 * The room code is part of the host's peer id, so the broker itself
 * guarantees two active rooms can never share a code.
 */

const PEER_PREFIX = 'codriver-rally-v1-';
const HOST_KEY = 'cdr.p2p.host';
const LINK_TIMEOUT_MS = 8000;
const NAV_RECONNECT_GIVE_UP_MS = 3 * 60 * 1000;

const peerIdFor = (code: string) => `${PEER_PREFIX}${code.toLowerCase()}`;

function peerOptions(): PeerOptions {
  const env = import.meta.env;
  const opts: PeerOptions = { debug: 0 };
  if (env.VITE_PEER_HOST) {
    opts.host = env.VITE_PEER_HOST;
    if (env.VITE_PEER_PORT) opts.port = Number(env.VITE_PEER_PORT);
    if (env.VITE_PEER_PATH) opts.path = env.VITE_PEER_PATH;
    opts.secure = env.VITE_PEER_SECURE ? env.VITE_PEER_SECURE === 'true' : location.protocol === 'https:';
  }
  return opts;
}

function randomHex(bytes: number) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomCode() {
  const a = new Uint32Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => ROOM_CODE_ALPHABET[n % ROOM_CODE_ALPHABET.length]).join('');
}

function describePeerError(err: { type?: string; message?: string }): string {
  switch (err.type) {
    case 'browser-incompatible':
      return 'This browser has WebRTC turned off or unsupported (common on managed school/work browsers). Try Chrome, Edge, Firefox or Safari on a personal device.';
    case 'ssl-unavailable':
      return 'The page must be opened over https:// (or localhost) for connections to work.';
    case 'network':
    case 'socket-error':
    case 'socket-closed':
    case 'server-error':
      return 'Cannot reach the PeerJS connection service (0.peerjs.com). Your network may be blocking it – try another Wi-Fi or a phone hotspot.';
    default:
      return `Connection error (${err.type ?? 'unknown'}): ${err.message ?? ''}`.trim();
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const fail = (code: ErrorCode, message: string) => ({ ok: false as const, code, message });

/** Messages on the wire. */
type Msg =
  | { k: 'req'; id: number; m: string; d?: unknown }
  | { k: 'res'; id: number; r: Ack<unknown> }
  | { k: 'evt'; e: string; d: unknown }
  | { k: 'tel'; d: RelayedTelemetry }
  | { k: 'ping' }
  | { k: 'pong' }
  | { k: 'sync'; c: number }
  | { k: 'syncR'; c: number; s: number };

interface NavSeat {
  playerId: string;
  token: string;
  name: string;
  conn: DataConnection | null;
  connected: boolean;
  disconnectedAt: number | null;
  lastSeen: number;
  callTimes: number[];
}

interface HostRecord {
  code: string;
  config: Partial<RallyConfig>;
  createdAt: number;
  driverId: string;
  driverName: string;
  nav: { playerId: string; token: string; name: string } | null;
}

interface HostState extends HostRecord {
  peer: Peer;
  race: RaceController;
  seat: NavSeat | null;
  callLog: NavCall[];
  callSeq: number;
  lastTelemetry: RelayedTelemetry | null;
}

export class P2PNetClient extends NetBase {
  readonly mode = 'p2p' as const;
  /** Peer used by the navigator (and as the "is the service reachable" probe). */
  private base: Peer | null = null;
  private baseReady: Promise<Peer> | null = null;
  private host: HostState | null = null;
  private hostTimer: ReturnType<typeof setInterval> | null = null;

  // navigator side
  private link: DataConnection | null = null;
  private linkCode: string | null = null;
  private lastHostMsg = 0;
  private reqSeq = 0;
  private pending = new Map<number, { resolve: (a: Ack<unknown>) => void; timer: ReturnType<typeof setTimeout> }>();
  private connectReject: ((e: NetError) => void) | null = null;
  private reconnecting = false;
  private navTimer: ReturnType<typeof setInterval> | null = null;
  private clockOffset = 0;
  private bestRtt = Infinity;

  constructor() {
    super();
    try {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (raw) this.session = JSON.parse(raw);
    } catch {
      this.session = null;
    }
    void this.ensureBase().catch(() => {});
    if (this.session) setTimeout(() => void this.resume(), 0);
    window.addEventListener('beforeunload', () => {
      // Tell the other side straight away instead of waiting for a timeout.
      this.base?.destroy();
      this.host?.peer.destroy();
    });
  }

  // ------------------------------------------------------------ peers
  private openPeer(id: string | null, timeoutMs = 12000): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
      const timer = setTimeout(() => {
        peer.destroy();
        reject(new NetError('OFFLINE', 'Timed out reaching the PeerJS connection service (0.peerjs.com). Your network may be blocking it – try another Wi-Fi or a phone hotspot.'));
      }, timeoutMs);
      peer.once('open', () => {
        clearTimeout(timer);
        resolve(peer);
      });
      peer.once('error', (err: { type?: string; message?: string }) => {
        if (peer.open) return;
        clearTimeout(timer);
        peer.destroy();
        if (err.type === 'unavailable-id') return reject(new NetError('ID_TAKEN', 'Room code in use'));
        reject(new NetError('OFFLINE', describePeerError(err)));
      });
    });
  }

  /** Keeps a peer registered with the broker (auto-reconnect). */
  private keepAlive(peer: Peer, onStatus: (ok: boolean) => void) {
    peer.on('disconnected', () => {
      onStatus(false);
      setTimeout(() => {
        if (!peer.destroyed && peer.disconnected) peer.reconnect();
      }, 1500);
    });
    peer.on('open', () => onStatus(true));
  }

  private ensureBase(): Promise<Peer> {
    if (this.base && !this.base.destroyed) return Promise.resolve(this.base);
    if (this.baseReady) return this.baseReady;
    this.baseReady = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const peer = await this.openPeer(null);
          this.base = peer;
          this.keepAlive(peer, (ok) => {
            if (!this.host && !this.link) this.setStatus(ok ? 'connected' : 'reconnecting');
          });
          peer.on('error', (err: { type?: string }) => {
            if (err.type === 'peer-unavailable' && this.connectReject) {
              this.connectReject(new NetError('ROOM_NOT_FOUND', 'No rally found with that code. Check the code on the driver\'s screen.'));
            }
          });
          this.lastError = null;
          if (!this.host && (!this.link || this.status !== 'reconnecting')) this.setStatus('connected');
          return peer;
        } catch (e) {
          this.lastError = (e as Error).message;
          console.warn('[p2p]', this.lastError);
          this.setStatus(attempt === 0 ? 'reconnecting' : 'disconnected');
          if (attempt >= 2) {
            this.baseReady = null;
            // keep trying quietly in the background so it recovers by itself
            setTimeout(() => void this.ensureBase().catch(() => {}), 6000);
            throw e;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
    return this.baseReady;
  }

  // ------------------------------------------------------------ clock
  serverNow() {
    return this.host ? Date.now() : Date.now() + this.clockOffset;
  }
  get latencyMs() {
    return this.host ? 0 : Number.isFinite(this.bestRtt) ? this.bestRtt : null;
  }

  // ------------------------------------------------------------ session storage
  private storeSession(res: JoinResult) {
    this.session = res.session;
    this.room = res.room;
    this.lastJoin = res;
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(res.session));
    } catch {
      /* ignore */
    }
  }
  private persistHost() {
    if (!this.host) return;
    const h = this.host;
    const rec: HostRecord = {
      code: h.code,
      config: { stageId: h.race.state.stageId, weather: h.race.state.weather, aiCount: h.race.state.aiCount, aiSkill: h.race.state.aiSkill },
      createdAt: h.createdAt,
      driverId: h.driverId,
      driverName: h.driverName,
      nav: h.seat ? { playerId: h.seat.playerId, token: h.seat.token, name: h.seat.name } : null,
    };
    try {
      sessionStorage.setItem(HOST_KEY, JSON.stringify(rec));
    } catch {
      /* ignore */
    }
  }
  clearSession() {
    this.session = null;
    this.room = null;
    this.lastJoin = null;
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      sessionStorage.removeItem(HOST_KEY);
    } catch {
      /* ignore */
    }
  }

  // =============================================================== HOST (driver)
  async createRoom(name: string, config: Partial<RallyConfig> = {}): Promise<JoinResult> {
    if (this.session) await this.leave();
    this.setStatus('connecting');
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomCode();
      try {
        const peer = await this.openPeer(peerIdFor(code));
        const rec: HostRecord = { code, config: validateConfig(config) ?? {}, createdAt: Date.now(), driverId: randomHex(8), driverName: sanitiseName(name, 'Driver'), nav: null };
        const res = this.startHosting(peer, rec, randomHex(24));
        this.setStatus('connected');
        return res;
      } catch (e) {
        if ((e as NetError).code === 'ID_TAKEN') continue; // code already used by another rally – pick another
        this.lastError = (e as Error).message;
        this.setStatus('disconnected');
        throw e;
      }
    }
    throw new NetError('SERVER_FULL', 'Could not find a free room code. Try again.');
  }

  private startHosting(peer: Peer, rec: HostRecord, token: string): JoinResult {
    const race = new RaceController(rec.config ?? {}, {
      onState: (state) => {
        if (this.room) this.room = { ...this.room, race: state };
        this.emit('race', state);
        this.toNav({ k: 'evt', e: 'race:state', d: state });
      },
      onCheckpoint: (evt) => {
        this.emit('checkpoint', evt);
        this.toNav({ k: 'evt', e: 'race:checkpoint', d: evt });
      },
      onWarning: (w) => {
        this.emit('warning', w);
        this.toNav({ k: 'evt', e: 'race:warning', d: w });
      },
      onFinished: (r) => {
        this.emit('finished', r);
        this.toNav({ k: 'evt', e: 'race:finished', d: r });
      },
    });
    const now = Date.now();
    this.host = {
      ...rec,
      peer,
      race,
      seat: rec.nav
        ? { ...rec.nav, conn: null, connected: false, disconnectedAt: now, lastSeen: 0, callTimes: [] }
        : null,
      callLog: [],
      callSeq: 0,
      lastTelemetry: null,
    };
    peer.on('connection', (conn) => this.hostAccept(conn));
    this.keepAlive(peer, (ok) => this.setStatus(ok ? 'connected' : 'reconnecting'));
    this.hostTimer = setInterval(() => this.hostTick(), 1000);
    const session: SessionInfo = { token, playerId: rec.driverId, role: 'driver', roomCode: rec.code };
    const res: JoinResult = { session, room: this.snapshot(), lastTelemetry: null, callLog: [] };
    this.storeSession(res);
    this.persistHost();
    return res;
  }

  private snapshot(): RoomSnapshot {
    const h = this.host!;
    return {
      code: h.code,
      createdAt: h.createdAt,
      driver: { playerId: h.driverId, name: h.driverName, role: 'driver', connected: true },
      navigator: h.seat ? { playerId: h.seat.playerId, name: h.seat.name, role: 'navigator', connected: h.seat.connected } : null,
      navigatorSeatReserved: !!h.seat && !h.seat.connected,
      race: h.race.state,
    };
  }

  private broadcastRoom() {
    if (!this.host) return;
    const room = this.snapshot();
    this.room = room;
    this.emit('room', room);
    this.toNav({ k: 'evt', e: 'room:update', d: room });
  }

  private toNav(msg: Msg) {
    const conn = this.host?.seat?.conn;
    if (conn?.open) {
      try {
        conn.send(msg);
      } catch {
        /* connection dropping – heartbeat will notice */
      }
    }
  }

  private hostAccept(conn: DataConnection) {
    conn.on('data', (raw) => this.hostHandle(conn, raw));
    const lost = () => {
      const seat = this.host?.seat;
      if (seat && seat.conn === conn) {
        seat.conn = null;
        seat.connected = false;
        seat.disconnectedAt = Date.now();
        this.broadcastRoom();
      }
    };
    conn.on('close', lost);
    conn.on('error', lost);
    // Unauthenticated connections that never join are dropped.
    setTimeout(() => {
      if (this.host?.seat?.conn !== conn) conn.close();
    }, 15000);
  }

  private hostTick() {
    const h = this.host;
    if (!h?.seat) return;
    const now = Date.now();
    const seat = h.seat;
    if (seat.connected) {
      this.toNav({ k: 'ping' });
      if (now - seat.lastSeen > LINK_TIMEOUT_MS) {
        seat.conn?.close();
        seat.conn = null;
        seat.connected = false;
        seat.disconnectedAt = now;
        this.broadcastRoom();
      }
    } else if (now - (seat.disconnectedAt ?? now) > DEFAULT_NAVIGATOR_RECONNECT_GRACE_MS) {
      h.seat = null; // release the reserved seat
      this.persistHost();
      this.broadcastRoom();
    }
  }

  private hostHandle(conn: DataConnection, raw: unknown) {
    const h = this.host;
    if (!h || !isObj(raw) || typeof raw.k !== 'string') return;
    if (h.seat?.conn === conn) h.seat.lastSeen = Date.now();
    if (raw.k === 'sync' && typeof raw.c === 'number') {
      conn.send({ k: 'syncR', c: raw.c, s: Date.now() } satisfies Msg);
      return;
    }
    if (raw.k !== 'req' || typeof raw.id !== 'number' || typeof raw.m !== 'string') return;
    const reply = (r: Ack<unknown>) => conn.open && conn.send({ k: 'res', id: raw.id as number, r } satisfies Msg);
    const d = isObj(raw.d) ? raw.d : {};
    const isNav = h.seat?.conn === conn;

    switch (raw.m) {
      case 'join': {
        const seat = h.seat;
        if (seat?.connected) return reply(fail('ROOM_FULL', 'This rally already has a navigator.'));
        if (seat && Date.now() - (seat.disconnectedAt ?? 0) < DEFAULT_NAVIGATOR_RECONNECT_GRACE_MS) {
          const secs = Math.ceil((DEFAULT_NAVIGATOR_RECONNECT_GRACE_MS - (Date.now() - (seat.disconnectedAt ?? 0))) / 1000);
          return reply(fail('SEAT_RESERVED', `The navigator seat is reserved for a reconnecting player (${secs}s).`));
        }
        h.seat = {
          playerId: randomHex(8),
          token: randomHex(24),
          name: sanitiseName(d.name, 'Navigator'),
          conn,
          connected: true,
          disconnectedAt: null,
          lastSeen: Date.now(),
          callTimes: [],
        };
        this.persistHost();
        reply({ ok: true, data: this.navJoinResult() });
        this.broadcastRoom();
        return;
      }
      case 'resume': {
        const seat = h.seat;
        if (!seat || typeof d.token !== 'string' || d.token !== seat.token) {
          return reply(fail('SESSION_INVALID', 'That session has expired.'));
        }
        if (seat.conn && seat.conn !== conn) {
          try {
            seat.conn.send({ k: 'evt', e: 'room:closed', d: { reason: 'This seat was taken over by another tab or device.' } } satisfies Msg);
          } catch {
            /* ignore */
          }
          seat.conn.close();
        }
        seat.conn = conn;
        seat.connected = true;
        seat.disconnectedAt = null;
        seat.lastSeen = Date.now();
        reply({ ok: true, data: this.navJoinResult() });
        this.broadcastRoom();
        return;
      }
    }

    if (!isNav) return reply(fail('NOT_IN_ROOM', 'You are not in this rally.'));
    const phase = h.race.state.phase;
    switch (raw.m) {
      case 'start':
        return reply(fail('NOT_ALLOWED', 'Only the driver can start the stage.'));
      case 'restart':
        if (phase === 'lobby') return reply(fail('WRONG_PHASE', 'The stage has not started yet.'));
        h.lastTelemetry = null;
        return reply({ ok: true, data: h.race.start() });
      case 'lobby':
        h.lastTelemetry = null;
        return reply({ ok: true, data: h.race.toLobby() });
      case 'leave':
        reply({ ok: true, data: null });
        h.seat = null;
        this.persistHost();
        setTimeout(() => conn.close(), 200);
        this.broadcastRoom();
        return;
      case 'call': {
        const seat = h.seat!;
        const now = Date.now();
        seat.callTimes = seat.callTimes.filter((t) => now - t < 1000);
        if (seat.callTimes.length >= NAV_CALL_MAX_PER_SECOND) return reply(fail('RATE_LIMITED', 'Slow down – too many calls.'));
        seat.callTimes.push(now);
        const req = validateNavCall(raw.d);
        if (!req) return reply(fail('BAD_PAYLOAD', 'That call could not be sent.'));
        let text = req.text ?? '';
        let kind = req.kind;
        let noteIndex = req.noteIndex ?? null;
        let repeated = false;
        if (req.kind === 'repeat') {
          const prev = [...h.callLog].reverse().find((c) => c.kind !== 'repeat') ?? h.callLog[h.callLog.length - 1];
          if (!prev) return reply(fail('BAD_PAYLOAD', 'There is no previous call to repeat.'));
          ({ text, kind, noteIndex } = prev);
          repeated = true;
        }
        const call: NavCall = { id: ++h.callSeq, kind, text, noteIndex, serverTime: now, repeated };
        h.callLog.push(call);
        if (h.callLog.length > CALL_LOG_LENGTH) h.callLog.shift();
        reply({ ok: true, data: call });
        this.emit('call', call);
        this.toNav({ k: 'evt', e: 'nav:call', d: call });
        return;
      }
      default:
        return reply(fail('BAD_PAYLOAD', 'Unknown request.'));
    }
  }

  private navJoinResult(): JoinResult {
    const h = this.host!;
    const seat = h.seat!;
    return {
      session: { token: seat.token, playerId: seat.playerId, role: 'navigator', roomCode: h.code },
      room: this.snapshot(),
      lastTelemetry: h.lastTelemetry,
      callLog: h.callLog,
    };
  }

  /** Re-opens the same room code after the driver refreshes the page. */
  private async restoreHost(): Promise<JoinResult | null> {
    let rec: HostRecord | null = null;
    try {
      rec = JSON.parse(sessionStorage.getItem(HOST_KEY) ?? 'null');
    } catch {
      rec = null;
    }
    if (!rec || !this.session) return null;
    // The broker may need a few seconds to release the old peer id.
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      try {
        const peer = await this.openPeer(peerIdFor(rec.code));
        const res = this.startHosting(peer, rec, this.session.token);
        this.setStatus('connected');
        return res;
      } catch (e) {
        if ((e as NetError).code !== 'ID_TAKEN') this.setStatus('reconnecting');
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    return null;
  }

  private stopHosting(reason: string | null) {
    const h = this.host;
    if (!h) return;
    if (reason) this.toNav({ k: 'evt', e: 'room:closed', d: { reason } });
    if (this.hostTimer) clearInterval(this.hostTimer);
    this.hostTimer = null;
    h.race.dispose();
    const peer = h.peer;
    setTimeout(() => peer.destroy(), 300); // let the close message go out
    this.host = null;
  }

  // =============================================================== NAVIGATOR
  private connectToHost(code: string): Promise<DataConnection> {
    return this.ensureBase().then(
      (peer) =>
        new Promise<DataConnection>((resolve, reject) => {
          const conn = peer.connect(peerIdFor(code), { reliable: true, serialization: 'json' });
          const timer = setTimeout(() => {
            this.connectReject = null;
            conn.close();
            reject(new NetError('TIMEOUT', 'Could not reach the driver. Check the code and that the driver is on the lobby screen.'));
          }, 12000);
          this.connectReject = (e) => {
            clearTimeout(timer);
            this.connectReject = null;
            conn.close();
            reject(e);
          };
          conn.once('open', () => {
            clearTimeout(timer);
            this.connectReject = null;
            resolve(conn);
          });
        }),
    );
  }

  private attachLink(conn: DataConnection, code: string) {
    if (this.link && this.link !== conn) this.link.close();
    this.link = conn;
    this.linkCode = code;
    this.lastHostMsg = Date.now();
    conn.on('data', (raw) => this.navHandle(conn, raw));
    const lost = () => {
      if (this.link === conn) this.onHostLost();
    };
    conn.on('close', lost);
    conn.on('error', lost);
    if (!this.navTimer) {
      this.navTimer = setInterval(() => {
        if (this.link && Date.now() - this.lastHostMsg > LINK_TIMEOUT_MS) this.onHostLost();
      }, 1000);
    }
    this.syncClock();
  }

  private syncClock() {
    for (let i = 0; i < 3; i++) setTimeout(() => this.link?.open && this.link.send({ k: 'sync', c: Date.now() } satisfies Msg), i * 150);
  }

  private navHandle(conn: DataConnection, raw: unknown) {
    if (conn !== this.link || !isObj(raw) || typeof raw.k !== 'string') return;
    this.lastHostMsg = Date.now();
    const msg = raw as Msg;
    switch (msg.k) {
      case 'ping':
        conn.send({ k: 'pong' } satisfies Msg);
        return;
      case 'syncR': {
        const now = Date.now();
        const rtt = now - msg.c;
        if (rtt <= this.bestRtt * 1.5 || !Number.isFinite(this.bestRtt)) {
          this.bestRtt = Math.min(this.bestRtt, rtt);
          this.clockOffset = msg.s - (msg.c + rtt / 2);
        }
        return;
      }
      case 'res': {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg.r);
        }
        return;
      }
      case 'tel':
        this.emit('telemetry', msg.d);
        return;
      case 'evt':
        this.navEvent(msg.e, msg.d);
    }
  }

  private navEvent(e: string, d: unknown) {
    switch (e) {
      case 'room:update':
        this.room = d as RoomSnapshot;
        this.emit('room', this.room);
        break;
      case 'race:state':
        if (this.room) this.room = { ...this.room, race: d as RaceState };
        this.emit('race', d as RaceState);
        break;
      case 'race:checkpoint':
        this.emit('checkpoint', d as never);
        break;
      case 'race:warning':
        this.emit('warning', d as never);
        break;
      case 'race:finished':
        this.emit('finished', d as never);
        break;
      case 'nav:call':
        this.emit('call', d as NavCall);
        break;
      case 'room:closed':
        this.dropLink();
        this.clearSession();
        this.emit('closed', d as { reason: string });
        break;
    }
  }

  private navRequest<T>(m: string, d?: unknown, timeoutMs = 8000, conn = this.link): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!conn?.open) {
        reject(new NetError('OFFLINE', 'Not connected to the driver. Reconnecting…'));
        return;
      }
      const id = ++this.reqSeq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NetError('TIMEOUT', 'The driver did not respond.'));
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        resolve: (r) => (r.ok ? resolve(r.data as T) : reject(new NetError(r.code, r.message))),
      });
      conn.send({ k: 'req', id, m, d } satisfies Msg);
    });
  }

  async joinRoom(rawCode: string, name: string): Promise<JoinResult> {
    const code = normaliseRoomCode(rawCode);
    if (!code) throw new NetError('INVALID_CODE', 'Room codes are 4 letters/numbers, e.g. R7K2.');
    if (this.session) await this.leave();
    const conn = await this.connectToHost(code);
    this.attachLink(conn, code);
    try {
      const res = await this.navRequest<JoinResult>('join', { name });
      this.storeSession(res);
      this.setStatus('connected');
      return res;
    } catch (e) {
      this.dropLink();
      throw e;
    }
  }

  private dropLink() {
    const l = this.link;
    this.link = null;
    this.linkCode = null;
    l?.close();
    if (this.navTimer) clearInterval(this.navTimer);
    this.navTimer = null;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  /** Lost the driver: keep the seat and keep trying to get back in. */
  private onHostLost() {
    if (this.reconnecting) return;
    const code = this.linkCode;
    this.dropLink();
    if (!this.session || !code) return;
    this.setStatus('reconnecting');
    if (this.room?.driver) {
      this.room = { ...this.room, driver: { ...this.room.driver, connected: false } };
      this.emit('room', this.room);
    }
    void this.navReconnectLoop(code, NAV_RECONNECT_GIVE_UP_MS);
  }

  private async navReconnectLoop(code: string, giveUpMs: number): Promise<JoinResult | null> {
    this.reconnecting = true;
    const deadline = Date.now() + giveUpMs;
    try {
      while (this.session && Date.now() < deadline) {
        try {
          const conn = await this.connectToHost(code);
          this.attachLink(conn, code);
          const res = await this.navRequest<JoinResult>('resume', { token: this.session.token });
          this.storeSession(res);
          this.setStatus('connected');
          this.emit('resumed', res);
          this.emit('room', res.room);
          return res;
        } catch (e) {
          const err = e as NetError;
          if (err.code === 'SESSION_INVALID') {
            this.dropLink();
            this.clearSession();
            this.emit('closed', { reason: 'The rally has ended.' });
            return null;
          }
          this.dropLink();
          await new Promise((r) => setTimeout(r, 2500));
        }
      }
      if (this.session) {
        this.clearSession();
        this.setStatus('disconnected');
        this.emit('closed', { reason: 'Lost the driver. The rally has ended.' });
      }
      return null;
    } finally {
      this.reconnecting = false;
    }
  }

  // =============================================================== shared API
  async resume(): Promise<JoinResult | null> {
    const s = this.session;
    if (!s) return null;
    let res: JoinResult | null = null;
    if (s.role === 'driver') {
      res = this.host ? { session: s, room: this.snapshot(), lastTelemetry: null, callLog: this.host.callLog } : await this.restoreHost();
      if (res) {
        this.emit('resumed', res);
        this.emit('room', res.room);
      }
    } else {
      res = await this.navReconnectLoop(s.roomCode, 20000);
    }
    if (!res) {
      const msg = 'Your previous rally session has ended.';
      this.clearSession();
      this.emit('resumeFailed', { message: msg });
    }
    return res;
  }

  async leave() {
    if (this.host) {
      this.stopHosting('The driver closed the rally.');
    } else if (this.link) {
      try {
        await this.navRequest('leave', undefined, 1500);
      } catch {
        /* leaving anyway */
      }
      this.dropLink();
    }
    this.clearSession();
    if (this.base && !this.base.destroyed && !this.base.disconnected) this.setStatus('connected');
  }

  async configure(config: Partial<RallyConfig>): Promise<RaceState> {
    const h = this.host;
    if (!h) throw new NetError('NOT_ALLOWED', 'Only the driver can choose the stage.');
    if (h.race.state.phase !== 'lobby') throw new NetError('WRONG_PHASE', 'Return to the lobby to change the stage.');
    const cfg = validateConfig(config);
    if (!cfg) throw new NetError('BAD_PAYLOAD', 'Invalid stage, weather or AI settings.');
    const state = h.race.configure(cfg);
    this.persistHost();
    return state;
  }

  async startRace(): Promise<RaceState> {
    const h = this.host;
    if (!h) throw new NetError('NOT_ALLOWED', 'Only the driver can start the stage.');
    if (h.race.state.phase !== 'lobby') throw new NetError('WRONG_PHASE', 'The stage has already started.');
    return h.race.start();
  }

  async restartRace(): Promise<RaceState> {
    const h = this.host;
    if (!h) return this.navRequest<RaceState>('restart');
    if (h.race.state.phase === 'lobby') throw new NetError('WRONG_PHASE', 'The stage has not started yet.');
    h.lastTelemetry = null;
    return h.race.start();
  }

  async toLobby(): Promise<RaceState> {
    const h = this.host;
    if (!h) return this.navRequest<RaceState>('lobby');
    h.lastTelemetry = null;
    return h.race.toLobby();
  }

  async sendCall(req: NavCallRequest): Promise<NavCall> {
    if (this.host) throw new NetError('NOT_ALLOWED', 'Only the navigator can send calls.');
    return this.navRequest<NavCall>('call', req);
  }

  sendTelemetry(p: TelemetryPacket) {
    const h = this.host;
    if (!h) return;
    if (!h.race.handleTelemetry(p)) return;
    const relayed: RelayedTelemetry = { ...p, serverTime: Date.now() };
    h.lastTelemetry = relayed;
    this.toNav({ k: 'tel', d: relayed });
  }
}
