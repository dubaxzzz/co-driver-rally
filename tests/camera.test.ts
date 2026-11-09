/**
 * Camera stability – the driver's head spring must stay inside the car at any
 * frame rate (a slow laptop used to throw the view out of the car in corners).
 *   npx tsx tests/camera.test.ts
 */
import * as THREE from 'three';
import { FirstPersonCamera } from '../client/src/game/camera/FirstPersonCamera';

let failures = 0;
for (const fps of [144, 60, 30, 15, 8, 5]) {
  const cam = new FirstPersonCamera(1.6, 'driver');
  const car = new THREE.Object3D();
  let maxOff = 0;
  const dt = 1 / fps;
  for (let t = 0; t < 6; t += dt) {
    // hard cornering that flips direction every second, plus bumps
    const acc = new THREE.Vector3(Math.sign(Math.sin(t * 3)) * 12, (Math.random() - 0.5) * 20, -6);
    cam.update(Math.min(0.1, dt), car, acc, 1);
    maxOff = Math.max(maxOff, cam.camera.position.distanceTo(new THREE.Vector3(0.37, 0.73, -0.36)));
  }
  const ok = maxOff < 0.15;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${fps} fps: furthest the head moved = ${(maxOff * 100).toFixed(1)} cm`);
}
process.exit(failures ? 1 : 0);
