import type { MapView } from './MapView';

/** Everything the co-driver's tablet shows. */
export interface TabletData {
  code: string;
  phase: string;
  timer: string;
  server: 'ok' | 'warn' | 'bad';
  driverOk: boolean;
  driverLabel: string;
  stageName: string;
  weatherName: string;
  waiting: boolean;
  mapStatus: string;
  speed: string;
  speedUnit: string;
  gear: string;
  rpm: string;
  pct: number;
  remain: string;
  cps: string;
  surface: string;
  damage: string;
  /** 0 = fine, 1 = worn, 2 = badly damaged */
  damageLevel: 0 | 1 | 2;
}

export type TabletButton = 'follow' | 'full';
interface Rect { x: number; y: number; w: number; h: number }

const ACCENT = '#ff4b1f';
const FONT = '"Inter", "Segoe UI", system-ui, sans-serif';

/**
 * Draws the co-driver's tablet screen (header, live stage map, car data) onto
 * one canvas. The canvas is used as the texture of the physical tablet in the
 * 3D passenger seat – or shown flat when the device cannot do 3D.
 */
export class TabletScreen {
  readonly canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d')!;
  private buttons = new Map<TabletButton, Rect>();
  /** Bumped every redraw so the 3D view knows to re-upload the texture. */
  version = 0;
  portrait = false;

  constructor(private map: MapView) {
    this.setPortrait(false);
  }

  setPortrait(p: boolean) {
    this.portrait = p;
    // portrait is shown much smaller (phones), so it uses fewer, bigger pixels
    this.canvas.width = p ? 600 : 1280;
    this.canvas.height = p ? 936 : 800;
  }

  /** Which drawn button (if any) is at texture coordinates (u, v), v = 0 at the bottom. */
  hit(u: number, v: number): TabletButton | null {
    const x = u * this.canvas.width, y = (1 - v) * this.canvas.height;
    for (const [id, r] of this.buttons) {
      if (x >= r.x - 8 && x <= r.x + r.w + 8 && y >= r.y - 8 && y <= r.y + r.h + 8) return id;
    }
    return null;
  }

  draw(d: TabletData) {
    const g = this.g;
    const W = this.canvas.width, H = this.canvas.height;
    const P = this.portrait;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.textBaseline = 'middle';
    // background: dark glass with a faint vignette
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#11161b');
    bg.addColorStop(1, '#07090c');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    // ---------- header ----------
    const HH = P ? 128 : 76;
    g.fillStyle = '#0b0e12';
    g.fillRect(0, 0, W, HH);
    g.fillStyle = ACCENT;
    g.fillRect(0, HH - 3, W, 3);
    let x = P ? 18 : 26;
    const row1 = P ? 40 : HH / 2;
    g.textAlign = 'left';
    if (!P) {
      g.font = `italic 900 30px ${FONT}`;
      g.fillStyle = ACCENT;
      g.fillText('CO-', x, row1);
      x += g.measureText('CO-').width;
      g.fillStyle = '#fff';
      g.fillText('DRIVER', x, row1);
      x += g.measureText('DRIVER').width + 26;
    }
    x = this.chip(x, row1, 'ROOM ' + d.code, '#2a3138', '#fff');
    x = this.chip(x + 10, row1, d.phase, d.phase === 'RACING' ? '#1d6b3f' : d.phase === 'COUNTDOWN' ? '#7a5a10' : '#2a3138', '#fff');
    // timer, right aligned
    g.textAlign = 'right';
    g.font = `800 ${P ? 44 : 40}px ${FONT}`;
    g.fillStyle = '#fff';
    g.fillText(d.timer, W - (P ? 18 : 26), row1 + 1);
    // second line (portrait) or continues (landscape): connection dots
    const row2 = P ? 94 : row1;
    let sx = P ? 18 : x + 18;
    g.textAlign = 'left';
    sx = this.dot(sx, row2, d.server === 'ok' ? '#2fd27a' : d.server === 'warn' ? '#f0b400' : '#ff4d4d', 'ONLINE');
    this.dot(sx + 18, row2, d.driverOk ? '#2fd27a' : '#ff4d4d', d.driverLabel);

    // ---------- layout ----------
    const pad = P ? 16 : 22;
    const map: Rect = P
      ? { x: pad, y: HH + pad, w: W - pad * 2, h: Math.round(H * 0.5) }
      : { x: pad, y: HH + pad, w: Math.round(W * 0.64), h: H - HH - pad * 2 };
    const data: Rect = P
      ? { x: pad, y: map.y + map.h + pad, w: W - pad * 2, h: H - (map.y + map.h + pad) - pad }
      : { x: map.x + map.w + pad, y: HH + pad, w: W - (map.x + map.w + pad) - pad, h: H - HH - pad * 2 };

    // ---------- map ----------
    const scale = P ? 1.25 : 1.6;
    this.map.pixelScale = scale;
    this.map.size = { w: map.w / scale, h: map.h / scale };
    this.map.draw(this.lastT, this.lastCps);
    g.save();
    this.round(map.x, map.y, map.w, map.h, 14);
    g.clip();
    g.drawImage(this.map.canvas, map.x, map.y, map.w, map.h);
    // map buttons
    this.buttons.clear();
    let bx = map.x + 14;
    for (const [id, label] of [['follow', 'FOLLOW'], ['full', 'FULL STAGE']] as const) {
      g.font = `800 22px ${FONT}`;
      const bw = g.measureText(label).width + 36;
      const r = { x: bx, y: map.y + 14, w: bw, h: 50 };
      const sel = this.map.mode === id;
      g.fillStyle = sel ? ACCENT : 'rgba(10,13,16,0.82)';
      this.round(r.x, r.y, r.w, r.h, 8);
      g.fill();
      g.strokeStyle = sel ? ACCENT : 'rgba(255,255,255,0.25)';
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 1);
      this.buttons.set(id, r);
      bx += bw + 10;
    }
    // status, bottom-left
    g.font = `700 20px ${FONT}`;
    g.textAlign = 'left';
    const sw = g.measureText(d.mapStatus).width + 24;
    g.fillStyle = 'rgba(0,0,0,0.7)';
    g.fillRect(map.x + 12, map.y + map.h - 50, sw, 38);
    g.fillStyle = '#cfd6dd';
    g.fillText(d.mapStatus, map.x + 24, map.y + map.h - 31);
    if (d.waiting) {
      g.fillStyle = 'rgba(4,6,8,0.78)';
      g.fillRect(map.x, map.y, map.w, map.h);
      g.textAlign = 'center';
      g.fillStyle = '#fff';
      g.font = `900 ${P ? 34 : 42}px ${FONT}`;
      g.fillText(d.stageName.toUpperCase(), map.x + map.w / 2, map.y + map.h / 2 - 34);
      g.font = `700 24px ${FONT}`;
      g.fillStyle = '#9aa4ae';
      g.fillText(d.weatherName.toUpperCase(), map.x + map.w / 2, map.y + map.h / 2 + 8);
      g.fillStyle = ACCENT;
      g.font = `700 22px ${FONT}`;
      g.fillText('Waiting for the driver to start the stage…', map.x + map.w / 2, map.y + map.h / 2 + 52);
    }
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    g.lineWidth = 2;
    this.round(map.x, map.y, map.w, map.h, 14);
    g.stroke();

    // ---------- data ----------
    const cells: Array<[string, string, string?]> = [
      ['SPEED', d.speed, d.speedUnit],
      ['GEAR', d.gear],
      ['RPM', d.rpm],
      ['PROGRESS', `${Math.round(d.pct)}%`],
      ['REMAINING', d.remain],
      ['CHECKPOINTS', d.cps],
      ['SURFACE', d.surface],
      ['DAMAGE', d.damage],
    ];
    const cols = P ? 3 : 2;
    const rows = Math.ceil(cells.length / cols);
    const barH = 18;
    const gap = 12;
    const cw = (data.w - gap * (cols - 1)) / cols;
    const ch = (data.h - barH - gap * rows) / rows;
    cells.forEach(([k, v, unit], i) => {
      const cx = data.x + (i % cols) * (cw + gap);
      const cy = data.y + Math.floor(i / cols) * (ch + gap);
      g.fillStyle = 'rgba(255,255,255,0.045)';
      this.round(cx, cy, cw, ch, 10);
      g.fill();
      g.fillStyle = i === 0 ? ACCENT : 'rgba(255,255,255,0.18)';
      g.fillRect(cx, cy + 12, 4, ch - 24);
      g.textAlign = 'left';
      g.fillStyle = '#8b96a1';
      let ks = P ? 18 : 20;
      g.font = `800 ${ks}px ${FONT}`;
      while (g.measureText(k).width > cw - 30 && ks > 12) g.font = `800 ${(ks -= 1)}px ${FONT}`;
      g.fillText(k, cx + 18, cy + 28);
      let col = '#fff';
      if (k === 'DAMAGE') col = d.damageLevel === 2 ? '#ff4d4d' : d.damageLevel === 1 ? '#f0b400' : '#2fd27a';
      g.fillStyle = col;
      let size = P ? 34 : 46;
      g.font = `900 ${size}px ${FONT}`;
      while (g.measureText(v).width > cw - 36 - (unit ? 50 : 0) && size > 18) g.font = `900 ${(size -= 2)}px ${FONT}`;
      const vy = cy + ch / 2 + 18;
      g.fillText(v, cx + 18, vy);
      if (unit) {
        const vw = g.measureText(v).width;
        g.font = `700 20px ${FONT}`;
        g.fillStyle = '#8b96a1';
        g.fillText(unit, cx + 26 + vw, vy + 8);
      }
    });
    // progress bar
    const by = data.y + data.h - barH;
    g.fillStyle = 'rgba(255,255,255,0.08)';
    this.round(data.x, by, data.w, barH, barH / 2);
    g.fill();
    const pw = Math.max(barH, (data.w * Math.min(100, Math.max(0, d.pct))) / 100);
    const grad = g.createLinearGradient(data.x, 0, data.x + data.w, 0);
    grad.addColorStop(0, ACCENT);
    grad.addColorStop(1, '#ffb020');
    g.fillStyle = grad;
    this.round(data.x, by, pw, barH, barH / 2);
    g.fill();

    this.version++;
  }

  private lastT: Parameters<MapView['draw']>[0] = null;
  private lastCps = 0;
  /** The map state to draw on the next `draw`. */
  setMapState(t: Parameters<MapView['draw']>[0], checkpointsPassed: number) {
    this.lastT = t;
    this.lastCps = checkpointsPassed;
  }

  private chip(x: number, y: number, text: string, bg: string, fg: string) {
    const g = this.g;
    g.font = `800 20px ${FONT}`;
    g.textAlign = 'left';
    const w = g.measureText(text).width + 24;
    g.fillStyle = bg;
    this.round(x, y - 18, w, 36, 6);
    g.fill();
    g.fillStyle = fg;
    g.fillText(text, x + 12, y + 1);
    return x + w;
  }

  private dot(x: number, y: number, color: string, text: string) {
    const g = this.g;
    g.fillStyle = color;
    g.beginPath();
    g.arc(x + 8, y, 8, 0, Math.PI * 2);
    g.fill();
    g.font = `800 20px ${FONT}`;
    g.textAlign = 'left';
    g.fillStyle = '#cfd6dd';
    g.fillText(text, x + 24, y + 1);
    return x + 24 + g.measureText(text).width;
  }

  private round(x: number, y: number, w: number, h: number, r: number) {
    const g = this.g;
    g.beginPath();
    g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  }
}
