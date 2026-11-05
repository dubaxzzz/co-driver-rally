import type { BuiltStage, RelayedTelemetry } from '@cdr/shared';

const SEV_COLOR: Record<string, string> = {
  H: '#ff3b4e', '1': '#ff3b4e', '2': '#ff6a2b', '3': '#ff9d2b', '4': '#ffd02b', '5': '#a6e22e', '6': '#2fd27a',
};

/**
 * Top-down 2D map of the stage drawn on a canvas. "Follow" mode zooms in and
 * rotates heading-up around the car; "Stage" mode shows the whole route.
 */
export class MapView {
  readonly canvas = document.createElement('canvas');
  mode: 'follow' | 'full' = 'follow';
  private ctx = this.canvas.getContext('2d')!;
  private trail: Array<[number, number]> = [];
  private viewHeading = 0;

  constructor(private stage: BuiltStage) {}

  clearTrail() {
    this.trail = [];
  }

  draw(t: RelayedTelemetry | null, checkpointsPassed: number) {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, hgt = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0c1013';
    g.fillRect(0, 0, w, hgt);

    // grid
    g.strokeStyle = 'rgba(255,255,255,0.04)';
    g.lineWidth = 1;
    for (let x = 0; x < w; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, hgt); g.stroke(); }
    for (let y = 0; y < hgt; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }

    const st = this.stage;
    const b = st.bounds;
    let scale: number;
    let cx: number, cz: number;
    let rot = 0;
    if (this.mode === 'full' || !t) {
      scale = Math.min(w / (b.maxX - b.minX + 80), hgt / (b.maxZ - b.minZ + 80));
      cx = (b.minX + b.maxX) / 2;
      cz = (b.minZ + b.maxZ) / 2;
    } else {
      scale = Math.min(w, hgt) / 340;
      cx = t.x;
      cz = t.z;
      // heading-up: smoothly rotate the map so the car always points up
      let d = t.h - this.viewHeading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.viewHeading += d * 0.15;
      rot = this.viewHeading;
    }
    // world (x,z) -> screen. Top-down view: +x right, +z down; heading-up rotates by heading.
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const toScreen = (x: number, z: number): [number, number] => {
      const dx = x - cx, dz = z - cz;
      // rotate so that forward (sin h, cos h) maps to screen up (0,-1)
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      return this.mode === 'full' || !t ? [w / 2 + dx * scale, hgt / 2 + dz * scale] : [w / 2 - rx * scale, hgt * 0.62 - rz * scale];
    };

    // road
    const s = st.samples;
    const stride = this.mode === 'full' ? 4 : 1;
    const path = () => {
      g.beginPath();
      for (let i = 0; i < s.length; i += stride) {
        const [px, py] = toScreen(s[i].x, s[i].z);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
    };
    g.lineCap = g.lineJoin = 'round';
    path();
    g.strokeStyle = '#2a3036';
    g.lineWidth = Math.max(5, st.def.roadWidth * scale + 4);
    g.stroke();
    path();
    g.strokeStyle = '#8a7a62';
    g.lineWidth = Math.max(3, st.def.roadWidth * scale);
    g.stroke();

    // driven trail
    if (t) {
      const last = this.trail[this.trail.length - 1];
      if (!last || Math.hypot(last[0] - t.x, last[1] - t.z) > 3) this.trail.push([t.x, t.z]);
      if (this.trail.length > 4000) this.trail.shift();
      g.beginPath();
      this.trail.forEach(([x, z], i) => {
        const [px, py] = toScreen(x, z);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      });
      g.strokeStyle = 'rgba(255,75,31,0.75)';
      g.lineWidth = 2.5;
      g.stroke();
    }

    // corners (pace-note markers)
    const font = this.mode === 'full' ? 10 : 13;
    g.font = `800 ${font}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const n of st.paceNotes) {
      if (n.kind !== 'corner') continue;
      const mid = s[Math.min(s.length - 1, Math.round(n.distance + n.length / 2))];
      const [px, py] = toScreen(mid.x, mid.z);
      if (px < -20 || py < -20 || px > w + 20 || py > hgt + 20) continue;
      g.fillStyle = SEV_COLOR[String(n.severity)] ?? '#fff';
      g.beginPath();
      g.arc(px, py, this.mode === 'full' ? 7 : 11, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#111';
      g.fillText(`${n.dir}${n.severity === 'H' ? 'H' : n.severity}`, px, py + 0.5);
    }

    // start / checkpoints / finish
    const flag = (x: number, z: number, color: string, label: string) => {
      const [px, py] = toScreen(x, z);
      g.fillStyle = color;
      g.fillRect(px - 6, py - 6, 12, 12);
      g.fillStyle = '#fff';
      g.font = '800 11px sans-serif';
      g.fillText(label, px, py - 14);
    };
    const start = s[Math.round(st.startDistance)];
    flag(start.x, start.z, '#d8261c', 'START');
    for (const cp of st.checkpoints) flag(cp.x, cp.z, cp.index < checkpointsPassed ? '#2fd27a' : '#ff8a00', `CP${cp.index + 1}`);
    const fin = s[Math.round(st.finishDistance)];
    flag(fin.x, fin.z, '#ffffff', 'FINISH');

    // car marker
    if (t) {
      const [px, py] = toScreen(t.x, t.z);
      const ang = this.mode === 'full' ? Math.atan2(Math.sin(t.h), Math.cos(t.h)) : t.h - rot;
      g.save();
      g.translate(px, py);
      // screen direction for heading: full mode -> (sin h, cos h) in (x, down)
      if (this.mode === 'full') g.rotate(-ang + Math.PI);
      else g.rotate(-ang);
      g.fillStyle = 'rgba(255,75,31,0.25)';
      g.beginPath();
      g.arc(0, 0, 18, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ff4b1f';
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, -13);
      g.lineTo(9, 10);
      g.lineTo(0, 5);
      g.lineTo(-9, 10);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
    }
  }
}
