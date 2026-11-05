import * as THREE from 'three';

export const CAMERA_MODES = ['Chase', 'Far chase', 'Bonnet'] as const;

/** Third-person chase camera (default) plus far-chase and bonnet views. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private dir = new THREE.Vector3(0, 0, 1);
  private initialised = false;

  constructor(aspect: number, private groundHeight: (x: number, z: number) => number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.1, 1200);
  }

  cycle() {
    this.mode = (this.mode + 1) % CAMERA_MODES.length;
    this.initialised = false;
    return CAMERA_MODES[this.mode];
  }

  snap() {
    this.initialised = false;
  }

  update(dt: number, target: THREE.Object3D, velocity: THREE.Vector3, speed: number) {
    const q = target.quaternion;
    const carFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    carFwd.y = 0;
    carFwd.normalize();

    if (this.mode === 2) {
      // Bonnet cam – rigidly attached
      const p = new THREE.Vector3(0, 0.95, 0.6).applyQuaternion(q).add(target.position);
      const l = new THREE.Vector3(0, 0.75, 12).applyQuaternion(q).add(target.position);
      this.camera.position.copy(p);
      this.camera.up.set(0, 1, 0).applyQuaternion(q);
      this.camera.lookAt(l);
      this.camera.fov = 72;
      this.camera.updateProjectionMatrix();
      return;
    }
    this.camera.up.set(0, 1, 0);

    // Blend car heading with travel direction so slides look dramatic but readable
    const flatVel = new THREE.Vector3(velocity.x, 0, velocity.z);
    const desiredDir = carFwd.clone();
    if (flatVel.length() > 4 && speed > 0) desiredDir.lerp(flatVel.normalize(), 0.35).normalize();
    const far = this.mode === 1;
    const dist = (far ? 9.5 : 6.2) + Math.min(2, Math.abs(speed) * 0.03);
    const height = far ? 3.6 : 2.3;

    if (!this.initialised) {
      this.dir.copy(desiredDir);
    } else {
      this.dir.lerp(desiredDir, 1 - Math.exp(-dt * 4)).normalize();
    }
    const desiredPos = target.position.clone().addScaledVector(this.dir, -dist).add(new THREE.Vector3(0, height, 0));
    const ground = this.groundHeight(desiredPos.x, desiredPos.z) + 0.8;
    if (desiredPos.y < ground) desiredPos.y = ground;
    const desiredLook = target.position.clone().addScaledVector(this.dir, 3.5).add(new THREE.Vector3(0, 0.9, 0));

    if (!this.initialised) {
      this.pos.copy(desiredPos);
      this.look.copy(desiredLook);
      this.initialised = true;
    } else {
      this.pos.lerp(desiredPos, 1 - Math.exp(-dt * 9));
      this.look.lerp(desiredLook, 1 - Math.exp(-dt * 14));
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    const fov = 62 + Math.min(14, Math.abs(speed) * 0.25);
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3);
    this.camera.updateProjectionMatrix();
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
