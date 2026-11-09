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
import { NAVIGATOR_SHARE } from '@cdr/shared';
import type { CockpitView } from './CockpitView';
import { Interpolator } from './Interpolator';
import { MapView } from './MapView';

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

  private readonly weatherId: string;

  constructor(
    private readonly onExit: () => void,
    /** Called when the driver picks a different stage or weather in the lobby. */
    private readonly onReload: () => void,
  ) {
    this.stage = getStage(net.room?.race.stageId ?? DEFAULT_STAGE_ID) ?? getStage(DEFAULT_STAGE_ID)!;
    this.weatherId = net.room?.race.weather ?? 'storm';
    this.map = new MapView(this.stage);
    const v = (key: string, init = '—') => (this.els[key] = h('div', { class: 'v' }, init));

    // ---- header ----
    this.lookBtn = h('button', { class: 'look-btn', 'data-testid': 'look-btn', onclick: () => this.toggleLook() }, '▲ Look at road') as HTMLButtonElement;
    this.els.code = h('span', { class: 'code' }, net.room?.code ?? '----');
    this.els.server = h('span', { class: 'chip' }, h('span', { class: 'status-dot' }), 'ONLINE');
    this.els.driver = h('span', { class: 'chip' }, h('span', { class: 'status-dot' }), 'DRIVER');
    this.els.timer = h('span', { class: 'timer', 'data-testid': 'nav-timer' }, '00:00.00');
    this.els.phase = h('span', { class: 'chip' }, 'LOBBY');
    const header = h(
      'div',
      { class: 'nav-header' },
      this.lookBtn,
      h('span', { class: 'brand' }, h('span', { class: 'co' }, 'CO-'), 'DRIVER'),
      h('span', { class: 'chip' }, 'ROOM'),
      this.els.code,
      this.els.server,
      this.els.driver,
      this.els.phase,
      this.els.timer,
      h('button', { class: 'back-btn', onclick: () => void this.leave() }, 'Leave'),
    );

    // ---- map ----
    const w = WEATHER[this.weatherId as keyof typeof WEATHER];
    this.waitingEl = h(
      'div',
      { class: 'nav-waiting', 'data-testid': 'nav-waiting' },
      h('div', {}, `${this.stage.def.name} · ${w?.name ?? ''}`, h('br'), h('small', { style: 'font-size:13px;color:var(--muted);letter-spacing:.06em' }, 'Waiting for the driver to start the stage…')),
    );
    this.els.mapStatus = h('div', { class: 'map-status' }, 'No telemetry yet');
    const followBtn = h('button', { class: 'sel' }, 'FOLLOW');
    const fullBtn = h('button', {}, 'FULL STAGE');
    followBtn.onclick = () => { this.map.mode = 'follow'; followBtn.classList.add('sel'); fullBtn.classList.remove('sel'); };
    fullBtn.onclick = () => { this.map.mode = 'full'; fullBtn.classList.add('sel'); followBtn.classList.remove('sel'); };
    const mapBox = h(
      'div',
      { class: 'nav-map' },
      this.map.canvas,
      h('div', { class: 'map-tools' }, followBtn, fullBtn),
      this.els.mapStatus,
      h('div', { class: 'map-hint' }, 'Read the road ahead and call it out loud to your driver'),
      this.waitingEl,
    );

    // ---- live data ----
    this.els.progress = h('i', {});
    const data = h(
      'div',
      { class: 'nav-data' },
      h('div', {}, h('div', { class: 'k' }, 'SPEED'), v('speed', '0')),
      h('div', {}, h('div', { class: 'k' }, 'GEAR'), v('gear', 'N')),
      h('div', {}, h('div', { class: 'k' }, 'RPM'), v('rpm', '0')),
      h('div', {}, h('div', { class: 'k' }, 'STAGE PROGRESS'), v('pct', '0%')),
      h('div', {}, h('div', { class: 'k' }, 'REMAINING'), v('remain', formatDistance(this.stage.finishDistance - this.stage.startDistance))),
      h('div', {}, h('div', { class: 'k' }, 'CHECKPOINTS'), v('cps', `0/${this.stage.checkpoints.length}`)),
      h('div', {}, h('div', { class: 'k' }, 'SURFACE'), v('surface', SURFACES[this.stage.def.surface].name)),
      h('div', {}, h('div', { class: 'k' }, 'CAR DAMAGE'), v('damage', 'OK')),
      h('div', { class: 'nav-progress' }, this.els.progress),
    );

    const navEl = h('div', { class: 'nav nav-voice' }, header, h('div', { class: 'nav-left' }, mapBox, data));
    const tablet = h('div', { class: 'nav-tablet' }, navEl);
    // When looking at the road, tapping the tablet edge brings it back up.
    tablet.addEventListener(
      'click',
      (e) => {
        if (!this.lookingDown && e.target !== this.lookBtn) {
          e.preventDefault();
          e.stopPropagation();
          this.toggleLook();
        }
      },
      true,
    );
    const view3d = h('div', { class: 'nav-3d' }, h('div', { class: 'nav-3d-loading' }, 'Loading passenger-seat view…'));
    this.root = h('div', { class: 'nav-shell' }, view3d, tablet);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);

    // Load the 3D passenger view after the tablet is on screen.
    setTimeout(() => {
      import('./CockpitView')
        .then(({ CockpitView }) => {
          if (this.disposed) return;
          this.view = new CockpitView(view3d, this.stage, this.weatherId as keyof typeof WEATHER);
          this.view.setLookDown(this.lookingDown);
          this.view.onSwitch = (id, down) => net.sendSwitch(id, down);
          view3d.querySelector('.nav-3d-loading')?.remove();
        })
        .catch((e) => {
          console.error(e);
          const l = view3d.querySelector('.nav-3d-loading');
          if (l) l.textContent = 'This device cannot show the 3D view – the tablet still works.';
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
    if (p.prize !== undefined && dr?.result && this.paidRun !== p.runId) {
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
        this.els.code.textContent = r.code;
        const f = net.followedDriverId();
        if (f !== this.followed) {
          this.followed = f;
          this.interp.clear();
          this.others.clear();
          this.map.clearTrail();
          toast(`Now navigating for ${this.driverName()}`, 'ok');
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
    const sDot = this.els.server.firstChild as HTMLElement;
    sDot.className = `status-dot ${net.status === 'connected' ? 'ok' : net.status === 'disconnected' ? 'bad' : 'warn'}`;
    const d = net.member(this.followed);
    const dDot = this.els.driver.firstChild as HTMLElement;
    dDot.className = `status-dot ${d?.connected ? 'ok' : 'bad'}`;
    this.els.driver.lastChild!.textContent = d ? (d.connected ? `DRIVER: ${d.name}` : 'DRIVER DISCONNECTED') : 'NO DRIVER';
  }

  private applyRace() {
    const s = this.race;
    if (!s) return;
    const labels = { lobby: 'LOBBY', countdown: 'COUNTDOWN', racing: 'RACING', finished: 'FINISHED' } as const;
    this.els.phase.textContent = labels[s.phase];
    if (s.phase === 'lobby') return void setTimeout(() => !this.disposed && this.onReload(), 0); // back to the lobby screen
    this.waitingEl.style.display = 'none';
    const dr = this.driverRace();
    this.els.cps.textContent = `${dr?.checkpointsPassed ?? 0}/${this.stage.checkpoints.length}`;
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
    this.map.draw(t, this.driverRace()?.checkpointsPassed ?? 0);

    // timer from the authoritative race state
    let ms = 0;
    if (s?.phase === 'racing' && s.startAt) ms = Math.max(0, now - s.startAt);
    const res = this.driverRace()?.result;
    if (res) ms = res.timeMs;
    if (s?.phase === 'countdown' && s.startAt) this.els.timer.textContent = `GO IN ${Math.max(0, Math.ceil((s.startAt - now) / 1000))}`;
    else this.els.timer.textContent = formatTime(ms);

    const age = performance.now() - this.lastPacketAt;
    if (!t) {
      this.els.mapStatus.textContent = net.member(this.followed)?.connected ? 'Waiting for telemetry…' : 'Driver offline';
      return;
    }
    this.els.mapStatus.textContent = age > 1500 ? `Telemetry stalled (${(age / 1000).toFixed(1)}s)` : `Live · ${net.latencyMs ?? '–'} ms`;
    const sp = formatSpeed(t.v);
    this.els.speed.innerHTML = `${sp.value}<small> ${sp.unit}</small>`;
    this.els.gear.textContent = t.gear === -1 ? 'R' : t.gear === 0 ? 'N' : String(t.gear);
    this.els.rpm.textContent = String(Math.round(t.rpm / 10) * 10);
    const span = this.stage.finishDistance - this.stage.startDistance;
    const pct = Math.min(100, Math.max(0, ((t.dist - this.stage.startDistance) / span) * 100));
    this.els.pct.textContent = `${pct.toFixed(0)}%`;
    this.els.progress.style.width = `${pct}%`;
    this.els.remain.textContent = formatDistance(t.remain);
    this.els.surface.textContent = SURFACES[surfaceAt(this.stage, t.dist)].name;
    const worst = t.dz ? Math.max(...t.dz) : t.dmg;
    this.els.damage.textContent = worst < 0.05 ? 'OK' : `${Math.round(worst * 100)}%`;
    this.els.damage.style.color = worst > 0.6 ? 'var(--bad)' : worst > 0.2 ? 'var(--warn)' : '';
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
