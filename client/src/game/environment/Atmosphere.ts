import * as THREE from 'three';
import type { StageDef } from '@cdr/shared';

/** Sky dome, fog, sun with a shadow frustum that follows the car, and dust particles. */
export class Atmosphere {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: THREE.Mesh;
  private sunOffset: THREE.Vector3;

  constructor(scene: THREE.Scene, env: StageDef['environment'], shadows: boolean) {
    scene.fog = new THREE.FogExp2(env.fogColor, env.fogDensity);
    scene.background = new THREE.Color(env.fogColor);

    const skyGeo = new THREE.SphereGeometry(900, 24, 12);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color(env.skyTop) }, bottom: { value: new THREE.Color(env.skyBottom) } },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vPos;
        void main(){ float h = clamp(normalize(vPos).y * 1.6 + 0.1, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }`,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x3a4a2a, 0.9);
    scene.add(this.hemi);

    const el = (env.sunElevationDeg * Math.PI) / 180;
    const az = (env.sunAzimuthDeg * Math.PI) / 180;
    this.sunOffset = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(120);
    this.sun = new THREE.DirectionalLight(0xfff0d6, 2.4);
    this.sun.castShadow = shadows;
    if (shadows) {
      this.sun.shadow.mapSize.set(2048, 2048);
      const s = this.sun.shadow.camera;
      s.left = -55;
      s.right = 55;
      s.top = 55;
      s.bottom = -55;
      s.near = 10;
      s.far = 300;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.04;
    }
    scene.add(this.sun, this.sun.target);
  }

  /** Keeps sky and shadow camera centred on the player. */
  follow(p: THREE.Vector3) {
    this.sky.position.copy(p);
    this.sun.target.position.copy(p);
    this.sun.position.copy(p).add(this.sunOffset);
  }
}

/** Pooled dust/gravel particles kicked up by the wheels. */
export class DustSystem {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private next = 0;
  private readonly count: number;

  constructor(count = 600) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    for (let i = 0; i < count; i++) this.pos[i * 3 + 1] = -9999;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(200,180,150,0.9)');
    grad.addColorStop(1, 'rgba(200,180,150,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const mat = new THREE.PointsMaterial({ size: 2.2, map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.55 });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  emit(x: number, y: number, z: number, vx: number, vz: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx * 0.2 + (Math.random() - 0.5) * 2;
    this.vel[i * 3 + 1] = 1 + Math.random() * 1.5;
    this.vel[i * 3 + 2] = vz * 0.2 + (Math.random() - 0.5) * 2;
    this.life[i] = 1.4;
  }

  update(dt: number) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = -9999;
        continue;
      }
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 0.8 * dt;
      this.vel[i * 3] *= 0.98;
      this.vel[i * 3 + 2] *= 0.98;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}
