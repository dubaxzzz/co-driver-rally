import * as THREE from 'three';
import type { PaintOption, WheelOption } from '@cdr/shared';

/** Wheel layout shared by the model and the physics. Car faces +Z. */
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
  setPaint(p: PaintOption): void;
  setWheels(w: WheelOption): void;
  setBrakeLights(on: boolean): void;
  dispose(): void;
}

function numberTexture(num: string) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(64, 64, 60, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#111';
  g.font = 'bold italic 76px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(num, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Builds a stylised but complete rally car from primitives. */
export function createCarModel(paint: PaintOption, wheel: WheelOption): CarModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const paintMat = new THREE.MeshStandardMaterial({ color: paint.body, metalness: 0.45, roughness: 0.35 });
  const accentMat = new THREE.MeshStandardMaterial({ color: paint.accent, metalness: 0.3, roughness: 0.45 });
  const blackMat = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.8 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0e1620, metalness: 0.9, roughness: 0.1 });
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff1c0, emissiveIntensity: 0.6 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff0000, emissiveIntensity: 0.3 });
  const disposables: Array<THREE.Material | THREE.BufferGeometry | THREE.Texture> = [paintMat, accentMat, blackMat, glassMat, lightMat, tailMat];

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    disposables.push(geo);
    return m;
  };

  // Lower body / sills
  add(new THREE.BoxGeometry(1.74, 0.42, 3.9), paintMat, 0, 0.05, 0.02);
  // Bonnet sloping toward the front
  const bonnet = add(new THREE.BoxGeometry(1.66, 0.18, 1.25), paintMat, 0, 0.3, 1.25);
  bonnet.rotation.x = 0.1;
  // Bonnet scoop
  add(new THREE.BoxGeometry(0.5, 0.08, 0.45), blackMat, 0, 0.42, 1.05);
  // Boot
  add(new THREE.BoxGeometry(1.66, 0.2, 0.7), paintMat, 0, 0.34, -1.55);
  // Cabin
  const cabin = add(new THREE.BoxGeometry(1.5, 0.52, 1.85), paintMat, 0, 0.6, -0.25);
  cabin.scale.set(1, 1, 1);
  // Windows (slightly larger dark glass boxes slanted)
  const ws = add(new THREE.BoxGeometry(1.42, 0.5, 0.06), glassMat, 0, 0.62, 0.72);
  ws.rotation.x = -0.75;
  const rw = add(new THREE.BoxGeometry(1.4, 0.42, 0.06), glassMat, 0, 0.62, -1.18);
  rw.rotation.x = 0.7;
  add(new THREE.BoxGeometry(1.52, 0.34, 1.3), glassMat, 0, 0.64, -0.22);
  // Roof (paint over glass) + roof vent
  add(new THREE.BoxGeometry(1.42, 0.06, 1.35), paintMat, 0, 0.88, -0.25);
  add(new THREE.BoxGeometry(0.36, 0.08, 0.3), accentMat, 0, 0.94, 0.15);
  // Livery stripes
  add(new THREE.BoxGeometry(1.76, 0.1, 3.92), accentMat, 0, 0.1, 0.02);
  add(new THREE.BoxGeometry(0.3, 0.02, 1.27), accentMat, 0.35, 0.405, 1.25).rotation.x = 0.1;
  add(new THREE.BoxGeometry(0.3, 0.02, 1.27), accentMat, -0.35, 0.405, 1.25).rotation.x = 0.1;
  // Bumpers + skid plate + mudflaps
  add(new THREE.BoxGeometry(1.8, 0.3, 0.25), blackMat, 0, -0.05, 2.02);
  add(new THREE.BoxGeometry(1.8, 0.3, 0.25), blackMat, 0, 0.0, -1.98);
  add(new THREE.BoxGeometry(1.3, 0.05, 0.9), blackMat, 0, -0.18, 1.5);
  for (const sx of [-0.78, 0.78]) add(new THREE.BoxGeometry(0.28, 0.32, 0.03), blackMat, sx, -0.2, -1.62);
  // Wheel arches (flares)
  for (const [x, z] of [[-0.86, WHEEL_LAYOUT.frontZ], [0.86, WHEEL_LAYOUT.frontZ], [-0.86, WHEEL_LAYOUT.rearZ], [0.86, WHEEL_LAYOUT.rearZ]]) {
    add(new THREE.BoxGeometry(0.16, 0.14, 0.95), blackMat, x, 0.24, z);
  }
  // Rear wing
  add(new THREE.BoxGeometry(1.6, 0.05, 0.36), accentMat, 0, 1.0, -1.72);
  for (const sx of [-0.62, 0.62]) add(new THREE.BoxGeometry(0.05, 0.3, 0.2), blackMat, sx, 0.82, -1.68);
  // Lights + light pod
  for (const sx of [-0.58, 0.58]) add(new THREE.BoxGeometry(0.34, 0.12, 0.05), lightMat, sx, 0.2, 2.0);
  add(new THREE.BoxGeometry(1.2, 0.2, 0.12), blackMat, 0, 0.32, 2.05);
  for (const sx of [-0.42, -0.14, 0.14, 0.42]) {
    const g = new THREE.CylinderGeometry(0.1, 0.1, 0.05, 14);
    const l = add(g, lightMat, sx, 0.32, 2.12);
    l.rotation.x = Math.PI / 2;
  }
  const tails: THREE.Mesh[] = [];
  for (const sx of [-0.62, 0.62]) tails.push(add(new THREE.BoxGeometry(0.36, 0.12, 0.05), tailMat, sx, 0.3, -1.92));
  // Mirrors
  for (const sx of [-0.82, 0.82]) add(new THREE.BoxGeometry(0.16, 0.1, 0.12), paintMat, sx, 0.66, 0.5);
  // Door numbers
  const numTex = numberTexture('7');
  disposables.push(numTex);
  const numMat = new THREE.MeshStandardMaterial({ map: numTex, transparent: true, roughness: 0.6 });
  disposables.push(numMat);
  for (const sx of [-1, 1]) {
    const p = add(new THREE.PlaneGeometry(0.5, 0.5), numMat, sx * 0.876, 0.12, -0.15);
    p.rotation.y = (sx * Math.PI) / 2;
    p.castShadow = false;
  }

  // Wheels
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95 });
  const rimMat = new THREE.MeshStandardMaterial({ color: wheel.rim, metalness: 0.6, roughness: 0.35 });
  disposables.push(tyreMat, rimMat);
  const wheels: THREE.Group[] = [];
  const { radius, width } = WHEEL_LAYOUT;
  const tyreGeo = new THREE.CylinderGeometry(radius, radius, width, 22);
  tyreGeo.rotateZ(Math.PI / 2);
  disposables.push(tyreGeo);
  let spokeGeos: THREE.BufferGeometry[] = [];

  const buildRim = (spin: THREE.Group, w: WheelOption) => {
    while (spin.children.length > 1) spin.remove(spin.children[spin.children.length - 1]);
    const hub = new THREE.CylinderGeometry(0.07, 0.07, width + 0.02, 10);
    hub.rotateZ(Math.PI / 2);
    spokeGeos.push(hub);
    spin.add(new THREE.Mesh(hub, rimMat));
    const ringGeo = new THREE.TorusGeometry(radius * 0.72, 0.03, 6, 20);
    ringGeo.rotateY(Math.PI / 2);
    spokeGeos.push(ringGeo);
    for (const side of [-1, 1]) {
      const ring = new THREE.Mesh(ringGeo, rimMat);
      ring.position.x = (side * width) / 2.2;
      spin.add(ring);
      for (let i = 0; i < w.spokes; i++) {
        const g = new THREE.BoxGeometry(0.03, radius * 1.4, 0.05);
        spokeGeos.push(g);
        const s = new THREE.Mesh(g, rimMat);
        s.rotation.x = (i / w.spokes) * Math.PI;
        s.position.x = (side * width) / 2.1;
        spin.add(s);
      }
    }
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
    const tyre = new THREE.Mesh(tyreGeo, tyreMat);
    tyre.castShadow = true;
    spin.add(tyre);
    buildRim(spin, wheel);
    steerGroup.add(spin);
    root.add(steerGroup);
    wheels.push(steerGroup);
  }

  return {
    root,
    body,
    wheels,
    setPaint(p) {
      paintMat.color.setHex(p.body);
      accentMat.color.setHex(p.accent);
    },
    setWheels(w) {
      rimMat.color.setHex(w.rim);
      spokeGeos.forEach((g) => g.dispose());
      spokeGeos = [];
      for (const wg of wheels) buildRim(wg.getObjectByName('spin') as THREE.Group, w);
    },
    setBrakeLights(on) {
      for (const t of tails) (t.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 2.2 : 0.3;
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      spokeGeos.forEach((g) => g.dispose());
    },
  };
}
