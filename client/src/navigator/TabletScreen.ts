import type { MapView } from './MapView';
import { FUSES, FUSE_COST, type CarSystems } from '@cdr/shared';

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
  /** The driver's car systems (null before telemetry arrives). */
  sys: CarSystems | null;
  /** Surface ahead, for picking tyre pressures. */
  nextSurface: string | null;
  nextSurfaceIn: number | null;
  /** A warning to call to the driver (obstacle / shower / fog ahead). */
  alert: string | null;
}

export type TabletButton = 'follow' | 'full';
/** The buttons on the car-systems panel in the co-driver's side of the dash. */
export type PanelButton =
  | 'flaps'
  | 'als'
  | `map${0 | 1 | 2}`
  | `tyre${0 | 1 | 2}`
  | `fuse${0 | 1 | 2 | 3 | 4 | 5}`
  | 'boost'
  | 'fix'
  | `bolt${0 | 1 | 2 | 3 | 4 | 5}`;
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
  private blink = 0;

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
    if (P) sx = this.dot(sx, row2, d.server === 'ok' ? '#2fd27a' : d.server === 'warn' ? '#f0b400' : '#ff4d4d', 'ONLINE') + 18;
    // (landscape: one dot – red if either the server or the driver is gone)
    this.dot(sx, row2, d.driverOk && d.server !== 'bad' ? '#2fd27a' : '#ff4d4d', d.driverLabel);

    this.buttons.clear();
    this.blink = (this.blink + 1) % 12;

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
    if (d.alert && !d.waiting) {
      const red = /TREE|ROCKS|ANIMALS|FUSE|OVERHEAT|FAULT/.test(d.alert);
      const fork = /^FORK/.test(d.alert);
      let fs = P ? 18 : 24;
      g.font = `900 ${fs}px ${FONT}`;
      while (g.measureText(d.alert).width > map.w - 64 && fs > 12) g.font = `900 ${(fs -= 1)}px ${FONT}`;
      const aw = Math.min(map.w - 24, g.measureText(d.alert).width + 40);
      const ay = map.y + (P ? 76 : 76);
      g.fillStyle = red ? (this.blink < 6 ? 'rgba(255,59,78,0.95)' : 'rgba(180,30,45,0.95)') : fork ? 'rgba(150,90,30,0.95)' : 'rgba(30,110,220,0.92)';
      this.round(map.x + 12, ay, aw, P ? 40 : 46, 8);
      g.fill();
      g.fillStyle = '#fff';
      g.textAlign = 'left';
      g.fillText(d.alert, map.x + 32, ay + (P ? 21 : 24), aw - 30);
    }
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
      ['COOLANT', d.sys ? `${Math.round(d.sys.temp)}°C` : '—'],
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
      if (k === 'COOLANT' && d.sys) col = d.sys.temp > 112 ? '#ff4d4d' : d.sys.temp > 104 || d.sys.temp < 62 ? '#f0b400' : '#2fd27a';
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

/** What the systems panel shows (only the co-driver can see it). */
export interface PanelData {
  sys: CarSystems | null;
  /** Surface now and next (for the tyre hint). */
  surface: string;
  nextSurface: string | null;
  nextSurfaceIn: number | null;
  /** Tyre wear 0..100 %. */
  tyreWear: number;
  /** Spare fuses left in the box. */
  fuseSpares: number;
  /** Tyre compound fitted (short name) and spare wheels left. */
  compound: string | null;
  spareWheels: number;
  /** Mechanical failures (names) and whether one can be fixed now. */
  faults: string[];
  canFix: boolean;
  /** Push-to-pass: 0 off, 1 armed, 2 running, 3 used; seconds left. */
  boost: number;
  boostLeft: number;
  /** Engine / gearbox life (championship), 0..1. */
  life: { engine: number; gearbox: number } | null;
  /** The roadside-fix mini-game, while fixing. */
  repair: { title: string; order: number[]; step: number; wait: number } | null;
}

/**
 * The car-systems panel built into the co-driver's side of the dashboard:
 * a coolant gauge, radiator and anti-lag switches, engine map, tyre
 * pressures and the fuse board. It is the only place these are shown – the
 * driver has no read-out, so the co-driver has to call it.
 * Drawn as the face texture of a 3D panel (or flat when there's no 3D).
 */
export class SystemsPanelScreen {
  readonly canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d')!;
  private buttons = new Map<PanelButton, Rect>();
  version = 0;
  private blink = 0;
  private lastKey = '';

  constructor() {
    this.canvas.width = 1024;
    this.canvas.height = 704;
  }

  hit(u: number, v: number): PanelButton | null {
    const x = u * this.canvas.width, y = (1 - v) * this.canvas.height;
    for (const [id, r] of this.buttons) {
      if (x >= r.x - 6 && x <= r.x + r.w + 6 && y >= r.y - 6 && y <= r.y + r.h + 6) return id;
    }
    return null;
  }

  /** Redraws only when something visible changed (returns true if it did). */
  draw(d: PanelData): boolean {
    const s = d.sys;
    const alarm = !!s && (s.fuse >= 0 || s.temp > 112);
    this.blink = (this.blink + 1) % 16;
    const flash = alarm && this.blink < 8;
    const key = s ? `${Math.round(s.temp * 2)}|${s.flaps}|${s.als}|${s.map}|${s.tyres}|${s.fuse}|${flash}|${d.surface}|${d.nextSurface}|${d.nextSurfaceIn === null ? '' : Math.round(d.nextSurfaceIn / 50)}|${d.tyreWear}|${d.fuseSpares}|${d.compound}|${d.spareWheels}|${d.faults.join()}|${d.canFix}|${d.boost}|${Math.ceil(d.boostLeft)}|${d.life ? Math.round(d.life.engine * 100) + '/' + Math.round(d.life.gearbox * 100) : ''}|${d.repair ? d.repair.step + '/' + Math.ceil(d.repair.wait) : ''}` : 'none';
    if (key === this.lastKey) return false;
    this.lastKey = key;
    const g = this.g;
    const W = this.canvas.width, H = this.canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.textBaseline = 'middle';
    // brushed aluminium plate
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#3a3f45');
    bg.addColorStop(1, '#25292e');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 0.06;
    for (let y = 0; y < H; y += 3) {
      g.fillStyle = (y / 3) % 2 ? '#fff' : '#000';
      g.fillRect(0, y, W, 1);
    }
    g.globalAlpha = 1;
    for (const [x, y] of [[16, 16], [W - 16, 16], [16, H - 16], [W - 16, H - 16]]) {
      g.fillStyle = '#15181b';
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#6a7078';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x - 4, y - 4);
      g.lineTo(x + 4, y + 4);
      g.stroke();
    }
    this.buttons.clear();
    if (!s) {
      g.fillStyle = '#9aa4ae';
      g.font = `800 40px ${FONT}`;
      g.textAlign = 'center';
      g.fillText('NO POWER – WAITING FOR THE CAR', W / 2, H / 2);
      this.version++;
      return true;
    }
    const engrave = (text: string, x: number, y: number, size = 24, align: CanvasTextAlign = 'left') => {
      g.font = `800 ${size}px ${FONT}`;
      g.textAlign = align;
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillText(text, x + 1, y + 2);
      g.fillStyle = '#e8ecef';
      g.fillText(text, x, y);
    };
    const button = (id: PanelButton, x: number, y: number, w: number, h: number, label: string, on: boolean, color: string) => {
      g.fillStyle = '#101214';
      this.round(x - 4, y - 4, w + 8, h + 8, 12);
      g.fill();
      g.fillStyle = on ? color : '#2c3136';
      this.round(x, y, w, h, 9);
      g.fill();
      if (on) {
        g.fillStyle = 'rgba(255,255,255,0.25)';
        this.round(x + 4, y + 4, w - 8, h * 0.35, 6);
        g.fill();
      }
      g.fillStyle = on ? '#fff' : '#8d969e';
      let size = 30;
      g.font = `900 ${size}px ${FONT}`;
      while (g.measureText(label).width > w - 14 && size > 16) g.font = `900 ${(size -= 2)}px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(label, x + w / 2, y + h / 2 + 1);
      this.buttons.set(id, { x, y, w, h });
    };
    const well = (x: number, y: number, w: number, h: number) => {
      g.fillStyle = 'rgba(0,0,0,0.28)';
      this.round(x, y, w, h, 14);
      g.fill();
    };

    // ---- coolant gauge (left) ----
    well(28, 28, 300, 340);
    engrave('COOLANT °C', 178, 54, 24, 'center');
    const cx = 178, cy = 200, r = 112;
    g.fillStyle = '#07090b';
    g.beginPath();
    g.arc(cx, cy, r + 14, 0, Math.PI * 2);
    g.fill();
    const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2;
    const ang = (t: number) => a0 + ((Math.min(130, Math.max(40, t)) - 40) / 90) * (a1 - a0);
    for (const [from, to, col] of [[40, 62, '#3d8fe0'], [62, 104, '#26b86a'], [104, 112, '#e0a800'], [112, 130, '#e8303f']] as const) {
      g.strokeStyle = col;
      g.lineWidth = 12;
      g.beginPath();
      g.arc(cx, cy, r - 6, ang(from), ang(to));
      g.stroke();
    }
    g.strokeStyle = '#e8ecef';
    g.fillStyle = '#e8ecef';
    g.font = `800 20px ${FONT}`;
    g.textAlign = 'center';
    for (let t = 40; t <= 130; t += 10) {
      const a = ang(t);
      const big = t % 30 === 10 || t === 130;
      g.lineWidth = big ? 4 : 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r - 16), cy + Math.sin(a) * (r - 16));
      g.lineTo(cx + Math.cos(a) * (r - (big ? 34 : 26)), cy + Math.sin(a) * (r - (big ? 34 : 26)));
      g.stroke();
      if (big) g.fillText(String(t), cx + Math.cos(a) * (r - 54), cy + Math.sin(a) * (r - 54));
    }
    // needle
    const na = ang(s.temp);
    g.strokeStyle = '#ff5a1f';
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - Math.cos(na) * 18, cy - Math.sin(na) * 18);
    g.lineTo(cx + Math.cos(na) * (r - 14), cy + Math.sin(na) * (r - 14));
    g.stroke();
    g.lineCap = 'butt';
    g.fillStyle = '#c9ced3';
    g.beginPath();
    g.arc(cx, cy, 13, 0, Math.PI * 2);
    g.fill();
    // digital read-out + warning lamp
    const hot = s.temp > 112, warm = s.temp > 104 || s.temp < 62;
    g.font = `900 40px ${FONT}`;
    g.textAlign = 'center';
    g.fillStyle = hot ? '#ff3b4e' : warm ? '#f0b400' : '#7dff9e';
    g.fillText(`${Math.round(s.temp)}°`, cx, cy + 74);
    g.fillStyle = hot ? (flash ? '#ff2a3a' : '#5a1218') : '#3a1a1c';
    this.round(68, 328, 220, 30, 8);
    g.fill();
    g.fillStyle = hot ? '#fff' : '#7a5a5c';
    g.font = `900 20px ${FONT}`;
    g.fillText(hot ? 'OVERHEAT' : s.temp < 62 ? 'COLD' : 'TEMP OK', 178, 344);

    // ---- cooling & boost (middle) ----
    well(344, 28, 316, 160);
    engrave('RADIATOR', 360, 54, 22);
    engrave('ANTI-LAG', 512, 54, 22);
    button('flaps', 360, 78, 136, 96, s.flaps ? 'OPEN' : 'SHUT', s.flaps, '#1f7ae0');
    button('als', 512, 78, 132, 96, s.als ? 'ON' : 'OFF', s.als, '#e05a1f');
    // ---- engine map ----
    well(344, 200, 316, 168);
    engrave('ENGINE MAP', 360, 226, 22);
    (['ECO', 'NORM', 'ATTACK'] as const).forEach((l, i) =>
      button(`map${i as 0 | 1 | 2}`, 360 + i * 100, 252, 88, 100, l, s.map === i, i === 2 ? '#d8301f' : i === 0 ? '#2f9d5a' : '#d0901a'),
    );
    // ---- tyres (right) ----
    well(676, 28, 320, 340);
    engrave(d.compound ? `TYRES: ${d.compound}` : 'TYRE PRESSURE', 692, 54, 22);
    (['LOW', 'MID', 'HIGH'] as const).forEach((l, i) => button(`tyre${i as 0 | 1 | 2}`, 692 + i * 100, 78, 88, 96, l, s.tyres === i, '#2c8fd0'));
    const best = (surf: string) => (/tarmac|wood|bridge/i.test(surf) ? 'HIGH' : 'LOW');
    g.font = `800 22px ${FONT}`;
    g.textAlign = 'left';
    g.fillStyle = '#cfd6dd';
    g.fillText(`NOW: ${d.surface.toUpperCase()} → ${best(d.surface)}`, 692, 200);
    if (d.nextSurface && d.nextSurfaceIn !== null) {
      g.fillStyle = '#9fe0ff';
      g.fillText(`${d.nextSurface.toUpperCase()} IN ${Math.max(0, Math.round(d.nextSurfaceIn / 10) * 10)} m → ${best(d.nextSurface)}`, 692, 232);
    } else {
      g.fillStyle = '#7a848d';
      g.fillText('NO CHANGE AHEAD', 692, 232);
    }
    // tyre wear: grip drops as the rubber goes
    engrave('TYRE WEAR', 692, 280, 22);
    const wr = Math.min(100, Math.max(0, d.tyreWear));
    g.fillStyle = '#101214';
    this.round(692, 300, 288, 34, 8);
    g.fill();
    g.fillStyle = wr > 60 ? '#e8303f' : wr > 35 ? '#e0a800' : '#26b86a';
    this.round(696, 304, Math.max(8, (280 * wr) / 100), 26, 6);
    g.fill();
    g.font = `900 24px ${FONT}`;
    g.textAlign = 'right';
    g.fillStyle = '#fff';
    g.fillText(`${Math.round(wr)}%`, 972, 280);
    g.font = `700 18px ${FONT}`;
    g.textAlign = 'left';
    g.fillStyle = '#9aa4ae';
    g.fillText(wr > 60 ? 'WORN – LESS GRIP, TELL THE DRIVER' : 'Sliding wears them fast', 692, 352);

    // ---- fuse board (bottom) ----
    well(28, 384, W - 56, 164);
    const spares = `SPARES: ${d.fuseSpares} ($${FUSE_COST} EACH)`;
    engrave(s.fuse >= 0 ? (d.fuseSpares > 0 ? 'FUSE BLOWN – TAP IT TO FIT A SPARE' : 'FUSE BLOWN – NO SPARES LEFT!') : 'FUSES', 44, 408, 22);
    g.font = `800 22px ${FONT}`;
    g.textAlign = 'right';
    g.fillStyle = d.fuseSpares > 0 ? '#e8ecef' : '#ff8a8f';
    g.fillText(spares, W - 44, 408);
    const fw = (W - 56 - 32 - 5 * 14) / 6;
    FUSES.forEach((name, i) => {
      const fx = 44 + i * (fw + 14), fy = 428;
      const blown = s.fuse === i;
      g.fillStyle = '#121416';
      this.round(fx, fy, fw, 104, 10);
      g.fill();
      // blade fuse body
      g.fillStyle = blown ? (flash ? '#ff2a3a' : '#5a1218') : ['#e8b400', '#2f7fe8', '#26b86a', '#ef6c1a', '#a65be8', '#c9ced3'][i];
      this.round(fx + fw / 2 - 26, fy + 10, 52, 46, 6);
      g.fill();
      g.fillStyle = '#b0b6bc';
      g.fillRect(fx + fw / 2 - 18, fy + 56, 10, 12);
      g.fillRect(fx + fw / 2 + 8, fy + 56, 10, 12);
      if (blown) {
        g.strokeStyle = '#fff';
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(fx + fw / 2 - 14, fy + 22);
        g.lineTo(fx + fw / 2 + 14, fy + 44);
        g.moveTo(fx + fw / 2 + 14, fy + 22);
        g.lineTo(fx + fw / 2 - 14, fy + 44);
        g.stroke();
      }
      g.fillStyle = blown ? '#ff8a8f' : '#e8ecef';
      g.font = `900 20px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(name, fx + fw / 2, fy + 88);
      this.buttons.set(`fuse${i as 0 | 1 | 2 | 3 | 4 | 5}`, { x: fx, y: fy, w: fw, h: 104 });
    });
    // ---- push-to-pass, faults, engine life (bottom row) ----
    well(28, 562, 290, 126);
    engrave('PUSH-TO-PASS', 44, 588, 22);
    const bl = d.boost === 0 ? 'ARM BOOST' : d.boost === 1 ? 'ARMED – DRIVER: B' : d.boost === 2 ? `BOOST ${Math.ceil(d.boostLeft)} s` : 'USED';
    button('boost', 44, 608, 258, 64, bl, d.boost === 1 || d.boost === 2, d.boost === 2 ? '#ff4b1f' : '#d0901a');
    well(334, 562, 420, 126);
    engrave(d.faults.length ? 'FAULTS' : 'NO FAULTS', 350, 588, 22);
    g.textAlign = 'right';
    g.font = `800 20px ${FONT}`;
    g.fillStyle = d.spareWheels > 0 ? '#cfd6dd' : '#ff8a8f';
    g.fillText(`SPARE WHEEL: ${d.spareWheels}`, 738, 588);
    g.textAlign = 'left';
    d.faults.slice(0, 2).forEach((f, i) => {
      g.fillStyle = flash ? '#ff3b4e' : '#ff8a8f';
      g.font = `900 20px ${FONT}`;
      g.fillText(`● ${f}`, 350, 618 + i * 26);
    });
    if (d.faults.length) button('fix', 576, 642, 162, 38, d.canFix ? 'ROADSIDE FIX' : 'STOP TO FIX', d.canFix, '#c0392b');
    well(770, 562, 226, 126);
    engrave('ENGINE · GEARBOX', 786, 588, 20);
    if (d.life) {
      const lifeBar = (label: string, v: number, y: number) => {
        g.font = `800 18px ${FONT}`;
        g.fillStyle = '#cfd6dd';
        g.fillText(label, 786, y + 12);
        g.fillStyle = '#101214';
        this.round(870, y, 112, 22, 5);
        g.fill();
        g.fillStyle = v < 0.4 ? '#e8303f' : v < 0.7 ? '#e0a800' : '#26b86a';
        this.round(872, y + 2, Math.max(4, 108 * v), 18, 4);
        g.fill();
      };
      lifeBar('ENGINE', d.life.engine, 610);
      lifeBar('BOX', d.life.gearbox, 646);
    } else {
      g.font = `700 17px ${FONT}`;
      g.fillStyle = '#7a848d';
      g.fillText('Fresh for this event', 786, 628);
    }

    // ---- the roadside fix: tap the bolts as they light up ----
    if (d.repair) {
      const rp = d.repair;
      g.fillStyle = 'rgba(6,8,10,0.97)';
      g.fillRect(0, 0, W, H);
      this.buttons.clear();
      engrave(`ROADSIDE FIX – ${rp.title}`, W / 2, 48, 30, 'center');
      g.font = `700 20px ${FONT}`;
      g.fillStyle = '#9aa4ae';
      g.textAlign = 'center';
      g.fillText(rp.step < rp.order.length ? 'Tap the bolt that lights up – quickly!' : rp.wait > 0 ? `Tightening up… ${Math.ceil(rp.wait)} s` : 'Done – tell the driver to go!', W / 2, 84);
      const cx = W / 2, cy = 400, R = 210;
      rp.order.forEach((_, k) => {
        const a = (k / rp.order.length) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R * 0.95;
        const lit = rp.step < rp.order.length && rp.order[rp.step] === k;
        const done = rp.order.indexOf(k) < rp.step;
        g.fillStyle = lit ? '#ffd23a' : done ? '#26b86a' : '#3a4048';
        g.beginPath();
        g.arc(x, y, 52, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#111';
        g.lineWidth = 8;
        g.beginPath();
        for (let q = 0; q < 6; q++) {
          const b = (q / 6) * Math.PI * 2;
          g[q ? 'lineTo' : 'moveTo'](x + Math.cos(b) * 26, y + Math.sin(b) * 26);
        }
        g.closePath();
        g.stroke();
        this.buttons.set(`bolt${k as 0 | 1 | 2 | 3 | 4 | 5}`, { x: x - 56, y: y - 56, w: 112, h: 112 });
      });
      g.font = `900 40px ${FONT}`;
      g.fillStyle = '#fff';
      g.fillText(`${Math.min(rp.step, rp.order.length)} / ${rp.order.length}`, cx, cy + 14);
    }

    this.version++;
    return true;
  }

  private round(x: number, y: number, w: number, h: number, r: number) {
    this.g.beginPath();
    this.g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  }
}
