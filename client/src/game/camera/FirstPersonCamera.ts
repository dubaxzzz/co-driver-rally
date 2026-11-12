import * as THREE from 'three';
import { SEATS, type Seat } from '../vehicle/Cockpit';

/**
 * Seat-mounted first-person camera. The head is a little spring that leans
 * against cornering, braking and acceleration forces and shakes over bumps,
 * so suspension movement is felt, not just seen.
 */
export class FirstPersonCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Look direction relative to the car (radians). */
  yaw = 0;
  pitch = -0.1;
  targetYaw = 0;
  targetPitch = -0.1;
  private headOffset = new THREE.Vector3();
  private headVel = new THREE.Vector3();
  private roll = 0;
  private shake = 0;
  private time = 0;
  private readonly eye: THREE.Vector3;
  /** Where the head has been thrown by G-forces (car frame) – things held in the hands follow it. */
  get head(): Readonly<THREE.Vector3> {
    return this.headOffset;
  }

  constructor(aspect: number, seat: Seat) {
    this.camera = new THREE.PerspectiveCamera(74, aspect, 0.03, 900);
    const s = SEATS[seat];
    this.eye = new THREE.Vector3(s.x, s.eyeY, s.eyeZ);
  }

  /**
   * @param accelLocal car acceleration in the car's frame (x = left, y = up, z = forward), m/s²
   * @param bump 0..1+ suspension activity for head shake
   */
  update(dt: number, car: THREE.Object3D, accelLocal: THREE.Vector3, bump: number) {
    // Head spring: pushed opposite to acceleration (G-forces)
    const target = new THREE.Vector3(
      THREE.MathUtils.clamp(-accelLocal.x * 0.006, -0.07, 0.07),
      THREE.MathUtils.clamp(-accelLocal.y * 0.003, -0.04, 0.04),
      THREE.MathUtils.clamp(-accelLocal.z * 0.005, -0.06, 0.06),
    );
    // Spring in small fixed sub-steps: one big step at a low frame rate made it
    // overshoot more every frame, throwing the camera out of the car in corners.
    const k = 120, c = 16;
    const n = Math.min(40, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      tmp.copy(target).sub(this.headOffset).multiplyScalar(k).addScaledVector(this.headVel, -c);
      this.headVel.addScaledVector(tmp, h);
      this.headOffset.addScaledVector(this.headVel, h);
    }
    // never further than a real head can move inside a helmet
    this.headOffset.clampLength(0, 0.12);
    this.roll += (THREE.MathUtils.clamp(accelLocal.x * 0.004, -0.06, 0.06) - this.roll) * Math.min(1, dt * 6);
    this.shake += (Math.min(1, bump) - this.shake) * Math.min(1, dt * 10);

    this.yaw += (this.targetYaw - this.yaw) * Math.min(1, dt * 8);
    this.pitch += (this.targetPitch - this.pitch) * Math.min(1, dt * 7);

    // smooth road buzz (layered sines) instead of fresh random noise every frame,
    // which looked like the picture glitching whenever the suspension worked in a corner
    this.time += dt;
    const t = this.time;
    const amp = this.shake * 0.006;
    const buzz = new THREE.Vector3(
      (Math.sin(t * 23.1) * 0.6 + Math.sin(t * 37.7 + 1.3) * 0.4) * amp,
      (Math.sin(t * 29.3 + 0.7) * 0.6 + Math.sin(t * 43.9 + 2.1) * 0.4) * amp,
      0,
    );
    const local = this.eye.clone().add(this.headOffset).add(buzz);
    car.updateMatrixWorld();
    this.camera.position.copy(local.applyMatrix4(car.matrixWorld));
    // camera looks down -Z by default; the car faces +Z, so turn around (yaw + π)
    const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, Math.PI + this.yaw, this.roll, 'YXZ'));
    this.camera.quaternion.copy(car.quaternion).multiply(look);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
