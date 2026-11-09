/**
 * Main-menu backdrop: your own car parked on a wet forest road at night, lights
 * blazing through the rain, with a slow orbiting camera.
 */
import * as THREE from 'three';
import { createCarModel } from '../game/vehicle/CarModel';
import { garageStore, settings } from '../settings';

export class MenuScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
  private raf = 0;
  private rain: THREE.Points;
  private disposed = false;
  private t0 = performance.now();

  constructor(private readonly host: HTMLElement) {
    const high = settings.get().quality === 'high';
    this.renderer = new THREE.WebGLRenderer({ antialias: high, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, high ? 1.75 : 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = high;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'menu-canvas';
    host.prepend(this.renderer.domElement);

    const s = this.scene;
    s.background = new THREE.Color(0x07090c);
    s.fog = new THREE.FogExp2(0x0b0e12, 0.045);

    // wet road + verges
    const road = new THREE.Mesh(new THREE.PlaneGeometry(9, 120), new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.32, metalness: 0.25 }));
    road.rotation.x = -Math.PI / 2;
    road.position.y = -0.68;
    road.receiveShadow = true;
    s.add(road);
    const verge = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x141a12, roughness: 0.95 }));
    verge.rotation.x = -Math.PI / 2;
    verge.position.y = -0.7;
    verge.receiveShadow = true;
    s.add(verge);
    // pine forest silhouettes either side
    const pineMat = new THREE.MeshStandardMaterial({ color: 0x0f1a12, roughness: 1 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x1a120c, roughness: 1 });
    for (let i = 0; i < 140; i++) {
      const side = i % 2 ? 1 : -1;
      const x = side * (6 + Math.random() * 40);
      const z = (Math.random() - 0.5) * 120;
      const hgt = 5 + Math.random() * 7;
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, hgt * 0.3, 6), trunkMat);
      trunk.position.y = hgt * 0.15;
      tree.add(trunk);
      for (let k = 0; k < 3; k++) {
        const c = new THREE.Mesh(new THREE.ConeGeometry(hgt * (0.26 - k * 0.06), hgt * 0.45, 7), pineMat);
        c.position.y = hgt * (0.35 + k * 0.2);
        c.castShadow = high;
        tree.add(c);
      }
      tree.position.set(x, -0.7, z);
      s.add(tree);
    }

    // the car
    const sel = garageStore.resolve();
    const car = createCarModel(sel.paint, sel.wheel, sel.vehicle.body);
    car.wheels.forEach((w) => (w.position.y = -0.12 - 0.22));
    car.root.traverse((o) => ((o as THREE.Mesh).castShadow = high));
    car.wheels[0].rotation.y = 0.35;
    car.wheels[1].rotation.y = 0.35;
    car.enableHeadlights();
    car.setHeadlights(true);
    car.setLightPod(true);
    car.setBrakeLights(true);
    car.root.rotation.y = -0.35;
    s.add(car.root);

    // lighting: cold moonlight, warm orange rim, a little fill
    s.add(new THREE.HemisphereLight(0x5a6c90, 0x0a0806, 0.9));
    const moon = new THREE.DirectionalLight(0x9db4ff, 1.6);
    moon.position.set(-8, 14, -6);
    moon.castShadow = high;
    moon.shadow.mapSize.set(1024, 1024);
    s.add(moon);
    const rim = new THREE.PointLight(0xff5a1f, 45, 16, 1.5);
    rim.position.set(-3.5, 1.8, -3.5);
    s.add(rim);
    const fill = new THREE.PointLight(0x7f9cff, 22, 14, 1.5);
    fill.position.set(-2.5, 3, 5);
    s.add(fill);

    // rain
    const n = high ? 2600 : 1200;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 30;
      pos[i * 3 + 1] = Math.random() * 14 - 0.7;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 30;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xb8c8dc, size: 0.05, transparent: true, opacity: 0.55, depthWrite: false }));
    s.add(this.rain);

    window.addEventListener('resize', this.resize);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
  }

  private resize = () => {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    // on narrow screens pull back so the car still fits
    this.camera.fov = this.camera.aspect < 1 ? 48 : 32;
    this.camera.updateProjectionMatrix();
  };

  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const t = (now - this.t0) / 1000;
    // slow orbit around the front three-quarter of the car, offset so the car sits right of the menu
    // front three-quarter view, swinging slowly from one headlight to the other
    const a = -0.35 + Math.sin(t * 0.07) * 0.5;
    const r = this.camera.aspect < 1 ? 9.5 : 9;
    this.camera.position.set(Math.sin(a) * r, 1.35 + Math.sin(t * 0.11) * 0.25, Math.cos(a) * r);
    const look = new THREE.Vector3(0, 0.15, 0);
    const right = new THREE.Vector3().subVectors(look, this.camera.position).cross(new THREE.Vector3(0, 1, 0)).normalize();
    if (this.camera.aspect > 1.2) look.addScaledVector(right, -1.0); // car on the right-hand side of the screen
    this.camera.lookAt(look);
    const p = this.rain.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) - 0.35;
      if (y < -0.7) y += 14;
      p.setY(i, y);
    }
    p.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
