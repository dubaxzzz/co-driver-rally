import * as THREE from 'three';
import type { PaintOption } from '@cdr/shared';

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
  wipers: 0 | 1 | 2;
  rain: number; // 0..1
  speedUnit: 'kmh' | 'mph';
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
  private clusterCanvas: HTMLCanvasElement;
  private clusterTex: THREE.CanvasTexture;
  private clusterTimer = 0;
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

  constructor(paint: PaintOption, readonly seat: Seat) {
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
    const bonnet = box(1.66, 0.07, 1.2, paintMat, 0, 0.3, 1.4);
    bonnet.rotation.x = 0.07;
    box(0.5, 0.06, 0.4, darkPlastic, 0, 0.36, 1.2);
    // ---- Dashboard ----
    box(1.62, 0.18, 0.38, plastic, 0, 0.34, 0.62);
    const dashTop = box(1.62, 0.04, 0.32, darkPlastic, 0, 0.44, 0.6);
    dashTop.rotation.x = -0.12;
    box(0.44, 0.09, 0.16, darkPlastic, this.dx, 0.48, 0.5); // cluster hood
    box(0.3, 0.2, 0.25, plastic, 0, 0.24, 0.42); // centre console
    // floor, firewall and transmission tunnel (no seeing the road through the footwell)
    box(1.7, 0.04, 2.1, darkPlastic, 0, -0.12, -0.15);
    box(1.7, 0.6, 0.04, darkPlastic, 0, 0.14, 0.82);
    box(0.28, 0.18, 1.6, plastic, 0, -0.03, -0.1);
    // switch panel lights (little glowing dots)
    const ledMat = this.track(new THREE.MeshBasicMaterial({ color: 0xff7a1a }));
    for (let i = 0; i < 5; i++) box(0.025, 0.012, 0.01, ledMat, -0.1 + i * 0.05, 0.31, 0.295);

    // Instrument cluster (live canvas texture)
    this.clusterCanvas = document.createElement('canvas');
    this.clusterCanvas.width = 256;
    this.clusterCanvas.height = 96;
    this.clusterTex = this.track(new THREE.CanvasTexture(this.clusterCanvas));
    this.clusterTex.colorSpace = THREE.SRGBColorSpace;
    const cluster = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.36, 0.135)), this.track(new THREE.MeshBasicMaterial({ map: this.clusterTex })));
    cluster.position.set(this.dx, 0.455, 0.44);
    cluster.rotation.set(0.35, Math.PI, 0); // face the driver, tilted up
    this.group.add(cluster);

    // ---- Body shell: pillars, roof, doors ----
    for (const sx of [-1, 1]) {
      tube(v(sx * 0.75, 0.44, 0.8), v(sx * 0.7, 0.87, 0.45), 0.035, darkPlastic); // A-pillar
      tube(v(sx * 0.72, 0.87, 0.45), v(sx * 0.72, 0.88, -0.9), 0.03, darkPlastic); // roof rail
      tube(v(sx * 0.78, 0.42, -0.85), v(sx * 0.72, 0.88, -0.9), 0.04, darkPlastic); // B-pillar
      box(0.05, 0.44, 1.7, plastic, sx * 0.86, 0.2, -0.1); // door card
      box(0.12, 0.04, 1.7, darkPlastic, sx * 0.83, 0.42, -0.1); // window sill
    }
    box(1.48, 0.06, 0.08, darkPlastic, 0, 0.87, 0.45); // header above windscreen
    box(1.46, 0.025, 1.4, plastic, 0, 0.9, -0.22); // headliner
    box(0.24, 0.07, 0.025, darkPlastic, 0, 0.8, 0.42); // rear-view mirror
    box(0.22, 0.055, 0.005, this.track(new THREE.MeshStandardMaterial({ color: 0x223040, metalness: 0.9, roughness: 0.15 })), 0, 0.8, 0.405);

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
    const rim = new THREE.Mesh(this.track(new THREE.TorusGeometry(WHEEL_RADIUS, 0.017, 8, 28)), glove);
    this.wheelSpin.add(rim);
    for (const a of [0, Math.PI * 0.75, Math.PI * 1.25]) {
      const spoke = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.03, WHEEL_RADIUS, 0.012)), plastic);
      spoke.position.set(Math.sin(a) * WHEEL_RADIUS * 0.5, Math.cos(a) * WHEEL_RADIUS * 0.5, 0);
      spoke.rotation.z = -a;
      this.wheelSpin.add(spoke);
    }
    const marker = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.03, 0.035, 0.022)), this.track(new THREE.MeshStandardMaterial({ color: 0xffc400 })));
    marker.position.set(0, WHEEL_RADIUS, 0);
    this.wheelSpin.add(marker);
    const hub = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 14)), plastic);
    hub.rotation.x = Math.PI / 2;
    this.wheelSpin.add(hub);
    tube(v(this.dx, 0.36, 0.6), v(this.dx, WHEEL_CENTER_Y - 0.01, WHEEL_CENTER_Z + 0.03), 0.03, darkPlastic); // column

    // ---- Gear lever (sequential) & hydraulic handbrake ----
    this.gearLever.position.set(0.1, 0.32, 0.12);
    this.group.add(this.gearLever);
    tube(v(0, 0, 0), v(0, 0.26, -0.05), 0.012, cage, this.gearLever);
    const knob = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.03, 10, 8)), darkPlastic);
    knob.position.set(0, 0.27, -0.055);
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
    const cabin = new THREE.PointLight(0x9fb4d8, 0.9, 2.4, 1.2); // faint map light
    cabin.position.set(0, 0.86, -0.3);
    this.group.add(cabin);
  }

  private track<T extends { dispose(): void }>(o: T) {
    this.disposables.push(o);
    return o;
  }

  update(dt: number, s: CockpitState) {
    this.time += dt;

    // Steering wheel + hands
    const spin = -s.steer * WHEEL_LOCK;
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

    this.updateWindscreen(dt, s);
    this.clusterTimer -= dt;
    if (this.clusterTimer <= 0) {
      this.clusterTimer = 1 / 15;
      this.drawCluster(s);
    }
  }

  private updateWindscreen(dt: number, s: CockpitState) {
    const g = this.wsCtx;
    const W = CANVAS_W, H = CANVAS_H;
    // Wipers: off finishes its stroke and parks
    const period = s.wipers === 2 ? 0.85 : 1.5;
    const prevAngle = this.wiperAngle;
    if (s.wipers > 0 || this.wiperPhase % 1 > 0.001) {
      const next = this.wiperPhase + dt / period;
      this.wiperPhase = s.wipers === 0 && Math.floor(next) > Math.floor(this.wiperPhase) ? Math.floor(next) : next;
    }
    this.wiperAngle = (WIPER_SWEEP * (1 - Math.cos(this.wiperPhase * Math.PI * 2))) / 2;
    this.wiperArms.forEach((a) => (a.rotation.z = this.wiperAngle));

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

  private drawCluster(s: CockpitState) {
    const g = this.clusterCanvas.getContext('2d')!;
    const W = 256, H = 96;
    g.fillStyle = '#050608';
    g.fillRect(0, 0, W, H);
    // shift-light bar
    const n = 20;
    const lit = Math.round((s.rpm / s.maxRpm) * n);
    for (let i = 0; i < n; i++) {
      g.fillStyle = i < lit ? (i >= 17 ? '#ff2a3a' : i >= 13 ? '#ffc400' : '#2fd27a') : '#1a1d22';
      g.fillRect(8 + i * 12, 8, 9, 12);
    }
    g.textAlign = 'center';
    g.fillStyle = '#ff8a2a';
    g.font = 'bold 52px sans-serif';
    g.fillText(s.gear === -1 ? 'R' : s.gear === 0 ? 'N' : String(s.gear), 50, 82);
    const sp = Math.abs(s.speed) * 3.6 * (s.speedUnit === 'mph' ? 0.621371 : 1);
    g.fillStyle = '#e8eef4';
    g.font = 'bold 44px monospace';
    g.fillText(String(Math.round(sp)), 170, 78);
    g.font = 'bold 12px sans-serif';
    g.fillStyle = '#7c8794';
    g.fillText(s.speedUnit === 'mph' ? 'MPH' : 'KM/H', 230, 86);
    g.fillText(`${Math.round(s.rpm / 100) * 100} RPM`, 170, 34);
    this.clusterTex.needsUpdate = true;
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
