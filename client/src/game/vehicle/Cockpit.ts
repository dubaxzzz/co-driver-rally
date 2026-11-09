import * as THREE from 'three';
import { type CarModelId, type CarSwitches, type PaintOption } from '@cdr/shared';
import { noDamage, type DamageZones } from './Vehicle';
import { buildDashboard, type Dashboard } from './Dashboards';
import type { Control, ControlId } from './Controls';

export type Seat = 'driver' | 'navigator';

/** Car-local positions. The car faces +Z; its left side is +X (left-hand drive). */
export const SEATS: Record<Seat, { x: number; eyeY: number; eyeZ: number }> = {
  driver: { x: 0.37, eyeY: 0.73, eyeZ: -0.36 },
  navigator: { x: -0.37, eyeY: 0.71, eyeZ: -0.36 },
};

export interface CockpitState {
  steer: number; // -1..1 (+ = left)
  rpm: number;
  maxRpm: number;
  speed: number; // m/s
  gear: number;
  handbrake: boolean;
  brake: number;
  /** The car's switches (wipers, lights, ignition…). */
  sw: CarSwitches;
  /** Controls being held down right now (push buttons show pressed). */
  held?: ReadonlySet<ControlId>;
  /** Navigator-side trip computer + map light (local to whoever is looking). */
  tripKm?: number;
  watchMs?: number;
  watchRunning?: boolean;
  mapLight?: boolean;
  rain: number; // 0..1
  snow: number; // 0..1 (flakes settle on the glass)
  speedUnit: 'kmh' | 'mph';
  damage: DamageZones;
  /** 0..1 – a bent or missing front wheel makes the steering wheel shake. */
  wheelShake?: number;
}

// Windscreen geometry (car-local)
const WS_BOTTOM = new THREE.Vector3(0, 0.44, 0.8);
const WS_TOP = new THREE.Vector3(0, 0.86, 0.45);
const WS_WIDTH = 1.44;
const WS_HEIGHT = WS_BOTTOM.distanceTo(WS_TOP);
const CANVAS_W = 512;
const CANVAS_H = Math.round((CANVAS_W * WS_HEIGHT) / WS_WIDTH);
const WIPER_LEN = CANVAS_W * 0.36;
const WIPER_PIVOTS = [CANVAS_W * 0.2, CANVAS_W * 0.62];
const WIPER_SWEEP = 2.7; // radians (~155°)

const WHEEL_CENTER_Y = 0.42;
const WHEEL_CENTER_Z = 0.17;
const WHEEL_TILT = 0.42;
const WHEEL_RADIUS = 0.17;
const WHEEL_LOCK = 2.4; // wheel rotation (rad) at full steering input

/**
 * The interior of the rally car, shared by both players: dashboard, roll
 * cage, seats, working gauges, steering wheel with the driver's hands on it,
 * gear and handbrake levers, both crew members, and a rain-covered windscreen
 * that animated wipers sweep clear.
 */
export class Cockpit {
  readonly group = new THREE.Group();
  private disposables: Array<{ dispose(): void }> = [];
  private wheelSpin = new THREE.Group();
  private wiperArms: THREE.Group[] = [];
  private wiperPhase = 0;
  private wiperAngle = 0;
  private wsCanvas: HTMLCanvasElement;
  private wsCtx: CanvasRenderingContext2D;
  private wsTex: THREE.CanvasTexture;
  private gearLever = new THREE.Group();
  private gearKick = 0;
  private gearKickVel = 0;
  private lastGear = 1;
  private handbrakeLever = new THREE.Group();
  private arms: Array<{ upper: THREE.Mesh; fore: THREE.Mesh; glove: THREE.Mesh; side: number }> = [];
  private driverBody = new THREE.Group();
  private navBody = new THREE.Group();
  private navHead = new THREE.Group();
  private time = 0;
  private readonly dx = SEATS.driver.x;
  // damage visuals
  private bonnetPivot = new THREE.Group();
  private bonnetCrease: THREE.Mesh | null = null;
  private doorCards: Record<'left' | 'right', THREE.Mesh | null> = { left: null, right: null };
  private crackCanvas: HTMLCanvasElement;
  private crackTex: THREE.CanvasTexture;
  private cracksDrawn = 0;
  private lastDamage: DamageZones = noDamage();
  private dash: Dashboard;
  /** Every clickable control (dashboard switches, horn on the wheel hub). */
  readonly controls: Control[] = [];
  private mistCanvas: HTMLCanvasElement;
  private mistTex: THREE.CanvasTexture;
  private mist = 0;
  private mistDrawn = -1;
  private glareMat: THREE.MeshBasicMaterial;
  private cabinLight: THREE.PointLight;
  private mapLight: THREE.PointLight;

  constructor(paint: PaintOption, readonly seat: Seat, readonly model: CarModelId = 'kestrel') {
    const mat = (o: THREE.MeshStandardMaterialParameters) => this.track(new THREE.MeshStandardMaterial(o));
    const paintMat = mat({ color: paint.body, metalness: 0.4, roughness: 0.4 });
    const plastic = mat({ color: 0x3a3d43, roughness: 0.8 });
    const darkPlastic = mat({ color: 0x24262b, roughness: 0.85 });
    const cage = mat({ color: 0x8d949c, metalness: 0.6, roughness: 0.35 });
    const seatMat = mat({ color: 0x2c2c35, roughness: 0.9 });
    const seatAccent = mat({ color: paint.accent, roughness: 0.7 });
    const suit = mat({ color: 0x1d3f7a, roughness: 0.85 });
    const navSuit = mat({ color: 0x6b1d1d, roughness: 0.85 });
    const glove = mat({ color: 0x1f1f24, roughness: 0.8 });
    const helmet = mat({ color: 0xf2f2f2, roughness: 0.35, metalness: 0.1 });
    const visor = mat({ color: 0x0a0c10, roughness: 0.1, metalness: 0.8 });

    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.group) => {
      const mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, h, d)), m);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };
    const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, parent: THREE.Object3D = this.group) => {
      const mesh = new THREE.Mesh(this.track(new THREE.CylinderGeometry(r, r, 1, 8)), m);
      placeLimb(mesh, a, b);
      parent.add(mesh);
      return mesh;
    };
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    // ---- Bonnet seen through the windscreen ----
    // bonnet hinges at the windscreen end so a front impact lifts and bends it into view
    this.bonnetPivot.position.set(0, 0.32, 0.82);
    this.group.add(this.bonnetPivot);
    const bonnet = box(1.66, 0.07, 1.2, paintMat, 0, -0.02, 0.58, this.bonnetPivot);
    bonnet.rotation.x = 0.07;
    box(0.5, 0.06, 0.4, darkPlastic, 0, 0.04, 0.38, this.bonnetPivot);
    this.bonnetCrease = box(1.5, 0.05, 0.5, paintMat, 0, 0.06, 1.0, this.bonnetPivot);
    this.bonnetCrease.rotation.x = -0.5;
    this.bonnetCrease.visible = false;
    // ---- Dashboard (different for every car, with clickable switches) ----
    this.dash = buildDashboard(model, this.group, (o) => this.track(o));
    this.controls.push(...this.dash.controls);
    // floor, firewall and transmission tunnel (no seeing the road through the footwell)
    box(1.7, 0.04, 2.1, darkPlastic, 0, -0.12, -0.15);
    box(1.7, 0.6, 0.04, darkPlastic, 0, 0.14, 0.82);
    box(0.28, 0.18, 1.6, plastic, 0, -0.03, -0.1);
    box(0.3, 0.16, 0.25, plastic, 0, 0.18, 0.42); // centre console

    // ---- Body shell: pillars, roof, doors ----
    for (const sx of [-1, 1]) {
      tube(v(sx * 0.75, 0.44, 0.8), v(sx * 0.7, 0.87, 0.45), 0.035, darkPlastic); // A-pillar
      tube(v(sx * 0.72, 0.87, 0.45), v(sx * 0.72, 0.88, -0.9), 0.03, darkPlastic); // roof rail
      tube(v(sx * 0.78, 0.42, -0.85), v(sx * 0.72, 0.88, -0.9), 0.04, darkPlastic); // B-pillar
      const door = box(0.05, 0.44, 1.7, plastic, sx * 0.86, 0.2, -0.1); // door card
      this.doorCards[sx > 0 ? 'left' : 'right'] = door;
      box(0.12, 0.04, 1.7, darkPlastic, sx * 0.83, 0.42, -0.1); // window sill
    }
    box(1.48, 0.06, 0.08, darkPlastic, 0, 0.87, 0.45); // header above windscreen
    box(1.46, 0.025, 1.4, plastic, 0, 0.9, -0.22); // headliner

    // ---- Roll cage ----
    for (const sx of [-1, 1]) {
      tube(v(sx * 0.68, 0.0, -0.9), v(sx * 0.66, 0.84, -0.9), 0.025, cage); // main hoop legs
      tube(v(sx * 0.7, 0.3, 0.62), v(sx * 0.65, 0.84, 0.42), 0.022, cage); // A-pillar bars
      tube(v(sx * 0.65, 0.84, 0.42), v(sx * 0.66, 0.84, -0.9), 0.022, cage); // roof bars
      tube(v(sx * 0.78, 0.08, 0.5), v(sx * 0.78, 0.4, -0.75), 0.02, cage); // door bars (X)
      tube(v(sx * 0.78, 0.4, 0.5), v(sx * 0.78, 0.08, -0.75), 0.02, cage);
    }
    tube(v(-0.66, 0.84, -0.9), v(0.66, 0.84, -0.9), 0.025, cage);
    tube(v(-0.65, 0.84, 0.42), v(0.65, 0.84, 0.42), 0.022, cage);
    tube(v(-0.66, 0.84, -0.9), v(0.68, 0.0, -0.9), 0.022, cage); // diagonal

    // ---- Seats ----
    for (const sx of [this.dx, -this.dx]) {
      box(0.5, 0.12, 0.5, seatMat, sx, 0.02, -0.45);
      const back = box(0.52, 0.8, 0.12, seatMat, sx, 0.42, -0.74);
      back.rotation.x = -0.14;
      for (const wx of [-0.25, 0.25]) box(0.04, 0.6, 0.3, seatMat, sx + wx, 0.35, -0.62);
      box(0.5, 0.05, 0.12, seatAccent, sx, 0.8, -0.76);
    }

    // ---- Steering wheel ----
    const wheelTilt = new THREE.Group();
    wheelTilt.position.set(this.dx, WHEEL_CENTER_Y, WHEEL_CENTER_Z);
    wheelTilt.rotation.x = WHEEL_TILT;
    wheelTilt.add(this.wheelSpin);
    this.group.add(wheelTilt);
    const ws = this.dash.wheelStyle;
    const rimMat = model === 'sparrow' ? mat({ color: 0x5a3a22, roughness: 0.55 }) : glove; // wood rim on the classic
    const rimR = ws === 'two' ? WHEEL_RADIUS * 1.1 : WHEEL_RADIUS;
    if (ws === 'flat') {
      // flat-bottomed competition wheel (D-shape)
      const shape = new THREE.Shape();
      shape.absarc(0, 0, rimR, -0.55, Math.PI + 0.55, false);
      const path = new THREE.Path(shape.getPoints(30));
      const pts = path.getPoints(40).map((p) => new THREE.Vector3(p.x, p.y, 0));
      pts.push(pts[0].clone());
      const curve = new THREE.CatmullRomCurve3(pts, true);
      this.wheelSpin.add(new THREE.Mesh(this.track(new THREE.TubeGeometry(curve, 60, 0.018, 8, true)), rimMat));
    } else {
      this.wheelSpin.add(new THREE.Mesh(this.track(new THREE.TorusGeometry(rimR, ws === 'two' ? 0.02 : 0.017, 8, 28)), rimMat));
    }
    const spokeAngles = ws === 'two' ? [Math.PI / 2, -Math.PI / 2] : ws === 'four' ? [Math.PI * 0.3, -Math.PI * 0.3, Math.PI * 0.7, -Math.PI * 0.7] : [Math.PI / 2, -Math.PI / 2, Math.PI];
    for (const a of spokeAngles) {
      const spoke = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.03, rimR, 0.012)), model === 'sparrow' ? mat({ color: 0xc0c6cc, metalness: 0.9, roughness: 0.25 }) : plastic);
      spoke.position.set(Math.sin(a) * rimR * 0.5, Math.cos(a) * rimR * 0.5, 0);
      spoke.rotation.z = -a;
      this.wheelSpin.add(spoke);
    }
    const marker = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.03, 0.035, 0.022)), this.track(new THREE.MeshStandardMaterial({ color: 0xffc400 })));
    marker.position.set(0, rimR, 0);
    this.wheelSpin.add(marker);
    // hub = HORN (press and hold)
    const hubMat = mat({ color: model === 'vortex' ? 0x0a0c0e : 0x2a2c30, roughness: 0.5, metalness: 0.2 });
    const hub = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.05, 0.05, 0.035, 18)), hubMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = -0.012;
    this.wheelSpin.add(hub);
    const hornIcon = new THREE.Mesh(this.track(new THREE.CircleGeometry(0.02, 16)), this.track(new THREE.MeshBasicMaterial({ color: 0x666a70 })));
    hornIcon.position.z = -0.031;
    hornIcon.rotation.y = Math.PI;
    this.wheelSpin.add(hornIcon);
    if (model === 'vortex') {
      // mini display + coloured buttons on the wheel
      const disp = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.07, 0.03)), this.track(new THREE.MeshBasicMaterial({ color: 0x0a3a50 })));
      disp.position.set(0, 0.075, -0.012);
      disp.rotation.y = Math.PI;
      this.wheelSpin.add(disp);
      [0xff3a3a, 0x37ff8b, 0xffc400, 0x00c8ff].forEach((c, i) => {
        const b = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.009, 0.009, 0.01, 10)), mat({ color: c, emissive: c, emissiveIntensity: 0.3 }));
        b.rotation.x = Math.PI / 2;
        b.position.set((i < 2 ? 1 : -1) * 0.085, i % 2 ? -0.02 : 0.02, -0.012);
        this.wheelSpin.add(b);
      });
    }
    this.controls.push({
      id: 'horn',
      label: 'HORN',
      hit: [hub, hornIcon],
      set: (_v, held) => (hub.position.z = held ? -0.004 : -0.012),
      hover: (on) => hubMat.emissive.setHex(on ? 0x553311 : 0x000000),
    });
    tube(v(this.dx, 0.36, 0.6), v(this.dx, WHEEL_CENTER_Y - 0.01, WHEEL_CENTER_Z + 0.03), 0.03, darkPlastic); // column

    // ---- Gear lever (sequential) & hydraulic handbrake ----
    this.gearLever.position.set(0.13, 0.2, -0.02);
    this.group.add(this.gearLever);
    tube(v(0, 0, 0), v(0, 0.2, -0.04), 0.011, cage, this.gearLever);
    const knob = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.026, 10, 8)), darkPlastic);
    knob.position.set(0, 0.21, -0.045);
    this.gearLever.add(knob);
    this.handbrakeLever.position.set(0.15, 0.16, 0.0);
    this.group.add(this.handbrakeLever);
    tube(v(0, 0, 0), v(0, 0.24, 0.05), 0.013, cage, this.handbrakeLever);
    box(0.03, 0.06, 0.03, darkPlastic, 0, 0.26, 0.055, this.handbrakeLever);

    // ---- Driver (avatar) ----
    this.group.add(this.driverBody);
    box(0.42, 0.52, 0.24, suit, this.dx, 0.36, -0.58, this.driverBody);
    const dHelmet = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.135, 14, 12)), helmet);
    dHelmet.position.set(this.dx, 0.7, -0.5);
    this.driverBody.add(dHelmet);
    box(0.2, 0.07, 0.05, visor, this.dx, 0.7, -0.38, this.driverBody);
    for (const side of [1, -1]) {
      const upper = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.05, 0.045, 1, 8)), suit);
      const fore = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.042, 0.038, 1, 8)), suit);
      const gloveMesh = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.045, 10, 8)), glove);
      // arms + gloves stay visible in the driver's own view
      this.group.add(upper, fore, gloveMesh);
      this.arms.push({ upper, fore, glove: gloveMesh, side });
    }

    // ---- Co-driver (avatar) with tablet on the lap ----
    const nx = -this.dx;
    this.group.add(this.navBody);
    box(0.42, 0.52, 0.24, navSuit, nx, 0.36, -0.58, this.navBody);
    this.navHead.position.set(nx, 0.62, -0.52);
    this.navBody.add(this.navHead);
    const nHelmet = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.135, 14, 12)), helmet);
    nHelmet.position.set(0, 0.07, 0);
    this.navHead.add(nHelmet);
    box(0.2, 0.07, 0.05, visor, 0, 0.07, 0.12, this.navHead);
    const tablet = new THREE.Group();
    tablet.position.set(nx, 0.3, -0.14);
    tablet.rotation.x = -2.3; // screen faces the co-driver
    this.navBody.add(tablet);
    box(0.3, 0.2, 0.015, darkPlastic, 0, 0, 0, tablet);
    const screen = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.27, 0.17)), this.track(new THREE.MeshBasicMaterial({ map: this.track(fakeMapTexture()) })));
    screen.position.z = 0.009;
    tablet.add(screen);
    for (const side of [1, -1]) {
      const sh = v(nx + side * 0.19, 0.5, -0.52);
      const hand = v(nx + side * 0.15, 0.3, -0.1);
      const elbow = sh.clone().lerp(hand, 0.5).add(v(side * 0.06, -0.12, -0.05));
      tube(sh, elbow, 0.048, navSuit, this.navBody);
      tube(elbow, hand, 0.04, navSuit, this.navBody);
      const g = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.045, 10, 8)), glove);
      g.position.copy(hand);
      this.navBody.add(g);
    }

    // Hide yourself: the driver sees only their arms; the co-driver's own body
    // is replaced by the real tablet UI on their device.
    if (seat === 'driver') this.driverBody.visible = false;
    if (seat === 'navigator') this.navBody.visible = false;

    // ---- Windscreen rain layer + wipers ----
    this.wsCanvas = document.createElement('canvas');
    this.wsCanvas.width = CANVAS_W;
    this.wsCanvas.height = CANVAS_H;
    this.wsCtx = this.wsCanvas.getContext('2d')!;
    this.wsTex = this.track(new THREE.CanvasTexture(this.wsCanvas));
    const wsTilt = new THREE.Group();
    wsTilt.position.copy(WS_BOTTOM.clone().lerp(WS_TOP, 0.5));
    wsTilt.rotation.x = -Math.atan2(WS_BOTTOM.z - WS_TOP.z, WS_TOP.y - WS_BOTTOM.y);
    const wsInner = new THREE.Group();
    wsInner.rotation.y = Math.PI; // local +x = viewer's right, local +z faces the crew
    wsTilt.add(wsInner);
    this.group.add(wsTilt);
    const glass = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(WS_WIDTH, WS_HEIGHT)),
      this.track(new THREE.MeshBasicMaterial({ map: this.wsTex, transparent: true, depthWrite: false, opacity: 0.9 })),
    );
    glass.renderOrder = 10;
    wsInner.add(glass);
    // cracks live on their own layer: the wipers can't clear them
    this.crackCanvas = document.createElement('canvas');
    this.crackCanvas.width = CANVAS_W * 2;
    this.crackCanvas.height = CANVAS_H * 2;
    this.crackTex = this.track(new THREE.CanvasTexture(this.crackCanvas));
    const crackGlass = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(WS_WIDTH, WS_HEIGHT)),
      this.track(new THREE.MeshBasicMaterial({ map: this.crackTex, transparent: true, depthWrite: false })),
    );
    crackGlass.position.z = 0.004;
    crackGlass.renderOrder = 11;
    wsInner.add(crackGlass);
    // condensation on the inside of the glass – the DEMISTER clears it
    this.mistCanvas = document.createElement('canvas');
    this.mistCanvas.width = 256;
    this.mistCanvas.height = Math.round((256 * WS_HEIGHT) / WS_WIDTH);
    this.mistTex = this.track(new THREE.CanvasTexture(this.mistCanvas));
    const mistGlass = new THREE.Mesh(this.track(new THREE.PlaneGeometry(WS_WIDTH, WS_HEIGHT)), this.track(new THREE.MeshBasicMaterial({ map: this.mistTex, transparent: true, depthWrite: false })));
    mistGlass.position.z = 0.008;
    mistGlass.renderOrder = 12;
    wsInner.add(mistGlass);
    // cabin-light reflection: a warm haze on the glass when the interior light is on
    this.glareMat = this.track(new THREE.MeshBasicMaterial({ color: 0xffe2b8, transparent: true, opacity: 0, depthWrite: false }));
    const glare = new THREE.Mesh(this.track(new THREE.PlaneGeometry(WS_WIDTH, WS_HEIGHT)), this.glareMat);
    glare.position.z = 0.01;
    glare.renderOrder = 13;
    wsInner.add(glare);
    const scale = WS_WIDTH / CANVAS_W;
    for (const px of WIPER_PIVOTS) {
      const arm = new THREE.Group();
      arm.position.set(px * scale - WS_WIDTH / 2, -WS_HEIGHT / 2 - 0.01, -0.02);
      const len = WIPER_LEN * scale;
      const rod = new THREE.Mesh(this.track(new THREE.BoxGeometry(len, 0.012, 0.012)), darkPlastic);
      rod.position.x = len / 2;
      const blade = new THREE.Mesh(this.track(new THREE.BoxGeometry(len * 0.7, 0.02, 0.018)), glove);
      blade.position.set(len * 0.62, 0, -0.008);
      arm.add(rod, blade);
      wsInner.add(arm);
      this.wiperArms.push(arm);
    }

    // Warm dashboard glow so the interior is readable at night
    const glow = new THREE.PointLight(0xffc49a, 2.4, 2.6, 1.1);
    glow.position.set(0, 0.62, 0.2);
    this.group.add(glow);
    this.cabinLight = new THREE.PointLight(0xffe6c4, 0.9, 2.4, 1.2); // CABIN switch brightens it
    this.cabinLight.position.set(0, 0.74, -0.2); // low enough to light the roof lining too
    this.group.add(this.cabinLight);
    this.mapLight = new THREE.PointLight(0xfff0d0, 0, 1.2, 1.4); // navigator's map light
    this.mapLight.position.set(-this.dx, 0.8, 0.0);
    this.group.add(this.mapLight);
  }

  private track<T extends { dispose(): void }>(o: T) {
    this.disposables.push(o);
    return o;
  }

  update(dt: number, s: CockpitState) {
    this.time += dt;

    // Steering wheel + hands
    const shake = (s.wheelShake ?? 0) * Math.sin(this.time * 38) * 0.09;
    const spin = -s.steer * WHEEL_LOCK + shake;
    this.wheelSpin.rotation.z = spin;
    const tiltAxis = new THREE.Vector3(1, 0, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const center = new THREE.Vector3(this.dx, WHEEL_CENTER_Y, WHEEL_CENTER_Z);
    for (const arm of this.arms) {
      // hands at roughly 9 and 3 o'clock, they slide a little at big lock
      const grip = new THREE.Vector3(arm.side * WHEEL_RADIUS, 0.02, 0)
        .applyAxisAngle(zAxis, spin * 0.85)
        .applyAxisAngle(tiltAxis, WHEEL_TILT)
        .add(center);
      const shoulder = new THREE.Vector3(this.dx + arm.side * 0.2, 0.52, -0.56);
      const elbow = shoulder.clone().lerp(grip, 0.5).add(new THREE.Vector3(arm.side * 0.09, -0.13, -0.02));
      placeLimb(arm.upper, shoulder, elbow);
      placeLimb(arm.fore, elbow, grip);
      arm.glove.position.copy(grip);
    }

    // Gear lever kicks on each shift (spring back)
    if (s.gear !== this.lastGear) {
      this.gearKickVel += s.gear > this.lastGear || s.gear === -1 ? -9 : 9;
      this.lastGear = s.gear;
    }
    this.gearKickVel += (-this.gearKick * 220 - this.gearKickVel * 18) * dt;
    this.gearKick += this.gearKickVel * dt;
    this.gearLever.rotation.x = this.gearKick;
    const hbTarget = s.handbrake ? -0.55 : 0;
    this.handbrakeLever.rotation.x += (hbTarget - this.handbrakeLever.rotation.x) * Math.min(1, dt * 18);

    // Co-driver glances up at the road now and then
    this.navHead.rotation.x = 0.35 + Math.sin(this.time * 0.7) * 0.08 + (Math.sin(this.time * 0.23) > 0.85 ? -0.4 : 0);

    this.updateDamage(s.damage);
    this.updateWindscreen(dt, s);
    this.updateMist(dt, s);
    const sw = s.sw;
    this.dash.update({
      speed: s.speed,
      rpm: sw.engine ? s.rpm : 0,
      maxRpm: s.maxRpm,
      gear: s.gear,
      unit: s.speedUnit,
      sw,
      engineDamage: s.damage.engine,
      tripKm: s.tripKm ?? 0,
      watchMs: s.watchMs ?? 0,
      watchRunning: !!s.watchRunning,
      time: this.time,
    });
    const held = s.held;
    for (const c of this.controls) {
      const v: number | boolean =
        c.id === 'wipers' ? sw.wipers
        : c.id === 'start' ? sw.engine
        : c.id === 'horn' ? sw.horn
        : c.id === 'watch' ? !!s.watchRunning
        : c.id === 'mapLight' ? !!s.mapLight
        : c.id === 'trip' || c.id === 'watchReset' ? false
        : !!sw[c.id as keyof CarSwitches];
      c.set(v, held?.has(c.id) || (c.id === 'horn' && sw.horn));
    }
    // cabin light: bright interior, warm reflection on the glass (harder to see out at night)
    this.cabinLight.intensity = sw.interior ? 4.5 : 0.9;
    this.glareMat.opacity += ((sw.interior ? 0.13 : 0) - this.glareMat.opacity) * Math.min(1, dt * 6);
    this.mapLight.intensity = s.mapLight ? 3 : 0;
  }

  /** Inside condensation builds up in wet/cold weather; the demister clears it from the bottom up. */
  private updateMist(dt: number, s: CockpitState) {
    const wet = Math.max(s.rain, s.snow);
    const target = s.sw.demister ? 0 : 0.15 + wet * 0.55;
    const rate = s.sw.demister ? 0.18 : 0.012 + wet * 0.01;
    this.mist += Math.sign(target - this.mist) * Math.min(Math.abs(target - this.mist), rate * dt);
    const q = Math.round(this.mist * 60);
    if (q === this.mistDrawn) return;
    this.mistDrawn = q;
    const g = this.mistCanvas.getContext('2d')!;
    const W = this.mistCanvas.width, H = this.mistCanvas.height;
    g.clearRect(0, 0, W, H);
    if (this.mist < 0.01) return void (this.mistTex.needsUpdate = true);
    // fogged glass, clearer at the bottom where the demister vents blow
    const grad = g.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, `rgba(205,212,220,${this.mist * 0.55})`);
    grad.addColorStop(0.5, `rgba(210,216,224,${this.mist * 0.85})`);
    grad.addColorStop(1, `rgba(215,220,228,${this.mist})`);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    this.mistTex.needsUpdate = true;
  }

  private updateWindscreen(dt: number, s: CockpitState) {
    const g = this.wsCtx;
    const W = CANVAS_W, H = CANVAS_H;
    // Wipers: off finishes its stroke and parks
    const wipers = s.sw.wipers;
    const period = wipers === 2 ? 0.85 : 1.5;
    const prevAngle = this.wiperAngle;
    if (wipers > 0 || this.wiperPhase % 1 > 0.001) {
      const next = this.wiperPhase + dt / period;
      this.wiperPhase = wipers === 0 && Math.floor(next) > Math.floor(this.wiperPhase) ? Math.floor(next) : next;
    }
    this.wiperAngle = (WIPER_SWEEP * (1 - Math.cos(this.wiperPhase * Math.PI * 2))) / 2;
    this.wiperArms.forEach((a) => (a.rotation.z = this.wiperAngle));

    if (s.snow > 0) {
      // snowflakes settle on the glass
      const n = s.snow * (1 + Math.min(4, Math.abs(s.speed) * 0.1)) * dt * 60;
      for (let i = 0; i < n; i++) {
        g.fillStyle = 'rgba(245,248,252,0.75)';
        g.beginPath();
        g.arc(Math.random() * W, Math.random() * H, 1 + Math.random() * 2.5, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (s.rain > 0) {
      // wet film builds up slowly everywhere the wipers don't reach
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = `rgba(120,135,150,${Math.min(0.006, 0.0009 * s.rain * dt * 60)})`;
      g.fillRect(0, 0, W, H);
      // new drops – more at speed
      const n = s.rain * (2 + Math.min(6, Math.abs(s.speed) * 0.15)) * dt * 60;
      for (let i = 0; i < n; i++) {
        const x = Math.random() * W, y = Math.random() * H, r = 1.2 + Math.random() * Math.random() * 4.5;
        g.fillStyle = 'rgba(170,190,210,0.2)';
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(x - r * 0.35, y - r * 0.45, Math.max(1, r * 0.35), Math.max(1, r * 0.3));
      }
    }
    // the blades clear the area they swept through since last frame
    const a0 = Math.min(prevAngle, this.wiperAngle) - 0.02;
    const a1 = Math.max(prevAngle, this.wiperAngle) + 0.02;
    if (a1 - a0 > 0.03) {
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = 'rgba(0,0,0,0.92)';
      for (const px of WIPER_PIVOTS) {
        g.beginPath();
        g.arc(px, H + 4, WIPER_LEN + 4, -a1, -a0);
        g.arc(px, H + 4, WIPER_LEN * 0.18, -a0, -a1, true);
        g.closePath();
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
    }
    this.wsTex.needsUpdate = true;
  }

  /** Bonnet, doors and windscreen react to damage. */
  private updateDamage(d: DamageZones) {
    const last = this.lastDamage;
    if (d.front !== last.front) {
      this.bonnetPivot.rotation.x = -Math.min(1, d.front) * 0.32; // front lifts into view
      this.bonnetPivot.rotation.z = (d.left - d.right) * 0.06;
      this.bonnetPivot.scale.y = 1 + d.front * 1.5;
      if (this.bonnetCrease) this.bonnetCrease.visible = d.front > 0.45;
    }
    for (const side of ['left', 'right'] as const) {
      const door = this.doorCards[side];
      if (door && d[side] !== last[side]) {
        const sx = side === 'left' ? 1 : -1;
        door.position.x = sx * (0.86 - d[side] * 0.12); // dented inwards
        door.rotation.y = sx * d[side] * 0.12;
      }
    }
    // windscreen: more cracks the more damage it has taken (deterministic, so
    // the navigator's screen shows the same pattern)
    const target = Math.min(9, Math.floor(d.windscreen * 10));
    if (target !== this.cracksDrawn) {
      drawCracks(this.crackCanvas, target);
      this.crackTex.needsUpdate = true;
      this.cracksDrawn = target;
    }
    this.lastDamage = { ...d };
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Positions a unit-height cylinder so it spans from a to b. */
function placeLimb(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.scale.set(1, Math.max(0.0001, len), 1);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
}

function fakeMapTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 80;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0c1013';
  g.fillRect(0, 0, 128, 80);
  g.strokeStyle = '#8a7a62';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(10, 75);
  g.bezierCurveTo(40, 40, 30, 20, 70, 30);
  g.bezierCurveTo(100, 38, 110, 10, 120, 5);
  g.stroke();
  g.fillStyle = '#ff4b1f';
  g.beginPath();
  g.arc(48, 34, 4, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Spider-web cracks: impact points with radial and ring fractures. */
function drawCracks(canvas: HTMLCanvasElement, count: number) {
  const g = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  // seeded so every device draws the same cracks for the same damage
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let c = 0; c < count; c++) {
    const cx = W * (0.15 + rnd() * 0.7), cy = H * (0.2 + rnd() * 0.65);
    const size = (0.18 + rnd() * 0.22) * H * (c > 4 ? 1.6 : 1);
    // impact point
    g.fillStyle = 'rgba(235,245,255,0.55)';
    g.beginPath();
    g.arc(cx, cy, 5 + rnd() * 6, 0, Math.PI * 2);
    g.fill();
    const rays = 7 + Math.floor(rnd() * 6);
    const ends: Array<[number, number]> = [];
    g.lineCap = 'round';
    for (let r = 0; r < rays; r++) {
      const a = (r / rays) * Math.PI * 2 + rnd() * 0.4;
      const len = size * (0.5 + rnd() * 0.8);
      let x = cx, y = cy;
      g.beginPath();
      g.moveTo(x, y);
      const segs = 5;
      for (let k = 1; k <= segs; k++) {
        const aa = a + (rnd() - 0.5) * 0.35;
        x = cx + Math.cos(aa) * (len * k) / segs;
        y = cy + Math.sin(aa) * (len * k) / segs;
        g.lineTo(x, y);
      }
      g.strokeStyle = 'rgba(230,240,250,0.75)';
      g.lineWidth = 1.6;
      g.stroke();
      g.strokeStyle = 'rgba(20,25,30,0.35)';
      g.lineWidth = 0.8;
      g.stroke();
      ends.push([x, y]);
    }
    // concentric rings between the rays
    for (const ring of [0.25, 0.5]) {
      g.beginPath();
      for (let r = 0; r <= rays; r++) {
        const a = (r / rays) * Math.PI * 2;
        const rr = size * ring * (0.8 + rnd() * 0.4);
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        if (r === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = 'rgba(230,240,250,0.5)';
      g.lineWidth = 1.1;
      g.stroke();
    }
    // frosted area around the impact
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, size * 0.3);
    grad.addColorStop(0, 'rgba(220,230,240,0.35)');
    grad.addColorStop(1, 'rgba(220,230,240,0)');
    g.fillStyle = grad;
    g.fillRect(cx - size, cy - size, size * 2, size * 2);
  }
}
