import {
  DEFAULT_STAGE_ID,
  SURFACES,
  WEATHER,
  getStage,
  surfaceAt,
  type BuiltStage,
  type RaceState,
  type RelayedTelemetry,
} from '@cdr/shared';
import { audio } from '../audio/AudioEngine';
import { net } from '../multiplayer/NetClient';
import { formatDistance, formatSpeed, formatTime } from '../settings';
import { h, toast } from '../ui/dom';
import { resultsOverlay, type Standing } from '../ui/results';
import { AI_CREWS } from '../game/ai/AIDriver';
import { career, money } from '../career';
import { NAVIGATOR_SHARE, decodeSystems, stageConditions, zoneAmount, type StageConditions, type SysCommand } from '@cdr/shared';
import type { CockpitView } from './CockpitView';
import { Interpolator } from './Interpolator';
import { MapView } from './MapView';
import { TabletScreen, type TabletData } from './TabletScreen';

/**
 * The co-driver's seat. The navigator sits in the passenger seat (3D view
 * driven by the driver's live telemetry) with a tablet on their lap showing
 * the stage map and the car's data. There are no pace-note lists or call
 * buttons: the navigator reads the road from the map and calls it out loud,
 * in real life, to the driver.
 */
export class NavigatorApp {
  readonly root: HTMLElement;
  private stage: BuiltStage;
  private map: MapView;
  private interp = new Interpolator();
  /** Every other driver (and the AI host's AI cars) for the map and the windscreen. */
  private others = new Map<string, Interpolator>();
  private followed: string | null = net.followedDriverId();
  private raf = 0;
  private unsubs: Array<() => void> = [];
  private race: RaceState | null = null;
  private lastPacketAt = 0;
  private overlay: HTMLElement | null = null;
  private els: Record<string, HTMLElement> = {};
  private waitingEl: HTMLElement;
  private resultRun = -1;
  private view: CockpitView | null = null;
  private lookingDown = true;
  private lookBtn: HTMLButtonElement;
  private lastFrame = performance.now();
  private disposed = false;
  private rewardsEl: HTMLElement | null = null;
  private paidRun = -1;
  private screen: TabletScreen;
  private weatherName: string;
  private lastTabletDraw = 0;
  private tab: TabletData;
  private sysHoldUntil = 0;
  private cond: StageConditions | null = null;
  /** Watching rather than navigating (TV cameras, live times, pick who to follow). */
  private readonly spectator = net.me()?.role === 'spectator';
  private spec: { hud: HTMLElement; who: HTMLElement; time: HTMLElement; gap: HTMLElement; speed: HTMLElement; cam: HTMLButtonElement; board: HTMLElement } | null = null;

  private readonly weatherId: string;

  constructor(
    private readonly onExit: () => void,
    /** Called when the driver picks a different stage or weather in the lobby. */
    private readonly onReload: () => void,
  ) {
    this.stage = getStage(net.room?.race.stageId ?? DEFAULT_STAGE_ID) ?? getStage(DEFAULT_STAGE_ID)!;
    this.weatherId = net.room?.race.weather ?? 'storm';
    this.map = new MapView(this.stage);
    this.screen = new TabletScreen(this.map);
    const w = WEATHER[this.weatherId as keyof typeof WEATHER];
    this.weatherName = w?.name ?? '';
    this.tab = {
      code: net.room?.code ?? '----',
      phase: 'LOBBY',
      timer: '00:00.00',
      server: 'warn',
      driverOk: false,
      driverLabel: 'DRIVER',
      stageName: this.stage.def.name,
      weatherName: this.weatherName,
      waiting: true,
      mapStatus: 'No telemetry yet',
      speed: '0',
      speedUnit: formatSpeed(0).unit,
      gear: 'N',
      rpm: '0',
      pct: 0,
      remain: formatDistance(this.stage.finishDistance - this.stage.startDistance),
      cps: `0/${this.stage.checkpoints.length}`,
      surface: SURFACES[this.stage.def.surface].name,
      damage: 'OK',
      damageLevel: 0,
      sys: null,
      nextSurface: null,
      nextSurfaceIn: null,
      alert: null,
    };

    // Only two real buttons float over the view; everything else is on the tablet in your hands.
    this.lookBtn = h('button', { class: 'look-btn nav-look', 'data-testid': 'look-btn', onclick: () => this.toggleLook() }, '▲ Look at road') as HTMLButtonElement;
    const leaveBtn = h('button', { class: 'back-btn nav-leave', onclick: () => void this.leave() }, 'Leave');
    const hud = h('div', { class: 'nav-hud' }, leaveBtn, this.lookBtn);
    this.els.timer = h('span', { class: 'nav-timer-sr', 'data-testid': 'nav-timer', 'aria-live': 'off' }, '00:00.00');
    this.waitingEl = h('span', { class: 'nav-timer-sr', 'data-testid': 'nav-waiting' }, 'Waiting for the driver');
    const view3d = h('div', { class: 'nav-3d' }, h('div', { class: 'nav-3d-loading' }, 'Loading passenger-seat view…'));
    this.root = h('div', { class: 'nav-shell' }, view3d, hud, this.els.timer, this.waitingEl);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    if (this.spectator) this.buildSpectatorHud(hud);

    setTimeout(() => {
      import('./CockpitView')
        .then(({ CockpitView }) => {
          if (this.disposed) return;
          this.view = new CockpitView(view3d, this.stage, this.weatherId as keyof typeof WEATHER, this.screen);
          this.view.setLookDown(this.lookingDown);
          this.view.onSwitch = (id, down) => net.sendSwitch(id, down);
          this.view.onTabletTap = (u, v) => this.tapTablet(u, v);
          this.view.onTabletRaise = () => !this.lookingDown && this.toggleLook();
          if (this.spectator) {
            this.view.setSpectator(true);
            this.lookingDown = false;
          }
          if (this.cond) this.view.setConditions(this.cond);
          view3d.querySelector('.nav-3d-loading')?.remove();
        })
        .catch((e) => {
          console.error(e);
          // No 3D on this device: show the tablet screen flat instead
          view3d.innerHTML = '';
          view3d.classList.add('flat');
          const c = this.screen.canvas;
          c.classList.add('nav-flat-tablet');
          c.addEventListener('pointerdown', (ev) => {
            const r = c.getBoundingClientRect();
            this.tapTablet((ev.clientX - r.left) / r.width, 1 - (ev.clientY - r.top) / r.height);
          });
          view3d.append(c);
          const fit = () => this.screen.setPortrait(window.innerWidth / Math.max(1, window.innerHeight) < 0.9);
          fit();
          window.addEventListener('resize', fit);
          this.unsubs.push(() => window.removeEventListener('resize', fit));
          this.lookBtn.style.display = 'none';
        });
    }, 60);
    for (const p of net.lastJoin?.lastTelemetry ?? []) this.route(p);
    this.race = net.room?.race ?? null;
    this.bind();
    this.updateConnection();
    this.applyRace();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Sends a packet to the followed driver's view, or to the "other cars" buffers. */
  private route(p: RelayedTelemetry) {
    if (this.race && p.runId !== this.race.runId) return;
    if (p.pid === this.followed) return this.pushTelemetry(p);
    let it = this.others.get(p.pid);
    if (!it) this.others.set(p.pid, (it = new Interpolator()));
    it.push(p);
  }

  private driverRace() {
    return this.race?.drivers.find((d) => d.playerId === this.followed) ?? null;
  }

  private driverName() {
    return net.member(this.followed)?.name ?? this.driverRace()?.name ?? 'Driver';
  }

  private pushTelemetry(p: RelayedTelemetry) {
    this.interp.push(p);
    this.lastPacketAt = performance.now();
    // co-driver's share of the prize (paid on top – the driver keeps all of theirs)
    const dr = this.driverRace();
    if (!this.spectator && p.prize !== undefined && dr?.result && this.paidRun !== p.runId) {
      this.paidRun = p.runId;
      const share = Math.round(p.prize * NAVIGATOR_SHARE);
      const paid = career.credit(`nav:${net.room?.code}:${p.runId}:${dr.result.finishedAt}`, share);
      if (this.rewardsEl) {
        this.rewardsEl.innerHTML = '';
        this.rewardsEl.append(
          h('div', { class: 'panel-title', style: 'margin:14px 0 6px' }, 'Co-driver reward'),
          h('div', { class: 'prize-line' }, h('span', {}, `Driver's prize`), h('span', {}, money(p.prize))),
          h('div', { class: 'prize-line total' }, h('span', {}, paid ? `Your ${Math.round(NAVIGATOR_SHARE * 100)}% share – added to your bank` : 'Already paid'), h('span', {}, money(share))),
          h('div', { class: 'prize-line' }, h('span', {}, 'Your balance'), h('span', {}, money(career.get().money))),
        );
      }
    }
  }

  private bind() {
    this.unsubs.push(
      net.on('telemetry', (p) => this.route(p)),
      net.on('race', (s) => {
        if (s.stageId !== this.stage.def.id || s.weather !== this.weatherId) return this.onReload();
        const newRun = !this.race || this.race.runId !== s.runId;
        this.race = s;
        if (newRun) {
          this.cond = stageConditions(this.stage, s.runId, this.weatherId as Parameters<typeof stageConditions>[2]);
          this.map.conditions = this.cond;
          this.view?.setConditions(this.cond);
          this.interp.clear();
          this.others.clear();
          this.map.clearTrail();
          this.view?.resetTrip();
        }
        this.applyRace();
      }),
      net.on('room', (r) => {
        if (r.race.stageId !== this.stage.def.id || r.race.weather !== this.weatherId) return this.onReload();
        this.race = r.race;
        this.tab.code = r.code;
        const f = this.spectator && this.followed && r.race.drivers.some((d) => d.playerId === this.followed) ? this.followed : net.followedDriverId();
        if (f !== this.followed) {
          this.followed = f;
          this.interp.clear();
          this.others.clear();
          this.map.clearTrail();
          toast(this.spectator ? `Watching ${this.driverName()}` : `Now navigating for ${this.driverName()}`, 'ok');
        }
        this.updateConnection();
        this.applyRace();
      }),
      net.on('status', () => this.updateConnection()),
      net.on('checkpoint', (e) => {
        if (e.playerId === this.followed) toast(`Checkpoint ${e.index + 1} · ${formatTime(e.timeMs)}`, 'ok');
      }),
      net.on('finished', (r) => {
        if (r.playerId !== this.followed) toast(`${r.name} finished · ${formatTime(r.timeMs)}`, 'ok');
      }),
      net.on('warning', (w) => {
        if (w.type === 'missed-checkpoint') toast(`Driver missed checkpoint ${w.checkpoint + 1}!`, 'bad');
      }),
      net.on('resumed', (r) => {
        this.race = r.room.race;
        this.followed = net.followedDriverId();
        r.lastTelemetry.forEach((p) => this.route(p));
        this.applyRace();
        toast('Reconnected – race data restored', 'ok');
      }),
      net.on('closed', (p) => {
        toast(p.reason, 'bad', 5000);
        this.onExit();
      }),
    );
  }

  /** Spectator overlay: who you're watching, their time and gap, cameras, standings. */
  private buildSpectatorHud(hud: HTMLElement) {
    this.lookBtn.style.display = 'none';
    const who = h('div', { class: 'spec-who' });
    const time = h('div', { class: 'spec-time' }, '00:00.00');
    const gap = h('div', { class: 'spec-gap' });
    const speed = h('div', { class: 'spec-speed' });
    const cam = h('button', { class: 'btn spec-btn', 'data-testid': 'spec-cam' }, '🎥 TV cameras') as HTMLButtonElement;
    const modes = ['tv', 'chase', 'heli', 'incar'] as const;
    const names = { tv: '🎥 TV cameras', chase: '🚗 Chase cam', heli: '🚁 Helicopter', incar: '👀 In the car' };
    cam.onclick = () => {
      if (!this.view) return;
      const next = modes[(modes.indexOf(this.view.cameraMode) + 1) % modes.length];
      this.view.cameraMode = next;
      cam.textContent = names[next];
    };
    const prev = h('button', { class: 'btn spec-btn', 'data-testid': 'spec-prev', onclick: () => this.followNext(-1) }, '◀');
    const next = h('button', { class: 'btn spec-btn', 'data-testid': 'spec-next', onclick: () => this.followNext(1) }, '▶');
    const board = h('div', { class: 'spec-board' });
    const panel = h('div', { class: 'spec-hud' },
      h('div', { class: 'spec-top' }, h('div', { class: 'spec-tag' }, 'LIVE · SPECTATING'), who, time, gap),
      h('div', { class: 'spec-bottom' }, prev, cam, next, speed),
      board,
    );
    hud.append(panel);
    this.spec = { hud: panel, who, time, gap, speed, cam, board };
  }

  /** Spectators: watch the next/previous driver. */
  private followNext(step: number) {
    const drivers = (this.race?.drivers ?? []).map((d) => d.playerId);
    if (drivers.length < 2) return;
    const i = Math.max(0, drivers.indexOf(this.followed ?? ''));
    const id = drivers[(i + step + drivers.length) % drivers.length];
    if (id === this.followed) return;
    // keep everyone's buffered positions: swap the followed buffer with theirs
    if (this.followed) this.others.set(this.followed, this.interp);
    this.interp = this.others.get(id) ?? new Interpolator();
    this.others.delete(id);
    this.followed = id;
    this.map.clearTrail();
    this.updateConnection();
    toast(`Watching ${this.driverName()}`, 'ok');
  }

  /** Live numbers for the spectator overlay. */
  private updateSpectatorHud(now: number) {
    const sp = this.spec;
    const s = this.race;
    if (!sp || !s) return;
    const me = this.driverRace();
    const t = this.interp.latest;
    const progress = (pid: string) => (pid === this.followed ? t?.dist : this.others.get(pid)?.latest?.dist) ?? 0;
    // order: finished by time, then by distance down the stage
    const rows = s.drivers
      .map((d) => ({ d, dist: progress(d.playerId) }))
      .sort((a, b) => (a.d.result && b.d.result ? a.d.result.timeMs - b.d.result.timeMs : a.d.result ? -1 : b.d.result ? 1 : a.d.retired ? 1 : b.d.retired ? -1 : b.dist - a.dist));
    const pos = rows.findIndex((r) => r.d.playerId === this.followed) + 1;
    sp.who.textContent = `${pos ? `P${pos} · ` : ''}${this.driverName()}`;
    let ms = 0;
    if (s.phase === 'racing' && s.startAt) ms = Math.max(0, now - s.startAt);
    if (me?.result) ms = me.result.timeMs;
    sp.time.textContent = s.phase === 'countdown' && s.startAt ? `GO IN ${Math.max(0, Math.ceil((s.startAt - now) / 1000))}` : formatTime(ms);
    const leader = rows[0];
    if (me?.result) sp.gap.textContent = 'FINISHED';
    else if (me?.retired) sp.gap.textContent = 'RETIRED';
    else if (!leader || leader.d.playerId === this.followed || rows.length < 2) sp.gap.textContent = rows.length > 1 ? 'LEADING' : '';
    else {
      const behind = Math.max(0, leader.dist - progress(this.followed ?? ''));
      sp.gap.textContent = `+${(behind / Math.max(8, Math.abs(t?.v ?? 0))).toFixed(1)}s to ${leader.d.name}`;
    }
    const spd = formatSpeed(t?.v ?? 0);
    sp.speed.textContent = `${spd.value} ${spd.unit}`;
    sp.board.replaceChildren(
      ...rows.map((r, i) =>
        h('div', { class: `spec-row ${r.d.playerId === this.followed ? 'me' : ''}` },
          h('span', { class: 'p' }, String(i + 1)),
          h('span', { class: 'n' }, r.d.name),
          h('span', { class: 't' }, r.d.result ? formatTime(r.d.result.timeMs) : r.d.retired ? 'OUT' : `${Math.round((Math.max(0, r.dist - this.stage.startDistance) / (this.stage.finishDistance - this.stage.startDistance)) * 100)}%`),
        ),
      ),
    );
  }

  /** A tap on the tablet's screen (texture coordinates). */
  private tapTablet(u: number, v: number) {
    const b = this.screen.hit(u, v);
    if (!b) return;
    audio.click();
    this.lastTabletDraw = 0; // redraw right away
    if (b === 'follow' || b === 'full') this.map.mode = b;
    else if (b === 'tab-map') this.screen.page = 'map';
    else if (b === 'tab-car') this.screen.page = 'car';
    else {
      // a car system: tell the driver's game, and show it straight away on the tablet
      const s = this.tab.sys;
      if (!s) return;
      let cmd: SysCommand | null = null;
      if (b === 'flaps') cmd = { key: 'flaps', value: !s.flaps };
      else if (b === 'als') cmd = { key: 'als', value: !s.als };
      else if (b.startsWith('map')) cmd = { key: 'map', value: Number(b.slice(3)) as 0 | 1 | 2 };
      else if (b.startsWith('tyre')) cmd = { key: 'tyres', value: Number(b.slice(4)) as 0 | 1 | 2 };
      else if (b.startsWith('fuse')) cmd = { key: 'fuse', value: Number(b.slice(4)) };
      if (!cmd) return;
      net.sendSys(cmd);
      if (cmd.key === 'fuse') {
        if (s.fuse === cmd.value) s.fuse = -1;
      } else (s as unknown as Record<string, unknown>)[cmd.key] = cmd.value;
      this.sysHoldUntil = performance.now() + 600; // don't let older telemetry flick it back
    }
  }

  private toggleLook() {
    this.lookingDown = !this.lookingDown;
    this.root.classList.toggle('looking-up', !this.lookingDown);
    this.lookBtn.textContent = this.lookingDown ? '▲ Look at road' : '▼ Look at tablet';
    this.view?.setLookDown(this.lookingDown);
  }

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key === 'ArrowUp' && this.lookingDown) this.toggleLook();
    else if (e.key === 'ArrowDown' && !this.lookingDown) this.toggleLook();
    else return;
    e.preventDefault();
  };

  private onResize = () => this.view?.resize();

  private updateConnection() {
    this.tab.server = net.status === 'connected' ? 'ok' : net.status === 'disconnected' ? 'bad' : 'warn';
    const d = net.member(this.followed);
    this.tab.driverOk = !!d?.connected;
    const name = d && d.name.length > 12 ? `${d.name.slice(0, 11)}…` : d?.name;
    this.tab.driverLabel = d ? (d.connected ? `DRIVER: ${name}` : 'DRIVER OFFLINE') : 'NO DRIVER';
  }

  private applyRace() {
    const s = this.race;
    if (!s) return;
    const labels = { lobby: 'LOBBY', countdown: 'COUNTDOWN', racing: 'RACING', finished: 'FINISHED' } as const;
    this.tab.phase = labels[s.phase];
    if (s.phase === 'lobby') return void setTimeout(() => !this.disposed && this.onReload(), 0); // back to the lobby screen
    this.tab.waiting = false;
    this.waitingEl.style.display = 'none';
    const dr = this.driverRace();
    this.tab.cps = `${dr?.checkpointsPassed ?? 0}/${this.stage.checkpoints.length}`;
    const result = dr?.result;
    if (result && this.resultRun !== s.runId) {
      this.resultRun = s.runId;
      audio.chime();
      const multi = s.drivers.length > 1;
      const actions = net.isHost
        ? [
            { label: multi ? 'Restart for everyone' : 'Restart stage', primary: true, onClick: () => void net.restartRace().catch((e) => toast(e.message, 'bad')) },
            { label: 'Back to lobby', onClick: () => void net.toLobby().catch((e) => toast(e.message, 'bad')) },
            { label: 'Close', onClick: () => this.closeOverlay() },
          ]
        : [{ label: 'Close', onClick: () => this.closeOverlay() }];
      this.showOverlay(
        resultsOverlay(result, this.stage, actions, () => this.standings(result.timeMs), (this.rewardsEl = h('div', { class: 'rewards', 'data-testid': 'nav-rewards' }, h('div', { class: 'setup-desc' }, 'Waiting for the prize…')))),
      );
    }
    if (s.phase === 'countdown') this.closeOverlay();
  }

  private standings(playerMs: number): Standing[] {
    const hostT = this.race?.aiHost === this.followed ? this.interp.latest : this.others.get(this.race?.aiHost ?? '')?.latest;
    const ai = hostT?.ai ?? [];
    const list: Standing[] = [{ name: this.driverName(), timeMs: playerMs, you: true }];
    for (const d of this.race?.drivers ?? []) {
      if (d.playerId !== this.followed) list.push({ name: d.name, timeMs: d.result?.timeMs ?? null, you: false });
    }
    for (let i = 0; i < ai.length / 6; i++) {
      const ms = ai[i * 6 + 5];
      list.push({ name: AI_CREWS[i % AI_CREWS.length].name, timeMs: ms >= 0 ? ms : null, you: false });
    }
    return list;
  }

  private showOverlay(el: HTMLElement) {
    this.closeOverlay();
    this.overlay = el;
    this.root.append(el);
  }
  private closeOverlay() {
    this.overlay?.remove();
    this.overlay = null;
  }

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    const now = net.serverNow();
    const t0 = this.interp.sample(now);
    const s = this.race;
    // merge AI cars (from the AI host) and the other players into one list of cars to draw
    let t = t0;
    if (t0) {
      const extra: number[] = [];
      for (const [pid, it] of this.others) {
        const o = it.sample(now);
        if (!o) continue;
        const d = s?.drivers.find((x) => x.playerId === pid);
        if (d && !d.result && !d.retired) extra.push(o.x, o.y, o.z, o.h, o.dist, -1);
        if (pid === s?.aiHost && o.ai) extra.push(...o.ai);
      }
      const ownAi = s?.aiHost === this.followed ? t0.ai ?? [] : [];
      t = { ...t0, ai: [...ownAi, ...extra] };
    }
    const pnow = performance.now();
    const dt = Math.min(0.1, (pnow - this.lastFrame) / 1000);
    this.lastFrame = pnow;
    this.view?.update(dt, t);
    if (this.spectator && pnow - this.lastTabletDraw > 200) {
      this.lastTabletDraw = pnow;
      this.updateSpectatorHud(now);
    }
    const tab = this.tab;
    // timer from the authoritative race state
    let ms = 0;
    if (s?.phase === 'racing' && s.startAt) ms = Math.max(0, now - s.startAt);
    const res = this.driverRace()?.result;
    if (res) ms = res.timeMs;
    tab.timer = s?.phase === 'countdown' && s.startAt ? `GO IN ${Math.max(0, Math.ceil((s.startAt - now) / 1000))}` : formatTime(ms);
    this.els.timer.textContent = tab.timer;
    const age = performance.now() - this.lastPacketAt;
    if (!t) {
      tab.mapStatus = net.member(this.followed)?.connected ? 'Waiting for telemetry…' : 'Driver offline';
    } else {
      tab.mapStatus = age > 1500 ? `Telemetry stalled (${(age / 1000).toFixed(1)}s)` : `Live · ${net.latencyMs ?? '–'} ms`;
      const sp = formatSpeed(t.v);
      tab.speed = String(sp.value);
      tab.speedUnit = sp.unit;
      tab.gear = t.gear === -1 ? 'R' : t.gear === 0 ? 'N' : String(t.gear);
      tab.rpm = String(Math.round(t.rpm / 10) * 10);
      const span = this.stage.finishDistance - this.stage.startDistance;
      tab.pct = Math.min(100, Math.max(0, ((t.dist - this.stage.startDistance) / span) * 100));
      tab.remain = formatDistance(t.remain);
      tab.surface = SURFACES[surfaceAt(this.stage, t.dist)].name;
      if (t.sys !== undefined && performance.now() > this.sysHoldUntil) tab.sys = decodeSystems(t.sys, t.tmp ?? 70);
      else if (tab.sys && t.tmp !== undefined) tab.sys.temp = t.tmp;
      // the next change of surface (for tyre pressures)
      const nextSpan = this.stage.surfaceSpans.find((sp) => sp.from > t.dist && sp.surface !== surfaceAt(this.stage, t.dist));
      const near = !!nextSpan && nextSpan.from - t.dist < 1500;
      tab.nextSurface = near && nextSpan ? SURFACES[nextSpan.surface].name : null;
      tab.nextSurfaceIn = near && nextSpan ? nextSpan.from - t.dist : null;
      // the next thing to warn the driver about
      tab.alert = null;
      if (this.cond) {
        const ob = this.cond.obstacles.find((o) => o.distance > t.dist - 5 && o.distance - t.dist < 700);
        if (ob) {
          const what = ob.kind === 'tree' ? 'TREE DOWN' : ob.kind === 'rocks' ? 'ROCKS ON ROAD' : 'ANIMALS CROSSING';
          tab.alert = `${what} IN ${Math.max(0, Math.round((ob.distance - t.dist) / 10) * 10)} m – ${ob.side > 0 ? 'LEFT' : 'RIGHT'} BLOCKED, KEEP ${ob.side > 0 ? 'RIGHT' : 'LEFT'}`;
        } else {
          const w = this.cond.wet.find((z) => z.from > t.dist && z.from - t.dist < 600);
          const f = this.cond.fog.find((z) => z.from > t.dist && z.from - t.dist < 600);
          if (w) tab.alert = `RAIN SHOWER IN ${Math.round((w.from - t.dist) / 10) * 10} m – GRIP WILL DROP`;
          else if (f) tab.alert = `FOG BANK IN ${Math.round((f.from - t.dist) / 10) * 10} m`;
          else if (zoneAmount(this.cond.wet, t.dist) > 0.2) tab.alert = 'IN THE SHOWER – WIPERS ON, WET ROAD';
        }
      }
      const worst = t.dz ? Math.max(...t.dz) : t.dmg;
      tab.damage = worst < 0.05 ? 'OK' : `${Math.round(worst * 100)}%`;
      tab.damageLevel = worst > 0.6 ? 2 : worst > 0.2 ? 1 : 0;
    }
    // the tablet screen refreshes ~12 times a second (plenty for a map, and cheap)
    if (!this.spectator && pnow - this.lastTabletDraw > 80) {
      this.lastTabletDraw = pnow;
      this.screen.setMapState(t, this.driverRace()?.checkpointsPassed ?? 0);
      this.screen.draw(tab);
    }
  };

  private async leave() {
    await net.leave();
    this.onExit();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    this.view?.dispose();
  }
}
