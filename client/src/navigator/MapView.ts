import { showerAt, type StageConditions } from '@cdr/shared';
import type { BuiltStage, RelayedTelemetry } from '@cdr/shared';

/**
 * Top-down 2D map of the stage drawn on a canvas. "Follow" mode zooms in and
 * rotates heading-up around the car; "Stage" mode shows the whole route.
 */
export class MapView {
  readonly canvas = document.createElement('canvas');
  mode: 'follow' | 'full' = 'follow';
  /** Small thumbnails (stage picker) draw markers only – text labels would overlap. */
  labels = true;
  /** Stage clock (s) – where the moving showers are on the radar. */
  raceTime = 0;
  /** This run's showers, fog banks and obstacles (drawn on the map). */
  conditions: StageConditions | null = null;
  /** Fixed drawing size (when the canvas is not in the page, e.g. drawn onto the tablet). */
  size: { w: number; h: number } | null = null;
  /** Pixels per logical unit when `size` is set (bigger = larger text and markers). */
  pixelScale = 1;
  private ctx = this.canvas.getContext('2d')!;
  private trail: Array<[number, number]> = [];
  private viewHeading = 0;

  constructor(private stage: BuiltStage) {}

  clearTrail() {
    this.trail = [];
  }

  draw(t: RelayedTelemetry | null, checkpointsPassed: number) {
    const c = this.canvas;
    const dpr = this.size ? this.pixelScale : Math.min(2, window.devicePixelRatio || 1);
    const w = this.size?.w ?? c.clientWidth, hgt = this.size?.h ?? c.clientHeight;
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

    // forks: short cuts (brown, dashed) and fast bypasses (green, dashed)
    for (const sp of st.splits) {
      const bs = sp.samples;
      const bpath = () => {
        g.beginPath();
        for (let i = 0; i < bs.length; i += stride * 2) {
          const [px, py] = toScreen(bs[i].x, bs[i].z);
          if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
      };
      bpath();
      g.strokeStyle = '#2a3036';
      g.lineWidth = Math.max(4, sp.width * scale + 4);
      g.stroke();
      bpath();
      g.setLineDash([8, 6]);
      g.strokeStyle = sp.kind === 'cut' ? '#b0703a' : '#3fbf6a';
      g.lineWidth = Math.max(2.5, sp.width * scale);
      g.stroke();
      g.setLineDash([]);
      if (this.labels) {
        const m = bs[Math.floor(bs.length / 2)];
        const [px, py] = toScreen(m.x, m.z);
        g.font = '800 10px sans-serif';
        g.textAlign = 'center';
        g.fillStyle = sp.kind === 'cut' ? '#ffc08a' : '#8dffb3';
        g.fillText(sp.kind === 'cut' ? `SHORT CUT ${Math.round(sp.length)} m (${sp.surface.toUpperCase()})` : `FAST ROUTE ${Math.round(sp.length)} m`, px, py - 10);
        g.fillStyle = '#cfd6dd';
        g.fillText(`road ${Math.round(sp.to - sp.from)} m`, px, py + 6);
        g.textAlign = 'left';
      }
    }

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
        const bs = this.labels ? 5 : 3;
        g.fillRect(px - bs, py - bs, bs * 2, bs * 2);
        if (this.labels) {
          g.fillStyle = '#fff';
          g.font = '800 10px sans-serif';
          g.fillText('BRIDGE', px + 30, py);
        }
      }
    }

    // this run's conditions: showers (blue), fog banks (grey), things on the road (red !)
    if (this.conditions) {
      const span = (from: number, to: number, color: string) => {
        g.beginPath();
        let first = true;
        for (let i = Math.max(0, Math.floor(from / st.step)); i < Math.min(s.length, Math.ceil(to / st.step)); i += stride) {
          const [px, py] = toScreen(s[i].x, s[i].z);
          if (first) g.moveTo(px, py);
          else g.lineTo(px, py);
          first = false;
        }
        g.strokeStyle = color;
        g.lineWidth = Math.max(6, st.def.roadWidth * scale + 10);
        g.stroke();
      };
      for (const z of this.conditions.wet) span(z.from, z.to, 'rgba(60,150,255,0.45)');
      for (const z of this.conditions.fog) span(z.from, z.to, 'rgba(200,210,220,0.35)');
      for (const o of this.conditions.obstacles) {
        const c = s[Math.min(s.length - 1, Math.round(o.distance / st.step))];
        const [px, py] = toScreen(c.x, c.z);
        const r = this.labels ? 9 : 5;
        g.fillStyle = '#ff3b4e';
        g.beginPath();
        g.moveTo(px, py - r * 1.2);
        g.lineTo(px + r, py + r * 0.7);
        g.lineTo(px - r, py + r * 0.7);
        g.closePath();
        g.fill();
        if (this.labels) {
          g.fillStyle = '#fff';
          g.font = '900 10px sans-serif';
          g.textAlign = 'center';
          g.fillText('!', px, py + 3);
          g.textAlign = 'left';
          g.font = '800 10px sans-serif';
          g.fillText(o.kind === 'tree' ? 'TREE DOWN' : o.kind === 'rocks' ? 'ROCKS' : 'ANIMALS', px + 12, py + 3);
        }
      }
    }

    // weather radar: showers drifting across the map (where they are now, and in a minute)
    if (this.conditions?.showers.length) {
      for (const sh of this.conditions.showers) {
        const now = showerAt(sh, this.raceTime);
        const later = showerAt(sh, this.raceTime + 60);
        const [px, py] = toScreen(now.x, now.z);
        const r = sh.r * scale;
        if (px < -r || py < -r || px > w + r || py > hgt + r) continue;
        const grad = g.createRadialGradient(px, py, 0, px, py, r);
        grad.addColorStop(0, `rgba(40,200,120,${0.45 * sh.amount})`);
        grad.addColorStop(0.45, `rgba(60,150,255,${0.35 * sh.amount})`);
        grad.addColorStop(1, 'rgba(60,150,255,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(px, py, r, 0, Math.PI * 2);
        g.fill();
        // where it'll be in a minute
        const [lx, ly] = toScreen(later.x, later.z);
        g.setLineDash([5, 5]);
        g.strokeStyle = 'rgba(120,190,255,0.6)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(lx, ly, r, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
        g.strokeStyle = 'rgba(160,210,255,0.9)';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(lx, ly);
        g.stroke();
        const a = Math.atan2(ly - py, lx - px);
        g.beginPath();
        g.moveTo(lx, ly);
        g.lineTo(lx - Math.cos(a - 0.5) * 9, ly - Math.sin(a - 0.5) * 9);
        g.moveTo(lx, ly);
        g.lineTo(lx - Math.cos(a + 0.5) * 9, ly - Math.sin(a + 0.5) * 9);
        g.stroke();
        if (this.labels) {
          g.fillStyle = '#bfe3ff';
          g.font = '800 10px sans-serif';
          g.textAlign = 'center';
          g.fillText('SHOWER', px, py);
          g.textAlign = 'left';
        }
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
      const r = this.labels ? 6 : 3.5;
      g.fillStyle = color;
      g.fillRect(px - r, py - r, r * 2, r * 2);
      if (!this.labels) return;
      g.fillStyle = '#fff';
      g.font = '800 11px sans-serif';
      g.fillText(label, px, py - 14);
    };
    const start = s[Math.round(st.startDistance)];
    flag(start.x, start.z, '#d8261c', 'START');
    for (const cp of st.checkpoints) flag(cp.x, cp.z, cp.index < checkpointsPassed ? '#2fd27a' : '#ff8a00', `CP${cp.index + 1}`);
    const fin = s[Math.round(st.finishDistance)];
    flag(fin.x, fin.z, '#ffffff', 'FINISH');


    // AI opponents
    if (t?.ai) {
      const colors = ['#1e5bc6', '#1f8a4c', '#f0b400', '#e11d48', '#a855f7', '#22d3ee', '#f97316'];
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
