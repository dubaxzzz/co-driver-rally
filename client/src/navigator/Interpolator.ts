import { INTERPOLATION_DELAY_MS, type RelayedTelemetry } from '@cdr/shared';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/**
 * Buffers telemetry (stamped with server time) and renders slightly in the
 * past so the navigator's map moves smoothly between 20 Hz packets.
 */
export class Interpolator {
  private buf: RelayedTelemetry[] = [];

  push(p: RelayedTelemetry) {
    const last = this.buf[this.buf.length - 1];
    if (last && (p.runId !== last.runId)) this.buf = [];
    if (last && p.runId === last.runId && p.seq <= last.seq) return; // out-of-order
    this.buf.push(p);
    if (this.buf.length > 60) this.buf.shift();
  }

  clear() {
    this.buf = [];
  }

  get latest(): RelayedTelemetry | null {
    return this.buf[this.buf.length - 1] ?? null;
  }

  /** Interpolated state at `serverNow - delay`. */
  sample(serverNow: number): RelayedTelemetry | null {
    const b = this.buf;
    if (!b.length) return null;
    const t = serverNow - INTERPOLATION_DELAY_MS;
    if (t <= b[0].serverTime) return b[0];
    for (let i = b.length - 1; i > 0; i--) {
      const a = b[i - 1], c = b[i];
      if (a.serverTime <= t && t <= c.serverTime) {
        const u = (t - a.serverTime) / Math.max(1, c.serverTime - a.serverTime);
        return {
          ...c,
          x: lerp(a.x, c.x, u),
          y: lerp(a.y, c.y, u),
          z: lerp(a.z, c.z, u),
          h: lerpAngle(a.h, c.h, u),
          v: lerp(a.v, c.v, u),
          rpm: lerp(a.rpm, c.rpm, u),
          dist: lerp(a.dist, c.dist, u),
          remain: lerp(a.remain, c.remain, u),
          toNote: lerp(a.toNote, c.toNote, u),
        };
      }
    }
    return b[b.length - 1]; // newer than buffer: hold last
  }
}
