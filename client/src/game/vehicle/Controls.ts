/**
 * Clickable cockpit controls: toggles, rockers, push buttons, rotary knobs
 * and an ignition key. Each one is a little 3D object built in a panel's
 * local space (x = right, y = up, +z = towards the crew) that animates to
 * show its state and reports which meshes can be clicked.
 */
import * as THREE from 'three';

export type ControlId =
  | 'ignition'
  | 'start'
  | 'wipers'
  | 'headlights'
  | 'pod'
  | 'hazards'
  | 'horn'
  | 'demister'
  | 'interior'
  | 'trip'
  | 'watch'
  | 'watchReset'
  | 'mapLight';

export type ControlKind = 'toggle' | 'rocker' | 'push' | 'rotary' | 'key' | 'tile';

export interface Control {
  id: ControlId;
  label: string;
  /** Meshes that respond to the mouse. */
  hit: THREE.Object3D[];
  /** Shows the state: booleans, or 0/1/2 for the wipers. `held` presses push buttons in. */
  set(value: number | boolean, held?: boolean): void;
  hover(on: boolean): void;
}

export interface ControlStyle {
  /** Panel/plate colour. */
  plate: number;
  /** Lever/knob/cap colour. */
  cap: number;
  /** Indicator LED colour when on. */
  led: number;
  /** Label text colour. */
  text: string;
  /** Size multiplier. */
  scale?: number;
}

type Disposable = { dispose(): void };

const labelCache = new Map<string, THREE.CanvasTexture>();
export function labelTexture(text: string, color: string) {
  const key = `${text}|${color}`;
  let t = labelCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.font = 'bold 20px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 17);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  labelCache.set(key, t);
  return t;
}

export class ControlFactory {
  constructor(private readonly track: <T extends Disposable>(o: T) => T) {}

  private mat(o: THREE.MeshStandardMaterialParameters) {
    return this.track(new THREE.MeshStandardMaterial(o));
  }

  private label(parent: THREE.Object3D, text: string, color: string, y: number, s = 1) {
    const m = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.06 * s, 0.015 * s)), this.track(new THREE.MeshBasicMaterial({ map: labelTexture(text, color), transparent: true, depthWrite: false })));
    m.position.set(0, y, 0.002);
    parent.add(m);
    return m;
  }

  private ledMesh(parent: THREE.Object3D, color: number, x: number, y: number, s = 1) {
    const mat = this.track(new THREE.MeshBasicMaterial({ color: 0x1a1a1a }));
    const m = new THREE.Mesh(this.track(new THREE.CircleGeometry(0.0045 * s, 10)), mat);
    m.position.set(x, y, 0.003);
    parent.add(m);
    const on = new THREE.Color(color);
    const off = new THREE.Color(0x1a1a1a);
    return (lit: boolean) => mat.color.copy(lit ? on : off);
  }

  /** Highlight: lift the control a touch and brighten its cap. */
  private hoverer(group: THREE.Object3D, mats: THREE.MeshStandardMaterial[]) {
    const base = mats.map((m) => m.emissive.clone());
    return (on: boolean) => {
      group.scale.setScalar(on ? 1.12 : 1);
      mats.forEach((m, i) => m.emissive.copy(on ? new THREE.Color(0x553311) : base[i]));
    };
  }

  /** Aircraft-style toggle: a metal lever that flips up (on) or down (off), optional red guard. */
  toggle(parent: THREE.Object3D, id: ControlId, text: string, x: number, y: number, st: ControlStyle, guard = false): Control {
    const s = st.scale ?? 1;
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    parent.add(g);
    const plate = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.011 * s, 0.011 * s, 0.006, 14)), this.mat({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.3 }));
    plate.rotation.x = Math.PI / 2;
    g.add(plate);
    const pivot = new THREE.Group();
    pivot.position.z = 0.004;
    g.add(pivot);
    const capMat = this.mat({ color: st.cap, metalness: 0.7, roughness: 0.25 });
    const lever = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.0035 * s, 0.005 * s, 0.03 * s, 8)), capMat);
    lever.position.y = 0.015 * s;
    pivot.add(lever);
    const tip = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.0055 * s, 10, 8)), capMat);
    tip.position.y = 0.03 * s;
    pivot.add(tip);
    // invisible, bigger click target
    const hitBox = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.032 * s, 0.05 * s, 0.03)), this.track(new THREE.MeshBasicMaterial({ visible: false })));
    hitBox.position.z = 0.012;
    g.add(hitBox);
    let guardPivot: THREE.Group | null = null;
    if (guard) {
      guardPivot = new THREE.Group();
      guardPivot.position.set(0, -0.016 * s, 0.006);
      const gm = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.026 * s, 0.04 * s, 0.022 * s)), this.mat({ color: 0xc8141c, roughness: 0.4, transparent: true, opacity: 0.85 }));
      gm.position.set(0, 0.02 * s, 0.011 * s);
      guardPivot.add(gm);
      g.add(guardPivot);
    }
    const led = this.ledMesh(g, st.led, 0, 0.026 * s, s);
    this.label(g, text, st.text, -0.024 * s, s);
    const hover = this.hoverer(pivot, [capMat]);
    return {
      id,
      label: text,
      hit: [hitBox, lever, tip],
      set: (v) => {
        const on = !!v;
        pivot.rotation.x = on ? -0.55 : 0.55;
        if (guardPivot) guardPivot.rotation.x = on ? -1.9 : 0;
        led(on);
      },
      hover,
    };
  }

  /** Rocker switch: a rectangular cap that rocks, with a glowing icon strip when on. */
  rocker(parent: THREE.Object3D, id: ControlId, text: string, x: number, y: number, st: ControlStyle): Control {
    const s = st.scale ?? 1;
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    parent.add(g);
    const bezel = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.03 * s, 0.05 * s, 0.006)), this.mat({ color: 0x0c0c0e, roughness: 0.7 }));
    g.add(bezel);
    const pivot = new THREE.Group();
    pivot.position.z = 0.005;
    g.add(pivot);
    const capMat = this.mat({ color: st.cap, roughness: 0.5 });
    const cap = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.024 * s, 0.042 * s, 0.01)), capMat);
    pivot.add(cap);
    const glowMat = this.track(new THREE.MeshBasicMaterial({ color: 0x222222 }));
    const glow = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.014 * s, 0.008 * s)), glowMat);
    glow.position.set(0, 0.01 * s, 0.0055);
    pivot.add(glow);
    this.label(g, text, st.text, -0.034 * s, s);
    const on = new THREE.Color(st.led), off = new THREE.Color(0x222222);
    return {
      id,
      label: text,
      hit: [cap],
      set: (v) => {
        pivot.rotation.x = v ? -0.18 : 0.18;
        glowMat.color.copy(v ? on : off);
      },
      hover: this.hoverer(pivot, [capMat]),
    };
  }

  /** Round push button with an LED ring; `held` pushes it in. */
  push(parent: THREE.Object3D, id: ControlId, text: string, x: number, y: number, st: ControlStyle, big = false): Control {
    const s = (st.scale ?? 1) * (big ? 1.7 : 1);
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    parent.add(g);
    const ringMat = this.track(new THREE.MeshBasicMaterial({ color: 0x1a1a1a }));
    const ring = new THREE.Mesh(this.track(new THREE.TorusGeometry(0.012 * s, 0.0025 * s, 6, 20)), ringMat);
    ring.position.z = 0.002;
    g.add(ring);
    const capMat = this.mat({ color: st.cap, roughness: 0.4, metalness: 0.2 });
    const cap = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.0105 * s, 0.0105 * s, 0.012, 18)), capMat);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.006;
    g.add(cap);
    if (big) {
      const t = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.02 * s, 0.006 * s)), this.track(new THREE.MeshBasicMaterial({ map: labelTexture(text, '#ffffff'), transparent: true, depthWrite: false })));
      t.position.z = 0.0125;
      g.add(t);
    }
    this.label(g, text, st.text, -0.02 * s, Math.min(1.3, s));
    const on = new THREE.Color(st.led), off = new THREE.Color(0x1a1a1a);
    return {
      id,
      label: text,
      hit: [cap],
      set: (v, held) => {
        cap.position.z = held ? 0.002 : 0.006;
        ringMat.color.copy(v ? on : off);
      },
      hover: this.hoverer(cap, [capMat]),
    };
  }

  /** Rotary knob with a pointer: 3 positions (OFF / 1 / 2) for the wipers. */
  rotary(parent: THREE.Object3D, id: ControlId, text: string, x: number, y: number, st: ControlStyle, marks = ['0', 'I', 'II']): Control {
    const s = st.scale ?? 1;
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    parent.add(g);
    const capMat = this.mat({ color: st.cap, roughness: 0.45, metalness: 0.3 });
    const knob = new THREE.Group();
    knob.position.z = 0.008;
    g.add(knob);
    const body = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.014 * s, 0.016 * s, 0.016, 20)), capMat);
    body.rotation.x = Math.PI / 2;
    knob.add(body);
    const pointer = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.003 * s, 0.012 * s, 0.003)), this.track(new THREE.MeshBasicMaterial({ color: 0xffffff })));
    pointer.position.set(0, 0.007 * s, 0.009);
    knob.add(pointer);
    marks.forEach((m, i) => {
      const a = (-0.8 + i * 0.8) * -1;
      const t = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.02 * s, 0.006 * s)), this.track(new THREE.MeshBasicMaterial({ map: labelTexture(m, st.text), transparent: true, depthWrite: false })));
      t.position.set(-Math.sin(a) * 0.024 * s, Math.cos(a) * 0.024 * s, 0.002);
      g.add(t);
    });
    this.label(g, text, st.text, -0.026 * s, s);
    return {
      id,
      label: text,
      hit: [body],
      set: (v) => {
        const n = Number(v);
        knob.rotation.z = 0.8 - n * 0.8;
      },
      hover: this.hoverer(knob, [capMat]),
    };
  }

  /** Ignition key in a barrel: turns clockwise when on. */
  key(parent: THREE.Object3D, id: ControlId, text: string, x: number, y: number, st: ControlStyle): Control {
    const s = st.scale ?? 1;
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    parent.add(g);
    const barrel = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.014 * s, 0.014 * s, 0.01, 18)), this.mat({ color: 0xb8bec4, metalness: 0.9, roughness: 0.25 }));
    barrel.rotation.x = Math.PI / 2;
    g.add(barrel);
    const turn = new THREE.Group();
    turn.position.z = 0.008;
    g.add(turn);
    const capMat = this.mat({ color: 0x111111, roughness: 0.5 });
    const head = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.02 * s, 0.028 * s, 0.006)), capMat);
    head.position.z = 0.012;
    turn.add(head);
    const blade = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.004 * s, 0.01 * s, 0.014)), this.mat({ color: 0xc9cdd1, metalness: 0.9, roughness: 0.2 }));
    turn.add(blade);
    const led = this.ledMesh(g, st.led, 0.02 * s, 0.014 * s, s);
    this.label(g, text, st.text, -0.024 * s, s);
    return {
      id,
      label: text,
      hit: [head, barrel],
      set: (v) => {
        turn.rotation.z = v ? -1.2 : 0;
        led(!!v);
      },
      hover: this.hoverer(turn, [capMat]),
    };
  }

  /** Flat glowing touch tile (modern cars). */
  tile(parent: THREE.Object3D, id: ControlId, text: string, x: number, y: number, st: ControlStyle, w = 0.05, h = 0.03): Control {
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    parent.add(g);
    const mat = this.mat({ color: 0x0c1418, emissive: 0x0a2a36, emissiveIntensity: 0.6, roughness: 0.3 });
    const t = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, h, 0.004)), mat);
    g.add(t);
    const txt = new THREE.Mesh(this.track(new THREE.PlaneGeometry(w * 0.9, h * 0.45)), this.track(new THREE.MeshBasicMaterial({ map: labelTexture(text, '#d8f4ff'), transparent: true, depthWrite: false })));
    txt.position.z = 0.0025;
    g.add(txt);
    const on = new THREE.Color(st.led), off = new THREE.Color(0x0a2a36);
    return {
      id,
      label: text,
      hit: [t],
      set: (v, held) => {
        mat.emissive.copy(v || held ? on : off);
        mat.emissiveIntensity = v || held ? 1.2 : 0.6;
      },
      hover: (h) => g.scale.setScalar(h ? 1.08 : 1),
    };
  }
}
