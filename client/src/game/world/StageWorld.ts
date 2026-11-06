import * as THREE from 'three';
import type { BuiltStage } from '@cdr/shared';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { Atmosphere, DustSystem, RainSystem } from '../environment/Atmosphere';
import { Scenery } from '../environment/Scenery';
import { buildTrack, type TerrainData } from '../tracks/TrackMeshes';

export interface StageWorld {
  terrain: TerrainData;
  scenery: Scenery;
  atmosphere: Atmosphere;
  rain: RainSystem | null;
  spray: DustSystem;
  /** Collider handle of the road surface (driver only). */
  roadColliderHandle: number | null;
}

/**
 * Builds everything you can see on a stage: road, terrain, forest, gates,
 * sky, fog, rain. The driver passes a physics world (colliders are created);
 * the navigator passes null and gets the same visuals without physics.
 */
export function buildStageWorld(
  scene: THREE.Scene,
  stage: BuiltStage,
  opts: { quality: 'high' | 'low'; physics: PhysicsWorld | null; fogMultiplier: number },
): StageWorld {
  const track = buildTrack(stage);
  scene.add(track.road, track.terrain);
  let roadColliderHandle: number | null = null;
  if (opts.physics) {
    roadColliderHandle = opts.physics.addTrimesh(track.roadCollider.vertices, track.roadCollider.indices, 0.9).handle;
    opts.physics.addTrimesh(track.terrainCollider.vertices, track.terrainCollider.indices, 0.8);
  }
  const env = stage.def.environment;
  const atmosphere = new Atmosphere(scene, env, opts.quality === 'high', opts.fogMultiplier);
  const scenery = new Scenery(stage, track.data, opts.physics, opts.quality);
  scene.add(scenery.group);
  let rain: RainSystem | null = null;
  if (env.rain > 0) {
    rain = new RainSystem(env.rain * (opts.quality === 'high' ? 1 : 0.5));
    scene.add(rain.lines);
  }
  const spray = new DustSystem(500, env.rain > 0 ? 'rgba(90,80,64,' : 'rgba(200,180,150,');
  scene.add(spray.points);
  return { terrain: track.data, scenery, atmosphere, rain, spray, roadColliderHandle };
}
