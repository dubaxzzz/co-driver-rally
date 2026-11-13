import * as THREE from 'three';
import type { StageScenery, WeatherDef } from '@cdr/shared';

/**
 * Sky dome, fog, sun/moon light and the shadow frustum that follows the car.
 * Night stages are lit almost entirely by the car's own headlights.
 */
export class Atmosphere {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: THREE.Mesh;
  readonly fog: THREE.FogExp2;
  private sunOffset: THREE.Vector3;

  /** Mountain stages have clearer air so you can see the views. */
  private fogScale: number;
  constructor(private scene: THREE.Scene, private env: WeatherDef, scenery: StageScenery, shadows: boolean, fogMultiplier = 1, clearAir = false) {
    this.fogScale = clearAir && !env.night ? 0.5 : 1;
    this.fog = new THREE.FogExp2(env.fogColor, env.fogDensity * fogMultiplier * this.fogScale);
    scene.fog = this.fog;
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

    const night = env.night;
    this.hemi = new THREE.HemisphereLight(env.hemiSky, env.hemiGround, env.hemiIntensity);
    scene.add(this.hemi);

    // dusk keeps the sun low on the horizon whatever the stage says
    const elevation = env.id === 'dusk' ? 6 : scenery.sunElevationDeg;
    const el = (elevation * Math.PI) / 180;
    const az = (scenery.sunAzimuthDeg * Math.PI) / 180;
    this.sunOffset = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(120);
    // At night this is a weak bluish moon without shadows.
    this.sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
    this.sun.castShadow = shadows && !night && env.sunIntensity > 0.8;
    if (this.sun.castShadow) {
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

  private dark = 0;
  /**
   * Nightfall on long stages: 0 = the weather's own light, 1 = full night.
   * Sky, fog, ambient and sun all fade towards a moonlit night.
   */
  setDarkness(k: number) {
    k = Math.max(0, Math.min(1, k));
    if (this.env.night || Math.abs(k - this.dark) < 0.004) return;
    this.dark = k;
    const lerp = (a: number, b: number) => new THREE.Color(a).lerp(new THREE.Color(b), k);
    // dusk on the way: the sky warms first, then goes dark
    const mid = Math.sin(Math.min(1, k * 1.6) * Math.PI) * 0.5;
    const top = lerp(this.env.skyTop, 0x03050a);
    const bottom = lerp(this.env.skyBottom, 0x0b1018).lerp(new THREE.Color(0xd9784a), mid * 0.6);
    const sky = this.sky.material as THREE.ShaderMaterial;
    (sky.uniforms.top.value as THREE.Color).copy(top);
    (sky.uniforms.bottom.value as THREE.Color).copy(bottom);
    const fogC = lerp(this.env.fogColor, 0x0a0e14).lerp(new THREE.Color(0x9a6a55), mid * 0.4);
    this.fog.color.copy(fogC);
    if (this.scene.background instanceof THREE.Color) this.scene.background.copy(fogC);
    this.hemi.intensity = this.env.hemiIntensity * (1 - k * 0.88);
    this.sun.intensity = this.env.sunIntensity * (1 - k * 0.9);
    this.sun.color.copy(lerp(this.env.sunColor, 0x8fa4c8).lerp(new THREE.Color(0xff9a5a), mid));
  }

  setFogMultiplier(m: number) {
    this.fog.density = this.env.fogDensity * m * this.fogScale;
  }

  /** Keeps sky and shadow camera centred on the player. */
  follow(p: THREE.Vector3) {
    this.sky.position.copy(p);
    this.sun.target.position.copy(p);
    this.sun.position.copy(p).add(this.sunOffset);
  }
}

/** Falling rain streaks that wrap around the camera. */
export class RainSystem {
  readonly lines: THREE.LineSegments;
  private pos: Float32Array;
  private readonly count: number;
  private readonly box = 26;

  constructor(intensity: number) {
    this.count = Math.round(2200 * intensity);
    this.pos = new Float32Array(this.count * 6);
    for (let i = 0; i < this.count; i++) {
      const x = (Math.random() - 0.5) * this.box * 2;
      const y = Math.random() * 18 - 4;
      const z = (Math.random() - 0.5) * this.box * 2;
      this.set(i, x, y, z, 0, 0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xa9bccf, transparent: true, opacity: 0.38, depthWrite: false });
    this.lines = new THREE.LineSegments(geo, mat);
    this.lines.frustumCulled = false;
  }

  private set(i: number, x: number, y: number, z: number, vx: number, vz: number) {
    const o = i * 6;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    // streak length follows fall speed + car motion (relative wind)
    this.pos[o + 3] = x + vx * 0.03;
    this.pos[o + 4] = y + 0.55;
    this.pos[o + 5] = z + vz * 0.03;
  }

  /** 0..1 of the streaks that are falling (for showers that come and go). */
  setIntensity(x: number) {
    const n = Math.round(this.count * Math.max(0, Math.min(1, x)));
    this.lines.geometry.setDrawRange(0, n * 2);
    this.lines.visible = n > 0;
  }

  /** `center` = camera position, `carVel` = car velocity (rain streaks lean with speed). */
  update(dt: number, center: THREE.Vector3, carVel: THREE.Vector3) {
    if (!this.lines.visible) return;
    const fall = 14 * dt;
    const b = this.box;
    for (let i = 0; i < this.count; i++) {
      const o = i * 6;
      let x = this.pos[o];
      let y = this.pos[o + 1] - fall;
      let z = this.pos[o + 2];
      // wrap inside a box that follows the camera
      if (x - center.x > b) x -= b * 2;
      else if (x - center.x < -b) x += b * 2;
      if (z - center.z > b) z -= b * 2;
      else if (z - center.z < -b) z += b * 2;
      if (y < center.y - 6) y += 22;
      else if (y > center.y + 16) y -= 22;
      this.set(i, x, y, z, carVel.x, carVel.z);
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
  }
}

/** Snowflakes drifting around the camera. */
export class SnowSystem {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private phase: Float32Array;
  private readonly count: number;
  private readonly box = 24;
  private t = 0;

  constructor(intensity: number) {
    this.count = Math.round(2600 * intensity);
    this.pos = new Float32Array(this.count * 3);
    this.phase = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.pos[i * 3] = (Math.random() - 0.5) * this.box * 2;
      this.pos[i * 3 + 1] = Math.random() * 20 - 4;
      this.pos[i * 3 + 2] = (Math.random() - 0.5) * this.box * 2;
      this.phase[i] = Math.random() * 10;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    const mat = new THREE.PointsMaterial({ size: 0.16, map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.9 });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  update(dt: number, center: THREE.Vector3, carVel: THREE.Vector3) {
    this.t += dt;
    const b = this.box;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      let x = this.pos[o] + Math.sin(this.t * 0.8 + this.phase[i]) * 0.6 * dt - carVel.x * 0.02 * dt;
      let y = this.pos[o + 1] - 1.4 * dt;
      let z = this.pos[o + 2] + Math.cos(this.t * 0.6 + this.phase[i]) * 0.6 * dt - carVel.z * 0.02 * dt;
      if (x - center.x > b) x -= b * 2;
      else if (x - center.x < -b) x += b * 2;
      if (z - center.z > b) z -= b * 2;
      else if (z - center.z < -b) z += b * 2;
      if (y < center.y - 5) y += 22;
      else if (y > center.y + 17) y -= 22;
      this.pos[o] = x;
      this.pos[o + 1] = y;
      this.pos[o + 2] = z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

/** Pooled spray/mud particles kicked up by the wheels. */
export class DustSystem {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private next = 0;
  private readonly count: number;

  constructor(count = 600, color = 'rgba(200,180,150,', private readonly gravity = 4, size = 1.6) {
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
    grad.addColorStop(0, `${color}0.9)`);
    grad.addColorStop(1, `${color}0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const mat = new THREE.PointsMaterial({ size, map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.5 });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  emit(x: number, y: number, z: number, vx: number, vz: number, life = 1.0) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx * 0.2 + (Math.random() - 0.5) * 2;
    this.vel[i * 3 + 1] = 1 + Math.random() * 1.5;
    this.vel[i * 3 + 2] = vz * 0.2 + (Math.random() - 0.5) * 2;
    this.life[i] = life;
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
      this.vel[i * 3 + 1] -= this.gravity * dt;
      this.vel[i * 3] *= 0.97;
      this.vel[i * 3 + 2] *= 0.97;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}
