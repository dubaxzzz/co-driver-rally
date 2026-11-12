import type { MapView } from './MapView';
import { FUSES, type CarSystems } from '@cdr/shared';

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

export type TabletButton =
  | 'follow'
  | 'full'
  | 'tab-map'
  | 'tab-car'
  | 'flaps'
  | 'als'
  | `map${0 | 1 | 2}`
  | `tyre${0 | 1 | 2}`
  | `fuse${0 | 1 | 2 | 3 | 4 | 5}`;
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
  /** Which page is showing: the stage map or the car's systems. */
  page: 'map' | 'car' = 'map';
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

    // page tabs (top right, left of the timer)
    this.buttons.clear();
    this.blink = (this.blink + 1) % 12;
    const alarm = !!d.sys && (d.sys.fuse >= 0 || d.sys.temp > 108);
    {
      g.font = `900 ${P ? 22 : 24}px ${FONT}`;
      const tw = P ? 100 : 120, th = P ? 44 : 48;
      let tx = P ? W - 18 - tw * 2 - 8 : W - 26 - 210 - tw * 2 - 16;
      const ty = P ? 72 : (HH - th) / 2;
      for (const [id, label] of [['tab-map', 'MAP'], ['tab-car', 'CAR']] as const) {
        const sel = (id === 'tab-map') === (this.page === 'map');
        const flash = id === 'tab-car' && alarm && !sel && this.blink < 6;
        g.fillStyle = flash ? '#ff3b4e' : sel ? ACCENT : 'rgba(255,255,255,0.08)';
        this.round(tx, ty, tw, th, 8);
        g.fill();
        g.fillStyle = '#fff';
        g.textAlign = 'center';
        g.fillText(label + (id === 'tab-car' && alarm ? ' !' : ''), tx + tw / 2, ty + th / 2 + 1);
        this.buttons.set(id, { x: tx, y: ty, w: tw, h: th });
        tx += tw + 8;
      }
    }
    if (this.page === 'car') {
      this.drawCarPage(d, HH);
      this.version++;
      return;
    }

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
      const red = /TREE|ROCKS|ANIMALS/.test(d.alert);
      g.font = `900 ${P ? 18 : 24}px ${FONT}`;
      const aw = Math.min(map.w - 24, g.measureText(d.alert).width + 40);
      const ay = map.y + (P ? 76 : 76);
      g.fillStyle = red ? (this.blink < 6 ? 'rgba(255,59,78,0.95)' : 'rgba(180,30,45,0.95)') : 'rgba(30,110,220,0.92)';
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

  /** The CAR page: coolant gauge, radiator, anti-lag, engine map, tyre pressures, fuse board. */
  private drawCarPage(d: TabletData, HH: number) {
    const g = this.g;
    const W = this.canvas.width, H = this.canvas.height;
    const P = this.portrait;
    const pad = P ? 16 : 22;
    const s = d.sys;
    if (!s) {
      g.fillStyle = '#9aa4ae';
      g.font = `700 26px ${FONT}`;
      g.textAlign = 'center';
      g.fillText('Waiting for the car…', W / 2, H / 2);
      return;
    }
    const panel = (x: number, y: number, w: number, h: number, title: string) => {
      g.fillStyle = 'rgba(255,255,255,0.045)';
      this.round(x, y, w, h, 12);
      g.fill();
      g.fillStyle = '#8b96a1';
      g.font = `800 ${P ? 17 : 20}px ${FONT}`;
      g.textAlign = 'left';
      g.fillText(title, x + 18, y + 26);
    };
    const button = (id: TabletButton, x: number, y: number, w: number, h: number, label: string, on: boolean, color = ACCENT) => {
      g.fillStyle = on ? color : 'rgba(255,255,255,0.07)';
      this.round(x, y, w, h, 10);
      g.fill();
      g.strokeStyle = on ? color : 'rgba(255,255,255,0.18)';
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = '#fff';
      g.font = `900 ${P ? 20 : 24}px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(label, x + w / 2, y + h / 2 + 1);
      this.buttons.set(id, { x, y, w, h });
    };
    // layout: two columns (landscape) or stacked (portrait)
    const colW = P ? W - pad * 2 : (W - pad * 3) / 2;
    const x1 = pad, x2 = P ? pad : pad * 2 + colW;
    const top = HH + pad;
    // ---- coolant gauge ----
    const gH = P ? 200 : 330;
    panel(x1, top, colW, gH, 'COOLANT TEMPERATURE');
    const cx = x1 + colW / 2, cy = top + gH * 0.56, r = Math.min(colW * 0.3, gH * 0.34);
    const a0 = Math.PI * 0.85, a1 = Math.PI * 2.15;
    const ang = (t: number) => a0 + ((Math.min(130, Math.max(40, t)) - 40) / 90) * (a1 - a0);
    for (const [from, to, col] of [[40, 62, '#4aa3ff'], [62, 104, '#2fd27a'], [104, 112, '#f0b400'], [112, 130, '#ff3b4e']] as const) {
      g.strokeStyle = col;
      g.lineWidth = 16;
      g.beginPath();
      g.arc(cx, cy, r, ang(from), ang(to));
      g.stroke();
    }
    g.strokeStyle = '#fff';
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(ang(s.temp)) * (r - 6), cy + Math.sin(ang(s.temp)) * (r - 6));
    g.stroke();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(cx, cy, 10, 0, Math.PI * 2);
    g.fill();
    g.textAlign = 'center';
    g.font = `900 ${P ? 40 : 48}px ${FONT}`;
    g.fillStyle = s.temp > 112 ? '#ff3b4e' : s.temp > 104 || s.temp < 62 ? '#f0b400' : '#fff';
    g.fillText(`${Math.round(s.temp)}°C`, cx, cy + r * 0.62);
    g.font = `700 ${P ? 16 : 18}px ${FONT}`;
    g.fillStyle = '#9aa4ae';
    const advice = s.temp > 110 ? 'TOO HOT – open radiator, ECO map, anti-lag off' : s.temp < 62 ? 'TOO COLD – shut the radiator' : s.temp > 104 ? 'Getting hot – open the radiator' : 'Good working temperature';
    g.fillText(advice, cx, top + gH - 16);
    // ---- radiator + anti-lag ----
    const tY = top + gH + pad;
    const tH = P ? 110 : 150;
    panel(x1, tY, colW, tH, 'COOLING & BOOST');
    const bw = (colW - 54) / 2, bh = P ? 56 : 70, by = tY + (P ? 44 : 56);
    button('flaps', x1 + 18, by, bw, bh, s.flaps ? 'RADIATOR OPEN' : 'RADIATOR SHUT', s.flaps, '#1f7ae0');
    button('als', x1 + 36 + bw, by, bw, bh, s.als ? 'ANTI-LAG ON' : 'ANTI-LAG OFF', s.als, '#e05a1f');
    // ---- tips (landscape has room under the cooling panel) ----
    if (!P) {
      const kY = tY + tH + pad;
      const kH = H - kY - pad;
      panel(x1, kY, colW, kH, 'CO-DRIVER TIPS');
      g.font = `600 18px ${FONT}`;
      g.fillStyle = '#cfd6dd';
      g.textAlign = 'left';
      [
        'Open the radiator on long climbs, shut it in snow and cold.',
        'ATTACK + ANTI-LAG is fastest – and hottest. Watch the gauge.',
        'Tyres: LOW on gravel, mud and snow; HIGH on tarmac.',
        'A blown fuse kills lights, wipers or the fan – replace it fast.',
      ].forEach((t, i) => g.fillText('• ' + t, x1 + 18, kY + 58 + i * 30));
    }
    // ---- engine map ----
    const rTop = P ? tY + tH + pad : top;
    const mH = P ? 100 : 150;
    panel(x2, rTop, colW, mH, 'ENGINE MAP');
    const sw3 = (colW - 36 - 24) / 3;
    (['ECO', 'NORMAL', 'ATTACK'] as const).forEach((l, i) =>
      button(`map${i as 0 | 1 | 2}`, x2 + 18 + i * (sw3 + 12), rTop + (P ? 40 : 56), sw3, P ? 54 : 70, l, s.map === i, i === 2 ? '#e0311f' : i === 0 ? '#2f9d5a' : ACCENT),
    );
    // ---- tyre pressures ----
    const pY = rTop + mH + pad;
    const pH = P ? 125 : 180;
    panel(x2, pY, colW, pH, 'TYRE PRESSURES');
    (['LOW', 'MID', 'HIGH'] as const).forEach((l, i) => button(`tyre${i as 0 | 1 | 2}`, x2 + 18 + i * (sw3 + 12), pY + (P ? 40 : 56), sw3, P ? 54 : 70, l, s.tyres === i));
    g.font = `700 ${P ? 15 : 18}px ${FONT}`;
    g.fillStyle = '#cfd6dd';
    g.textAlign = 'left';
    const best = (surf: string) => (surf === 'TARMAC' || surf === 'WOOD' ? 'HIGH' : 'LOW');
    const now = d.surface.toUpperCase();
    let line = `On ${now}: ${best(now)} is fastest`;
    if (d.nextSurface && d.nextSurfaceIn !== null) line += ` · ${d.nextSurface.toUpperCase()} in ${Math.round(d.nextSurfaceIn)} m`;
    g.fillText(line, x2 + 18, pY + pH - 22);
    // ---- fuse board ----
    const fY = pY + pH + pad;
    const fH = H - fY - pad;
    panel(x2, fY, colW, fH, s.fuse >= 0 ? 'FUSE BOARD – A FUSE HAS BLOWN! TAP IT TO REPLACE' : 'FUSE BOARD');
    const fw = (colW - 36 - 5 * 10) / 6, fh = Math.max(40, fH - (P ? 52 : 64));
    FUSES.forEach((name, i) => {
      const fx = x2 + 18 + i * (fw + 10), fy = fY + (P ? 40 : 48);
      const blown = s.fuse === i;
      g.fillStyle = blown ? (this.blink < 6 ? '#ff3b4e' : '#5a1218') : '#2a2f36';
      this.round(fx, fy, fw, fh, 8);
      g.fill();
      g.fillStyle = blown ? '#fff' : ['#f0b400', '#3a8dff', '#2fd27a', '#ff7a1a', '#c86bff', '#cfd6dd'][i];
      g.fillRect(fx + fw * 0.3, fy + 8, fw * 0.4, Math.max(8, fh - 40));
      g.fillStyle = '#fff';
      g.font = `800 ${P ? 11 : 14}px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(name, fx + fw / 2, fy + fh - 14);
      this.buttons.set(`fuse${i as 0 | 1 | 2 | 3 | 4 | 5}`, { x: fx, y: fy, w: fw, h: fh });
    });
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
