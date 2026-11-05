import * as THREE from 'three';
import {
  DEFAULT_STAGE_ID,
  TELEMETRY_INTERVAL_MS,
  getStage,
  sampleAt,
  type BuiltStage,
  type NavCall,
  type RaceResult,
  type RaceState,
  type TelemetryPacket,
} from '@cdr/shared';
import { audio } from '../audio/AudioEngine';
import { net } from '../multiplayer/NetClient';
import { garageStore, settings } from '../settings';
import { h, loadingOverlay, toast } from '../ui/dom';
import { Hud } from '../ui/hud';
import { resultsOverlay } from '../ui/results';
import { CameraRig } from './camera/CameraRig';
import { Atmosphere, DustSystem } from './environment/Atmosphere';
import { Scenery } from './environment/Scenery';
import { Input } from './input/Input';
import { loadRapier, PhysicsWorld } from './physics/PhysicsWorld';
import { RaceClient } from './race/RaceClient';
import { buildTrack, type TerrainData } from './tracks/TrackMeshes';
import { createCarModel } from './vehicle/CarModel';
import { Vehicle } from './vehicle/Vehicle';

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
  private terrain!: TerrainData;
  private scenery!: Scenery;
  private atmosphere!: Atmosphere;
  private dust = new DustSystem();
  private rig!: CameraRig;
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
      const quality = settings.get().quality;

      // Renderer
      this.renderer = new THREE.WebGLRenderer({ antialias: quality === 'high', powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1));
      this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
      this.renderer.shadowMap.enabled = quality === 'high';
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.renderer.domElement.classList.add('webgl');
      this.container.prepend(this.renderer.domElement);

      // Physics + world
      this.physics = new PhysicsWorld(R);
      await new Promise((r) => setTimeout(r, 0)); // let the loading screen paint
      const track = buildTrack(stage);
      this.terrain = track.data;
      this.scene.add(track.road, track.terrain);
      const roadCol = this.physics.addTrimesh(track.roadCollider.vertices, track.roadCollider.indices, 0.9);
      this.physics.addTrimesh(track.terrainCollider.vertices, track.terrainCollider.indices, 0.8);
      this.atmosphere = new Atmosphere(this.scene, stage.def.environment, quality === 'high');
      this.scenery = new Scenery(stage, this.terrain, this.physics, quality);
      this.scene.add(this.scenery.group, this.dust.points);

      // Vehicle
      const sel = garageStore.resolve();
      const model = createCarModel(sel.paint, sel.wheel);
      this.scene.add(model.root);
      this.vehicle = new Vehicle(this.physics, sel.vehicle, sel.wheel, model);
      this.vehicle.roadColliders.add(roadCol.handle);
      this.vehicle.onGearChange = (up) => audio.gearChange(up);
      this.vehicle.onImpact = (s) => audio.impact(s);

      this.race = new RaceClient(stage);
      this.race.onAnnounce = (note, dist) => {
        this.hud.showNote(note.text, dist);
        audio.chime(note.kind === 'hazard');
        if (!net.room?.navigator?.connected || settings.get().autoNotes === 'always') audio.speak(note.spoken);
      };

      this.rig = new CameraRig(this.container.clientWidth / this.container.clientHeight, (x, z) => this.terrain.heightAt(x, z));
      this.rig.mode = settings.get().camera % 3;

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
    this.input.on('camera', () => {
      const name = this.rig.cycle();
      settings.update({ camera: this.rig.mode });
      toast(`Camera: ${name}`);
    });
    this.input.on('reset', () => this.resetVehicle());
    this.input.on('pause', () => (this.paused ? this.closeOverlay() : this.openPause()));
  }

  private bindNet() {
    this.unsubs.push(
      net.on('race', (s) => this.applyRaceState(s)),
      net.on('call', (c) => this.onNavCall(c)),
      net.on('checkpoint', (e) => {
        if (e.runId !== this.raceState?.runId) return;
        this.scenery.markCheckpoint(e.index, true);
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
    const s = sampleAt(this.stage.samples, this.stage.spawnDistance);
    this.vehicle.place(s.x, s.y + 0.9, s.z, s.h);
    this.vehicle.resetDamage();
    this.vehicle.syncVisuals();
    this.race.resetRun();
    this.resets = 0;
    this.stage.checkpoints.forEach((c) => this.scenery.markCheckpoint(c.index, false));
    this.rig?.snap();
  }

  private resetVehicle() {
    if (!this.vehicle || this.raceState?.phase === 'finished') return;
    const d = Math.max(this.stage.spawnDistance, this.race.distance - 3);
    const s = sampleAt(this.stage.samples, d);
    this.vehicle.place(s.x, s.y + 1.0, s.z, s.h);
    this.resets++;
    this.rig.snap();
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
        ]),
      );
    }, 1200);
  }

  private onNavCall(c: NavCall) {
    const caution = c.kind === 'caution';
    this.hud.showCall(c.repeated ? `${c.text} (REPEAT)` : c.text, caution);
    audio.chime(caution);
    audio.speak(c.text);
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
          h('button', { class: 'btn', onclick: () => { const n = this.rig.cycle(); settings.update({ camera: this.rig.mode }); toast(`Camera: ${n}`); } }, 'Change camera'),
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
    this.physics.step(dt, (fixed) => v.step(fixed, this.input.state));
    v.afterStep();
    v.syncVisuals();

    const pos = v.position.clone();
    const phase = this.raceState?.phase;
    this.race.update(pos.x, pos.z, v.telemetry.speed, phase === 'racing' && settings.get().autoNotes !== 'off' &&
      (settings.get().autoNotes === 'always' || !net.room?.navigator?.connected));

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
    if (v.upright < 0.2 && Math.abs(v.telemetry.speed) < 2) {
      this.upsideDownFor += dt;
      if (this.upsideDownFor > 2.5) {
        this.hud.warn('PRESS R TO RESET', 1);
      }
    } else this.upsideDownFor = 0;

    // Dust from the wheels
    const t = v.telemetry;
    if (t.grounded && Math.abs(t.speed) > 6 && settings.get().quality === 'high') {
      const lv = v.body.linvel();
      const n = Math.min(4, Math.floor(Math.abs(t.speed) / 8 + t.slip * 3));
      for (let i = 0; i < n; i++) {
        const back = new THREE.Vector3((Math.random() - 0.5) * 1.6, -0.3, -1.6).applyQuaternion(v.model.root.quaternion).add(pos);
        this.dust.emit(back.x, back.y, back.z, lv.x, lv.z);
      }
    }
    this.dust.update(dt);

    // Camera + atmosphere
    const lv = v.body.linvel();
    this.rig.update(dt, v.model.root, new THREE.Vector3(lv.x, lv.y, lv.z), t.speed);
    this.atmosphere.follow(pos);

    // HUD
    const timeMs = this.raceTimeMs();
    const next = this.race.nextNote;
    this.hud.updateDash(t.speed, t.gear, t.rpm, v.def.maxRpm, t.damage);
    this.hud.updateRace(timeMs, this.race.distance, this.race.remaining, this.race.progress01, this.raceState?.checkpointsPassed ?? 0, next?.text ?? '', this.race.distanceToNext);
    this.hud.tick(dt);

    audio.update(t.rpm, phase === 'racing' ? t.throttle : 0, t.speed, t.slip, t.onGravel, t.grounded);

    // Telemetry at ~20 Hz
    this.telemetryAcc += dt * 1000;
    if (this.telemetryAcc >= TELEMETRY_INTERVAL_MS) {
      this.telemetryAcc %= TELEMETRY_INTERVAL_MS;
      this.sendTelemetry(timeMs);
    }

    this.renderer.render(this.scene, this.rig.camera);
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
    };
    net.sendTelemetry(packet);
  }

  private onResize = () => {
    const w = this.container.clientWidth;
    const hgt = this.container.clientHeight;
    this.renderer.setSize(w, hgt);
    this.rig.resize(w / hgt);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    audio.stopDriving();
    this.vehicle?.model.dispose();
    this.scenery?.dispose();
    this.physics?.dispose();
    this.renderer?.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}
