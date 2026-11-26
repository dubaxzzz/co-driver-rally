import * as THREE from 'three';
import type { PaintOption, VehicleDef, WheelOption } from '@cdr/shared';
import { ghostPose } from '../timeattack/ghosts';
import { createCarModel, type CarModel } from './vehicle/CarModel';

/** Time attack: your best run, drawn as a see-through car that drives the line again. */
export class Ghost {
  private readonly model: CarModel;
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(private readonly scene: THREE.Scene, private readonly samples: number[], paint: PaintOption, wheel: WheelOption, body: VehicleDef['body']) {
    this.model = createCarModel(paint, wheel, body);
    this.model.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        m.transparent = true;
        m.opacity = 0.38;
        m.depthWrite = false;
      }
      if (mesh.isMesh) mesh.castShadow = false;
    });
    this.model.root.visible = false;
    scene.add(this.model.root);
  }

  /** Puts the ghost where it was `tMs` into its run. */
  update(tMs: number) {
    const p = ghostPose(this.samples, Math.max(0, tMs));
    if (!p) return void (this.model.root.visible = false);
    this.model.root.visible = true;
    this.model.root.position.set(p.x, p.y, p.z);
    this.model.root.quaternion.setFromEuler(this.e.set(0, p.h, 0));
  }

  dispose() {
    this.scene.remove(this.model.root);
    this.model.dispose();
  }
}
