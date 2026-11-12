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
  bestKey,
  computePrize,
  gridSpot,
  aiGridOffset,
  type DriverRace,
  type RelayedTelemetry,
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
import { career, money } from '../career';
import { AIDriver, AI_CREWS } from './ai/AIDriver';
import { VEHICLES, FIELD, TEAMS, applyUpgrades, vehicleById, dailyChallenge, medalFor, MEDAL_PAY, MEDAL_RANK, DAILY_FINISH_PAY } from '@cdr/shared';
import { eventCtx, type EventContext } from '../events/context';
import { champ } from '../championship/state';
import { classificationTable, formatMs } from '../ui/classification';
import { RemoteCar, fallbackPaint } from './RemoteCars';
import { applySharedSwitch, decodeSwitches, defaultSwitches, encodeSwitches, SHARED_SWITCHES, type CarSwitches, type SharedSwitch } from '@cdr/shared';
import { CockpitPicker } from './vehicle/CockpitPicker';
import type { ControlId } from './vehicle/Controls';

import { DustSystem } from './environment/Atmosphere';
import { FirstPersonCamera } from './camera/FirstPersonCamera';
import { Input } from './input/Input';
import { loadRapier, PhysicsWorld } from './physics/PhysicsWorld';
import { RaceClient } from './race/RaceClient';
import { bakeCarModel, createCarModel } from './vehicle/CarModel';
import { Cockpit } from './vehicle/Cockpit';
import { DAMAGE_KEYS, Vehicle } from './vehicle/Vehicle';
import type { AIDriver as AIDriverT } from './ai/AIDriver';
import { buildStageWorld, type StageWorld } from './world/StageWorld';

export type GameExit = 'menu' | 'lobby' | 'service' | 'daily' | 'limited';

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
  /** Prize for the current run (sent to the navigator so they get their share). */
  private prize: { runId: number; total: number } | null = null;
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
  private ctx: EventContext = eventCtx.get();
  private carryApplied = false;
  private retired = false;
  /** Other players' cars, and AI cars run on the AI host's machine. */
  private remotes = new Map<string, RemoteCar>();
  /** True when this game simulates the AI cars (solo, or first on the grid). */
  private aiLocal = true;
  private look: number[] = [0, 0, 0];
  private readonly myId = net.session?.playerId ?? '';
  /** Cockpit switches of my car (ignition, lights, wipers…). */
  private sw: CarSwitches = defaultSwitches();
  private held = new Set<ControlId>();
  private cranking = 0;
  private crankNeed = 1;
  private trip = { start: 0, watchStart: 0, watchAcc: 0, running: false, mapLight: false };
  private picker: CockpitPicker | null = null;
  private clock = 0;

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
      // sharp but not wasteful: very high-DPI screens cost 4× the pixels for little gain
      this.maxPixelRatio = Math.min(window.devicePixelRatio, quality === 'high' ? 1.5 : 1);
      this.pixelRatio = this.maxPixelRatio;
      this.renderer.setPixelRatio(this.pixelRatio);
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
      const ctx = this.ctx;
      if (ctx.kind === 'championship') {
        sel.vehicle = applyUpgrades(vehicleById(ctx.carId), ctx.upgrades);
        const team = TEAMS[champ.get()?.team ?? 'privateer'];
        if (team.carId) sel.paint = { id: team.id, name: team.name, body: team.colour, accent: team.accent };
      } else if (ctx.kind === 'daily') {
        sel.vehicle = vehicleById(ctx.carId); // loan car, stock – same for everyone
      } else if (ctx.kind === 'limited' && ctx.carId) {
        sel.vehicle = vehicleById(ctx.carId); // the event's loan car, stock
      }
      const model = createCarModel(sel.paint, sel.wheel, sel.vehicle.body);
      this.scene.add(model.root);
      this.vehicle = new Vehicle(this.physics, sel.vehicle, sel.wheel, model);
      if (this.world.roadColliderHandle !== null) this.vehicle.roadColliders.add(this.world.roadColliderHandle);
      // First person only: hide the outside of the car, show the cockpit and switch on real headlights.
      model.setExteriorVisible(false);
      if (this.weather.headlights) model.enableHeadlights();
      model.setHeadlights(false);
      this.vehicle.weatherGrip = this.weather.grip;
      this.cockpit = new Cockpit(sel.paint, 'driver', sel.vehicle.body.model);
      model.root.add(this.cockpit.group);
      this.vehicle.onGearChange = (up) => audio.gearChange(up);
      this.vehicle.onImpact = (s, zone) => {
        audio.impact(s);
        if (zone === 'windscreen' || (zone === 'front' && s > 0.15)) audio.glass(s);
      };

      this.look = [Math.max(0, VEHICLES.findIndex((x) => x.id === sel.vehicle.id)), sel.paint.body, sel.paint.accent];
      // AI opponents: real physics cars lined up behind the players. In a multiplayer rally
      // the first driver on the grid runs them and everyone else sees them as remote cars.
      const aiHost = room?.race.aiHost;
      this.aiLocal = !aiHost || aiHost === this.myId;
      const driverCount = Math.max(1, room?.race.drivers.length ?? 1);
      const aiCount = this.aiLocal ? room?.race.aiCount ?? 0 : 0;
      for (let i = 0; i < aiCount; i++) {
        const entrant = this.ctx.kind === 'championship' ? this.ctx.entrants[i] : undefined;
        const crew = entrant ?? AI_CREWS[i % AI_CREWS.length];
        // AI drive a mix of cars (their team's car in the championship) – looks only, same physics
        const champEntrant = entrant ? FIELD.find((f) => f.id === entrant.entrantId) : undefined;
        const bodyCar = champEntrant ? vehicleById(TEAMS[champEntrant.team].carId ?? VEHICLES[(i + 1) % VEHICLES.length].id) : VEHICLES[(i + 1) % VEHICLES.length];
        const aiModel = createCarModel(crew.paint, WHEELS[0], bodyCar.body);
        bakeCarModel(aiModel); // merged into a few meshes – rivals used to cost hundreds of draw calls each
        this.scene.add(aiModel.root);
        const skill = entrant?.skill ?? room?.race.aiSkill ?? 'medium';
        const driver = new AIDriver(this.physics, stage, crew.name, aiModel, skill, aiGridOffset(i, driverCount), this.weather);
        if (entrant) this.aiEntrant.set(driver, entrant.entrantId);
        if (this.world.roadColliderHandle !== null) driver.vehicle.roadColliders.add(this.world.roadColliderHandle);
        this.ai.push(driver);
      }

      // No automatic pace notes: the co-driver calls the stage out loud.
      this.race = new RaceClient(stage);

      this.fp = new FirstPersonCamera(this.container.clientWidth / this.container.clientHeight, 'driver');
      this.picker = new CockpitPicker(this.container, () => this.fp.camera, this.cockpit.controls, (id) => this.pressControl(id), (id) => this.releaseControl(id));
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
    this.input.on('reset', () => this.resetVehicle());
    this.input.on('pause', () => (this.paused ? this.closeOverlay() : this.openPause()));
  }

  private bindNet() {
    this.unsubs.push(
      net.on('race', (s) => this.applyRaceState(s)),
      net.on('telemetry', (p) => this.onRemoteTelemetry(p)),
      net.on('switch', (e) => {
        if (import.meta.env.DEV) console.debug('[switch]', e.id, e.down, e.from);
        if (!(SHARED_SWITCHES as readonly string[]).includes(e.id)) return;
        this.sw = applySharedSwitch(this.sw, e.id, e.down);
        if (e.id === 'horn') audio.horn(e.down);
        else {
          audio.click();
          this.hud.warn(`${e.from.toUpperCase()}: ${e.id.toUpperCase()}`, 1.2);
        }
      }),
      net.on('checkpoint', (e) => {
        if (e.runId !== this.raceState?.runId || e.playerId !== this.myId) return;
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
      net.on('finished', (r) => {
        if (r.playerId === this.myId) this.onFinished(r);
        else if (r.name) toast(`${r.name} finished · ${formatMs(r.timeMs)}`, 'ok');
      }),
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
    const nav = net.room?.members.find((m) => m.role === 'navigator' && m.navFor === this.myId);
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
    const me = this.myRace();
    const grid = gridSpot(this.stage, me?.slot ?? 0, Math.max(1, this.raceState?.drivers.length ?? net.room?.race.drivers.length ?? 1));
    if (spawnD === this.stage.spawnDistance) spawnD = grid.distance;
    const s = sampleAt(this.stage.samples, spawnD);
    // +lateral = left of the road: left of heading h is (cos h, 0, -sin h)
    this.vehicle.place(s.x + Math.cos(s.h) * grid.lateral, s.y + 0.9, s.z - Math.sin(s.h) * grid.lateral, s.h);
    this.vehicle.resetDamage();
    if (this.ctx.kind === 'championship' && !this.carryApplied) {
      this.vehicle.setDamage(this.ctx.carry.zones);
      this.carryApplied = true;
    }
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
    this.prize = null;
    // every stage starts with the car switched off: pre-stage checks are part of the job
    this.sw = defaultSwitches();
    this.cranking = 0;
    audio.crank(false);
    audio.horn(false);
    this.trip = { start: this.stage.spawnDistance, watchStart: 0, watchAcc: 0, running: false, mapLight: this.trip.mapLight };
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('devstart')) this.sw = { ...this.sw, ignition: true, engine: true, headlights: true };
    this.remotes.forEach((r) => {
      r.clear();
      r.finishMs = null;
      r.active = true;
    });
  }

  // ---------------------------------------------------------------- cockpit switches
  private pressControl(id: ControlId) {
    this.held.add(id);
    const sw = this.sw;
    switch (id) {
      case 'ignition':
        this.sw = { ...sw, ignition: !sw.ignition, engine: sw.ignition ? false : sw.engine };
        audio.click(true);
        break;
      case 'start':
        audio.click(true);
        if (sw.ignition && !sw.engine) {
          this.cranking = performance.now();
          // a battered engine takes longer to fire
          this.crankNeed = 0.55 + Math.random() * 0.45 + this.vehicle.damage.engine * 1.6;
          audio.crank(true);
        } else if (!sw.ignition) this.hud.warn('IGNITION FIRST', 1.2);
        break;
      case 'horn':
        this.sw = { ...sw, horn: true };
        audio.horn(true);
        break;
      case 'trip':
        this.trip.start = this.race.distance;
        audio.click();
        break;
      case 'watch': {
        const now = performance.now();
        if (this.trip.running) this.trip.watchAcc += now - this.trip.watchStart;
        else this.trip.watchStart = now;
        this.trip.running = !this.trip.running;
        audio.click();
        break;
      }
      case 'watchReset':
        this.trip.watchAcc = 0;
        this.trip.watchStart = performance.now();
        audio.click();
        break;
      case 'mapLight':
        this.trip.mapLight = !this.trip.mapLight;
        audio.click();
        break;
      default:
        this.sw = applySharedSwitch(sw, id as SharedSwitch);
        audio.click();
    }
  }

  private releaseControl(id: ControlId) {
    this.held.delete(id);
    if (id === 'start') {
      this.cranking = 0;
      audio.crank(false);
    }
    if (id === 'horn') {
      this.sw = { ...this.sw, horn: false };
      audio.horn(false);
    }
  }

  /** Starter motor, engine state, lights – once per frame. */
  private updateSwitches(dt: number) {
    if (this.cranking > 0) {
      const held = (performance.now() - this.cranking) / 1000;
      if (!this.sw.ignition) {
        this.cranking = 0;
        audio.crank(false);
      } else if (held >= this.crankNeed) {
        this.cranking = 0;
        this.sw = { ...this.sw, engine: true };
        audio.crank(false);
        audio.engineCatch();
      }
    }
    const v = this.vehicle;
    v.engineOn = this.sw.engine;
    const m = v.model;
    m.setHeadlights(this.sw.headlights);
    m.setLightPod(this.sw.pod);
    m.setHazards(this.sw.hazards);
    m.tick(this.clock);

    const phase = this.raceState?.phase;

    // point at the next switch to use (glowing ring + label in the car)
    const raceOn = phase === 'countdown' || phase === 'racing';
    let next: ControlId | null = null;
    let text = '';
    if (raceOn && !this.myRace()?.result) {
      if (!this.sw.ignition) [next, text] = ['ignition', 'CLICK: IGNITION'];
      else if (!this.sw.engine) [next, text] = ['start', this.cranking > 0 ? 'KEEP HOLDING…' : 'HOLD: START'];
      else if (this.weather.headlights && !this.sw.headlights) [next, text] = ['headlights', 'CLICK: LIGHTS'];
      else if ((this.weather.rain > 0 || this.weather.snow > 0) && this.sw.wipers === 0) [next, text] = ['wipers', 'CLICK: WIPERS'];
    }
    this.cockpit.setGuide(next, text);
  }

  private watchMs() {
    return this.trip.watchAcc + (this.trip.running ? performance.now() - this.trip.watchStart : 0);
  }

  // ---------------------------------------------------------------- other players
  private myRace(state: RaceState | null = this.raceState ?? net.room?.race ?? null): DriverRace | null {
    return state?.drivers.find((d) => d.playerId === this.myId) ?? null;
  }

  private remote(id: string, name: string, paintIndex: number, carIndex = 0) {
    let r = this.remotes.get(id);
    if (!r) {
      r = new RemoteCar(this.scene, this.physics, id, name, fallbackPaint(paintIndex), carIndex);
      if (id.startsWith('ai:')) {
        const crew = AI_CREWS[Number(id.slice(3)) % AI_CREWS.length];
        r.model.setPaint(crew.paint);
      }
      this.remotes.set(id, r);
    }
    return r;
  }

  private onRemoteTelemetry(p: RelayedTelemetry) {
    if (!this.physics || p.pid === this.myId || p.runId !== this.raceState?.runId) return;
    const d = this.raceState.drivers.find((x) => x.playerId === p.pid);
    if (!d) return;
    const car = this.remote(p.pid, d.name, d.slot);
    if (p.look) car.setLook(p.look[0], p.look[1], p.look[2]);
    car.push({ t: p.serverTime, x: p.x, y: p.y, z: p.z, h: p.h, p: p.p, r: p.r });
    car.distance = p.dist;
    car.model.setBrakeLights(p.brake > 0.1 || p.handbrake); // so you can see them stop in the dark
    if (p.sw !== undefined) {
      const rs = decodeSwitches(p.sw);
      car.model.setHeadlights(rs.headlights);
      car.model.setLightPod(rs.pod);
      car.model.setHazards(rs.hazards);
    }
    car.active = !d.result && !d.retired; // finished cars leave the road so nobody piles into them
    // AI cars simulated by the AI host
    if (!this.aiLocal && p.pid === this.raceState.aiHost && p.ai) {
      for (let i = 0; i < p.ai.length / 6; i++) {
        const a = p.ai.slice(i * 6, i * 6 + 6);
        const crew = AI_CREWS[i % AI_CREWS.length];
        const ai = this.remote(`ai:${i}`, crew.name, i);
        ai.push({ t: p.serverTime, x: a[0], y: a[1], z: a[2], h: a[3], p: 0, r: 0 });
        ai.distance = a[4];
        ai.finishMs = a[5] >= 0 ? a[5] : null;
        ai.active = ai.finishMs === null;
      }
    }
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
    for (const d of state.drivers) {
      const r = this.remotes.get(d.playerId);
      if (r && (d.result || d.retired)) r.active = false;
    }
    const mine = this.myRace(state);
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
    this.vehicle.frozen = state.phase !== 'racing' || !!mine?.result || !!mine?.retired;
    if (state.phase === 'racing' && prev?.phase === 'countdown') {
      this.hud.center('GO!');
      audio.countdown(0);
    }
    if (mine?.result && !this.resultShown) this.onFinished(mine.result);
  }

  private onFinished(r: RaceResult) {
    if (this.resultShown) return;
    this.resultShown = true;
    this.vehicle.frozen = true;
    this.hud.center('FINISH');
    if (this.ctx.kind === 'championship') return this.finishChampionship(r);
    if (this.ctx.kind === 'daily') return this.finishDaily(r, this.ctx.date);
    if (this.ctx.kind === 'limited') return this.finishLimited(r, this.ctx);

    // ---- prize money + personal best ----
    const state = this.raceState!;
    const standings = this.standings(r.timeMs, true);
    const sorted = [...standings].sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity));
    const position = sorted.findIndex((s) => s.you) + 1;
    const v = this.vehicle;
    const prize = computePrize({
      stageLengthM: this.stage.finishDistance - this.stage.startDistance,
      weather: state.weather,
      aiSkill: state.aiSkill,
      position,
      fieldSize: standings.length,
      zones: DAMAGE_KEYS.map((k) => v.damage[k]),
      resets: r.resets,
    });
    this.prize = { runId: state.runId, total: prize.total };
    const runKey = `${net.room?.code}:${state.runId}:${r.finishedAt}`;
    const paid = career.credit(runKey, prize.total, position === 1 && standings.length > 1);
    const isBest = career.recordBest(bestKey(state.stageId, state.weather), r.timeMs);
    const rewards = h(
      'div',
      { class: 'rewards', 'data-testid': 'rewards' },
      isBest ? h('div', { class: 'new-record' }, 'NEW PERSONAL BEST!') : null,
      h('div', { class: 'panel-title', style: 'margin:14px 0 6px' }, 'Prize money'),
      ...prize.lines.map((l) => h('div', { class: `prize-line ${l.amount < 0 ? 'neg' : ''}` }, h('span', {}, l.label), h('span', {}, `${l.amount < 0 ? '−' : '+'}${money(Math.abs(l.amount))}`))),
      h('div', { class: 'prize-line total' }, h('span', {}, paid ? 'Added to your bank' : 'Already paid'), h('span', {}, money(prize.total))),
      h('div', { class: 'prize-line' }, h('span', {}, 'Balance'), h('span', {}, money(career.get().money))),
    );

    setTimeout(() => {
      if (this.disposed || this.myRace()?.result?.finishedAt !== r.finishedAt) return;
      const multi = (this.raceState?.drivers.length ?? 1) > 1;
      const actions = net.isHost
        ? [
            { label: multi ? 'Restart for everyone' : 'Restart stage', primary: true, onClick: () => this.restart() },
            { label: 'Back to lobby', onClick: () => void net.toLobby().catch((e) => toast(e.message, 'bad')) },
            { label: 'Main menu', onClick: () => this.leave() },
          ]
        : [{ label: 'Leave rally', onClick: () => this.leave() }];
      if (!net.isHost) rewards.prepend(h('div', { class: 'setup-desc' }, `${net.member(net.room?.hostId)?.name ?? 'The host'} decides when to restart or go back to the lobby.`));
      this.showOverlay(resultsOverlay(r, this.stage, actions, () => this.standings(r.timeMs), rewards));
    }, 1200);
  }

  /**
   * Standings vs the AI. With `project`, crews still on the stage get an
   * estimated time from their pace so far (used for the payout at the finish).
   */
  private standings(playerMs: number, project = false): Standing[] {
    const elapsed = Math.max(1, this.raceTimeMs());
    const estimate = (a: AIDriverT) => {
      const covered = Math.max(1, a.distance - this.stage.spawnDistance);
      const remaining = Math.max(0, this.stage.finishDistance - a.distance);
      return Math.round(elapsed + remaining / (covered / elapsed));
    };
    const est = (dist: number) => {
      const covered = Math.max(1, dist - this.stage.spawnDistance);
      return Math.round(elapsed + Math.max(0, this.stage.finishDistance - dist) / (covered / elapsed));
    };
    const players: Standing[] = (this.raceState?.drivers ?? [])
      .filter((d) => d.playerId !== this.myId)
      .map((d) => ({
        name: d.name,
        timeMs: d.result?.timeMs ?? (d.retired ? null : project ? est(this.remotes.get(d.playerId)?.distance ?? this.stage.spawnDistance) : null),
        you: false,
      }));
    const remoteAi: Standing[] = [...this.remotes.values()]
      .filter((r) => r.id.startsWith('ai:'))
      .map((r) => ({ name: r.name, timeMs: r.finishMs ?? (project ? est(r.distance) : null), you: false }));
    return [
      { name: this.myRace()?.name ?? 'You', timeMs: playerMs, you: true },
      ...players,
      ...this.ai.map((a) => ({ name: a.name, timeMs: a.finishTimeMs ?? (project ? estimate(a) : null), you: false })),
      ...remoteAi,
    ];
  }

  // ---------------------------------------------------------------- championship
  private aiEntrant = new Map<AIDriverT, string>();

  private damageNow() {
    const v = this.vehicle;
    return { zones: DAMAGE_KEYS.map((k) => v.damage[k]), wheels: [0, 0, 0, 0] };
  }

  /** Times of the AI that raced you; any still on the stage get a projected time. */
  private onTrackTimes(playerMs: number | null) {
    const proj = this.standings(playerMs ?? this.raceTimeMs(), true);
    const len = this.stage.finishDistance - this.stage.spawnDistance;
    return this.ai.map((a, i) => {
      // a projection from the first few hundred metres is meaningless – let the championship simulate it
      const enough = a.finishTimeMs !== null || (a.distance - this.stage.spawnDistance) / len > 0.3;
      return { entrantId: this.aiEntrant.get(a) ?? '', timeMs: enough ? proj[i + 1].timeMs : null };
    });
  }

  private finishChampionship(r: RaceResult | null) {
    const summary = champ.finishRound(r?.timeMs ?? null, this.onTrackTimes(r?.timeMs ?? null), this.damageNow(), r?.resets ?? this.resets);
    if (summary) this.prize = { runId: this.raceState?.runId ?? 0, total: summary.prize.total };
    const save = champ.get();
    const rec = save?.results[save.results.length - 1];
    const extra = h('div', { class: 'rewards', 'data-testid': 'rewards' });
    if (summary && rec) {
      extra.append(
        h('div', { class: 'new-record' }, summary.position === null ? 'RETIRED – NO POINTS' : `P${summary.position} · +${summary.pointsGained} PTS`),
        classificationTable(rec.classification, 12),
        h('div', { class: 'panel-title', style: 'margin:14px 0 6px' }, 'Prize money'),
        ...summary.prize.lines.map((l) => h('div', { class: `prize-line ${l.amount < 0 ? 'neg' : ''}` }, h('span', {}, l.label), h('span', {}, `${l.amount < 0 ? '−' : '+'}${money(Math.abs(l.amount))}`))),
        h('div', { class: 'prize-line total' }, h('span', {}, 'Added to your bank'), h('span', {}, money(summary.prize.total))),
      );
    }
    const show = () => {
      if (this.disposed) return;
      const actions = [{ label: 'Go to service park', primary: true, onClick: () => void this.leaveTo('service') }];
      if (r) return this.showOverlay(resultsOverlay(r, this.stage, actions, undefined, extra));
      const go = h('button', { class: 'btn primary', onclick: () => void this.leaveTo('service') }, 'Go to service park');
      this.showOverlay(
        h('div', { class: 'overlay results' },
          h('div', { class: 'card', style: 'max-height:92vh;overflow-y:auto' },
            h('h2', {}, 'Retired'),
            h('div', { class: 'sub' }, `${this.stage.def.name} · ${this.stage.def.location}`),
            extra,
            h('div', { class: 'actions' }, go),
          ),
        ),
      );
    };
    if (r) setTimeout(show, 1200);
    else show();
  }

  private retire() {
    if (this.retired || this.resultShown) return;
    this.retired = true;
    void net.retire().catch(() => undefined);
    this.resultShown = true;
    this.vehicle.frozen = true;
    this.finishChampionship(null);
  }

  private finishDaily(r: RaceResult, date: string) {
    const ch = dailyChallenge(date);
    const medal = medalFor(r.timeMs, ch.targets);
    const prev = career.get().daily;
    const today = prev.date === date ? prev : { date, bestMs: null, medal: 'none' as const, finished: false };
    let pay = today.finished ? 0 : DAILY_FINISH_PAY;
    const lines: Array<[string, number]> = [];
    if (pay) lines.push(['First finish today', pay]);
    if (MEDAL_RANK[medal] > MEDAL_RANK[today.medal]) {
      const diff = MEDAL_PAY[medal] - MEDAL_PAY[today.medal];
      lines.push([`${medal[0].toUpperCase()}${medal.slice(1)} medal${today.medal !== 'none' ? ' (upgrade)' : ''}`, diff]);
      pay += diff;
    }
    const best = today.bestMs === null || r.timeMs < today.bestMs;
    career.setDaily({ date, bestMs: best ? r.timeMs : today.bestMs, medal: MEDAL_RANK[medal] > MEDAL_RANK[today.medal] ? medal : today.medal, finished: true });
    if (pay) career.credit(`daily:${date}:${r.finishedAt}`, pay, false);
    this.prize = { runId: this.raceState?.runId ?? 0, total: pay };
    const t = ch.targets;
    const tgt = (m: 'gold' | 'silver' | 'bronze', ms: number) =>
      h('div', { class: `prize-line ${r.timeMs <= ms ? '' : 'neg'}` }, h('span', {}, `${m === 'gold' ? '🥇' : m === 'silver' ? '🥈' : '🥉'} ${m}`), h('span', {}, formatMs(ms)));
    const extra = h(
      'div',
      { class: 'rewards', 'data-testid': 'rewards' },
      h('div', { class: 'new-record' }, medal === 'none' ? 'NO MEDAL – TRY AGAIN' : `${medal.toUpperCase()} MEDAL!`),
      best ? h('div', { class: 'sub' }, 'Your best time today.') : null,
      tgt('gold', t.gold), tgt('silver', t.silver), tgt('bronze', t.bronze),
      h('div', { class: 'panel-title', style: 'margin:14px 0 6px' }, 'Prize money'),
      ...(lines.length ? lines : [['Nothing new this time', 0] as [string, number]]).map(([l, a]) => h('div', { class: 'prize-line' }, h('span', {}, l), h('span', {}, `+${money(a)}`))),
      h('div', { class: 'prize-line' }, h('span', {}, 'Balance'), h('span', {}, money(career.get().money))),
    );
    setTimeout(() => {
      if (this.disposed || this.raceState?.phase !== 'finished') return;
      this.showOverlay(
        resultsOverlay(r, this.stage, [
          { label: 'Try again', primary: true, onClick: () => this.restart() },
          { label: 'Daily leaderboard', onClick: () => void this.leaveTo('daily') },
          { label: 'Main menu', onClick: () => this.leave() },
        ], undefined, extra),
      );
    }, 1200);
  }

  private finishLimited(r: RaceResult, ev: { id: string; name: string; prize: number }) {
    const first = !career.limitedDone(ev.id);
    if (first) {
      career.markLimitedDone(ev.id);
      if (ev.prize > 0) career.credit(`limited:${ev.id}`, ev.prize, false);
    }
    this.prize = { runId: this.raceState?.runId ?? 0, total: first ? ev.prize : 0 };
    const extra = h(
      'div',
      { class: 'rewards', 'data-testid': 'rewards' },
      h('div', { class: 'new-record' }, ev.name.toUpperCase()),
      h('div', { class: 'panel-title', style: 'margin:14px 0 6px' }, 'Prize money'),
      h('div', { class: 'prize-line' }, h('span', {}, first ? 'Event finished' : 'Prize already collected'), h('span', {}, `+${money(first ? ev.prize : 0)}`)),
      h('div', { class: 'prize-line' }, h('span', {}, 'Balance'), h('span', {}, money(career.get().money))),
      h('div', { class: 'sub' }, 'Your time is on the event leaderboard.'),
    );
    setTimeout(() => {
      if (this.disposed || this.raceState?.phase !== 'finished') return;
      this.showOverlay(
        resultsOverlay(r, this.stage, [
          { label: 'Try again', primary: true, onClick: () => this.restart() },
          { label: 'Event leaderboard', onClick: () => void this.leaveTo('limited') },
          { label: 'Main menu', onClick: () => this.leave() },
        ], undefined, extra),
      );
    }, 1200);
  }

  private async leaveTo(to: GameExit) {
    this.closeOverlay();
    await net.leave().catch(() => undefined);
    this.onExit(to);
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
    if (this.raceState?.phase === 'finished' || this.resultShown) return;
    const champRound = this.ctx.kind === 'championship';
    const card = h(
      'div',
      { class: 'overlay' },
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Paused'),
        h('div', { class: 'sub' }, champRound ? 'Championship round – no restarts. The clock keeps running.' : (this.raceState?.drivers.length ?? 1) > 1 ? 'The stage clock keeps running and the others keep driving.' : 'The stage clock keeps running – this is rally.'),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => this.closeOverlay() }, 'Resume'),
          champRound || !net.isHost ? null : h('button', { class: 'btn', onclick: () => this.restart() }, (this.raceState?.drivers.length ?? 1) > 1 ? 'Restart for everyone' : 'Restart stage'),
          h('button', { class: 'btn', onclick: () => { this.closeOverlay(); this.resetVehicle(); } }, 'Reset car'),
          this.ctx.kind === 'quick' && net.isHost ? h('button', { class: 'btn', onclick: () => void net.toLobby().catch((e) => toast(e.message, 'bad')) }, 'Back to lobby') : null,
          champRound
            ? h('button', { class: 'btn danger', onclick: () => this.retire() }, 'Retire from round (0 pts)')
            : h('button', { class: 'btn danger', onclick: () => void (this.ctx.kind === 'daily' ? this.leaveTo('daily') : this.ctx.kind === 'limited' ? this.leaveTo('limited') : this.leave()) }, 'Quit rally'),
        ),
      ),
    );
    this.showOverlay(card);
    this.paused = true;
    this.input.enabled = false;
  }

  // ---------------------------------------------------------------- loop
  private maxPixelRatio = 1;
  private pixelRatio = 1;
  private frameAvg = 16;
  private perfCheckAt = 0;

  /**
   * Keeps the game smooth: if frames get slow the picture is drawn at a lower
   * resolution (and shadows switch off), then sharpened again when there is room.
   * A smooth frame rate matters more than sharpness – at low frame rates the car
   * seems to jump along the road.
   */
  private adaptQuality(frameMs: number, now: number) {
    this.frameAvg += (Math.min(frameMs, 100) - this.frameAvg) * 0.05;
    if (now < this.perfCheckAt) return;
    this.perfCheckAt = now + 1500;
    if (this.frameAvg > 22) {
      if (this.renderer.shadowMap.enabled) {
        this.renderer.shadowMap.enabled = false;
        this.scene.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | undefined;
          if (m && !Array.isArray(m)) m.needsUpdate = true;
        });
      } else if (this.pixelRatio > 0.6) {
        this.pixelRatio = Math.max(0.6, this.pixelRatio - 0.15);
        this.renderer.setPixelRatio(this.pixelRatio);
      }
    } else if (this.frameAvg < 13 && this.pixelRatio < this.maxPixelRatio) {
      this.pixelRatio = Math.min(this.maxPixelRatio, this.pixelRatio + 0.1);
      this.renderer.setPixelRatio(this.pixelRatio);
    }
  }

  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const frameMs = now - this.lastFrame;
    const dt = Math.min(0.1, frameMs / 1000);
    this.lastFrame = now;
    if (this.lastFrame > 0 && frameMs > 0) this.adaptQuality(frameMs, now);
    const v = this.vehicle;

    this.input.update(dt, v.telemetry.speed);
    this.clock += dt;
    this.updateSwitches(dt);
    const phase = this.raceState?.phase;

    // Surface under the car: road surface at this point of the stage, the
    // stage's verge when off the road, and the river if we went in.
    const p0 = v.position;
    v.roadSurface = SURFACES[surfaceAt(this.stage, this.race.distance)];
    v.offroadSurface = SURFACES[this.stage.def.offroad];
    const river = this.world.terrain.waterAt(p0.x, p0.z);
    v.inWater = !!river && p0.y < river.waterY + 0.6;

    // where everyone is (AI overtaking / not ramming)
    const others = [
      { x: p0.x, z: p0.z, speed: Math.abs(v.telemetry.speed) },
      ...[...this.remotes.values()].filter((r) => r.active).map((r) => {
        const rp = r.body.translation();
        return { x: rp.x, z: rp.z, speed: 15 };
      }),
      ...this.ai.map((a) => {
        const ap = a.vehicle.position;
        return { x: ap.x, z: ap.z, speed: Math.abs(a.vehicle.telemetry.speed) };
      }),
    ];
    this.ai.forEach((a, i) => {
      const selfIdx = others.length - this.ai.length + i;
      a.others = others.map((o, j) => ({ ...o, self: j === selfIdx }));
    });

    const aiRacing = phase === 'racing' || phase === 'finished';
    const raceMs = this.raceTimeMs();
    let netT = net.serverNow();
    this.physics.step(dt, (fixed) => {
      netT += fixed * 1000;
      for (const r of this.remotes.values()) r.stepBody(netT);
      v.step(fixed, this.input.state);
      for (const a of this.ai) a.step(fixed, aiRacing, phase === 'racing' ? Math.max(0, net.serverNow() - (this.raceState?.startAt ?? 0)) : raceMs);
    });
    v.afterStep();
    const alpha = this.physics.alpha;
    v.syncVisuals(alpha);
    for (const a of this.ai) {
      a.afterStep();
      a.vehicle.syncVisuals(alpha);
      // rivals far away (hidden by night/fog anyway) aren't drawn at all
      const ap = a.vehicle.model.root.position;
      a.vehicle.model.root.visible = Math.abs(ap.x - p0.x) + Math.abs(ap.z - p0.z) < 400;
    }
    v.model.setHeadlightDamage(v.damage.front);
    for (const r of this.remotes.values()) {
      r.syncVisual(p0);
      r.model.tick(this.clock);
    }

    const pos = v.model.root.position.clone();
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
      sw: this.sw,
      held: this.held,
      tripKm: (this.race.distance - this.trip.start) / 1000,
      watchMs: this.watchMs(),
      watchRunning: this.trip.running,
      mapLight: this.trip.mapLight,
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
    this.hud.updateRace(timeMs, this.race.distance, this.race.remaining, this.race.progress01, this.myRace()?.checkpointsPassed ?? 0);
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
    const mine = this.myRace();
    if (mine?.result) return mine.result.timeMs;
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
      cp: this.myRace()?.checkpointsPassed ?? 0,
      nextNote: this.race.nextNote ? this.race.nextNoteIndex : -1,
      toNote: r2(this.race.distanceToNext),
      dmg: r2(t.damage),
      resets: this.resets,
      dz: DAMAGE_KEYS.map((k) => r2(v.damage[k])),
      prize: this.prize && this.prize.runId === this.raceState.runId ? this.prize.total : undefined,
      look: this.look,
      sw: encodeSwitches(this.sw),
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
    this.remotes.forEach((r) => r.dispose());
    this.picker?.dispose();
    audio.crank(false);
    audio.horn(false);
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

