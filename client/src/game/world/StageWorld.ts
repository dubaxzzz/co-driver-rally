import * as THREE from 'three';
import { WEATHER, type BuiltStage, type WeatherDef, type WeatherId } from '@cdr/shared';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { Atmosphere, DustSystem, RainSystem, SnowSystem } from '../environment/Atmosphere';
import { Scenery } from '../environment/Scenery';
import { buildTrack, type TerrainData, type WaterBody } from '../tracks/TrackMeshes';

export interface StageWorld {
  terrain: TerrainData;
  scenery: Scenery;
  atmosphere: Atmosphere;
  weather: WeatherDef;
  rain: RainSystem | null;
  snow: SnowSystem | null;
  spray: DustSystem;
  water: WaterBody[];
  /** Per-frame animation of weather + rivers around the camera. */
  update(dt: number, camera: THREE.Vector3, carVel: THREE.Vector3): void;
  /** Collider handles of the road surface (driver only; in chunks on long stages). */
  roadColliderHandles: number[];
}

/**
 * Builds everything you can see on a stage: road, terrain, forest, gates,
 * sky, fog, rain. The driver passes a physics world (colliders are created);
 * the navigator passes null and gets the same visuals without physics.
 */
export function buildStageWorld(
  scene: THREE.Scene,
  stage: BuiltStage,
  opts: { quality: 'high' | 'low'; physics: PhysicsWorld | null; fogMultiplier: number; weather: WeatherId },
): StageWorld {
  const weather = WEATHER[opts.weather] ?? WEATHER.storm;
  const track = buildTrack(stage);
  scene.add(track.road, track.terrain);
  for (const w of track.water) scene.add(w.mesh);
  const roadColliderHandles: number[] = [];
  if (opts.physics) {
    // split into pieces so the physics only tests the bits of road/ground near the car
    for (const part of splitTrimesh(track.roadCollider.vertices, track.roadCollider.indices, 250)) roadColliderHandles.push(opts.physics.addTrimesh(part.vertices, part.indices, 0.9).handle);
    for (const part of splitTrimesh(track.terrainCollider.vertices, track.terrainCollider.indices, 250)) opts.physics.addTrimesh(part.vertices, part.indices, 0.8);
  }
  // long stages draw a little less far (the far landscape and fog cover the rest)
  const long = stage.length > 12000;
  // the road is never drawn further than the ground beside it (or the coarse far
  // landscape would show through over it)
  const viewRoad = long ? 620 : 820;
  const viewGround = long ? 620 : 820;
  const sceneryView = long ? 520 : 650;
  const atmosphere = new Atmosphere(scene, weather, stage.def.scenery, opts.quality === 'high', opts.fogMultiplier, !!stage.def.flatBase);
  const scenery = new Scenery(stage, track.data, opts.physics, opts.quality);
  scene.add(scenery.group);
  const q = opts.quality === 'high' ? 1 : 0.5;
  // rain is always ready: showers can drift over a dry stage (see stageConditions)
  let rain: RainSystem | null = null;
  if (weather.snow === 0) {
    rain = new RainSystem(Math.max(weather.rain, 0.9) * q);
    rain.setIntensity(weather.rain / Math.max(weather.rain, 0.9));
    scene.add(rain.lines);
  }
  let snow: SnowSystem | null = null;
  if (weather.snow > 0) {
    snow = new SnowSystem(weather.snow * q);
    scene.add(snow.points);
  }
  const sprayColor =
    stage.def.surface === 'snow'
      ? 'rgba(235,240,245,'
      : weather.rain > 0 || stage.def.surface === 'tarmac'
        ? 'rgba(90,80,64,'
        : stage.def.offroad === 'sand'
          ? 'rgba(190,100,50,'
          : 'rgba(200,180,150,';
  const spray = new DustSystem(500, sprayColor);
  scene.add(spray.points);
  return {
    terrain: track.data,
    scenery,
    atmosphere,
    weather,
    rain,
    snow,
    spray,
    water: track.water,
    roadColliderHandles,
    update(dt, camera, carVel) {
      scenery.cull(camera, sceneryView);
      // long stages: don't even consider road/terrain pieces far behind or ahead
      for (const g of [track.road, track.terrain])
        for (const m of g.children) {
          const bs = (m as THREE.Mesh).geometry.boundingSphere;
          if (bs) m.visible = bs.center.distanceTo(camera) - bs.radius < (g === track.road ? viewRoad : viewGround);
        }
      rain?.update(dt, camera, carVel);
      snow?.update(dt, camera, carVel);
      for (const w of track.water) w.update(dt);
      atmosphere.follow(camera);
    },
  };

}

/** Splits a triangle mesh into square cells (by triangle centre) – one collider each. */
function splitTrimesh(vertices: Float32Array, indices: Uint32Array, cell: number) {
  const groups = new Map<string, number[]>();
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const key = `${Math.floor(vertices[a] / cell)},${Math.floor(vertices[a + 2] / cell)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(indices[t], indices[t + 1], indices[t + 2]);
  }
  const out: Array<{ vertices: Float32Array; indices: Uint32Array }> = [];
  for (const tri of groups.values()) {
    const remap = new Map<number, number>();
    const v: number[] = [];
    const ix = new Uint32Array(tri.length);
    tri.forEach((old, i) => {
      let n = remap.get(old);
      if (n === undefined) {
        n = v.length / 3;
        remap.set(old, n);
        v.push(vertices[old * 3], vertices[old * 3 + 1], vertices[old * 3 + 2]);
      }
      ix[i] = n;
    });
    out.push({ vertices: new Float32Array(v), indices: ix });
  }
  return out;
}
