/**
 * A completely different dashboard for every car, each with working gauges
 * and clickable switches:
 *  - Sparrow R2   classic: chrome toggles, twin analogue dials, ignition key
 *  - Kestrel R5   modern rally: digital cluster, guarded toggle bank, big START
 *  - Dune Raider  rugged truck: four round gauges, rocker switches, grab handle
 *  - Bruno 300    80s Group B: orange tacho + LCD, satellite button pods
 *  - Vortex RX    Rally1: wide screen, glowing touch tiles
 * The navigator gets a trip computer on their side of every dash.
 */
import * as THREE from 'three';
import type { CarModelId, CarSwitches } from '@cdr/shared';
import { ControlFactory, type Control, type ControlStyle } from './Controls';

export interface DashState {
  speed: number; // m/s
  rpm: number;
  maxRpm: number;
  gear: number;
  unit: 'kmh' | 'mph';
  sw: CarSwitches;
  engineDamage: number;
  tripKm: number;
  watchMs: number;
  watchRunning: boolean;
  time: number;
}

export interface Dashboard {
  controls: Control[];
  update(s: DashState): void;
  /** Where the steering wheel hub sits (the horn) – the cockpit builds the wheel. */
  wheelStyle: 'three' | 'two' | 'four' | 'flat';
  dashColor: number;
}

type Track = <T extends { dispose(): void }>(o: T) => T;
type P = [number, number];

const DX = 0.37; // driver x (left-hand drive: driver on +X)

function sideExtrude(pts: P[], width: number) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2 });
  g.rotateY(-Math.PI / 2);
  g.translate(width / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

export function buildDashboard(model: CarModelId, group: THREE.Group, track: Track): Dashboard {
  const f = new ControlFactory(track);
  const mat = (o: THREE.MeshStandardMaterialParameters) => track(new THREE.MeshStandardMaterial(o));
  const controls: Control[] = [];
  const updaters: Array<(s: DashState) => void> = [];
  const add = <T extends THREE.Object3D>(o: T, parent: THREE.Object3D = group) => (parent.add(o), o);
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = group) => {
    const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), m);
    mesh.position.set(x, y, z);
    return add(mesh, parent);
  };

  /** A flat panel facing the crew; children use x = right, y = up, +z = towards the crew. */
  const panel = (x: number, y: number, z: number, w: number, h: number, tilt: number, m: THREE.Material | null, parent: THREE.Object3D = group, scale = 1) => {
    const outer = new THREE.Group();
    // sit proud of the dash face (the dash mesh is bevelled towards the crew)
    outer.position.set(x, y, z - 0.04);
    outer.rotation.y = Math.PI;
    outer.scale.setScalar(scale);
    const inner = new THREE.Group();
    inner.rotation.x = -tilt;
    outer.add(inner);
    parent.add(outer);
    if (m) {
      const back = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, 0.012)), m);
      back.position.z = -0.006;
      inner.add(back);
    }
    return inner;
  };

  /** Switch panels are drawn bigger so they're easy to see and click. */
  const SW = 1.45;
  const swPanel = (x: number, y: number, z: number, w: number, h: number, tilt: number, m: THREE.Material | null) => panel(x, y, z, w, h, tilt, m, group, SW);

  /** Canvas screen that redraws ~15×/s. */
  const screen = (parent: THREE.Object3D, x: number, y: number, w: number, h: number, px: number, draw: (g: CanvasRenderingContext2D, W: number, H: number, s: DashState) => void) => {
    const c = document.createElement('canvas');
    c.width = px;
    c.height = Math.round((px * h) / w);
    const tex = track(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(track(new THREE.PlaneGeometry(w, h)), track(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })));
    m.position.set(x, y, 0.002);
    parent.add(m);
    let next = 0;
    updaters.push((s) => {
      if (s.time < next) return;
      next = s.time + 1 / 15;
      draw(c.getContext('2d')!, c.width, c.height, s);
      tex.needsUpdate = true;
    });
    return m;
  };

  /** Analogue dial: printed face + a needle that sweeps 270°. */
  const dial = (parent: THREE.Object3D, x: number, y: number, r: number, max: number, labelText: string, value: (s: DashState) => number, look: { face: string; ink: string; needle: number; red?: number; div?: number; glow?: string }) => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(128, 128, 20, 128, 128, 128);
    grd.addColorStop(0, look.face);
    grd.addColorStop(1, '#000');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(128, 128, 126, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#c8ccd0';
    g.lineWidth = 6;
    g.stroke();
    const steps = 10;
    for (let i = 0; i <= steps * 2; i++) {
      const a = (-135 + (270 * i) / (steps * 2)) * (Math.PI / 180) - Math.PI / 2;
      const major = i % 2 === 0;
      const v = (max * i) / (steps * 2);
      g.strokeStyle = look.red && v >= look.red ? '#ff3030' : look.ink;
      g.lineWidth = major ? 5 : 2.5;
      g.beginPath();
      g.moveTo(128 + Math.cos(a) * 112, 128 + Math.sin(a) * 112);
      g.lineTo(128 + Math.cos(a) * (major ? 92 : 102), 128 + Math.sin(a) * (major ? 92 : 102));
      g.stroke();
      if (major) {
        g.fillStyle = look.ink;
        g.font = 'bold 22px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(Math.round(v / (look.div ?? 1))), 128 + Math.cos(a) * 72, 128 + Math.sin(a) * 72);
      }
    }
    g.fillStyle = look.ink;
    g.font = 'bold 18px sans-serif';
    g.fillText(labelText, 128, 178);
    const tex = track(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    const faceMat = track(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const face = new THREE.Mesh(track(new THREE.CircleGeometry(r, 40)), faceMat);
    face.position.set(x, y, 0.001);
    parent.add(face);
    const bezel = new THREE.Mesh(track(new THREE.TorusGeometry(r, r * 0.06, 8, 40)), mat({ color: 0xb8bec4, metalness: 0.9, roughness: 0.25 }));
    bezel.position.set(x, y, 0.003);
    parent.add(bezel);
    const needle = new THREE.Group();
    needle.position.set(x, y, 0.006);
    parent.add(needle);
    const nm = new THREE.Mesh(track(new THREE.BoxGeometry(r * 0.05, r * 0.85, 0.002)), track(new THREE.MeshBasicMaterial({ color: look.needle, toneMapped: false })));
    nm.position.y = r * 0.36;
    needle.add(nm);
    const cap = new THREE.Mesh(track(new THREE.CircleGeometry(r * 0.1, 14)), track(new THREE.MeshBasicMaterial({ color: 0x111111 })));
    cap.position.z = 0.002;
    needle.add(cap);
    let shown = 0;
    updaters.push((s) => {
      const target = s.sw.ignition ? Math.min(max, Math.max(0, value(s))) : 0;
      shown += (target - shown) * 0.35;
      needle.rotation.z = THREE.MathUtils.degToRad(135 - (270 * shown) / max);
      faceMat.color.setScalar(s.sw.ignition ? 1 : 0.35); // backlight off without ignition
    });
  };

  const speedOf = (s: DashState) => Math.abs(s.speed) * 3.6 * (s.unit === 'mph' ? 0.621371 : 1);
  const gearText = (g: number) => (g === -1 ? 'R' : g === 0 ? 'N' : String(g));

  /** Navigator's trip computer: TRIP km + stopwatch, with its buttons. */
  const tripComputer = (parent: THREE.Object3D, style: ControlStyle, look: { bg: string; fg: string; font: string }, mount: THREE.Material, lift = 0) => {
    const p = panel(-DX - 0.02, 0.505 + lift, 0.6, 0.24, 0.13, 0.95, mount, parent, 1.3); // on top of the dash, like a real trip meter
    screen(p, 0, 0.022, 0.2, 0.06, 256, (g, W, H, s) => {
      g.fillStyle = look.bg;
      g.fillRect(0, 0, W, H);
      g.fillStyle = look.fg;
      g.font = `bold 13px ${look.font}`;
      g.textAlign = 'left';
      g.fillText('TRIP', 8, 18);
      g.fillText('WATCH', 8, 54);
      g.textAlign = 'right';
      g.font = `bold 30px ${look.font}`;
      g.fillText(`${Math.max(0, s.tripKm).toFixed(2)}`, W - 30, 32);
      const ms = Math.max(0, s.watchMs);
      const m = Math.floor(ms / 60000);
      const sec = Math.floor((ms % 60000) / 1000);
      const t = Math.floor((ms % 1000) / 100);
      g.font = `bold 26px ${look.font}`;
      g.fillText(`${m}:${String(sec).padStart(2, '0')}.${t}`, W - 30, H - 8);
      g.font = `bold 11px ${look.font}`;
      g.fillText('km', W - 6, 30);
      if (s.watchRunning && Math.floor(s.time * 2) % 2) {
        g.fillStyle = '#ff4040';
        g.beginPath();
        g.arc(W - 14, H - 18, 4, 0, Math.PI * 2);
        g.fill();
      }
    });
    controls.push(f.push(p, 'trip', 'TRIP 0', -0.075, -0.04, style));
    controls.push(f.push(p, 'watch', 'WATCH', -0.025, -0.04, style));
    controls.push(f.push(p, 'watchReset', 'RESET', 0.025, -0.04, style));
    controls.push(f.toggle(p, 'mapLight', 'MAP LT', 0.075, -0.04, style));
  };

  /** Hazard tell-tale that blinks with the hazards. */
  const hazardLamp = (parent: THREE.Object3D, x: number, y: number, size = 0.012) => {
    const m = track(new THREE.MeshBasicMaterial({ color: 0x2a1a00, toneMapped: false }));
    const shape = new THREE.Shape();
    shape.moveTo(0, size);
    shape.lineTo(size * 0.9, -size * 0.6);
    shape.lineTo(-size * 0.9, -size * 0.6);
    shape.closePath();
    const t = new THREE.Mesh(track(new THREE.ShapeGeometry(shape)), m);
    t.position.set(x, y, 0.003);
    parent.add(t);
    updaters.push((s) => m.color.setHex(s.sw.hazards && Math.floor(s.time * 2.4) % 2 ? 0xff9a00 : 0x2a1a00));
  };

  /** Warning lights row: ignition (battery), oil, engine. */
  const telltales = (parent: THREE.Object3D, x: number, y: number) => {
    const lamps: Array<[number, (s: DashState) => boolean]> = [
      [0xff2020, (s) => s.sw.ignition && !s.sw.engine],
      [0xffa000, (s) => s.sw.ignition && (!s.sw.engine || s.engineDamage > 0.5)],
      [0x20a0ff, (s) => s.sw.headlights],
      [0x30ff60, (s) => s.sw.pod],
    ];
    lamps.forEach(([col, on], i) => {
      const m = track(new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false }));
      const c = new THREE.Mesh(track(new THREE.CircleGeometry(0.0055, 10)), m);
      c.position.set(x + i * 0.016, y, 0.003);
      parent.add(c);
      const lit = new THREE.Color(col);
      updaters.push((s) => m.color.copy(on(s) ? lit : new THREE.Color(0x111111)));
    });
  };

  // ======================================================================
  let wheelStyle: Dashboard['wheelStyle'] = 'three';
  let dashColor = 0x24262b;

  if (model === 'sparrow') {
    // ---------------- classic: vinyl dash, chrome strip, twin dials, key
    dashColor = 0x2e2a26;
    wheelStyle = 'three';
    const vinyl = mat({ color: dashColor, roughness: 0.9 });
    const chrome = mat({ color: 0xcfd4d8, metalness: 1, roughness: 0.2 });
    add(new THREE.Mesh(track(sideExtrude([[0.84, 0.18], [0.84, 0.46], [0.62, 0.5], [0.46, 0.46], [0.44, 0.26], [0.52, 0.18]], 1.6)), vinyl));
    box(1.58, 0.012, 0.012, chrome, 0, 0.35, 0.445);
    // binnacle with two big dials
    const hood = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 24, 1, true, 0, Math.PI)), vinyl);
    hood.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    hood.position.set(DX, 0.47, 0.47);
    hood.scale.set(1, 1, 0.55);
    add(hood);
    const bin = panel(DX, 0.43, 0.455, 0.3, 0.12, 0.25, mat({ color: 0x0b0b0b, roughness: 0.9 }));
    const look = { face: '#1a1a1a', ink: '#f0ead8', needle: 0xff5a1a };
    dial(bin, -0.07, 0, 0.052, 200, 'KM/H', speedOf, look);
    dial(bin, 0.07, 0, 0.052, 8000, 'RPM x1000', (s) => s.rpm, { ...look, red: 6500, div: 1000 });
    hazardLamp(bin, 0, 0.035);
    telltales(bin, -0.024, -0.045);
    // centre: chrome toggles + rotary wipers + red start button
    const st: ControlStyle = { plate: 0x111111, cap: 0xd8dde2, led: 0x7cff4a, text: '#e8e2d0' };
    const c = swPanel(-0.13, 0.37, 0.46, 0.42, 0.11, 0.45, mat({ color: 0x14120f, roughness: 0.8 }));
    controls.push(f.toggle(c, 'headlights', 'LIGHTS', -0.16, 0.012, st));
    controls.push(f.toggle(c, 'pod', 'SPOTS', -0.1, 0.012, st));
    controls.push(f.rotary(c, 'wipers', 'WIPERS', -0.03, 0.012, st));
    controls.push(f.toggle(c, 'hazards', 'HAZARD', 0.04, 0.012, st));
    controls.push(f.toggle(c, 'demister', 'DEMIST', 0.1, 0.012, st));
    controls.push(f.toggle(c, 'interior', 'CABIN', 0.16, 0.012, st));
    const k = swPanel(0.66, 0.42, 0.5, 0.12, 0.1, 0.35, mat({ color: 0x14120f, roughness: 0.8 }));
    controls.push(f.key(k, 'ignition', 'IGNITION', -0.025, 0.01, st));
    controls.push(f.push(k, 'start', 'START', 0.03, 0.01, { ...st, cap: 0xc8141c, led: 0xff3030 }));
    tripComputer(group, { ...st, cap: 0x222222 }, { bg: '#0b1408', fg: '#9cff7a', font: 'monospace' }, mat({ color: 0x1a1816, roughness: 0.8 }));
  } else if (model === 'kestrel') {
    // ---------------- modern rally: flat carbon dash, digital cluster, toggle bank
    dashColor = 0x1b1d20;
    wheelStyle = 'flat';
    const carbon = mat({ color: dashColor, roughness: 0.45, metalness: 0.3 });
    add(new THREE.Mesh(track(sideExtrude([[0.84, 0.18], [0.84, 0.45], [0.6, 0.47], [0.45, 0.42], [0.44, 0.24], [0.52, 0.18]], 1.6)), carbon));
    box(0.44, 0.09, 0.16, carbon, DX, 0.48, 0.5); // cluster hood
    const cl = panel(DX, 0.455, 0.44, 0.38, 0.14, 0.35, null);
    screen(cl, 0, 0, 0.36, 0.135, 320, (g, W, H, s) => {
      g.fillStyle = '#050608';
      g.fillRect(0, 0, W, H);
      if (!s.sw.ignition) return;
      const n = 20, lit = Math.round((s.rpm / s.maxRpm) * n);
      for (let i = 0; i < n; i++) {
        g.fillStyle = i < lit ? (i >= 17 ? '#ff2a3a' : i >= 13 ? '#ffc400' : '#2fd27a') : '#1a1d22';
        g.fillRect(10 + i * 15, 8, 11, 14);
      }
      g.textAlign = 'center';
      g.fillStyle = '#ff8a2a';
      g.font = 'bold 64px sans-serif';
      g.fillText(gearText(s.gear), 60, 104);
      g.fillStyle = '#e8eef4';
      g.font = 'bold 56px monospace';
      g.fillText(String(Math.round(speedOf(s))), 210, 100);
      g.font = 'bold 14px sans-serif';
      g.fillStyle = '#7c8794';
      g.fillText(s.unit === 'mph' ? 'MPH' : 'KM/H', 290, 110);
      g.fillText(`${Math.round(s.rpm / 100) * 100} RPM`, 210, 42);
      if (!s.sw.engine) {
        g.fillStyle = '#ff3a3a';
        g.font = 'bold 15px sans-serif';
        g.fillText('ENGINE OFF – PRESS START', W / 2, H - 6);
      } else if (s.engineDamage > 0.4) {
        g.fillStyle = Math.floor(s.time * 2.5) % 2 ? '#ff2a3a' : '#7a1018';
        g.font = 'bold 15px sans-serif';
        g.fillText('ENGINE', 60, 42);
      }
      if (s.sw.hazards && Math.floor(s.time * 2.4) % 2) {
        g.fillStyle = '#ff9a00';
        g.font = 'bold 22px sans-serif';
        g.fillText('◀ ▶', W - 40, 42);
      }
    });
    const st: ControlStyle = { plate: 0x222428, cap: 0xc9ced3, led: 0xff7a1a, text: '#e8eef4' };
    const sp = swPanel(-0.05, 0.37, 0.46, 0.4, 0.13, 0.45, mat({ color: 0x2b2e33, roughness: 0.6, metalness: 0.4 }));
    controls.push(f.toggle(sp, 'ignition', 'IGN', -0.15, 0.025, { ...st, led: 0xff3030 }, true));
    controls.push(f.toggle(sp, 'headlights', 'LIGHTS', -0.09, 0.025, st));
    controls.push(f.toggle(sp, 'pod', 'POD', -0.03, 0.025, st));
    controls.push(f.toggle(sp, 'hazards', 'HAZ', 0.03, 0.025, st));
    controls.push(f.toggle(sp, 'demister', 'DEMIST', 0.09, 0.025, st));
    controls.push(f.toggle(sp, 'interior', 'CABIN', 0.15, 0.025, st));
    controls.push(f.rotary(sp, 'wipers', 'WIPE', -0.06, -0.035, st));
    controls.push(f.push(sp, 'start', 'START', 0.06, -0.035, { ...st, cap: 0xd0141c, led: 0xff3030 }, true));
    hazardLamp(sp, 0.15, -0.035);
    tripComputer(group, { ...st, cap: 0x333333 }, { bg: '#020a12', fg: '#5fd2ff', font: 'monospace' }, mat({ color: 0x2b2e33, roughness: 0.6 }));
  } else if (model === 'dune') {
    // ---------------- rugged truck: tall boxy dash, 4 dials, rockers, grab handle
    dashColor = 0x3b4038;
    wheelStyle = 'two';
    const rugged = mat({ color: dashColor, roughness: 0.85 });
    add(new THREE.Mesh(track(sideExtrude([[0.84, 0.16], [0.84, 0.5], [0.58, 0.52], [0.44, 0.5], [0.42, 0.22], [0.52, 0.16]], 1.64)), rugged));
    const g4 = panel(DX, 0.43, 0.43, 0.34, 0.12, 0.1, mat({ color: 0x111311, roughness: 0.9 }));
    const look = { face: '#101410', ink: '#e8f0e0', needle: 0xff6a00 };
    dial(g4, -0.1, 0.005, 0.046, 180, 'KM/H', speedOf, look);
    dial(g4, 0.0, 0.005, 0.046, 7000, 'RPM', (s) => s.rpm, { ...look, red: 5800, div: 1000 });
    dial(g4, 0.085, 0.025, 0.026, 100, 'OIL', (s) => (s.sw.engine ? 60 + s.rpm / 300 : 0), look);
    dial(g4, 0.085, -0.03, 0.026, 130, 'TEMP', (s) => (s.sw.engine ? 85 + s.engineDamage * 40 : 20), { ...look, red: 110 });
    telltales(g4, -0.13, -0.05);
    hazardLamp(g4, 0.04, -0.05);
    const st: ControlStyle = { plate: 0x111111, cap: 0x2a2a2a, led: 0xffb000, text: '#f0f0e0', scale: 1.1 };
    const rp = swPanel(-0.13, 0.39, 0.44, 0.4, 0.11, 0.35, mat({ color: 0x171a16, roughness: 0.9 }));
    controls.push(f.rocker(rp, 'headlights', 'LIGHTS', -0.15, 0.012, st));
    controls.push(f.rocker(rp, 'pod', 'LIGHTBAR', -0.09, 0.012, st));
    controls.push(f.rocker(rp, 'hazards', 'HAZARD', -0.03, 0.012, st));
    controls.push(f.rocker(rp, 'demister', 'DEMIST', 0.03, 0.012, st));
    controls.push(f.rocker(rp, 'interior', 'CABIN', 0.09, 0.012, st));
    controls.push(f.rotary(rp, 'wipers', 'WIPERS', 0.155, 0.012, st));
    const k = swPanel(0.66, 0.43, 0.47, 0.13, 0.1, 0.35, mat({ color: 0x171a16, roughness: 0.9 }));
    controls.push(f.key(k, 'ignition', 'KEY', -0.03, 0.008, st));
    controls.push(f.push(k, 'start', 'START', 0.03, 0.008, { ...st, cap: 0x111111, led: 0x40ff60 }));
    // grab handle for the navigator + diff-lock lever on the tunnel
    const handle = new THREE.Mesh(track(new THREE.TorusGeometry(0.1, 0.014, 8, 20, Math.PI)), mat({ color: 0x111111, roughness: 0.6 }));
    handle.position.set(-DX - 0.05, 0.64, 0.46);
    handle.rotation.x = -0.4;
    add(handle);
    box(0.02, 0.12, 0.02, mat({ color: 0xffc400, roughness: 0.5 }), 0.06, 0.2, 0.2);
    tripComputer(group, { ...st, scale: 1, cap: 0x333333 }, { bg: '#100a00', fg: '#ffb000', font: 'monospace' }, mat({ color: 0x171a16, roughness: 0.9 }), 0.04);
  } else if (model === 'bruno') {
    // ---------------- 80s Group B: angular dash, orange tacho + LCD, satellite pods
    dashColor = 0x151515;
    wheelStyle = 'four';
    const dark = mat({ color: dashColor, roughness: 0.75 });
    add(new THREE.Mesh(track(sideExtrude([[0.84, 0.18], [0.84, 0.44], [0.66, 0.5], [0.48, 0.48], [0.44, 0.3], [0.5, 0.18]], 1.6)), dark));
    const cl = panel(DX, 0.445, 0.47, 0.3, 0.13, 0.3, mat({ color: 0x080808, roughness: 0.9 }));
    dial(cl, -0.06, 0, 0.058, 9000, 'RPM x1000', (s) => s.rpm, { face: '#2a1200', ink: '#ff9a2a', needle: 0xfff2d0, red: 7500, div: 1000 });
    screen(cl, 0.075, 0.015, 0.11, 0.05, 192, (g, W, H, s) => {
      g.fillStyle = '#120800';
      g.fillRect(0, 0, W, H);
      if (!s.sw.ignition) return;
      g.fillStyle = '#ff9a1a';
      g.font = 'bold 52px monospace';
      g.textAlign = 'right';
      g.fillText(String(Math.round(speedOf(s))).padStart(3, ' '), W - 8, H - 18);
      g.font = 'bold 14px monospace';
      g.fillText(s.unit === 'mph' ? 'MPH' : 'KM/H', W - 8, H - 4);
    });
    screen(cl, 0.075, -0.035, 0.05, 0.035, 64, (g, W, H, s) => {
      g.fillStyle = '#120800';
      g.fillRect(0, 0, W, H);
      if (!s.sw.ignition) return;
      g.fillStyle = '#ff9a1a';
      g.font = 'bold 36px monospace';
      g.textAlign = 'center';
      g.fillText(gearText(s.gear), W / 2, H - 8);
    });
    hazardLamp(cl, 0.12, -0.035);
    telltales(cl, -0.12, -0.055);
    // satellite pods each side of the cluster: square push buttons
    const st: ControlStyle = { plate: 0x111111, cap: 0x2b2b2b, led: 0xff8a00, text: '#ff9a2a' };
    const left = swPanel(DX + 0.3, 0.45, 0.48, 0.1, 0.13, 0.3, mat({ color: 0x0c0c0c, roughness: 0.8 }));
    controls.push(f.push(left, 'headlights', 'LIGHTS', 0, 0.04, st));
    controls.push(f.push(left, 'pod', 'POD', 0, 0.0, st));
    controls.push(f.push(left, 'hazards', 'HAZ', 0, -0.04, st));
    const right = swPanel(DX - 0.27, 0.42, 0.48, 0.1, 0.13, 0.3, mat({ color: 0x0c0c0c, roughness: 0.8 }));
    controls.push(f.push(right, 'wipers', 'WIPE', 0, 0.04, st));
    controls.push(f.push(right, 'demister', 'DEMIST', 0, 0.0, st));
    controls.push(f.push(right, 'interior', 'CABIN', 0, -0.04, st));
    const con = swPanel(-0.02, 0.37, 0.46, 0.18, 0.08, 0.45, mat({ color: 0x0c0c0c, roughness: 0.8 }));
    controls.push(f.toggle(con, 'ignition', 'IGN', -0.04, 0.008, { ...st, cap: 0xd0d4d8, led: 0xff3030 }, true));
    controls.push(f.push(con, 'start', 'START', 0.04, 0.008, { ...st, cap: 0xc8141c, led: 0xff3030 }));
    tripComputer(group, st, { bg: '#120800', fg: '#ff9a1a', font: 'monospace' }, mat({ color: 0x0c0c0c, roughness: 0.8 }));
  } else {
    // ---------------- Rally1 hybrid: carbon dash, wide screen, glowing touch tiles
    dashColor = 0x121416;
    wheelStyle = 'flat';
    const carbon = mat({ color: dashColor, roughness: 0.35, metalness: 0.45 });
    add(new THREE.Mesh(track(sideExtrude([[0.84, 0.2], [0.84, 0.44], [0.58, 0.46], [0.46, 0.4], [0.45, 0.26], [0.52, 0.2]], 1.6)), carbon));
    const sc = panel(DX, 0.46, 0.45, 0.42, 0.13, 0.4, mat({ color: 0x050505, roughness: 0.4 }));
    screen(sc, 0, 0, 0.4, 0.12, 400, (g, W, H, s) => {
      g.fillStyle = '#02060a';
      g.fillRect(0, 0, W, H);
      if (!s.sw.ignition) {
        g.fillStyle = '#123';
        g.font = 'bold 18px sans-serif';
        g.textAlign = 'center';
        g.fillText('VORTEX', W / 2, H / 2 + 6);
        return;
      }
      // rpm arc
      const frac = Math.min(1, s.rpm / s.maxRpm);
      g.lineWidth = 12;
      g.strokeStyle = '#0f2430';
      g.beginPath();
      g.arc(W / 2, H + 40, 150, Math.PI * 1.15, Math.PI * 1.85);
      g.stroke();
      g.strokeStyle = frac > 0.9 ? '#ff2a5a' : '#00c8ff';
      g.beginPath();
      g.arc(W / 2, H + 40, 150, Math.PI * 1.15, Math.PI * (1.15 + 0.7 * frac));
      g.stroke();
      g.textAlign = 'center';
      g.fillStyle = '#ffffff';
      g.font = 'bold 54px sans-serif';
      g.fillText(String(Math.round(speedOf(s))), W / 2, H - 22);
      g.font = 'bold 12px sans-serif';
      g.fillStyle = '#6fd8ff';
      g.fillText(s.unit === 'mph' ? 'MPH' : 'KM/H', W / 2, H - 6);
      g.font = 'bold 48px sans-serif';
      g.fillStyle = '#00e0ff';
      g.fillText(gearText(s.gear), 50, H - 24);
      g.font = 'bold 13px sans-serif';
      g.fillStyle = s.sw.engine ? '#37ff8b' : '#ff4a4a';
      g.fillText(s.sw.engine ? 'HYBRID READY' : 'PRESS START', W - 70, 22);
      g.fillStyle = '#6fd8ff';
      g.fillText(`${s.sw.headlights ? 'LIGHTS ' : ''}${s.sw.pod ? 'POD ' : ''}${s.sw.wipers ? `WIPE ${s.sw.wipers}` : ''}`, W - 70, H - 8);
      if (s.sw.hazards && Math.floor(s.time * 2.4) % 2) {
        g.fillStyle = '#ff9a00';
        g.fillText('HAZARD', 50, 22);
      }
    });
    const st: ControlStyle = { plate: 0x000000, cap: 0x000000, led: 0x00c8ff, text: '#d8f4ff' };
    const tp = swPanel(-0.05, 0.37, 0.46, 0.3, 0.13, 0.5, mat({ color: 0x050708, roughness: 0.3 }));
    controls.push(f.tile(tp, 'ignition', 'POWER', -0.1, 0.035, { ...st, led: 0xff3a5a }));
    controls.push(f.tile(tp, 'start', 'START', -0.1, -0.005, { ...st, led: 0x37ff8b }));
    controls.push(f.tile(tp, 'headlights', 'LIGHTS', -0.04, 0.035, st));
    controls.push(f.tile(tp, 'pod', 'POD', 0.02, 0.035, st));
    controls.push(f.tile(tp, 'hazards', 'HAZARD', 0.08, 0.035, { ...st, led: 0xff9a00 }));
    controls.push(f.tile(tp, 'wipers', 'WIPERS', -0.04, -0.005, st));
    controls.push(f.tile(tp, 'demister', 'DEMIST', 0.02, -0.005, st));
    controls.push(f.tile(tp, 'interior', 'CABIN', 0.08, -0.005, st));
    hazardLamp(tp, 0.0, -0.045);
    tripComputer(group, { ...st, cap: 0x10181c, led: 0x00c8ff }, { bg: '#02060a', fg: '#00d8ff', font: 'sans-serif' }, mat({ color: 0x050708, roughness: 0.3 }));
  }

  return {
    controls,
    wheelStyle,
    dashColor,
    update: (s) => updaters.forEach((u) => u(s)),
  };
}
