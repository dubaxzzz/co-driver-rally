import type { BuiltStage, RelayedTelemetry } from '@cdr/shared';

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

    // rivers + bridges
    g.strokeStyle = '#2f6f8f';
    for (const r of st.rivers) {
      g.lineWidth = Math.max(3, r.halfWidth * 2 * scale);
      g.beginPath();
      r.points.forEach((p, i) => {
        const [px, py] = toScreen(p.x, p.z);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      });
      g.stroke();
    }
    // redraw the road over the river so the crossing reads as a bridge
    if (st.rivers.length) {
      path();
      g.strokeStyle = '#8a7a62';
      g.lineWidth = Math.max(3, st.def.roadWidth * scale);
      g.stroke();
      for (const b of st.bridges) {
        const [px, py] = toScreen(b.x, b.z);
        g.fillStyle = '#c08a4a';
        g.fillRect(px - 5, py - 5, 10, 10);
        g.fillStyle = '#fff';
        g.font = '800 10px sans-serif';
        g.fillText('BRIDGE', px + 30, py);
      }
    }

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

    // No corner labels: the navigator reads the road shape and calls it themselves.
    g.textAlign = 'center';
    g.textBaseline = 'middle';

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

    // potholes – the navigator can see them and call them
    g.fillStyle = '#ffcf33';
    for (const ph of st.potholes) {
      const [px, py] = toScreen(ph.x, ph.z);
      if (px < -10 || py < -10 || px > w + 10 || py > hgt + 10) continue;
      const r = this.mode === 'full' ? 2 : Math.max(3, ph.radius * scale * 1.6);
      g.beginPath();
      g.arc(px, py, r, 0, Math.PI * 2);
      g.fill();
    }

    // AI opponents
    if (t?.ai) {
      const colors = ['#1e5bc6', '#1f8a4c', '#f0b400'];
      for (let i = 0; i < t.ai.length / 6; i++) {
        const [px, py] = toScreen(t.ai[i * 6], t.ai[i * 6 + 2]);
        g.fillStyle = colors[i % colors.length];
        g.strokeStyle = '#fff';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(px, py, 6, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }

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
