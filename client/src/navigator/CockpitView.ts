import * as THREE from 'three';
import { WEATHER, WHEELS, VEHICLES, sampleAt, decodeSwitches, defaultSwitches, SHARED_SWITCHES, type BuiltStage, type CarModelId, type CarSwitches, type RelayedTelemetry, type SharedSwitch, type WeatherDef, type WeatherId } from '@cdr/shared';
import { CockpitPicker } from '../game/vehicle/CockpitPicker';
import type { ControlId } from '../game/vehicle/Controls';
import { audio } from '../audio/AudioEngine';
import { AI_CREWS } from '../game/ai/AIDriver';
import { DustSystem } from '../game/environment/Atmosphere';
import { DAMAGE_KEYS, noDamage, type DamageZones } from '../game/vehicle/Vehicle';
import { fogMultiplier, garageStore, settings } from '../settings';
import { FirstPersonCamera } from '../game/camera/FirstPersonCamera';
import { bakeCarModel, createCarModel, type CarModel } from '../game/vehicle/CarModel';
import { Cockpit } from '../game/vehicle/Cockpit';
import { buildStageWorld, type StageWorld } from '../game/world/StageWorld';
import { SEATS } from '../game/vehicle/Cockpit';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { TabletScreen } from './TabletScreen';

const LOOK_DOWN_PITCH = -0.95;
const LOOK_DOWN_YAW = 0.12;
const LOOK_UP_PITCH = -0.1;
const ROAD_FOV = 74;
/** How far in front of the eyes the co-driver holds the tablet (m). */
const TABLET_DIST = 0.4;
/** Screen size of the tablet (m), landscape; the case adds a rugged bezel around it. */
const SCREEN_W = 0.25;
const SCREEN_H = 0.156;

/**
 * The co-driver's seat. Renders the same stage and the same car interior as
 * the driver sees, positioned every frame from the driver's interpolated
 * telemetry – so the navigator can look up through the windscreen and see
 * exactly where the real car is.
 */
export class CockpitView {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private world: StageWorld;
  private car: CarModel;
  private cockpit: Cockpit;
  private fp: FirstPersonCamera;
  private lookingDown = true;
  private lastPos: THREE.Vector3 | null = null;
  private lastVel = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private accel = new THREE.Vector3();
  private drag: { x: number; y: number; yaw: number; pitch: number } | null = null;
  private unsub: () => void;
  private weather: WeatherDef;
  private damage: DamageZones = noDamage();
  private aiCars: CarModel[] = [];
  private smoke = new DustSystem(200, 'rgba(70,70,74,', -0.8, 2.6);
  private modelId: CarModelId = 'kestrel';
  private sw: CarSwitches = defaultSwitches();
  private held = new Set<ControlId>();
  private picker: CockpitPicker;
  private trip = { start: 0, watchStart: 0, watchAcc: 0, running: false, mapLight: false };
  private lastDist = 0;
  private tablet = new THREE.Group();
  private tabletScreenMesh: THREE.Mesh | null = null;
  private tabletTex: THREE.CanvasTexture | null = null;
  private tabletBase = new THREE.Vector3();
  private tabletVersion = -1;
  private ray = new THREE.Raycaster();
  /** Tap on the tablet screen while looking at it (u, v = texture coordinates). */
  onTabletTap: (u: number, v: number) => void = () => {};
  /** Tap on the tablet while looking at the road: bring it up. */
  onTabletRaise: () => void = () => {};
  /** Sends a shared switch press to the driver's car. */
  onSwitch: (id: SharedSwitch, down: boolean) => void = () => {};

  constructor(private container: HTMLElement, private stage: BuiltStage, weatherId: WeatherId, private screen: TabletScreen) {
    this.weather = WEATHER[weatherId] ?? WEATHER.storm;
    const quality = settings.get().quality;
    this.renderer = new THREE.WebGLRenderer({ antialias: quality === 'high', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.canvas = this.renderer.domElement;
    container.append(this.canvas);

    this.world = buildStageWorld(this.scene, stage, { quality: 'low', physics: null, fogMultiplier: fogMultiplier(), weather: this.weather.id });
    this.scene.add(this.smoke.points);
    this.unsub = settings.subscribe(() => this.world.atmosphere.setFogMultiplier(fogMultiplier()));
    this.fp = new FirstPersonCamera(1, 'navigator');
    const built = this.buildCar('kestrel');
    this.car = built.car;
    this.cockpit = built.cockpit;
    this.picker = new CockpitPicker(container, () => this.fp.camera, this.cockpit.controls, (id) => this.press(id), (id) => this.release(id), (id) => id !== 'ignition' && id !== 'start');
    this.fp.pitch = this.fp.targetPitch = LOOK_DOWN_PITCH;
    this.fp.yaw = this.fp.targetYaw = LOOK_DOWN_YAW;
    this.placeAtStart();
    this.resize();
    if (import.meta.env.DEV) (window as unknown as { __cdrNavView: CockpitView }).__cdrNavView = this;

    // Drag to look around while looking up at the road
    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('pointerdown', (e) => {
      const uv = this.pickTablet(e);
      if (uv) {
        if (this.lookingDown) this.onTabletTap(uv.x, uv.y);
        else this.onTabletRaise();
        return;
      }
      if (this.lookingDown || this.picker.busy) return;
      this.drag = { x: e.clientX, y: e.clientY, yaw: this.fp.targetYaw, pitch: this.fp.targetPitch };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) {
        if (!this.picker.busy) this.canvas.style.cursor = this.pickTablet(e) ? 'pointer' : '';
        return;
      }
      const k = 3 / Math.max(300, this.canvas.clientWidth);
      this.fp.targetYaw = THREE.MathUtils.clamp(this.drag.yaw - (e.clientX - this.drag.x) * k, -1.7, 1.7);
      this.fp.targetPitch = THREE.MathUtils.clamp(this.drag.pitch - (e.clientY - this.drag.y) * k, -1.0, 0.45);
    });
    const end = () => {
      this.drag = null;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  /** Where on the tablet screen (texture uv) the pointer is, or null when it misses the tablet. */
  private pickTablet(e: PointerEvent): THREE.Vector2 | null {
    if (!this.tabletScreenMesh) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.fp.camera);
    this.ray.far = 2;
    const hit = this.ray.intersectObject(this.tablet, true)[0];
    if (!hit) return null;
    if (hit.object === this.tabletScreenMesh && hit.uv) return hit.uv.clone();
    return new THREE.Vector2(-1, -1); // the case: still "the tablet"
  }

  /**
   * The co-driver's tablet: a rugged-case tablet held in both gloved hands,
   * in front of the passenger's chest. Its screen is the live TabletScreen canvas.
   */
  private buildTablet() {
    const portrait = this.screen.portrait;
    // clear the old one
    this.tablet.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    this.tablet.clear();
    this.tabletTex?.dispose();

    const sw = portrait ? SCREEN_H : SCREEN_W;
    const sh = portrait ? SCREEN_W : SCREEN_H;
    const caseW = sw + 0.034, caseH = sh + 0.034;
    const caseMat = new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.75, metalness: 0.1 });
    const bumperMat = new THREE.MeshStandardMaterial({ color: 0xc8401c, roughness: 0.85 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.15, metalness: 0.4 });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      this.tablet.add(m);
      return m;
    };
    // case body + black glass border
    add(new RoundedBoxGeometry(caseW, caseH, 0.016, 3, 0.008), caseMat, 0, 0, -0.008);
    add(new THREE.PlaneGeometry(sw + 0.01, sh + 0.01), glassMat, 0, 0, 0.0005);
    // orange corner bumpers
    for (const cx of [-1, 1]) for (const cy of [-1, 1]) {
      add(new RoundedBoxGeometry(0.026, 0.026, 0.02, 2, 0.007), bumperMat, cx * (caseW / 2 - 0.004), cy * (caseH / 2 - 0.004), -0.008);
    }
    // little camera dot + a strap on the back
    add(new THREE.CircleGeometry(0.0025, 10), new THREE.MeshBasicMaterial({ color: 0x222831 }), 0, caseH / 2 - 0.006, 0.001);
    add(new THREE.BoxGeometry(0.03, caseH * 0.8, 0.006), caseMat, 0, 0, -0.019);

    // the live screen
    this.tabletTex = new THREE.CanvasTexture(this.screen.canvas);
    this.tabletTex.colorSpace = THREE.SRGBColorSpace;
    this.tabletTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.tabletTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tabletVersion = -1;
    this.tabletScreenMesh = add(new THREE.PlaneGeometry(sw, sh), new THREE.MeshBasicMaterial({ map: this.tabletTex, toneMapped: false }), 0, 0, 0.001);

    // gloved hands gripping the sides, forearms running back towards the body
    const glove = new THREE.MeshStandardMaterial({ color: 0x18191c, roughness: 0.85 });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x2a3a52, roughness: 0.9 });
    const palmY = portrait ? -sh * 0.12 : -sh * 0.05;
    for (const side of [-1, 1]) {
      const hx = side * (caseW / 2 + 0.004);
      const palm = add(new RoundedBoxGeometry(0.03, 0.085, 0.045, 2, 0.012), glove, hx + side * 0.006, palmY, -0.018);
      palm.rotation.z = side * 0.12;
      // thumb over the bezel
      const thumb = add(new RoundedBoxGeometry(0.022, 0.05, 0.016, 2, 0.007), glove, side * (caseW / 2 - 0.006), palmY + 0.012, 0.006);
      thumb.rotation.z = side * -0.5;
      // fingers wrapping round the back
      add(new RoundedBoxGeometry(0.05, 0.075, 0.014, 2, 0.006), glove, side * (caseW / 2 - 0.016), palmY - 0.004, -0.03);
      // forearm: from the wrist down and back out of view
      const wrist = new THREE.Vector3(hx + side * 0.01, palmY - 0.035, -0.04);
      const elbow = new THREE.Vector3(hx + side * 0.07, palmY - 0.26, -0.2);
      const len = wrist.distanceTo(elbow);
      const arm = add(new THREE.CylinderGeometry(0.03, 0.036, len, 10), sleeve, 0, 0, 0);
      arm.position.copy(wrist).lerp(elbow, 0.5);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), elbow.clone().sub(wrist).normalize());
    }

    // place it in front of the passenger's eyes, along the "look down" direction, facing them
    const seat = SEATS.navigator;
    const p = LOOK_DOWN_PITCH, y = LOOK_DOWN_YAW;
    const dir = new THREE.Vector3(Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y));
    this.tabletBase.set(seat.x, seat.eyeY, seat.eyeZ).addScaledVector(dir, TABLET_DIST);
    this.tablet.position.copy(this.tabletBase);
    this.tablet.quaternion.setFromEuler(new THREE.Euler(p, Math.PI + y, 0, 'YXZ'));
    this.tabletBaseQ.copy(this.tablet.quaternion);
    // the plane faces the camera's +Z, i.e. back at the eyes
  }

  private tabletBaseQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();

  /**
   * While you look at the tablet you hold it steady in front of your eyes (like
   * a real co-driver bracing their arms), so it is locked to the view and
   * never shakes. Looking at the road it rests in your lap, moving with the car.
   */
  private placeTablet(root: THREE.Object3D, lock: number) {
    const cam = this.fp.camera;
    cam.updateMatrixWorld();
    root.updateMatrixWorld();
    // where the tablet sits when held in front of the eyes, in the car's frame
    const held = this.tmpV.set(0, 0, -TABLET_DIST).applyMatrix4(cam.matrixWorld);
    root.worldToLocal(held);
    const heldQ = this.tmpQ.copy(root.getWorldQuaternion(this.tmpQ2)).invert().multiply(cam.getWorldQuaternion(this.tmpQ2));
    // in the lap: the fixed spot, moving with the body
    this.tablet.position.copy(this.tabletBase).addScaledVector(this.fp.head, 0.85).lerp(held, lock);
    this.tablet.quaternion.copy(this.tabletBaseQ).slerp(heldQ, lock);
  }

  /** Field of view that makes the held tablet fill most of the screen. */
  private tabletFov() {
    const portrait = this.screen.portrait;
    const tw = (portrait ? SCREEN_H : SCREEN_W) + (portrait ? 0.035 : 0.07); // include the hands (on phones, just the bezel)
    const th = (portrait ? SCREEN_W : SCREEN_H) + 0.03;
    const aspect = this.fp.camera.aspect;
    const vFromH = 2 * Math.atan(th / 2 / TABLET_DIST / 0.9);
    const vFromW = 2 * Math.atan(Math.tan(Math.atan(tw / 2 / TABLET_DIST / 0.96)) / aspect);
    return THREE.MathUtils.radToDeg(Math.max(vFromH, vFromW));
  }

  /** The driver's car: interior + dashboard of whatever they drive. */
  private buildCar(id: CarModelId) {
    const sel = garageStore.resolve();
    const def = VEHICLES.find((v) => v.body.model === id) ?? VEHICLES[0];
    const car = createCarModel(sel.paint, sel.wheel, def.body);
    car.setExteriorVisible(false);
    if (this.weather.headlights) car.enableHeadlights();
    const cockpit = new Cockpit(sel.paint, 'navigator', id);
    car.root.add(cockpit.group);
    car.root.add(this.tablet);
    this.scene.add(car.root);
    this.modelId = id;
    return { car, cockpit };
  }

  private swapCar(id: CarModelId) {
    const pos = this.car.root.position.clone();
    const q = this.car.root.quaternion.clone();
    this.scene.remove(this.car.root);
    this.cockpit.dispose();
    this.car.dispose();
    const built = this.buildCar(id);
    this.car = built.car;
    this.cockpit = built.cockpit;
    this.car.root.position.copy(pos);
    this.car.root.quaternion.copy(q);
    this.picker.setControls(this.cockpit.controls);
  }

  private press(id: ControlId) {
    this.held.add(id);
    audio.click();
    if ((SHARED_SWITCHES as readonly string[]).includes(id)) {
      this.onSwitch(id as SharedSwitch, true);
      return;
    }
    if (id === 'trip') this.trip.start = this.lastDist;
    else if (id === 'watch') {
      const now = performance.now();
      if (this.trip.running) this.trip.watchAcc += now - this.trip.watchStart;
      else this.trip.watchStart = now;
      this.trip.running = !this.trip.running;
    } else if (id === 'watchReset') {
      this.trip.watchAcc = 0;
      this.trip.watchStart = performance.now();
    } else if (id === 'mapLight') this.trip.mapLight = !this.trip.mapLight;
  }

  private release(id: ControlId) {
    this.held.delete(id);
    if (id === 'horn') this.onSwitch('horn', false);
  }

  /** Called when a new run starts: trip back to zero. */
  resetTrip() {
    this.trip = { ...this.trip, start: this.stage.spawnDistance, watchAcc: 0, running: false };
  }

  private placeAtStart() {
    const s = sampleAt(this.stage.samples, this.stage.spawnDistance);
    this.car.root.position.set(s.x, s.y + 0.8, s.z);
    this.car.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.h);
  }

  setLookDown(down: boolean) {
    this.lookingDown = down;
    this.fp.targetPitch = down ? LOOK_DOWN_PITCH : LOOK_UP_PITCH;
    this.fp.targetYaw = down ? LOOK_DOWN_YAW : 0;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.fp.resize(w / Math.max(1, h));
    // tall phone screens get the tablet turned to portrait
    const portrait = w / Math.max(1, h) < 0.9;
    if (portrait !== this.screen.portrait || !this.tabletScreenMesh) {
      this.screen.setPortrait(portrait);
      this.buildTablet();
    }
  }

  update(dt: number, t: RelayedTelemetry | null) {
    if (dt <= 0) return;
    const root = this.car.root;
    if (t) {
      // follow what the driver drives and how their switches are set
      const want = t.look ? VEHICLES[t.look[0]]?.body.model : undefined;
      if (want && want !== this.modelId) this.swapCar(want);
      if (t.sw !== undefined) this.sw = decodeSwitches(t.sw);
      this.lastDist = t.dist;
      root.position.set(t.x, t.y, t.z);
      root.quaternion.setFromEuler(new THREE.Euler(t.p, t.h, t.r, 'YXZ'));
      // estimate acceleration from the interpolated motion for head movement
      if (this.lastPos) {
        const v = root.position.clone().sub(this.lastPos).divideScalar(dt);
        this.vel.lerp(v, Math.min(1, dt * 10));
        const a = this.vel.clone().sub(this.lastVel).divideScalar(dt);
        a.applyQuaternion(root.quaternion.clone().invert());
        this.accel.lerp(a, Math.min(1, dt * 4));
        this.lastVel.copy(this.vel);
      }
      this.lastPos = root.position.clone();
      // same damage as the real car
      if (t.dz) DAMAGE_KEYS.forEach((k, i) => (this.damage[k] = t.dz![i] ?? 0));
      this.car.setHeadlightDamage(this.damage.front);
      this.updateAiCars(t.ai ?? []);
    }
    if (this.damage.engine > 0.35 && Math.random() < this.damage.engine * dt * 30) {
      const sp = new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.45, 1.7).applyQuaternion(root.quaternion).add(root.position);
      this.smoke.emit(sp.x, sp.y, sp.z, this.vel.x * 2, this.vel.z * 2, 1.6);
    }
    this.smoke.update(dt);
    const st = settings.get();
    this.cockpit.update(dt, {
      steer: t?.steer ?? 0,
      rpm: t?.rpm ?? 900,
      maxRpm: 7600,
      speed: t?.v ?? 0,
      gear: t?.gear ?? 1,
      handbrake: t?.handbrake ?? false,
      brake: t?.brake ?? 0,
      sw: this.sw,
      held: this.held,
      tripKm: (this.lastDist - this.trip.start) / 1000,
      watchMs: this.trip.watchAcc + (this.trip.running ? performance.now() - this.trip.watchStart : 0),
      watchRunning: this.trip.running,
      mapLight: this.trip.mapLight,
      wheelShake: t?.dz && t.dz.length === 10 ? Math.max(t.dz[6], t.dz[7]) * Math.min(1, Math.abs(t.v) / 15) : 0,
      rain: this.weather.rain,
      snow: this.weather.snow,
      speedUnit: st.units,
      damage: this.damage,
    });
    this.car.setBrakeLights((t?.brake ?? 0) > 0.1);
    this.car.setHeadlights(this.sw.headlights);
    this.car.setLightPod(this.sw.pod);
    this.car.setHazards(this.sw.hazards);
    this.car.tick(performance.now() / 1000);
    // zoom in on the tablet when looking at it, wide angle when looking at the road
    const k = THREE.MathUtils.clamp((this.fp.pitch - LOOK_UP_PITCH) / (LOOK_DOWN_PITCH - LOOK_UP_PITCH), 0, 1);
    const ease = k * k * (3 - 2 * k);
    const fov = THREE.MathUtils.lerp(ROAD_FOV, this.tabletFov(), ease);
    if (Math.abs(fov - this.fp.camera.fov) > 0.01) {
      this.fp.camera.fov = fov;
      this.fp.camera.updateProjectionMatrix();
    }
    this.fp.update(dt, root, this.accel, Math.min(1, Math.abs(this.accel.y) * 0.04));
    this.world.update(dt, this.fp.camera.position, this.vel);
    this.placeTablet(root, ease);
    if (this.tabletTex && this.screen.version !== this.tabletVersion) {
      this.tabletVersion = this.screen.version;
      this.tabletTex.needsUpdate = true;
    }
    this.picker.enabled = !this.lookingDown;
    this.renderer.render(this.scene, this.fp.camera);
  }

  /** AI opponents shown where the driver's device says they are. */
  private updateAiCars(ai: number[]) {
    const n = Math.floor(ai.length / 6);
    while (this.aiCars.length < n) {
      const crew = AI_CREWS[this.aiCars.length % AI_CREWS.length];
      const m = createCarModel(crew.paint, WHEELS[0]);
      bakeCarModel(m);
      this.scene.add(m.root);
      this.aiCars.push(m);
    }
    for (let i = 0; i < this.aiCars.length; i++) {
      const m = this.aiCars[i];
      m.root.visible = i < n;
      if (i >= n) continue;
      const o = i * 6;
      m.root.position.set(ai[o], ai[o + 1], ai[o + 2]);
      m.root.rotation.set(0, ai[o + 3], 0);
      // hidden while it overlaps our car (interpolation lag)
      if (m.root.position.distanceTo(this.car.root.position) < 3.0) m.root.visible = false;
    }
  }

  dispose() {
    this.tabletTex?.dispose();
    this.picker.dispose();
    this.aiCars.forEach((m) => m.dispose());
    this.unsub();
    this.cockpit.dispose();
    this.car.dispose();
    this.world.scenery.dispose();
    this.renderer.dispose();
    this.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.canvas.remove();
  }
}
