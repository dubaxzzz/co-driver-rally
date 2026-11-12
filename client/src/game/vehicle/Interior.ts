import * as THREE from 'three';
import type { CarModelId, PaintOption } from '@cdr/shared';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Interior trim for each car: bucket seats with harnesses, roll cage (with
 * padding) in the car's own colour, floor, footrest, pedals, door cards and
 * the bits rally crews carry (fire extinguisher, intercom, grab handle).
 * The car faces +Z; its left side is +X (left-hand drive, driver at +dx).
 */

interface Theme {
  cage: number;
  seat: number;
  seatSide: number;
  harness: number;
  door: 'carbon' | 'alu' | 'vinyl';
  doorColor: number;
  floor: 'checker' | 'carpet';
  pad: number;
}

const THEMES: Record<CarModelId, Theme> = {
  kestrel: { cage: 0x8d949c, seat: 0x222329, seatSide: 0x33353d, harness: 0xd8261c, door: 'carbon', doorColor: 0x2a2c31, floor: 'checker', pad: 0x111214 },
  sparrow: { cage: 0xe6e6e2, seat: 0x5a3a24, seatSide: 0x6e4a30, harness: 0x1d4fb8, door: 'vinyl', doorColor: 0x5b4c3e, floor: 'carpet', pad: 0x1a1a1a },
  dune: { cage: 0xf0b400, seat: 0x7d6a52, seatSide: 0x5d4d3a, harness: 0x111214, door: 'alu', doorColor: 0x9aa0a6, floor: 'checker', pad: 0x1c1c1c },
  bruno: { cage: 0xc0302a, seat: 0x2a3540, seatSide: 0x1f2830, harness: 0xf0b400, door: 'alu', doorColor: 0x8f969c, floor: 'checker', pad: 0x111214 },
  vortex: { cage: 0x1c1e22, seat: 0x121316, seatSide: 0x24262b, harness: 0xff3a3a, door: 'carbon', doorColor: 0x1a1c20, floor: 'checker', pad: 0x0c0c0d },
};

export interface InteriorParts {
  /** Door card meshes (dented by side damage). */
  doors: Record<'left' | 'right', THREE.Mesh>;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat: [number, number] = [1, 1]) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  return t;
}

/** Aluminium "checker plate" (diamond tread) floor. */
const checkerTex = (repeat: [number, number]) =>
  canvasTex(128, 128, (g) => {
    g.fillStyle = '#5d6268';
    g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 32) {
      for (let x = 0; x < 128; x += 32) {
        const flip = ((x + y) / 32) % 2;
        g.save();
        g.translate(x + 16, y + 16);
        g.rotate(flip ? Math.PI / 4 : -Math.PI / 4);
        g.fillStyle = '#8b9096';
        g.fillRect(-11, -3, 22, 6);
        g.fillStyle = '#3f4348';
        g.fillRect(-11, 2, 22, 2);
        g.restore();
      }
    }
  }, repeat);

const carpetTex = (repeat: [number, number]) =>
  canvasTex(64, 64, (g) => {
    g.fillStyle = '#26221f';
    g.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 700; i++) {
      g.fillStyle = Math.random() < 0.5 ? '#2f2a26' : '#1d1a18';
      g.fillRect(Math.random() * 64, Math.random() * 64, 1.5, 1.5);
    }
  }, repeat);

const carbonTex = () =>
  canvasTex(64, 64, (g) => {
    g.fillStyle = '#16181b';
    g.fillRect(0, 0, 64, 64);
    for (let y = 0; y < 64; y += 8) {
      for (let x = 0; x < 64; x += 8) {
        const a = ((x + y) / 8) % 2;
        const grd = a ? g.createLinearGradient(x, y, x + 8, y) : g.createLinearGradient(x, y, x, y + 8);
        grd.addColorStop(0, '#202328');
        grd.addColorStop(0.5, '#33373d');
        grd.addColorStop(1, '#1a1c20');
        g.fillStyle = grd;
        g.fillRect(x + 0.5, y + 0.5, 7, 7);
      }
    }
  }, [6, 2]);

/** Quilted / stitched seat fabric. */
const seatTex = (base: number) =>
  canvasTex(64, 64, (g) => {
    const c = new THREE.Color(base);
    g.fillStyle = `#${c.getHexString()}`;
    g.fillRect(0, 0, 64, 64);
    g.strokeStyle = `#${c.clone().multiplyScalar(0.6).getHexString()}`;
    g.lineWidth = 2;
    for (let y = 8; y < 64; y += 16) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(64, y);
      g.stroke();
    }
    g.strokeStyle = `#${c.clone().lerp(new THREE.Color(1, 1, 1), 0.25).getHexString()}`;
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    for (let y = 10; y < 64; y += 16) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(64, y);
      g.stroke();
    }
  }, [1, 3]);

export function buildInterior(
  group: THREE.Group,
  model: CarModelId,
  paint: PaintOption,
  track: <T extends { dispose(): void }>(o: T) => T,
  dx: number,
): InteriorParts {
  const th = THEMES[model] ?? THEMES.kestrel;
  const mat = (o: THREE.MeshStandardMaterialParameters) => track(new THREE.MeshStandardMaterial(o));
  const cageMat = mat({ color: th.cage, metalness: model === 'vortex' ? 0.3 : 0.6, roughness: model === 'vortex' ? 0.4 : 0.35, map: model === 'vortex' ? track(carbonTex()) : null });
  const padMat = mat({ color: th.pad, roughness: 0.95 });
  const seatMat = mat({ color: 0xffffff, map: track(seatTex(th.seat)), roughness: 0.9 });
  const seatSide = mat({ color: th.seatSide, roughness: 0.8 });
  const shell = mat({ color: model === 'vortex' ? 0xffffff : 0x1b1c20, map: model === 'vortex' ? track(carbonTex()) : null, roughness: 0.5, metalness: 0.2 });
  const accent = mat({ color: paint.accent, roughness: 0.7 });
  const harness = mat({ color: th.harness, roughness: 0.85 });
  const chrome = mat({ color: 0xd0d5da, metalness: 1, roughness: 0.2 });
  const black = mat({ color: 0x141518, roughness: 0.8 });
  const red = mat({ color: 0xc8141c, roughness: 0.4, metalness: 0.2 });
  const alu = mat({ color: 0xffffff, map: track(checkerTex([3, 3])), roughness: 0.45, metalness: 0.7 });

  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = group) => {
    const mesh = new THREE.Mesh(track(geo), m);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const rbox = (w: number, h: number, d: number, r: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = group) =>
    add(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)), m, x, y, z, parent);
  const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, parent: THREE.Object3D = group) => {
    const dir = b.clone().sub(a);
    const mesh = add(new THREE.CylinderGeometry(r, r, dir.length(), 10), m, 0, 0, 0, parent);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return mesh;
  };
  /** A flat webbing strap from a to b (wide side faces forward). */
  const strap = (a: THREE.Vector3, b: THREE.Vector3, w = 0.05) => {
    const dir = b.clone().sub(a);
    const mesh = add(new THREE.BoxGeometry(w, dir.length(), 0.006), harness, 0, 0, 0);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return mesh;
  };
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // ---- Floor ----
  const floorMat = th.floor === 'carpet' ? mat({ map: track(carpetTex([8, 10])), roughness: 1 }) : mat({ color: 0xffffff, map: track(checkerTex([5, 6])), roughness: 0.5, metalness: 0.6 });
  const floor = add(new THREE.PlaneGeometry(1.62, 2.0), floorMat, 0, -0.098, -0.15);
  floor.rotation.x = -Math.PI / 2;

  // ---- Roll cage (in the car's colour) with foam padding where heads go ----
  for (const sx of [-1, 1]) {
    tube(v(sx * 0.68, 0.0, -0.9), v(sx * 0.66, 0.84, -0.9), 0.025, cageMat); // main hoop legs
    tube(v(sx * 0.7, 0.3, 0.62), v(sx * 0.65, 0.84, 0.42), 0.022, cageMat); // A-pillar bars
    tube(v(sx * 0.65, 0.84, 0.42), v(sx * 0.66, 0.84, -0.9), 0.022, cageMat); // roof bars
    tube(v(sx * 0.78, 0.08, 0.5), v(sx * 0.78, 0.4, -0.75), 0.02, cageMat); // door bars (X)
    tube(v(sx * 0.78, 0.4, 0.5), v(sx * 0.78, 0.08, -0.75), 0.02, cageMat);
    tube(v(sx * 0.7, 0.3, 0.62), v(sx * 0.78, 0.08, 0.5), 0.02, cageMat); // door bar to A-leg
    // gussets at the top corners
    const gus = add(new THREE.BoxGeometry(0.008, 0.08, 0.08), cageMat, sx * 0.655, 0.81, 0.39);
    gus.rotation.x = Math.PI / 4;
    // padding on the roof bars beside the helmets and the side of the main hoop
    tube(v(sx * 0.655, 0.84, -0.05), v(sx * 0.66, 0.84, -0.7), 0.042, padMat);
    tube(v(sx * 0.67, 0.4, -0.9), v(sx * 0.665, 0.8, -0.9), 0.042, padMat);
    tube(v(sx * 0.78, 0.18, 0.2), v(sx * 0.78, 0.31, -0.45), 0.034, padMat); // door bar pad (knees)
  }
  tube(v(-0.66, 0.84, -0.9), v(0.66, 0.84, -0.9), 0.025, cageMat);
  tube(v(-0.65, 0.84, 0.42), v(0.65, 0.84, 0.42), 0.022, cageMat);
  tube(v(-0.66, 0.84, -0.9), v(0.68, 0.0, -0.9), 0.022, cageMat); // diagonal
  tube(v(-0.67, 0.5, -0.92), v(0.67, 0.5, -0.92), 0.022, cageMat); // harness bar
  tube(v(-0.6, 0.84, -0.9), v(0.6, 0.84, 0.42), 0.02, cageMat); // roof X
  tube(v(0.6, 0.84, -0.9), v(-0.6, 0.84, 0.42), 0.02, cageMat);

  // ---- Bucket seats + 4-point harnesses ----
  for (const sx of [dx, -dx]) {
    const seat = new THREE.Group();
    seat.position.set(sx, 0, 0);
    group.add(seat);
    // base cushion + side bolsters
    rbox(0.42, 0.09, 0.46, 0.035, seatMat, 0, 0.025, -0.46, seat);
    for (const wx of [-1, 1]) {
      const b = rbox(0.08, 0.15, 0.46, 0.03, seatSide, wx * 0.22, 0.06, -0.46, seat);
      b.rotation.z = wx * -0.18;
    }
    // shell behind the back
    const back = new THREE.Group();
    back.position.set(0, 0.06, -0.72);
    back.rotation.x = -0.14;
    seat.add(back);
    rbox(0.52, 0.84, 0.05, 0.02, shell, 0, 0.4, -0.04, back);
    rbox(0.4, 0.62, 0.08, 0.035, seatMat, 0, 0.32, 0.03, back); // backrest padding
    for (const wx of [-1, 1]) {
      // tall back bolsters wrapping round the ribs
      const b = rbox(0.08, 0.5, 0.2, 0.03, seatSide, wx * 0.24, 0.3, 0.06, back);
      b.rotation.y = wx * 0.3;
      // head wings (HANS-style)
      const hw = rbox(0.06, 0.22, 0.18, 0.025, seatSide, wx * 0.2, 0.74, 0.06, back);
      hw.rotation.y = wx * 0.35;
      // harness slots
      rbox(0.07, 0.02, 0.09, 0.006, black, wx * 0.1, 0.66, 0.03, back);
    }
    rbox(0.32, 0.16, 0.07, 0.03, seatMat, 0, 0.75, 0.03, back); // head pad
    rbox(0.3, 0.035, 0.02, 0.008, accent, 0, 0.57, 0.08, back); // logo band
    // seat rails + side mounts
    for (const wx of [-1, 1]) add(new THREE.BoxGeometry(0.03, 0.05, 0.5), chrome, sx + wx * 0.17, -0.07, -0.48);
    // harness: shoulder straps from the slots over the shoulders, lap straps, cam buckle
    const buckle = v(sx, 0.2, -0.43);
    for (const wx of [-1, 1]) {
      const slot = v(sx + wx * 0.1, 0.68, -0.76);
      const shoulder = v(sx + wx * 0.1, 0.645, -0.6);
      const chest = v(sx + wx * 0.1, 0.56, -0.475);
      strap(slot, shoulder);
      strap(shoulder, chest);
      strap(chest, v(sx + wx * 0.06, 0.3, -0.46));
      strap(v(sx + wx * 0.06, 0.3, -0.46), buckle.clone().add(v(wx * 0.02, 0.02, 0)));
      strap(v(sx + wx * 0.23, 0.08, -0.52), buckle.clone().add(v(wx * 0.03, -0.01, 0)), 0.045);
      // adjusters
      rbox(0.055, 0.03, 0.012, 0.004, chrome, sx + wx * 0.09, 0.45, -0.462);
    }
    const cam = add(new THREE.CylinderGeometry(0.035, 0.035, 0.014, 18), chrome, buckle.x, buckle.y, buckle.z + 0.01);
    cam.rotation.x = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.018, 0.018, 0.016, 12), red, buckle.x, buckle.y, buckle.z + 0.012).rotation.x = Math.PI / 2;
    // crotch strap
    strap(v(sx, 0.05, -0.36), buckle, 0.045);
  }

  // ---- Door cards ----
  const doorMat =
    th.door === 'carbon'
      ? mat({ color: 0xffffff, map: track(carbonTex()), roughness: 0.35, metalness: 0.3 })
      : th.door === 'alu'
        ? mat({ color: th.doorColor, roughness: 0.45, metalness: 0.7 })
        : mat({ color: th.doorColor, roughness: 0.85 });
  const doors = {} as Record<'left' | 'right', THREE.Mesh>;
  for (const sx of [-1, 1]) {
    const door = add(new THREE.BoxGeometry(0.05, 0.44, 1.7), doorMat, sx * 0.86, 0.2, -0.1);
    doors[sx > 0 ? 'left' : 'right'] = door;
    // the details are children so they dent with the door (local coords)
    const inX = -sx * 0.03; // inner face
    rbox(0.03, 0.06, 0.36, 0.02, padMat, inX - sx * 0.01, 0.06, -0.25, door); // armrest pad
    // red pull strap in a loop
    const pull = rbox(0.012, 0.035, 0.24, 0.006, red, inX - sx * 0.025, 0.14, 0.08, door);
    pull.rotation.x = 0.15;
    rbox(0.02, 0.04, 0.03, 0.006, black, inX - sx * 0.012, 0.15, -0.04, door);
    rbox(0.02, 0.04, 0.03, 0.006, black, inX - sx * 0.012, 0.13, 0.2, door);
    // speaker / vent grille and the window winder (or catch on the modern cars)
    const grille = add(new THREE.CylinderGeometry(0.05, 0.05, 0.01, 18), black, inX - sx * 0.002, -0.1, 0.45, door);
    grille.rotation.z = Math.PI / 2;
    if (model === 'sparrow') {
      const w = tube(v(0, 0, 0), v(-sx * 0.05, 0, 0), 0.008, chrome, door);
      w.position.set(inX - sx * 0.02, 0.12, 0.38);
      rbox(0.02, 0.02, 0.07, 0.008, black, inX - sx * 0.045, 0.12, 0.4, door);
    } else {
      rbox(0.02, 0.03, 0.08, 0.008, chrome, inX - sx * 0.01, 0.17, 0.42, door); // latch
    }
    // window sill
    add(new THREE.BoxGeometry(0.12, 0.04, 1.7), black, sx * 0.83, 0.42, -0.1);
  }

  // ---- Driver: pedal box ----
  const pedalArm = (x: number, h: number, w: number) => {
    tube(v(x, 0.32, 0.72), v(x, 0.32 - h, 0.66), 0.008, chrome);
    const p = rbox(w, 0.08, 0.012, 0.005, alu, x, 0.32 - h, 0.655);
    p.rotation.x = -0.35;
  };
  pedalArm(dx + 0.13, 0.26, 0.07); // clutch
  pedalArm(dx + 0.02, 0.26, 0.08); // brake
  pedalArm(dx - 0.1, 0.28, 0.05); // throttle
  // driver footrest (dead pedal)
  rbox(0.08, 0.16, 0.012, 0.005, alu, dx + 0.26, 0.0, 0.62).rotation.x = -0.6;

  // ---- Navigator: big footrest plate with a lip ----
  const fr = new THREE.Group();
  fr.position.set(-dx, -0.02, 0.5);
  fr.rotation.x = -0.75;
  group.add(fr);
  rbox(0.4, 0.3, 0.014, 0.006, alu, 0, 0, 0, fr);
  rbox(0.4, 0.03, 0.04, 0.01, black, 0, -0.15, 0.02, fr);
  // grab handle on the navigator's A-pillar bar
  tube(v(-0.69, 0.42, 0.56), v(-0.665, 0.66, 0.5), 0.016, black);

  // ---- Between the seats: fire extinguisher, intercom ----
  const ext = add(new THREE.CylinderGeometry(0.045, 0.045, 0.32, 16), red, 0, 0.11, -0.6);
  ext.rotation.x = Math.PI / 2;
  const head = add(new THREE.CylinderGeometry(0.02, 0.03, 0.05, 10), chrome, 0, 0.11, -0.42);
  head.rotation.x = Math.PI / 2;
  rbox(0.06, 0.02, 0.06, 0.005, black, 0, 0.165, -0.42); // handle
  for (const z of [-0.7, -0.5]) {
    const band = add(new THREE.TorusGeometry(0.047, 0.006, 6, 18), chrome, 0, 0.11, z);
    band.rotation.y = 0;
  }
  // intercom box with two volume knobs
  rbox(0.1, 0.05, 0.08, 0.008, black, -0.09, 0.09, -0.26);
  for (const kx of [-0.115, -0.065]) {
    const k = add(new THREE.CylinderGeometry(0.009, 0.009, 0.014, 10), chrome, kx, 0.12, -0.25);
    k.rotation.x = 0;
  }
  // helmet intercom leads curling to each seat
  for (const sx of [dx, -dx]) {
    const o = Math.sign(sx);
    const pts = [v(-0.09, 0.1, -0.3), v(sx * 0.6, 0.05, -0.45), v(sx + o * 0.27, 0.3, -0.62), v(sx + o * 0.21, 0.62, -0.74)];
    const curve = new THREE.CatmullRomCurve3(pts);
    add(new THREE.TubeGeometry(curve, 20, 0.005, 5, false), black, 0, 0, 0);
  }

  return { doors };
}
