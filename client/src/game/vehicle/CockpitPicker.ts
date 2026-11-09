/**
 * Mouse / touch interaction with the cockpit: hovering a switch highlights it
 * and shows its name; pressing calls `onPress`, letting go calls `onRelease`
 * (START and HORN are held, everything else is a click).
 */
import * as THREE from 'three';
import type { Control, ControlId } from './Controls';

export class CockpitPicker {
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private hovered: Control | null = null;
  private pressed: Control | null = null;
  private tip: HTMLElement;
  private targets: THREE.Object3D[] = [];
  private byMesh = new Map<THREE.Object3D, Control>();
  enabled = true;

  constructor(
    private readonly el: HTMLElement,
    private readonly camera: () => THREE.Camera,
    controls: Control[],
    private readonly onPress: (id: ControlId) => void,
    private readonly onRelease: (id: ControlId) => void,
    /** Optional: may this control be used from this seat? */
    private readonly allowed: (id: ControlId) => boolean = () => true,
  ) {
    this.tip = document.createElement('div');
    this.tip.className = 'cockpit-tip';
    el.append(this.tip);
    this.setControls(controls);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerdown', this.onDown, true);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointerleave', this.onLeave);
  }

  setControls(controls: Control[]) {
    this.targets = [];
    this.byMesh.clear();
    for (const c of controls) for (const m of c.hit) {
      this.targets.push(m);
      this.byMesh.set(m, c);
    }
    this.setHover(null);
  }

  /** True when the pointer is over a control (so the caller can skip camera dragging). */
  get busy() {
    return !!this.pressed || !!this.hovered;
  }

  private pick(e: PointerEvent): Control | null {
    const r = this.el.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera());
    this.ray.far = 2.5;
    const hits = this.ray.intersectObjects(this.targets, false);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !this.byMesh.has(o)) o = o.parent;
      const c = o ? this.byMesh.get(o)! : null;
      if (c && this.visible(h.object)) return c;
    }
    return null;
  }

  private visible(o: THREE.Object3D) {
    for (let p: THREE.Object3D | null = o.parent; p; p = p.parent) if (!p.visible) return false;
    return true;
  }

  private setHover(c: Control | null, e?: PointerEvent) {
    if (c !== this.hovered) {
      this.hovered?.hover(false);
      this.hovered = c;
      c?.hover(true);
    }
    this.el.style.cursor = c ? 'pointer' : '';
    if (c && e) {
      const r = this.el.getBoundingClientRect();
      const ok = this.allowed(c.id);
      this.tip.textContent = ok ? c.label : `${c.label} – driver only`;
      this.tip.classList.toggle('no', !ok);
      this.tip.style.left = `${e.clientX - r.left + 14}px`;
      this.tip.style.top = `${e.clientY - r.top + 10}px`;
      this.tip.style.display = 'block';
    } else this.tip.style.display = 'none';
  }

  /** Only the 3D view itself – not menus/overlays drawn on top of it. */
  private onCanvas(e: PointerEvent) {
    return (e.target as HTMLElement | null)?.tagName === 'CANVAS';
  }

  private onMove = (e: PointerEvent) => {
    if (!this.enabled || !this.onCanvas(e)) return this.setHover(null);
    this.setHover(this.pick(e), e);
  };

  private onDown = (e: PointerEvent) => {
    if (!this.enabled || !this.onCanvas(e)) return;
    const c = this.pick(e);
    if (!c) return;
    e.stopPropagation(); // don't start a camera drag
    e.preventDefault();
    this.setHover(c, e);
    if (!this.allowed(c.id)) return;
    this.pressed = c;
    this.onPress(c.id);
  };

  private onUp = () => {
    if (!this.pressed) return;
    const c = this.pressed;
    this.pressed = null;
    this.onRelease(c.id);
  };

  private onLeave = () => this.setHover(null);

  dispose() {
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerdown', this.onDown, true);
    window.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointerleave', this.onLeave);
    this.tip.remove();
  }
}
