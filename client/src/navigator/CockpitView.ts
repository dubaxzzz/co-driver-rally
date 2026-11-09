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
import { createCarModel, type CarModel } from '../game/vehicle/CarModel';
import { Cockpit } from '../game/vehicle/Cockpit';
import { buildStageWorld, type StageWorld } from '../game/world/StageWorld';

const LOOK_DOWN_PITCH = -0.95;
const LOOK_UP_PITCH = -0.1;

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
  private frameSkip = 0;
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
  /** Sends a shared switch press to the driver's car. */
  onSwitch: (id: SharedSwitch, down: boolean) => void = () => {};

  constructor(private container: HTMLElement, private stage: BuiltStage, weatherId: WeatherId) {
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
    this.placeAtStart();
    this.resize();
    if (import.meta.env.DEV) (window as unknown as { __cdrNavView: CockpitView }).__cdrNavView = this;

    // Drag to look around while looking up at the road
    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.lookingDown || this.picker.busy) return;
      this.drag = { x: e.clientX, y: e.clientY, yaw: this.fp.targetYaw, pitch: this.fp.targetPitch };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
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

  /** The driver's car: interior + dashboard of whatever they drive. */
  private buildCar(id: CarModelId) {
    const sel = garageStore.resolve();
    const def = VEHICLES.find((v) => v.body.model === id) ?? VEHICLES[0];
    const car = createCarModel(sel.paint, sel.wheel, def.body);
    car.setExteriorVisible(false);
    if (this.weather.headlights) car.enableHeadlights();
    const cockpit = new Cockpit(sel.paint, 'navigator', id);
    car.root.add(cockpit.group);
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
    this.fp.targetYaw = down ? 0.12 : 0;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.fp.resize(w / Math.max(1, h));
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
    this.fp.update(dt, root, this.accel, Math.min(1, Math.abs(this.accel.y) * 0.04));
    this.world.update(dt, this.fp.camera.position, this.vel);

    // While the tablet covers the screen, render at half rate to save battery
    if (this.lookingDown && Math.abs(this.fp.pitch - LOOK_DOWN_PITCH) < 0.02 && this.frameSkip++ % 2) return;
    this.picker.enabled = !this.lookingDown;
    this.renderer.render(this.scene, this.fp.camera);
  }

  /** AI opponents shown where the driver's device says they are. */
  private updateAiCars(ai: number[]) {
    const n = Math.floor(ai.length / 6);
    while (this.aiCars.length < n) {
      const crew = AI_CREWS[this.aiCars.length % AI_CREWS.length];
      const m = createCarModel(crew.paint, WHEELS[0]);
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
