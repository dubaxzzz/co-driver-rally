import * as THREE from 'three';
import {
  SURFACES,
  VEHICLES,
  WHEELS,
  projectOnStage,
  sampleAt,
  surfaceAt,
  type AiSkill,
  type BuiltStage,
  type WeatherDef,
} from '@cdr/shared';
import type { DriveInput } from '../input/Input';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { CarModel } from '../vehicle/CarModel';
import { Vehicle } from '../vehicle/Vehicle';

/** Fictional AI crews. */
export const AI_CREWS = [
  { name: 'S. Virtanen', paint: { id: 'ai1', name: 'Blue', body: 0x1e5bc6, accent: 0xffd400 } },
  { name: 'E. Lindqvist', paint: { id: 'ai2', name: 'Green', body: 0x1f8a4c, accent: 0xffffff } },
  { name: 'M. Dubois', paint: { id: 'ai3', name: 'Yellow', body: 0xf0b400, accent: 0x111111 } },
];

/** How hard each difficulty pushes: cornering grip used, braking, top speed. */
const SKILL: Record<AiSkill, { lat: number; brake: number; top: number; look: number }> = {
  easy: { lat: 0.8, brake: 5.5, top: 32, look: 0.55 },
  medium: { lat: 1.05, brake: 7, top: 40, look: 0.6 },
  hard: { lat: 1.3, brake: 8.5, top: 48, look: 0.65 },
};

/**
 * An AI opponent: a real physics car (same Vehicle class as the player)
 * driven by a simple racing-line follower. It brakes for corners by looking
 * ahead at the road's curvature, adjusts for the surface and weather, and
 * resets itself if it gets stuck or lost.
 */
export class AIDriver {
  readonly vehicle: Vehicle;
  distance: number;
  finishTimeMs: number | null = null;
  /** How many times it had to be put back on the road. */
  resets = 0;
  private hint = -1;
  private stuckFor = 0;
  private readonly input: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private readonly skill: (typeof SKILL)[AiSkill];

  constructor(
    physics: PhysicsWorld,
    private readonly stage: BuiltStage,
    readonly name: string,
    model: CarModel,
    skill: AiSkill,
    private readonly gridOffset: number,
    private readonly weather: WeatherDef,
  ) {
    this.skill = SKILL[skill];
    this.vehicle = new Vehicle(physics, VEHICLES[0], WHEELS[0], model);
    this.vehicle.weatherGrip = weather.grip;
    this.distance = stage.spawnDistance;
    this.resetToGrid();
  }

  /** Back to its starting slot behind the player. */
  resetToGrid() {
    const d = Math.max(2, this.stage.spawnDistance - this.gridOffset);
    const s = sampleAt(this.stage.samples, d);
    this.vehicle.place(s.x, s.y + 0.9, s.z, s.h);
    this.vehicle.resetDamage();
    this.vehicle.frozen = true;
    this.distance = d;
    this.hint = -1;
    this.finishTimeMs = null;
    this.stuckFor = 0;
  }

  private placeOnRoad(d: number) {
    const s = sampleAt(this.stage.samples, d);
    this.vehicle.place(s.x, s.y + 1.0, s.z, s.h);
  }

  /** One fixed physics step. `raceTimeMs` is the stage clock (for the finish time). */
  step(dt: number, racing: boolean, raceTimeMs: number) {
    const v = this.vehicle;
    const st = this.stage;
    const pos = v.position;
    const proj = projectOnStage(st, pos.x, pos.z, this.hint);
    this.hint = proj.index;
    this.distance = proj.distance;

    // surfaces, like the player car
    const onRoad = Math.abs(proj.lateral) < st.def.roadWidth / 2 + 0.6;
    v.roadSurface = SURFACES[surfaceAt(st, proj.distance)];
    v.offroadSurface = SURFACES[st.def.offroad];
    void onRoad;

    if (this.finishTimeMs === null && proj.distance >= st.finishDistance && racing) {
      this.finishTimeMs = raceTimeMs;
    }
    v.frozen = !racing;
    const speed = v.telemetry.speed;
    const absV = Math.abs(speed);

    // ---- steering: aim at a point ahead on the centre line ----
    const look = THREE.MathUtils.clamp(absV * this.skill.look, 6, 26);
    const target = sampleAt(st.samples, Math.min(st.length, proj.distance + look));
    const h = v.heading;
    const toX = target.x - pos.x, toZ = target.z - pos.z;
    const desired = Math.atan2(toX, toZ);
    let err = desired - h;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    const steer = THREE.MathUtils.clamp(err * 2.4 - proj.lateral * 0.02, -1, 1);

    // ---- speed: slow enough for every corner within braking distance ----
    const surfGrip = v.roadSurface.grip * this.weather.grip;
    const lat = this.skill.lat * 9.81 * surfGrip;
    const decel = this.skill.brake * surfGrip;
    let targetV = this.skill.top * Math.min(1.05, 0.75 + surfGrip * 0.3);
    const horizon = Math.min(st.length, proj.distance + 12 + (absV * absV) / (2 * decel) + 20);
    for (let d = proj.distance; d < horizon; d += 3) {
      const k = Math.abs(sampleAt(st.samples, d).k);
      if (k < 1e-4) continue;
      const vCorner = Math.sqrt(lat / k);
      const vAllowed = Math.sqrt(vCorner * vCorner + 2 * decel * Math.max(0, d - proj.distance - 6));
      if (vAllowed < targetV) targetV = vAllowed;
    }
    if (this.finishTimeMs !== null) targetV = 0; // pull up after the finish

    let throttle = 0;
    let brake = 0;
    if (absV < targetV - 1) throttle = 1;
    else if (absV > targetV + 1.5) brake = THREE.MathUtils.clamp((absV - targetV) / 6, 0.2, 1);
    else throttle = 0.4;
    if (speed < -0.5) {
      throttle = 1; // never reverse on purpose
      brake = 0;
    }
    this.input.throttle = throttle;
    this.input.brake = brake;
    this.input.steer = steer;
    this.input.handbrake = false;

    // ---- recovery: stuck, lost or upside down ----
    if (racing && this.finishTimeMs === null) {
      if (absV < 1.5 || v.upright < 0.3) this.stuckFor += dt;
      else this.stuckFor = 0;
      if (this.stuckFor > 3 || Math.abs(proj.lateral) > 30) {
        this.placeOnRoad(Math.max(st.spawnDistance, proj.distance - 2));
        this.resets++;
        this.stuckFor = 0;
        this.hint = -1;
      }
    }
    v.step(dt, this.input);
  }

  afterStep() {
    this.vehicle.afterStep();
  }

  dispose() {
    this.vehicle.dispose();
  }
}
