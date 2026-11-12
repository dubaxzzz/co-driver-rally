import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarModelId, PaintOption, VehicleDef, WheelOption } from '@cdr/shared';

/** Wheel layout shared by the model and the physics. Car faces +Z, left is +X. */
export const WHEEL_LAYOUT = {
  halfTrack: 0.8,
  frontZ: 1.28,
  rearZ: -1.22,
  connectionY: -0.12,
  radius: 0.34,
  width: 0.24,
};

export interface CarModel {
  root: THREE.Group;
  body: THREE.Group;
  /** Order: FL, FR, RL, RR */
  wheels: THREE.Group[];
  readonly modelId: CarModelId;
  setPaint(p: PaintOption): void;
  setWheels(w: WheelOption): void;
  setBrakeLights(on: boolean): void;
  /** Hide the outside of the car (first-person views show the cockpit instead). */
  setExteriorVisible(v: boolean): void;
  /** Creates the 3D headlights (spot lights) – only for the car a camera sits in. */
  enableHeadlights(): void;
  /** Dipped beams on/off (the HEADLIGHTS switch). */
  setHeadlights(on: boolean): void;
  /** Extra light pod for more reach (the LIGHT POD switch). */
  setLightPod(on: boolean): void;
  /** Hazard lights flash the indicators. */
  setHazards(on: boolean): void;
  /** Front-end damage smashes the headlights (left first, then right, then the pod). */
  setHeadlightDamage(front: number): void;
  /** Call every frame for blinking lights. */
  tick(time: number): void;
  readonly lightPodOn: boolean;
  dispose(): void;
}

// ---------------------------------------------------------------- textures
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const numberTexture = (num: string) =>
  canvasTex(128, 128, (g) => {
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.roundRect(6, 6, 116, 116, 18);
    g.fill();
    g.fillStyle = '#111';
    g.font = 'bold italic 78px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(num, 64, 70);
  });

const plateTexture = (text: string) =>
  canvasTex(256, 64, (g) => {
    g.fillStyle = '#f4f1e6';
    g.fillRect(0, 0, 256, 64);
    g.strokeStyle = '#111';
    g.lineWidth = 4;
    g.strokeRect(3, 3, 250, 58);
    g.fillStyle = '#1f3fa8';
    g.fillRect(3, 3, 30, 58);
    g.fillStyle = '#111';
    g.font = 'bold 40px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 144, 34);
  });

const sponsorTexture = (text: string, bg: string, fg: string) =>
  canvasTex(256, 64, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = fg;
    g.font = 'bold italic 40px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 34);
  });

const grilleTexture = () => {
  const t = canvasTex(64, 64, (g) => {
    g.fillStyle = '#070809';
    g.fillRect(0, 0, 64, 64);
    g.strokeStyle = '#2a2d31';
    g.lineWidth = 3;
    for (let i = -64; i < 128; i += 10) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i + 64, 64);
      g.moveTo(i + 64, 0);
      g.lineTo(i, 64);
      g.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 2);
  return t;
};

const treadTexture = () => {
  const t = canvasTex(64, 256, (g) => {
    g.fillStyle = '#1b1b1b';
    g.fillRect(0, 0, 64, 256);
    g.fillStyle = '#0b0b0b';
    for (let y = 0; y < 256; y += 16) {
      g.fillRect(4, y, 24, 8);
      g.fillRect(36, y + 8, 24, 8);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};

// ---------------------------------------------------------------- geometry helpers
type P = [number, number]; // [z, y] in the car's side view

/** Extrudes a side-view outline across the car (x), with rounded edges. */
function sideExtrude(outline: P[] | THREE.Shape, width: number, bevel: number) {
  const shape = outline instanceof THREE.Shape ? outline : new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(z, y)));
  const depth = Math.max(0.01, width - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 10 });
  // shape x → car z, shape y → car y, extrusion → car x (centred)
  g.rotateY(-Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

/** Lower-body outline with semicircular wheel-arch cut-outs along the bottom edge. */
function bodyShape(top: P[], bottomY: number, rearZ: number, frontZ: number, archR: number, archY: number) {
  const s = new THREE.Shape();
  s.moveTo(rearZ, bottomY);
  for (const wz of [WHEEL_LAYOUT.rearZ, WHEEL_LAYOUT.frontZ]) {
    const dy = bottomY - archY;
    const dz = Math.sqrt(Math.max(0.0001, archR * archR - dy * dy));
    s.lineTo(wz - dz, bottomY);
    s.absarc(wz, archY, archR, Math.atan2(dy, -dz), Math.atan2(dy, dz), true);
  }
  s.lineTo(frontZ, bottomY);
  for (const [z, y] of top) s.lineTo(z, y);
  s.lineTo(rearZ, bottomY);
  return s;
}

/** A box spanning two side-view points (pillars, struts, trim lines). */
function strut(a: P, b: P, thick: number, depth: number) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const g = new THREE.BoxGeometry(depth, thick, len);
  const m = new THREE.Matrix4().makeRotationX(-Math.atan2(b[1] - a[1], b[0] - a[0]));
  g.applyMatrix4(m);
  g.translate(0, (a[1] + b[1]) / 2, (a[0] + b[0]) / 2);
  return g;
}

interface Spec {
  number: string;
  plate: string;
  sponsor: [string, string, string];
  rideY: number; // whole body raised (trucks)
}

const SPECS: Record<CarModelId, Spec> = {
  kestrel: { number: '7', plate: 'KR5 007', sponsor: ['KESTREL', '#111', '#ffcc00'], rideY: 0 },
  sparrow: { number: '12', plate: 'SPR 12', sponsor: ['SPARROW', '#f2f2f2', '#c8102e'], rideY: 0 },
  dune: { number: '44', plate: 'DUNE 44', sponsor: ['DUNE', '#2b2b2b', '#ff8a00'], rideY: 0.12 },
  bruno: { number: '30', plate: 'GRP B 30', sponsor: ['BRUNO', '#0a2a6b', '#ffffff'], rideY: -0.03 },
  vortex: { number: '1', plate: 'RX1 HYB', sponsor: ['VORTEX', '#00c2ff', '#06121c'], rideY: -0.02 },
};

/** Builds a detailed rally car. Each model id has its own body, lights and details. */
export function createCarModel(paint: PaintOption, wheel: WheelOption, bodyDef?: VehicleDef['body']): CarModel {
  const modelId: CarModelId = bodyDef?.model ?? 'kestrel';
  const spec = SPECS[modelId];
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = spec.rideY;
  root.add(body);
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(o: T) => (disposables.push(o), o);

  const M = (o: THREE.MeshStandardMaterialParameters) => track(new THREE.MeshStandardMaterial(o));
  const paintMat = M({ color: paint.body, metalness: 0.5, roughness: 0.28 });
  const accentMat = M({ color: paint.accent, metalness: 0.35, roughness: 0.4 });
  const black = M({ color: 0x0e0f11, roughness: 0.75 });
  const satin = M({ color: 0x1c1e22, roughness: 0.55, metalness: 0.3 });
  const chrome = M({ color: 0xd8dde2, metalness: 1, roughness: 0.18 });
  const glass = M({ color: 0x0b141d, metalness: 0.9, roughness: 0.06, transparent: true, opacity: 0.88 });
  const lens = M({ color: 0xfff7e0, emissive: 0xfff1c0, emissiveIntensity: 0.15, roughness: 0.1, metalness: 0.2 });
  const podLens = M({ color: 0xfff7e0, emissive: 0xfff1c0, emissiveIntensity: 0.05, roughness: 0.1, metalness: 0.2 });
  const tailMat = M({ color: 0x4a0000, emissive: 0xff1010, emissiveIntensity: 0.35, roughness: 0.25 });
  const amber = M({ color: 0x5a3000, emissive: 0xff8a00, emissiveIntensity: 0.05, roughness: 0.3 });
  const red = M({ color: 0xd0141c, roughness: 0.5 });
  const carbon = M({ color: 0x15171a, roughness: 0.35, metalness: 0.4 });
  const grilleTex = track(grilleTexture());
  const grilleMat = M({ map: grilleTex, roughness: 0.8 });
  const numTex = track(numberTexture(bodyDef?.number ?? spec.number));
  const numMat = M({ map: numTex, transparent: true, roughness: 0.6 });
  const plateTex = track(plateTexture(spec.plate));
  const plateMat = M({ map: plateTex, roughness: 0.6 });
  const sponsorTex = track(sponsorTexture(...(bodyDef?.sponsor ?? spec.sponsor)));
  const sponsorMat = M({ map: sponsorTex, roughness: 0.5 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = body) => {
    const m = new THREE.Mesh(track(geo), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  const cyl = (r: number, len: number, mat: THREE.Material, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'z', seg = 16) => {
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    return add(g, mat, x, y, z);
  };
  const decal = (w: number, h: number, mat: THREE.Material, side: 1 | -1, x: number, y: number, z: number) => {
    const m = add(new THREE.PlaneGeometry(w, h), mat, side * x, y, z);
    m.rotation.y = (side * Math.PI) / 2;
    m.castShadow = false;
    return m;
  };

  // --------------------------------------------------------- shared detail parts
  const lowBeams: THREE.Mesh[] = [];
  const podLamps: THREE.Mesh[] = [];
  const tails: THREE.Mesh[] = [];
  const indicators: THREE.Mesh[] = [];

  /** Headlight unit: housing, reflector and lens (round or rectangular). */
  const headlight = (x: number, y: number, z: number, w: number, h: number, round: boolean) => {
    if (round) {
      cyl(w / 2 + 0.015, 0.05, chrome, x, y, z - 0.01, 'z', 20);
      lowBeams.push(cyl(w / 2, 0.06, lens, x, y, z, 'z', 20));
    } else {
      box(w + 0.03, h + 0.03, 0.05, black, x, y, z - 0.01);
      lowBeams.push(box(w, h, 0.06, lens, x, y, z));
      box(w * 0.3, h * 0.6, 0.065, chrome, x + w * 0.25, y, z + 0.002);
    }
  };
  const taillight = (x: number, y: number, z: number, w: number, h: number) => {
    box(w + 0.02, h + 0.02, 0.04, black, x, y, z + 0.01);
    tails.push(box(w, h, 0.05, tailMat, x, y, z));
  };
  const indicator = (x: number, y: number, z: number, s = 0.07) => indicators.push(box(s, s * 0.6, 0.04, amber, x, y, z));
  const doorLines = (w: number, frontZ: number, rearZ: number, topY: number, botY: number) => {
    for (const s of [1, -1] as const) {
      const x = s * (w / 2 + 0.004);
      add(strut([frontZ, botY], [frontZ, topY], 0.012, 0.008), black, x);
      add(strut([rearZ, botY], [rearZ, topY], 0.012, 0.008), black, x);
      add(strut([rearZ, botY], [frontZ, botY], 0.012, 0.008), black, x);
      box(0.02, 0.025, 0.12, chrome, x + s * 0.008, topY - 0.06, rearZ + 0.18); // handle
    }
  };
  const mudflaps = (w: number, z: number, y: number) => {
    for (const s of [1, -1]) {
      box(0.26, 0.24, 0.015, black, s * (w / 2 - 0.12), y, z);
      box(0.2, 0.06, 0.017, accentMat, s * (w / 2 - 0.12), y - 0.06, z);
    }
  };
  const towHook = (z: number, y: number, x: number) => {
    const g = new THREE.TorusGeometry(0.04, 0.012, 6, 12);
    g.rotateY(Math.PI / 2);
    add(g, red, x, y, z);
  };
  const plate = (z: number, y: number, facing: 1 | -1) => {
    const m = add(new THREE.PlaneGeometry(0.42, 0.105), plateMat, 0, y, z);
    if (facing < 0) m.rotation.y = Math.PI;
    m.castShadow = false;
  };
  const exhaust = (x: number, y: number, z: number, r = 0.045) => {
    cyl(r, 0.18, chrome, x, y, z, 'z');
    cyl(r * 0.7, 0.19, black, x, y, z - 0.002, 'z');
  };
  const numbers = (x: number, y: number, z: number, s = 0.42) => {
    decal(s, s, numMat, 1, x, y, z);
    decal(s, s, numMat, -1, x, y, z);
  };
  const sponsor = (x: number, y: number, z: number, w = 0.7) => {
    decal(w, w / 4, sponsorMat, 1, x, y, z);
    decal(w, w / 4, sponsorMat, -1, x, y, z);
  };
  /** A flat stripe that follows the top of the car (bonnet → roof → boot). */
  const stripe = (pts: P[], w: number, x: number) => {
    for (let i = 0; i < pts.length - 1; i++) add(strut([pts[i][0], pts[i][1] + 0.012], [pts[i + 1][0], pts[i + 1][1] + 0.012], 0.012, w), accentMat, x);
  };
  /** A decal rotated within the body side (diagonal graphics). */
  const slantDecal = (w: number, h: number, angle: number, x: number, y: number, z: number) => {
    for (const side of [1, -1] as const) {
      const g = new THREE.PlaneGeometry(w, h);
      g.rotateZ(side * angle);
      const m = add(g, accentMat, side * x, y, z);
      m.rotation.y = (side * Math.PI) / 2;
      m.castShadow = false;
    }
  };
  const flare = (w: number, archR: number, archY: number, thick: number, out: number) => {
    // a ring segment around each arch, sticking out from the body side
    for (const wz of [WHEEL_LAYOUT.frontZ, WHEEL_LAYOUT.rearZ]) {
      const s = new THREE.Shape();
      s.absarc(0, 0, archR + thick, Math.PI * 0.05, Math.PI * 0.95, false);
      s.absarc(0, 0, archR, Math.PI * 0.95, Math.PI * 0.05, true);
      for (const side of [1, -1]) {
        const g = new THREE.ExtrudeGeometry(s, { depth: out, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 1, curveSegments: 14 });
        g.rotateY(-Math.PI / 2);
        add(g, black, side > 0 ? w / 2 + out : -w / 2, archY, wz);
      }
    }
  };
  const roundPod = (y: number, z: number, n: number, r: number, spacing: number) => {
    box(spacing * n + 0.06, r * 2 + 0.06, 0.08, black, 0, y, z - 0.03);
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * spacing;
      cyl(r + 0.012, 0.04, chrome, x, y, z + 0.01, 'z', 18);
      podLamps.push(cyl(r, 0.05, podLens, x, y, z + 0.02, 'z', 18));
    }
  };

  // --------------------------------------------------------- per-car bodies
  if (modelId === 'kestrel') buildKestrel();
  else if (modelId === 'sparrow') buildSparrow();
  else if (modelId === 'dune') buildDune();
  else if (modelId === 'bruno') buildBruno();
  else buildVortex();
  screenExtras();

  /**
   * Things every car has on its windscreen: a tinted sun strip with the event
   * banner across the top, and two parked wiper arms at the bottom.
   */
  function screenExtras() {
    // [bottom, top, glass width, glass bevel] – matching each body's windscreen
    const WS: Record<CarModelId, [P, P, number, number]> = {
      kestrel: [[0.84, 0.44], [0.36, 0.86], 1.54, 0.05],
      sparrow: [[0.78, 0.45], [0.32, 0.88], 1.42, 0.08],
      dune: [[0.95, 0.56], [0.55, 1.06], 1.7, 0.04],
      bruno: [[0.72, 0.38], [0.15, 0.82], 1.5, 0.04],
      vortex: [[0.86, 0.44], [0.3, 0.86], 1.58, 0.04],
    };
    const [[z0, y0], [z1, y1], gw, bev] = WS[modelId];
    const len = Math.hypot(z1 - z0, y1 - y0);
    const tilt = Math.atan2(z1 - z0, y1 - y0);
    const screen = new THREE.Group();
    screen.position.set(0, y0, z0);
    screen.rotation.x = tilt; // local +Y runs up the glass, +Z points out of it
    body.add(screen);
    const bannerTex = track(
      canvasTex(512, 40, (g) => {
        g.fillStyle = '#0b1a2e';
        g.fillRect(0, 0, 512, 40);
        g.fillStyle = '#ffffff';
        g.font = 'italic 900 26px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('CO-DRIVER  RALLY', 256, 21);
      }),
    );
    const strip = add(new THREE.PlaneGeometry(gw - bev * 2 - 0.04, 0.09), M({ map: bannerTex, roughness: 0.4, metalness: 0.2 }), 0, len - 0.075, bev + 0.004, screen);
    strip.castShadow = false;
    for (const [x, l] of [[0.32, 0.5], [-0.24, 0.5]] as const) {
      const arm = add(new THREE.BoxGeometry(l, 0.012, 0.014), black, x - 0.04, 0.05, bev + 0.012, screen);
      arm.rotation.z = 0.05;
      add(new THREE.BoxGeometry(l * 0.85, 0.018, 0.02), black, x - 0.06, 0.07, bev + 0.01, screen).rotation.z = 0.05;
      add(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 10), satin, x + l / 2 - 0.04, 0.03, bev + 0.01, screen).rotation.x = Math.PI / 2;
    }
  }

  /** Kestrel R5 – boxy modern rally hatch, big flares, roof scoop, rear wing. */
  function buildKestrel() {
    const W = 1.72, archR = 0.44, archY = -0.34;
    const lower = bodyShape([[2.06, 0.02], [2.02, 0.26], [1.85, 0.34], [0.84, 0.44], [-1.72, 0.47], [-1.98, 0.4], [-2.02, 0.1]], -0.2, -2.02, 2.04, archR, archY);
    add(sideExtrude(lower, W, 0.06), paintMat);
    add(sideExtrude([[0.84, 0.44], [0.36, 0.86], [-1.12, 0.9], [-1.62, 0.6], [-1.72, 0.47]], W - 0.18, 0.05), glass);
    add(sideExtrude([[0.36, 0.86], [0.3, 0.9], [-1.14, 0.94], [-1.12, 0.9]], W - 0.22, 0.03), paintMat); // roof
    for (const s of [1, -1]) {
      const x = s * (W / 2 - 0.11);
      add(strut([0.84, 0.44], [0.36, 0.87], 0.05, 0.05), paintMat, x); // A
      add(strut([-0.38, 0.45], [-0.42, 0.89], 0.06, 0.05), paintMat, x); // B
      add(strut([-1.25, 0.46], [-1.1, 0.9], 0.18, 0.05), paintMat, x); // C (wide)
    }
    flare(W, archR, archY, 0.09, 0.07);
    box(W + 0.12, 0.06, 2.0, black, 0, -0.17, 0.04); // side skirts
    // front: bumper, grille, splitter, lights, pod
    box(1.78, 0.24, 0.16, satin, 0, -0.06, 2.04);
    add(new THREE.PlaneGeometry(0.9, 0.14), grilleMat, 0, 0.1, 2.075);
    box(1.6, 0.03, 0.18, black, 0, -0.19, 2.1);
    headlight(0.6, 0.2, 2.03, 0.34, 0.11, false);
    headlight(-0.6, 0.2, 2.03, 0.34, 0.11, false);
    indicator(0.8, 0.06, 2.07);
    indicator(-0.8, 0.06, 2.07);
    roundPod(0.4, 1.88, 4, 0.085, 0.26);
    for (const s of [0.4, -0.4]) box(0.18, 0.015, 0.3, black, s, 0.42, 1.25); // bonnet vents
    box(0.42, 0.1, 0.4, black, 0, 0.98, 0.0); // roof scoop
    box(0.38, 0.06, 0.02, satin, 0, 0.98, 0.21);
    cyl(0.006, 0.4, black, -0.4, 1.12, -0.9, 'y'); // aerial
    // rear: hatch spoiler wing, lights, diffuser, exhausts
    box(1.66, 0.04, 0.42, accentMat, 0, 0.98, -1.8);
    for (const s of [1, -1]) box(0.03, 0.22, 0.48, carbon, s * 0.82, 0.92, -1.8);
    for (const s of [1, -1]) box(0.08, 0.16, 0.06, carbon, s * 0.5, 0.86, -1.72);
    taillight(0.68, 0.32, -2.0, 0.26, 0.14);
    taillight(-0.68, 0.32, -2.0, 0.26, 0.14);
    box(1.78, 0.24, 0.16, satin, 0, -0.06, -2.02);
    for (let i = -2; i <= 2; i++) box(0.02, 0.1, 0.16, black, i * 0.18, -0.16, -2.06);
    exhaust(-0.45, -0.12, -2.08, 0.05);
    plate(-2.03, 0.15, -1);
    plate(2.13, -0.04, 1);
    doorLines(W, 0.72, -0.4, 0.42, -0.14);
    numbers(W / 2 + 0.006, 0.12, 0.15);
    sponsor(W / 2 + 0.006, -0.08, -0.85);
    mudflaps(W, -1.72, -0.3);
    mudflaps(W, 0.82, -0.3);
    towHook(2.14, -0.08, 0.55);
    towHook(-2.1, -0.08, -0.55);
    // livery: accent band along the sides and a bonnet stripe
    for (const s of [1, -1] as const) decal(3.6, 0.06, accentMat, s, W / 2 + 0.005, 0.32, 0.0);
    stripe([[1.98, 0.3], [1.85, 0.34], [0.86, 0.44]], 0.32, 0);
    stripe([[0.84, 0.445], [0.36, 0.88], [0.3, 0.92], [-1.14, 0.955]], 0.32, 0);
  }

  /** Sparrow R2 – small, rounded classic hatch with chrome trim and round lamps. */
  function buildSparrow() {
    const W = 1.62, archR = 0.42, archY = -0.33;
    const lower = bodyShape([[1.92, 0.0], [1.9, 0.22], [1.72, 0.34], [0.78, 0.45], [-1.62, 0.48], [-1.82, 0.42], [-1.86, 0.08]], -0.18, -1.86, 1.9, archR, archY);
    add(sideExtrude(lower, W, 0.1), paintMat);
    add(sideExtrude([[0.78, 0.45], [0.32, 0.88], [-1.2, 0.9], [-1.55, 0.62], [-1.62, 0.48]], W - 0.2, 0.08), glass);
    add(sideExtrude([[0.32, 0.88], [0.28, 0.92], [-1.22, 0.94], [-1.2, 0.9]], W - 0.24, 0.05), paintMat);
    for (const s of [1, -1]) {
      const x = s * (W / 2 - 0.12);
      add(strut([0.78, 0.45], [0.32, 0.89], 0.04, 0.05), paintMat, x);
      add(strut([-0.42, 0.46], [-0.44, 0.9], 0.05, 0.05), paintMat, x);
      add(strut([-1.35, 0.47], [-1.22, 0.9], 0.12, 0.05), paintMat, x);
    }
    // chrome bumpers, round headlights, spot lamps on the bumper
    box(1.7, 0.1, 0.12, chrome, 0, -0.04, 1.96);
    box(1.7, 0.1, 0.12, chrome, 0, -0.02, -1.9);
    add(new THREE.PlaneGeometry(0.7, 0.12), grilleMat, 0, 0.12, 1.925);
    box(0.74, 0.02, 0.02, chrome, 0, 0.19, 1.93);
    headlight(0.56, 0.16, 1.92, 0.2, 0.2, true);
    headlight(-0.56, 0.16, 1.92, 0.2, 0.2, true);
    indicator(0.56, 0.01, 1.98, 0.06);
    indicator(-0.56, 0.01, 1.98, 0.06);
    roundPod(0.08, 2.05, 2, 0.08, 0.6);
    taillight(0.62, 0.28, -1.87, 0.18, 0.12);
    taillight(-0.62, 0.28, -1.87, 0.18, 0.12);
    box(1.3, 0.035, 0.18, accentMat, 0, 0.93, -1.6); // roof lip spoiler
    for (const s of [1, -1]) box(1.2, 0.02, 0.012, chrome, s * (W / 2 + 0.003), 0.36, 0.1); // chrome belt trim
    exhaust(0.55, -0.12, -1.92, 0.035);
    plate(-1.97, 0.12, -1);
    plate(2.03, -0.02, 1);
    doorLines(W, 0.68, -0.44, 0.43, -0.12);
    numbers(W / 2 + 0.006, 0.1, 0.12, 0.38);
    sponsor(W / 2 + 0.006, -0.08, -0.9, 0.6);
    mudflaps(W, -1.62, -0.28);
    towHook(-1.97, -0.06, -0.5);
    // twin racing stripes over bonnet, roof and boot
    for (const off of [0.17, -0.17]) stripe([[1.9, 0.22], [1.72, 0.34], [0.78, 0.45], [0.32, 0.89], [0.28, 0.925], [-1.22, 0.945], [-1.55, 0.63], [-1.62, 0.49]], 0.14, off);
  }

  /** Dune Raider – 4×4 pick-up: tall cab, bed with spare wheel, roll hoop, light bar, bull bar, snorkel. */
  function buildDune() {
    const W = 1.84, archR = 0.47, archY = -0.36;
    const lower = bodyShape([[2.1, 0.05], [2.08, 0.4], [1.9, 0.5], [0.95, 0.56], [-2.12, 0.56], [-2.16, 0.1]], -0.14, -2.16, 2.12, archR, archY);
    add(sideExtrude(lower, W, 0.05), paintMat);
    // cab only (bed is open)
    add(sideExtrude([[0.95, 0.56], [0.55, 1.06], [-0.55, 1.08], [-0.62, 0.56]], W - 0.14, 0.04), glass);
    add(sideExtrude([[0.55, 1.06], [0.5, 1.1], [-0.58, 1.12], [-0.55, 1.08]], W - 0.16, 0.02), paintMat);
    for (const s of [1, -1]) {
      const x = s * (W / 2 - 0.08);
      add(strut([0.95, 0.56], [0.55, 1.07], 0.06, 0.05), paintMat, x);
      add(strut([-0.1, 0.57], [-0.1, 1.08], 0.06, 0.05), paintMat, x);
      add(strut([-0.6, 0.57], [-0.57, 1.08], 0.1, 0.05), paintMat, x);
    }
    // bed: floor + inner walls + spare wheel + roll hoop
    box(W - 0.16, 0.03, 1.45, black, 0, 0.42, -1.38);
    box(W - 0.1, 0.16, 0.05, paintMat, 0, 0.5, -2.08); // tailgate
    const spare = new THREE.TorusGeometry(0.26, 0.11, 10, 20);
    spare.rotateX(Math.PI / 2);
    add(spare, black, 0, 0.55, -1.35);
    for (const s of [1, -1]) cyl(0.035, 0.62, satin, s * 0.78, 0.86, -0.72, 'y');
    cyl(0.035, 1.56, satin, 0, 1.17, -0.72, 'x');
    for (const s of [1, -1]) add(strut([-0.72, 1.17], [-1.9, 0.6], 0.06, 0.06), satin, s * 0.78);
    // roof light bar, roof rack, snorkel
    box(1.4, 0.12, 0.14, black, 0, 1.2, 0.36);
    for (let i = 0; i < 6; i++) podLamps.push(box(0.17, 0.08, 0.02, podLens, (i - 2.5) * 0.22, 1.2, 0.44));
    for (const s of [1, -1]) box(0.04, 0.05, 1.0, satin, s * 0.7, 1.16, -0.06);
    cyl(0.05, 0.75, black, 0.9, 0.85, 0.85, 'y');
    box(0.12, 0.1, 0.14, black, 0.9, 1.22, 0.85);
    // front: bull bar, square lamps, big grille, winch
    box(1.6, 0.36, 0.08, black, 0, 0.18, 2.12);
    add(new THREE.PlaneGeometry(1.0, 0.24), grilleMat, 0, 0.3, 2.11);
    for (const s of [1, -1]) {
      cyl(0.04, 0.6, satin, s * 0.62, 0.15, 2.28, 'y');
      headlight(s * 0.66, 0.36, 2.1, 0.24, 0.16, false);
      indicator(s * 0.84, 0.22, 2.13);
    }
    cyl(0.04, 1.3, satin, 0, 0.42, 2.28, 'x');
    cyl(0.04, 1.3, satin, 0, -0.1, 2.28, 'x');
    cyl(0.07, 0.36, satin, 0, -0.02, 2.2, 'x'); // winch drum
    box(1.6, 0.08, 0.6, black, 0, -0.18, 1.6); // skid plate
    // side steps, chunky flares, rear lamps
    box(0.18, 0.04, 1.3, satin, 0.96, -0.12, -0.05);
    box(0.18, 0.04, 1.3, satin, -0.96, -0.12, -0.05);
    flare(W, archR, archY, 0.12, 0.09);
    taillight(0.78, 0.36, -2.15, 0.16, 0.24);
    taillight(-0.78, 0.36, -2.15, 0.16, 0.24);
    box(1.7, 0.14, 0.12, black, 0, -0.06, -2.18);
    plate(-2.19, 0.18, -1);
    plate(2.17, 0.0, 1);
    doorLines(W, 0.88, -0.58, 0.54, -0.1);
    numbers(W / 2 + 0.006, 0.22, 0.15, 0.4);
    sponsor(W / 2 + 0.006, 0.2, -1.4, 0.8);
    mudflaps(W, -1.78, -0.26);
    towHook(-2.2, -0.04, 0);
    exhaust(-0.6, -0.18, -2.2, 0.05);
    for (const s of [1, -1] as const) decal(4.1, 0.08, accentMat, s, W / 2 + 0.005, 0.02, -0.02);
  }

  /** Bruno 300 – 80s Group B wedge coupe: low nose, louvred engine cover, side intakes, big wing. */
  function buildBruno() {
    const W = 1.8, archR = 0.45, archY = -0.34;
    const lower = bodyShape([[2.08, -0.06], [2.06, 0.1], [1.7, 0.22], [0.72, 0.38], [-1.0, 0.45], [-1.85, 0.48], [-2.02, 0.44], [-2.04, 0.08]], -0.21, -2.04, 2.08, archR, archY);
    add(sideExtrude(lower, W, 0.05), paintMat);
    add(sideExtrude([[0.72, 0.38], [0.15, 0.82], [-0.75, 0.84], [-1.1, 0.46]], W - 0.3, 0.04), glass);
    add(sideExtrude([[0.15, 0.82], [0.1, 0.86], [-0.78, 0.88], [-0.75, 0.84]], W - 0.34, 0.02), paintMat);
    for (const s of [1, -1]) {
      const x = s * (W / 2 - 0.17);
      add(strut([0.72, 0.38], [0.15, 0.83], 0.05, 0.05), paintMat, x);
      add(strut([-0.75, 0.84], [-1.3, 0.46], 0.22, 0.06), paintMat, x); // flying buttress
      box(0.06, 0.24, 0.6, black, s * (W / 2 + 0.01), 0.18, -0.9); // side intake
      for (let i = 0; i < 5; i++) box(0.065, 0.015, 0.56, satin, s * (W / 2 + 0.012), 0.08 + i * 0.045, -0.9);
    }
    // louvres over the engine cover
    for (let i = 0; i < 7; i++) box(1.1, 0.02, 0.06, black, 0, 0.48 + i * 0.002, -1.25 - i * 0.1);
    // pop-up headlamps (closed covers with a lamp slot) + 4-lamp rally pod on the nose
    for (const s of [1, -1]) {
      box(0.42, 0.05, 0.36, paintMat, s * 0.52, 0.27, 1.58);
      headlight(s * 0.52, 0.2, 1.78, 0.34, 0.06, false);
      indicator(s * 0.78, 0.0, 2.08, 0.08);
    }
    roundPod(0.16, 2.12, 4, 0.08, 0.24);
    add(new THREE.PlaneGeometry(1.2, 0.08), grilleMat, 0, -0.05, 2.09);
    box(1.82, 0.03, 0.2, black, 0, -0.2, 2.06); // chin
    // giant wing on stalks, rear lamp strip, quad exhausts
    box(1.8, 0.05, 0.5, accentMat, 0, 0.95, -1.82);
    for (const s of [1, -1]) {
      box(0.04, 0.26, 0.56, carbon, s * 0.9, 0.88, -1.82);
      box(0.06, 0.42, 0.1, carbon, s * 0.55, 0.7, -1.82);
    }
    box(1.6, 0.06, 0.05, black, 0, 0.3, -2.04);
    taillight(0.6, 0.3, -2.06, 0.4, 0.08);
    taillight(-0.6, 0.3, -2.06, 0.4, 0.08);
    box(1.0, 0.16, 0.02, grilleMat, 0, 0.1, -2.05);
    for (const s of [0.2, 0.32, -0.2, -0.32]) exhaust(s, -0.1, -2.1, 0.035);
    plate(-2.06, -0.06, -1);
    doorLines(W, 0.64, -0.62, 0.38, -0.16);
    numbers(W / 2 + 0.006, 0.12, 0.0);
    sponsor(W / 2 + 0.006, -0.1, 1.0, 0.65);
    mudflaps(W, -1.68, -0.3);
    flare(W, archR, archY, 0.06, 0.04);
    towHook(2.1, -0.1, 0.6);
    // deep wedge stripe
    slantDecal(3.9, 0.12, 0.04, W / 2 + 0.005, 0.25, 0.0);
  }

  /** Vortex RX – modern Rally1 hybrid: LED slivers, canards, vented arches, swan-neck wing, diffuser. */
  function buildVortex() {
    const W = 1.84, archR = 0.45, archY = -0.34;
    const lower = bodyShape([[2.12, -0.02], [2.1, 0.18], [1.9, 0.3], [0.86, 0.44], [-1.7, 0.47], [-2.0, 0.42], [-2.06, 0.06]], -0.21, -2.06, 2.12, archR, archY);
    add(sideExtrude(lower, W, 0.04), paintMat);
    add(sideExtrude([[0.86, 0.44], [0.3, 0.86], [-1.1, 0.88], [-1.62, 0.56], [-1.7, 0.47]], W - 0.26, 0.04), glass);
    add(sideExtrude([[0.3, 0.86], [0.26, 0.9], [-1.12, 0.92], [-1.1, 0.88]], W - 0.3, 0.02), carbon);
    for (const s of [1, -1]) {
      const x = s * (W / 2 - 0.14);
      add(strut([0.86, 0.44], [0.3, 0.87], 0.05, 0.05), carbon, x);
      add(strut([-0.4, 0.45], [-0.44, 0.88], 0.06, 0.05), paintMat, x);
      add(strut([-1.3, 0.46], [-1.1, 0.88], 0.16, 0.05), paintMat, x);
      // vented arches: louvres over the front wheels, aero fin behind the rear wheel
      for (let i = 0; i < 4; i++) box(0.1, 0.012, 0.32, black, s * (W / 2 - 0.02), 0.28 + i * 0.012, 1.22 - i * 0.06);
      box(0.02, 0.22, 0.4, carbon, s * (W / 2 + 0.03), 0.12, -1.75);
      box(0.12, 0.02, 0.2, carbon, s * (W / 2 + 0.01), -0.02, 1.92); // canard
    }
    flare(W, archR, archY, 0.08, 0.08);
    box(W + 0.16, 0.05, 2.1, carbon, 0, -0.18, 0.04);
    // front: splitter, hex grille, LED slivers + pod
    box(1.9, 0.03, 0.3, carbon, 0, -0.2, 2.1);
    add(new THREE.PlaneGeometry(1.1, 0.2), grilleMat, 0, 0.04, 2.115);
    for (const s of [1, -1]) {
      lowBeams.push(box(0.4, 0.035, 0.05, lens, s * 0.58, 0.24, 2.05));
      const drl = box(0.36, 0.015, 0.055, lens, s * 0.6, 0.19, 2.06);
      drl.rotation.z = s * 0.15;
      indicator(s * 0.85, 0.2, 2.05, 0.06);
    }
    // LED pod: a slim bar across the bonnet nose
    box(1.2, 0.08, 0.06, black, 0, 0.36, 1.92);
    for (let i = 0; i < 8; i++) podLamps.push(box(0.12, 0.04, 0.02, podLens, (i - 3.5) * 0.14, 0.36, 1.955));
    box(0.5, 0.08, 0.45, carbon, 0, 0.96, 0.0); // roof scoop
    box(0.6, 0.02, 0.5, black, 0, 0.47, 1.1); // bonnet vent
    // swan-neck wing, diffuser, light strip
    box(1.86, 0.04, 0.42, carbon, 0, 1.08, -1.9);
    box(1.86, 0.02, 0.1, accentMat, 0, 1.11, -1.72);
    for (const s of [1, -1]) {
      box(0.03, 0.3, 0.5, carbon, s * 0.93, 1.0, -1.9);
      add(strut([-1.75, 0.6], [-1.9, 1.08], 0.05, 0.03), carbon, s * 0.4);
    }
    tails.push(box(1.6, 0.025, 0.04, tailMat, 0, 0.36, -2.04));
    taillight(0.7, 0.3, -2.03, 0.22, 0.08);
    taillight(-0.7, 0.3, -2.03, 0.22, 0.08);
    for (let i = -3; i <= 3; i++) box(0.015, 0.16, 0.3, carbon, i * 0.2, -0.13, -2.0);
    exhaust(-0.62, -0.06, -2.1, 0.06);
    plate(-2.08, 0.14, -1);
    doorLines(W, 0.74, -0.42, 0.42, -0.15);
    numbers(W / 2 + 0.006, 0.12, 0.15, 0.44);
    sponsor(W / 2 + 0.006, -0.08, -0.9, 0.75);
    mudflaps(W, -1.72, -0.3);
    towHook(2.14, -0.1, 0.6);
    towHook(-2.1, -0.08, -0.6);
    // hybrid livery: accent diagonal + glowing strip
    slantDecal(1.6, 0.16, 0.3, W / 2 + 0.005, 0.1, -0.35);
    slantDecal(1.2, 0.06, 0.3, W / 2 + 0.005, -0.05, -0.55);
  }

  // --------------------------------------------------------- wheels
  const tread = track(treadTexture());
  const tyreMat = M({ color: 0xffffff, map: tread, roughness: 0.95 });
  const wallMat = M({ color: 0x141414, roughness: 0.9 });
  const rimMat = M({ color: wheel.rim, metalness: 0.7, roughness: 0.3 });
  const discMat = M({ color: 0x8a8d91, metalness: 0.8, roughness: 0.45 });
  const caliperMat = M({ color: modelId === 'vortex' ? 0x00b7ff : modelId === 'dune' ? 0xffc400 : 0xd0141c, roughness: 0.4 });
  const wheels: THREE.Group[] = [];
  const radius = WHEEL_LAYOUT.radius;
  const width = modelId === 'dune' ? 0.3 : WHEEL_LAYOUT.width;
  const treadGeo = track(new THREE.CylinderGeometry(radius, radius, width, 32, 1, true));
  treadGeo.rotateZ(Math.PI / 2);
  const wallGeo = track(new THREE.RingGeometry(radius * 0.72, radius, 32));
  let rimGeos: THREE.BufferGeometry[] = [];
  const discGeo = track(new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, 0.025, 24));
  discGeo.rotateZ(Math.PI / 2);
  const caliperGeo = track(new THREE.BoxGeometry(0.06, 0.13, 0.09));

  const buildRim = (spin: THREE.Group, w: WheelOption) => {
    for (const c of [...spin.children]) if (c.name === 'rim') spin.remove(c);
    const rim = new THREE.Group();
    rim.name = 'rim';
    const barrel = new THREE.CylinderGeometry(radius * 0.72, radius * 0.72, width * 0.9, 24, 1, true);
    barrel.rotateZ(Math.PI / 2);
    rimGeos.push(barrel);
    rim.add(new THREE.Mesh(barrel, rimMat));
    const hub = new THREE.CylinderGeometry(0.065, 0.065, width + 0.02, 12);
    hub.rotateZ(Math.PI / 2);
    rimGeos.push(hub);
    rim.add(new THREE.Mesh(hub, rimMat));
    for (const side of [-1, 1]) {
      const lip = new THREE.TorusGeometry(radius * 0.72, 0.014, 6, 24);
      lip.rotateY(Math.PI / 2);
      rimGeos.push(lip);
      const l = new THREE.Mesh(lip, rimMat);
      l.position.x = (side * width) / 2.1;
      rim.add(l);
    }
    for (let i = 0; i < w.spokes; i++) {
      const g = new THREE.BoxGeometry(0.03, radius * 0.66, 0.045);
      g.translate(0, radius * 0.36, 0);
      rimGeos.push(g);
      for (const side of [-1, 1]) {
        const s = new THREE.Mesh(g, rimMat);
        s.rotation.x = (i / w.spokes) * Math.PI * 2;
        s.position.x = (side * width) / 2.3;
        rim.add(s);
      }
    }
    // centre lock nut
    const nut = new THREE.CylinderGeometry(0.035, 0.035, width + 0.05, 6);
    nut.rotateZ(Math.PI / 2);
    rimGeos.push(nut);
    rim.add(new THREE.Mesh(nut, chrome));
    spin.add(rim);
  };

  const positions: Array<[number, number]> = [
    [WHEEL_LAYOUT.halfTrack, WHEEL_LAYOUT.frontZ], // FL (left = +X when facing +Z)
    [-WHEEL_LAYOUT.halfTrack, WHEEL_LAYOUT.frontZ], // FR
    [WHEEL_LAYOUT.halfTrack, WHEEL_LAYOUT.rearZ], // RL
    [-WHEEL_LAYOUT.halfTrack, WHEEL_LAYOUT.rearZ], // RR
  ];
  for (const [x, z] of positions) {
    const steerGroup = new THREE.Group();
    steerGroup.position.set(x, WHEEL_LAYOUT.connectionY, z);
    const spin = new THREE.Group();
    spin.name = 'spin';
    const t = new THREE.Mesh(treadGeo, tyreMat);
    t.castShadow = true;
    spin.add(t);
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(wallGeo, wallMat);
      wall.position.x = (side * width) / 2;
      wall.rotation.y = (side * Math.PI) / 2;
      spin.add(wall);
    }
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.x = (x > 0 ? -1 : 1) * width * 0.15;
    spin.add(disc);
    buildRim(spin, wheel);
    steerGroup.add(spin);
    // the brake caliper doesn't spin with the wheel
    const cal = new THREE.Mesh(caliperGeo, caliperMat);
    cal.position.set((x > 0 ? -1 : 1) * width * 0.12, radius * 0.45, -radius * 0.25);
    steerGroup.add(cal);
    root.add(steerGroup);
    wheels.push(steerGroup);
  }

  boltOns();
  if (bodyDef?.widthScale) body.scale.x = bodyDef.widthScale;

  /** Variant parts: roof rack + spares, lamp bar, roof scoop, mud guards, snorkel. */
  function boltOns() {
    const extras = bodyDef?.extras ?? [];
    if (!extras.length) return;
    // roof: [front z, height] of the roof line and the body width, per chassis
    const ROOF: Record<CarModelId, [number, number, number]> = {
      kestrel: [0.36, 0.91, 1.72],
      sparrow: [0.32, 0.96, 1.62],
      dune: [0.55, 1.1, 1.84],
      bruno: [0.15, 0.86, 1.8],
      vortex: [0.3, 0.9, 1.84],
    };
    const [rz, ry, W] = ROOF[modelId];
    const y = ry; // body space (the body group carries the ride height)
    if (extras.includes('rack')) {
      for (const sx of [-1, 1]) {
        add(new THREE.BoxGeometry(0.04, 0.04, 1.2), satin, sx * 0.5, y + 0.06, rz - 0.75);
        for (const z of [rz - 0.25, rz - 1.25]) add(new THREE.BoxGeometry(0.03, 0.08, 0.03), satin, sx * 0.5, y + 0.02, z);
      }
      for (const z of [rz - 0.3, rz - 0.75, rz - 1.2]) add(new THREE.BoxGeometry(1.04, 0.03, 0.04), satin, 0, y + 0.07, z);
      // two spare tyres strapped flat
      for (const z of [rz - 0.55, rz - 1.0]) {
        const tyre = add(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 20), tyreMat, 0, y + 0.18, z);
        tyre.scale.set(1, 1, 0.75);
        add(new THREE.BoxGeometry(0.66, 0.205, 0.05), accentMat, 0, y + 0.18, z);
      }
    }
    if (extras.includes('lightbar')) {
      add(new THREE.BoxGeometry(1.1, 0.06, 0.08), black, 0, y + 0.08, rz - 0.08);
      for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.04, 0.1, 0.04), black, sx * 0.48, y + 0.02, rz - 0.1);
      for (let i = 0; i < 4; i++) {
        const x = -0.39 + i * 0.26;
        const can = add(new THREE.CylinderGeometry(0.075, 0.08, 0.09, 16), black, x, y + 0.15, rz - 0.04);
        can.rotation.x = Math.PI / 2;
        const l = add(new THREE.CircleGeometry(0.068, 16), podLens, x, y + 0.15, rz + 0.006);
        l.rotation.y = 0;
      }
    }
    if (extras.includes('scoop')) {
      add(new THREE.BoxGeometry(0.42, 0.09, 0.4), paintMat, 0, y + 0.04, rz - 0.4);
      add(new THREE.BoxGeometry(0.36, 0.06, 0.02), black, 0, y + 0.05, rz - 0.195);
    }
    if (extras.includes('mudguards')) {
      for (const [x, z] of positions) {
        const flap = add(new THREE.BoxGeometry(0.3, 0.32, 0.02), accentMat, x / (bodyDef?.widthScale ?? 1), WHEEL_LAYOUT.connectionY - 0.12 - spec.rideY, z - WHEEL_LAYOUT.radius - 0.08);
        flap.rotation.x = 0.08;
      }
    }
    if (extras.includes('snorkel')) {
      const sx = -(W / 2 + 0.02);
      add(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 12), black, sx, y - 0.32, rz + 0.25);
      const top = add(new THREE.BoxGeometry(0.12, 0.12, 0.16), black, sx, y + 0.06, rz + 0.25);
      top.rotation.x = 0.2;
    }
  }

  // --------------------------------------------------------- lights
  const lightRig = new THREE.Group();
  root.add(lightRig);
  let pod: THREE.SpotLight | null = null;
  let lowL: THREE.SpotLight | null = null;
  let lowR: THREE.SpotLight | null = null;
  let podOn = false;
  let beamsOn = true;
  let hazards = false;
  let frontDamage = 0;
  const frontZ = modelId === 'dune' ? 2.2 : 2.12;
  const spot = (x: number, y: number, z: number, intensity: number, angle: number, distance: number, aimY: number) => {
    const l = new THREE.SpotLight(0xfff0d8, intensity, distance, angle, 0.6, 1.3);
    l.position.set(x, y, z);
    l.target.position.set(x, y + aimY, z + 30);
    lightRig.add(l, l.target);
    return l;
  };
  const applyLights = () => {
    const lowOkL = frontDamage < 0.45, lowOkR = frontDamage < 0.8, podOk = frontDamage < 0.9;
    if (lowL) lowL.intensity = beamsOn && lowOkL ? 140 : 0;
    if (lowR) lowR.intensity = beamsOn && lowOkR ? 140 : 0;
    if (pod) pod.intensity = podOn && podOk ? 380 : 0;
    lens.emissiveIntensity = beamsOn && lowOkR ? 1.4 : 0.05;
    podLens.emissiveIntensity = podOn && podOk ? 2.2 : 0.05;
  };

  return {
    root,
    body,
    wheels,
    modelId,
    get lightPodOn() {
      return podOn;
    },
    setExteriorVisible(v) {
      body.visible = v;
      wheels.forEach((w) => (w.visible = v));
    },
    enableHeadlights() {
      if (lightRig.children.length) return;
      lowL = spot(0.5, 0.2 + spec.rideY, frontZ, 140, 0.5, 75, -3.2);
      lowR = spot(-0.5, 0.2 + spec.rideY, frontZ, 140, 0.5, 75, -3.2);
      pod = spot(0, 0.4 + spec.rideY, frontZ, 0, 0.26, 120, -1.6);
      applyLights();
    },
    setHeadlights(on) {
      beamsOn = on;
      applyLights();
    },
    setLightPod(on) {
      podOn = on;
      applyLights();
    },
    setHazards(on) {
      hazards = on;
      if (!on) amber.emissiveIntensity = 0.05;
    },
    setHeadlightDamage(front) {
      if (front === frontDamage) return;
      frontDamage = front;
      applyLights();
    },
    tick(time) {
      if (hazards) amber.emissiveIntensity = Math.floor(time * 2.4) % 2 ? 2.5 : 0.05;
    },
    setPaint(p) {
      paintMat.color.setHex(p.body);
      accentMat.color.setHex(p.accent);
    },
    setWheels(w) {
      rimMat.color.setHex(w.rim);
      rimGeos.forEach((g) => g.dispose());
      rimGeos = [];
      for (const wg of wheels) buildRim(wg.getObjectByName('spin') as THREE.Group, w);
    },
    setBrakeLights(on) {
      tailMat.emissiveIntensity = on ? 2.4 : 0.35;
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      rimGeos.forEach((g) => g.dispose());
    },
  };
}

/**
 * Merges the hundreds of little parts of a car into one mesh per material
 * (and one per wheel), so a rival car costs a few draw calls instead of
 * hundreds. Lights, paint and damage still work – they only change materials.
 * Only for cars nobody edits afterwards (AI and other players' cars).
 */
export function bakeCarModel(model: CarModel): void {
  const made: THREE.BufferGeometry[] = [];
  mergeByMaterial(model.body, made);
  for (const w of model.wheels) {
    const spin = w.getObjectByName('spin');
    if (spin) mergeByMaterial(spin, made);
  }
  const dispose = model.dispose.bind(model);
  model.dispose = () => {
    dispose();
    made.forEach((g) => g.dispose());
  };
}

function mergeByMaterial(root: THREE.Object3D, made: THREE.BufferGeometry[]) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const groups = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; shadow: boolean }>();
  const merged: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || (m as unknown as THREE.InstancedMesh).isInstancedMesh || !m.visible) return;
    const geo = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()) as THREE.BufferGeometry;
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((geo.attributes.position.count) * 2), 2));
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    let g = groups.get(m.material);
    if (!g) groups.set(m.material, (g = { geos: [], shadow: false }));
    g.geos.push(geo);
    g.shadow ||= m.castShadow;
    merged.push(m);
  });
  if (merged.length < 2) return;
  for (const m of merged) m.removeFromParent();
  for (const [mat, g] of groups) {
    const geo = mergeGeometries(g.geos, false);
    g.geos.forEach((x) => x.dispose());
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = g.shadow;
    mesh.userData.baked = true;
    made.push(geo);
    root.add(mesh);
  }
}
