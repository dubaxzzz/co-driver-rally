import { io, type Socket } from 'socket.io-client';
import {
  SESSION_STORAGE_KEY,
  type Ack,
  type ClientToServerEvents,
  type JoinResult,
  type NavCall,
  type NavCallRequest,
  type RaceState,
  type RallyConfig,
  type Role,
  type SharedSwitch,
  type RoomSnapshot,
  type ServerToClientEvents,
  type TelemetryPacket,
} from '@cdr/shared';
import { NetBase, NetError } from './types';

/**
 * Single Socket.IO connection used by every screen. Handles automatic
 * reconnection, session resume (via the token issued by the server),
 * and server clock synchronisation.
 */
export class SocketNetClient extends NetBase {
  readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private clockOffset = 0;
  private bestRtt = Infinity;

  constructor() {
    super();
    const url = import.meta.env.VITE_SERVER_URL || undefined;
    this.socket = io(url ?? '/', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 8000,
    });
    try {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (raw) this.session = JSON.parse(raw);
    } catch {
      this.session = null;
    }

    const s = this.socket;
    s.on('connect', () => {
      this.setStatus('connected');
      void this.syncClock();
      if (this.session) void this.resume();
    });
    s.on('disconnect', (reason) => {
      this.setStatus(reason === 'io client disconnect' ? 'disconnected' : 'reconnecting');
    });
    s.io.on('reconnect_attempt', () => this.setStatus('reconnecting'));
    s.io.on('reconnect_failed', () => this.setStatus('disconnected'));
    s.on('connect_error', () => this.setStatus(this.session ? 'reconnecting' : 'connecting'));

    s.on('room:update', (room) => {
      this.room = room;
      this.emit('room', room);
    });
    s.on('race:state', (state) => {
      if (this.room) this.room = { ...this.room, race: state };
      this.emit('race', state);
    });
    s.on('telemetry', (p) => this.emit('telemetry', p));
    s.on('nav:call', (c) => this.emit('call', c));
    s.on('race:checkpoint', (e) => this.emit('checkpoint', e));
    s.on('race:warning', (w) => this.emit('warning', w));
    s.on('race:finished', (r) => this.emit('finished', r));
    s.on('car:switch', (e) => this.emit('switch', e));
    s.on('room:closed', (p) => {
      this.clearSession();
      this.emit('closed', p);
    });

    setInterval(() => {
      if (this.socket.connected) void this.syncClock();
    }, 15000);
  }

  // ---------- clock ----------
  /** Current time on the server's clock (ms). */
  serverNow() {
    return Date.now() + this.clockOffset;
  }
  private async syncClock() {
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const serverTime = await new Promise<number>((resolve) => this.socket.emit('time:sync', t0, resolve));
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (rtt <= this.bestRtt * 1.5 || i === 0) {
        this.bestRtt = Math.min(this.bestRtt, rtt);
        this.clockOffset = serverTime - (t0 + rtt / 2);
      }
    }
  }
  get latencyMs() {
    return Number.isFinite(this.bestRtt) ? this.bestRtt : null;
  }

  // ---------- session ----------
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
  clearSession() {
    this.session = null;
    this.room = null;
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Resolves once the socket is connected (or rejects after `ms`). */
  private waitConnected(ms: number): Promise<void> {
    if (this.socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off('connect', onConnect);
        reject(new NetError('OFFLINE', 'Cannot reach the rally server. Is it running? Retrying…'));
      }, ms);
      const onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      this.socket.once('connect', onConnect);
    });
  }

  private async request<T>(fn: (ack: (res: Ack<T>) => void) => void, timeoutMs = 6000): Promise<T> {
    await this.waitConnected(timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new NetError('TIMEOUT', 'The server did not respond.')), timeoutMs);
      fn((res) => {
        clearTimeout(timer);
        if (res.ok) resolve(res.data);
        else reject(new NetError(res.code, res.message));
      });
    });
  }

  async createRoom(name: string, config?: Partial<RallyConfig>): Promise<JoinResult> {
    const res = await this.request<JoinResult>((ack) => this.socket.emit('room:create', { name, config }, ack));
    this.storeSession(res);
    return res;
  }

  async joinRoom(code: string, name: string, role?: Role): Promise<JoinResult> {
    const res = await this.request<JoinResult>((ack) => this.socket.emit('room:join', { code, name, role }, ack));
    this.storeSession(res);
    return res;
  }

  /** Re-claims our seat after a reconnect or page refresh. */
  async resume(): Promise<JoinResult | null> {
    if (!this.session) return null;
    try {
      const res = await this.request<JoinResult>((ack) =>
        this.socket.emit('session:resume', { token: this.session!.token }, ack),
      );
      this.storeSession(res);
      this.emit('resumed', res);
      this.emit('room', res.room);
      return res;
    } catch (e) {
      this.clearSession();
      this.emit('resumeFailed', { message: (e as Error).message });
      return null;
    }
  }

  async leave() {
    try {
      await this.request<null>((ack) => this.socket.emit('room:leave', ack), 2000);
    } catch {
      /* leaving anyway */
    }
    this.clearSession();
  }

  configure(config: Partial<RallyConfig>) {
    return this.request<RaceState>((ack) => this.socket.emit('room:configure', config, ack));
  }
  async setRole(role: Role, navFor?: string | null) {
    const room = await this.request<RoomSnapshot>((ack) => this.socket.emit('room:role', { role, navFor }, ack));
    this.room = room;
    this.emit('room', room);
    return room;
  }
  async setReady(ready: boolean) {
    const room = await this.request<RoomSnapshot>((ack) => this.socket.emit('room:ready', ready, ack));
    this.room = room;
    this.emit('room', room);
    return room;
  }
  retire() {
    return this.request<RaceState>((ack) => this.socket.emit('race:retire', ack));
  }
  startRace() {
    return this.request<RaceState>((ack) => this.socket.emit('race:start', ack));
  }
  restartRace() {
    return this.request<RaceState>((ack) => this.socket.emit('race:restart', ack));
  }
  toLobby() {
    return this.request<RaceState>((ack) => this.socket.emit('race:lobby', ack));
  }
  sendCall(req: NavCallRequest) {
    return this.request<NavCall>((ack) => this.socket.emit('nav:call', req, ack));
  }
  sendSwitch(id: SharedSwitch, down = true) {
    // socket.io buffers this during a brief reconnect, so a click isn't lost
    this.socket.emit('car:switch', { id, down });
  }
  sendTelemetry(p: TelemetryPacket) {
    if (this.socket.connected) this.socket.volatile.emit('telemetry', p);
  }
}

