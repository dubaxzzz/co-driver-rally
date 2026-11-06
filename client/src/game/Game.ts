import * as THREE from 'three';
import {
  DEFAULT_STAGE_ID,
  SURFACES,
  TELEMETRY_INTERVAL_MS,
  WEATHER,
  WHEELS,
  getStage,
  sampleAt,
  surfaceAt,
  type WeatherDef,
  type BuiltStage,
  type RaceResult,
  type RaceState,
  type TelemetryPacket,
} from '@cdr/shared';
import { audio } from '../audio/AudioEngine';
import { net } from '../multiplayer/NetClient';
import { fogMultiplier, garageStore, settings } from '../settings';
import { h, loadingOverlay, toast } from '../ui/dom';
import { Hud } from '../ui/hud';
import { resultsOverlay, type Standing } from '../ui/results';
import { AIDriver, AI_CREWS } from './ai/AIDriver';
import { DustSystem } from './environment/Atmosphere';
import { FirstPersonCamera } from './camera/FirstPersonCamera';
import { Input } from './input/Input';
import { loadRapier, PhysicsWorld } from './physics/PhysicsWorld';
import { RaceClient } from './race/RaceClient';
import { createCarModel } from './vehicle/CarModel';
import { Cockpit } from './vehicle/Cockpit';
import { DAMAGE_KEYS, Vehicle } from './vehicle/Vehicle';
import { buildStageWorld, type StageWorld } from './world/StageWorld';

export type GameExit = 'menu' | 'lobby';

/**
 * The driver's game: owns the renderer, physics world, vehicle, stage and
 * HUD, and keeps them in sync with the server-authoritative race state.
 */
export class Game {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private physics!: PhysicsWorld;
  private vehicle!: Vehicle;
  private stage!: BuiltStage;
  private world!: StageWorld;
  private weather!: WeatherDef;
  private ai: AIDriver[] = [];
  private smoke = new DustSystem(260, 'rgba(70,70,74,', -0.8, 2.6);
  private underwaterFor = 0;
  private cockpit!: Cockpit;
  private fp!: FirstPersonCamera;
  private input = new Input();
  private race!: RaceClient;
  private hud!: Hud;
  private raf = 0;
  private lastFrame = 0;
  private telemetryAcc = 0;
  private seq = 0;
  private resets = 0;
  private upsideDownFor = 0;
  private raceState: RaceState | null = null;
  private lastCountdownShown = -1;
  private overlay: HTMLElement | null = null;
  private paused = false;
  private unsubs: Array<() => void> = [];
  private disposed = false;
  private resultShown = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly onExit: (to: GameExit) => void,
  ) {}

  async init() {
    const loading = loadingOverlay('Loading stage');
    this.container.append(loading);
    try {
      const R = await loadRapier();
      if (this.disposed) return;
      const room = net.room;
      const stage = getStage(room?.race.stageId ?? DEFAULT_STAGE_ID);
      if (!stage) throw new Error('Stage not found');
      this.stage = stage;
      this.weather = WEATHER[room?.race.weather ?? 'storm'] ?? WEATHER.storm;
      const quality = settings.get().quality;

      // Renderer
      this.renderer = new THREE.WebGLRenderer({ antialias: quality === 'high', powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1));
      this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
      this.renderer.shadowMap.enabled = quality === 'high' && !this.weather.night;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.renderer.domElement.classList.add('webgl');
      this.container.prepend(this.renderer.domElement);

      // Physics + world
      this.physics = new PhysicsWorld(R);
      await new Promise((r) => setTimeout(r, 0)); // let the loading screen paint
      this.world = buildStageWorld(this.scene, stage, { quality, physics: this.physics, fogMultiplier: fogMultiplier(), weather: this.weather.id });
      this.scene.add(this.smoke.points);
      this.unsubs.push(settings.subscribe(() => this.world.atmosphere.setFogMultiplier(fogMultiplier())));

      // Vehicle
      const sel = garageStore.resolve();
      const model = createCarModel(sel.paint, sel.wheel);
      this.scene.add(model.root);
      this.vehicle = new Vehicle(this.physics, sel.vehicle, sel.wheel, model);
      if (this.world.roadColliderHandle !== null) this.vehicle.roadColliders.add(this.world.roadColliderHandle);
      // First person only: hide the outside of the car, show the cockpit and switch on real headlights.
      model.setExteriorVisible(false);
      if (this.weather.headlights) model.enableHeadlights();
      this.vehicle.weatherGrip = this.weather.grip;
      this.cockpit = new Cockpit(sel.paint, 'driver');
      model.root.add(this.cockpit.group);
      this.vehicle.onGearChange = (up) => audio.gearChange(up);
      this.vehicle.onImpact = (s, zone) => {
        audio.impact(s);
        if (zone === 'windscreen' || (zone === 'front' && s > 0.15)) audio.glass(s);
      };

      // AI opponents: real physics cars lined up behind you; they never collide with you.
      const aiCount = room?.race.aiCount ?? 0;
      for (let i = 0; i < aiCount; i++) {
        const crew = AI_CREWS[i % AI_CREWS.length];
        const aiModel = createCarModel(crew.paint, WHEELS[0]);
        this.scene.add(aiModel.root);
        const driver = new AIDriver(this.physics, stage, crew.name, aiModel, room?.race.aiSkill ?? 'medium', 9 * (i + 1), this.weather);
        if (this.world.roadColliderHandle !== null) driver.vehicle.roadColliders.add(this.world.roadColliderHandle);
        this.ai.push(driver);
      }

      // No automatic pace notes: the co-driver calls the stage out loud.
      this.race = new RaceClient(stage);

      this.fp = new FirstPersonCamera(this.container.clientWidth / this.container.clientHeight, 'driver');
      if (import.meta.env.DEV) (window as unknown as { __cdrGame?: unknown }).__cdrGame = this;

      this.hud = new Hud(stage);
      this.container.append(this.hud.root);
      this.hud.setRoom(room?.code ?? '----');

      this.bindInput();
      this.bindNet();
      this.spawn();
      window.addEventListener('resize', this.onResize);
      audio.startDriving();

      this.raceState = net.room?.race ?? null;
      if (this.raceState) this.applyRaceState(this.raceState);
      this.lastFrame = performance.now();
      this.raf = requestAnimationFrame(this.loop);
    } catch (e) {
      console.error(e);
      toast(`Could not start the game: ${(e as Error).message}`, 'bad', 6000);
      this.onExit('menu');
    } finally {
      loading.remove();
    }
  }

  // ---------------------------------------------------------------- setup
  private bindInput() {
    this.input.on('wipers', () => {
      const next = ((settings.get().wipers + 1) % 3) as 0 | 1 | 2;
      settings.update({ wipers: next });
      toast(`Wipers: ${['off', 'slow', 'fast'][next]}`);
    });
    this.input.on('lights', () => {
      const m = this.vehicle.model;
      m.setLightPod(!m.lightPodOn);
      toast(`Light pod ${m.lightPodOn ? 'on' : 'off'}`);
    });
    this.input.on('reset', () => this.resetVehicle());
    this.input.on('pause', () => (this.paused ? this.closeOverlay() : this.openPause()));
  }

  private bindNet() {
    this.unsubs.push(
      net.on('race', (s) => this.applyRaceState(s)),
      net.on('checkpoint', (e) => {
        if (e.runId !== this.raceState?.runId) return;
        this.world.scenery.markCheckpoint(e.index, true);
        this.hud.center(`CP ${e.index + 1}`);
        audio.chime();
      }),
      net.on('warning', (w) => {
        if (w.type === 'missed-checkpoint') {
          this.hud.warn(`MISSED CHECKPOINT ${w.checkpoint + 1} – GO BACK`, 4);
        } else if (w.type === 'telemetry-rejected') {
          this.hud.warn('POSITION REJECTED BY SERVER', 2);
        }
      }),
      net.on('finished', (r) => this.onFinished(r)),
      net.on('room', () => this.updateConnectionChips()),
      net.on('status', () => this.updateConnectionChips()),
      net.on('closed', (p) => {
        toast(p.reason, 'bad', 5000);
        this.onExit('menu');
      }),
      net.on('resumed', (r) => {
        this.applyRaceState(r.room.race);
        this.updateConnectionChips();
      }),
    );
    this.updateConnectionChips();
  }

  private updateConnectionChips() {
    if (!this.hud) return;
    const server = net.status === 'connected' ? 'ok' : net.status === 'reconnecting' || net.status === 'connecting' ? 'warn' : 'bad';
    const nav = net.room?.navigator;
    const navState = !nav ? 'none' : nav.connected ? 'ok' : 'warn';
    const label = !nav ? 'NO NAVIGATOR' : nav.connected ? `NAV: ${nav.name}` : 'NAVIGATOR RECONNECTING';
    this.hud.setConnection(server, navState, label);
  }

  private spawn() {
    // Development-only shortcuts for screenshots/testing (stripped from production builds):
    //   ?devspawn=bridge|<metres>  start somewhere else on the stage
    //   ?devdamage=0.8            start with a damaged car
    let spawnD = this.stage.spawnDistance;
    let devDamage = 0;
    if (import.meta.env.DEV) {
      const q = new URLSearchParams(location.search);
      const sp = q.get('devspawn');
      if (sp === 'bridge' && this.stage.bridges[0]) spawnD = this.stage.bridges[0].distance - 45;
      else if (sp && Number.isFinite(Number(sp))) spawnD = Number(sp);
      devDamage = Number(q.get('devdamage') ?? 0) || 0;
    }
    const s = sampleAt(this.stage.samples, spawnD);
    this.vehicle.place(s.x, s.y + 0.9, s.z, s.h);
    this.vehicle.resetDamage();
    if (devDamage) {
      const d = this.vehicle.damage;
      d.front = d.windscreen = d.engine = devDamage;
      d.left = devDamage * 0.5;
    }
    this.vehicle.syncVisuals();
    this.race.resetRun();
    this.resets = 0;
    this.stage.checkpoints.forEach((c) => this.world.scenery.markCheckpoint(c.index, false));
    this.ai.forEach((a) => {
      a.resetToGrid();
      a.vehicle.syncVisuals();
    });
  }

  private resetVehicle() {
    if (!this.vehicle || this.raceState?.phase === 'finished') return;
    const d = Math.max(this.stage.spawnDistance, this.race.distance - 3);
    const s = sampleAt(this.stage.samples, d);
    this.vehicle.place(s.x, s.y + 1.0, s.z, s.h);
    this.resets++;
    this.upsideDownFor = 0;
  }

  // ---------------------------------------------------------------- race
  private applyRaceState(state: RaceState) {
    const prev = this.raceState;
    this.raceState = state;
    if (state.phase === 'lobby') {
      this.onExit('lobby');
      return;
    }
    const newRun = !prev || prev.runId !== state.runId;
    if (state.phase === 'countdown' && newRun) {
      this.closeOverlay();
      this.resultShown = false;
      this.spawn();
      this.lastCountdownShown = -1;
    }
    this.vehicle.frozen = state.phase !== 'racing';
    if (state.phase === 'racing' && prev?.phase === 'countdown') {
      this.hud.center('GO!');
      audio.countdown(0);
    }
    if (state.phase === 'finished' && state.result && !this.resultShown) this.onFinished(state.result);
  }

  private onFinished(r: RaceResult) {
    if (this.resultShown) return;
    this.resultShown = true;
    this.vehicle.frozen = true;
    this.hud.center('FINISH');
    setTimeout(() => {
      if (this.disposed || this.raceState?.phase !== 'finished') return;
      this.showOverlay(
        resultsOverlay(r, this.stage, [
          { label: 'Restart stage', primary: true, onClick: () => this.restart() },
          { label: 'Back to lobby', onClick: () => void net.toLobby().catch((e) => toast(e.message, 'bad')) },
          { label: 'Main menu', onClick: () => this.leave() },
        ], () => this.standings(r.timeMs)),
      );
    }, 1200);
  }

  private standings(playerMs: number): Standing[] {
    return [
      { name: net.room?.driver?.name ?? 'You', timeMs: playerMs, you: true },
      ...this.ai.map((a) => ({ name: a.name, timeMs: a.finishTimeMs, you: false })),
    ];
  }

  private restart() {
    this.closeOverlay();
    net.restartRace().catch((e) => toast(e.message, 'bad'));
  }

  private async leave() {
    this.closeOverlay();
    await net.leave();
    this.onExit('menu');
  }

  // ---------------------------------------------------------------- overlays
  private showOverlay(el: HTMLElement) {
    this.closeOverlay();
    this.overlay = el;
    this.container.append(el);
  }

  private closeOverlay() {
    this.overlay?.remove();
    this.overlay = null;
    this.paused = false;
    this.input.enabled = true;
  }

  private openPause() {
    if (this.raceState?.phase === 'finished') return;
    const card = h(
      'div',
      { class: 'overlay' },
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Paused'),
        h('div', { class: 'sub' }, 'The stage clock keeps running – this is rally.'),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => this.closeOverlay() }, 'Resume'),
          h('button', { class: 'btn', onclick: () => this.restart() }, 'Restart stage'),
          h('button', { class: 'btn', onclick: () => { this.closeOverlay(); this.resetVehicle(); } }, 'Reset car'),
          h('button', { class: 'btn', onclick: () => void net.toLobby().catch((e) => toast(e.message, 'bad')) }, 'Back to lobby'),
          h('button', { class: 'btn danger', onclick: () => void this.leave() }, 'Quit rally'),
        ),
      ),
    );
    this.showOverlay(card);
    this.paused = true;
    this.input.enabled = false;
  }

  // ---------------------------------------------------------------- loop
  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const v = this.vehicle;

    this.input.update(dt, v.telemetry.speed);
    const phase = this.raceState?.phase;

    // Surface under the car: road surface at this point of the stage, the
    // stage's verge when off the road, and the river if we went in.
    const p0 = v.position;
    v.roadSurface = SURFACES[surfaceAt(this.stage, this.race.distance)];
    v.offroadSurface = SURFACES[this.stage.def.offroad];
    const river = this.world.terrain.waterAt(p0.x, p0.z);
    v.inWater = !!river && p0.y < river.waterY + 0.6;

    const aiRacing = phase === 'racing' || phase === 'finished';
    const raceMs = this.raceTimeMs();
    this.physics.step(dt, (fixed) => {
      v.step(fixed, this.input.state);
      for (const a of this.ai) a.step(fixed, aiRacing, phase === 'racing' ? Math.max(0, net.serverNow() - (this.raceState?.startAt ?? 0)) : raceMs);
    });
    v.afterStep();
    v.syncVisuals();
    for (const a of this.ai) {
      a.afterStep();
      a.vehicle.syncVisuals();
      // AI cars pass through you (no contact in rally) – hide one while it overlaps your car
      a.vehicle.model.root.visible = a.vehicle.model.root.position.distanceTo(v.model.root.position) > 4.2;
    }
    v.model.setHeadlightDamage(v.damage.front);

    const pos = v.position.clone();
    this.race.update(pos.x, pos.z, v.telemetry.speed, false);

    // Countdown display
    if (phase === 'countdown' && this.raceState?.startAt) {
      const remain = this.raceState.startAt - net.serverNow();
      const n = Math.ceil(remain / 1000);
      if (n !== this.lastCountdownShown && n > 0 && n <= 3) {
        this.lastCountdownShown = n;
        this.hud.center(String(n));
        audio.countdown(n);
      }
    }

    // Off-road safety: fell through/away, or stuck upside down
    const roadY = sampleAt(this.stage.samples, this.race.distance).y;
    if (pos.y < roadY - 25 || Math.abs(this.race.lateral) > 105) this.resetVehicle();
    // stuck in the river?
    if (v.inWater && Math.abs(v.telemetry.speed) < 2) {
      this.underwaterFor += dt;
      if (this.underwaterFor > 3) this.hud.warn('IN THE RIVER – PRESS R', 1);
    } else this.underwaterFor = 0;
    // a damaged engine smokes from under the bonnet
    if (v.damage.engine > 0.35 && Math.random() < v.damage.engine * dt * 30) {
      const sp = new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.45, 1.7).applyQuaternion(v.model.root.quaternion).add(pos);
      const lvv = v.body.linvel();
      this.smoke.emit(sp.x, sp.y, sp.z, lvv.x * 2, lvv.z * 2, 1.6);
    }
    this.smoke.update(dt);
    if (v.upright < 0.2 && Math.abs(v.telemetry.speed) < 2) {
      this.upsideDownFor += dt;
      if (this.upsideDownFor > 2.5) {
        this.hud.warn('PRESS R TO RESET', 1);
      }
    } else this.upsideDownFor = 0;

    // Mud spray from the wheels
    const t = v.telemetry;
    const lv = v.body.linvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    if (t.grounded && Math.abs(t.speed) > 6 && settings.get().quality === 'high') {
      const n = Math.min(4, Math.floor(Math.abs(t.speed) / 8 + t.slip * 3));
      for (let i = 0; i < n; i++) {
        const back = new THREE.Vector3((Math.random() - 0.5) * 1.6, -0.5, -1.8).applyQuaternion(v.model.root.quaternion).add(pos);
        this.world.spray.emit(back.x, back.y, back.z, lv.x, lv.z);
      }
    }
    this.world.spray.update(dt);

    // Cockpit animation, first-person camera, weather
    const st = settings.get();
    this.cockpit.update(dt, {
      steer: this.input.state.steer,
      rpm: t.rpm,
      maxRpm: v.def.maxRpm,
      speed: t.speed,
      gear: t.gear,
      handbrake: this.input.state.handbrake && !v.frozen,
      brake: t.brake,
      wipers: st.wipers,
      rain: this.weather.rain,
      snow: this.weather.snow,
      speedUnit: st.units,
      damage: v.damage,
    });
    this.fp.update(dt, v.model.root, v.accelLocal, v.bump);
    this.world.update(dt, this.fp.camera.position, vel);
    audio.setRiver(Math.max(0, 1 - this.world.terrain.riverDistanceAt(pos.x, pos.z) / 80));

    // HUD
    const timeMs = this.raceTimeMs();
    this.hud.updateDash(t.speed, t.gear, t.rpm, v.def.maxRpm, t.damage);
    this.hud.updateRace(timeMs, this.race.distance, this.race.remaining, this.race.progress01, this.raceState?.checkpointsPassed ?? 0);
    this.hud.tick(dt);

    this.hud.setDamage(v.damage, v.surfaceName.name);
    audio.update(t.rpm, phase === 'racing' ? t.throttle : 0, t.speed, t.slip, v.surfaceName.sound, t.grounded);

    // Telemetry at ~20 Hz
    this.telemetryAcc += dt * 1000;
    if (this.telemetryAcc >= TELEMETRY_INTERVAL_MS) {
      this.telemetryAcc %= TELEMETRY_INTERVAL_MS;
      this.sendTelemetry(timeMs);
    }

    this.renderer.render(this.scene, this.fp.camera);
  };

  private raceTimeMs() {
    const s = this.raceState;
    if (!s || !s.startAt) return 0;
    if (s.phase === 'finished' && s.result) return s.result.timeMs;
    if (s.phase !== 'racing') return 0;
    return Math.max(0, net.serverNow() - s.startAt);
  }

  private sendTelemetry(timeMs: number) {
    if (!this.raceState) return;
    const v = this.vehicle;
    const p = v.position;
    const pr = v.pitchRoll;
    const t = v.telemetry;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const packet: TelemetryPacket = {
      runId: this.raceState.runId,
      seq: ++this.seq,
      t: Math.round(timeMs),
      x: r2(p.x),
      y: r2(p.y),
      z: r2(p.z),
      h: Math.round(v.heading * 1000) / 1000,
      p: Math.round(pr.pitch * 1000) / 1000,
      r: Math.round(pr.roll * 1000) / 1000,
      v: r2(t.speed),
      steer: r2(this.input.state.steer),
      throttle: r2(t.throttle),
      brake: r2(t.brake),
      handbrake: this.input.state.handbrake,
      gear: t.gear,
      rpm: Math.round(t.rpm),
      dist: r2(this.race.distance),
      remain: r2(this.race.remaining),
      cp: this.raceState.checkpointsPassed,
      nextNote: this.race.nextNote ? this.race.nextNoteIndex : -1,
      toNote: r2(this.race.distanceToNext),
      dmg: r2(t.damage),
      resets: this.resets,
      dz: DAMAGE_KEYS.map((k) => r2(v.damage[k])),
      ai: this.ai.flatMap((a) => {
        const ap = a.vehicle.position;
        return [r2(ap.x), r2(ap.y), r2(ap.z), Math.round(a.vehicle.heading * 1000) / 1000, Math.round(a.distance), a.finishTimeMs ?? -1];
      }),
    };
    net.sendTelemetry(packet);
  }

  private onResize = () => {
    const w = this.container.clientWidth;
    const hgt = this.container.clientHeight;
    this.renderer.setSize(w, hgt);
    this.fp.resize(w / hgt);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    audio.stopDriving();
    this.vehicle?.model.dispose();
    this.ai.forEach((a) => {
      a.vehicle.model.dispose();
      a.dispose();
    });
    this.cockpit?.dispose();
    this.world?.scenery.dispose();
    this.physics?.dispose();
    this.renderer?.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}
