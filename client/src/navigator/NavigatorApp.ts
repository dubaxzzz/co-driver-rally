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
          view3d.querySelector('.nav-3d-loading')?.remove();
        })
        .catch((e) => {
          console.error(e);
          const l = view3d.querySelector('.nav-3d-loading');
          if (l) l.textContent = 'This device cannot show the 3D view – the tablet still works.';
          this.lookBtn.style.display = 'none';
        });
    }, 60);

    if (net.lastJoin?.lastTelemetry) this.pushTelemetry(net.lastJoin.lastTelemetry);
    this.race = net.room?.race ?? null;
    this.bind();
    this.updateConnection();
    this.applyRace();
    this.raf = requestAnimationFrame(this.frame);
  }

  private pushTelemetry(p: RelayedTelemetry) {
    this.interp.push(p);
    this.lastPacketAt = performance.now();
  }

  private bind() {
    this.unsubs.push(
      net.on('telemetry', (p) => {
        if (this.race && p.runId !== this.race.runId) return;
        this.pushTelemetry(p);
      }),
      net.on('race', (s) => {
        if (s.stageId !== this.stage.def.id || s.weather !== this.weatherId) return this.onReload();
        const newRun = !this.race || this.race.runId !== s.runId;
        this.race = s;
        if (newRun) {
          this.interp.clear();
          this.map.clearTrail();
        }
        this.applyRace();
      }),
      net.on('room', (r) => {
        if (r.race.stageId !== this.stage.def.id || r.race.weather !== this.weatherId) return this.onReload();
        this.race = r.race;
        this.els.code.textContent = r.code;
        this.updateConnection();
        this.applyRace();
      }),
      net.on('status', () => this.updateConnection()),
      net.on('checkpoint', (e) => toast(`Checkpoint ${e.index + 1} · ${formatTime(e.timeMs)}`, 'ok')),
      net.on('warning', (w) => {
        if (w.type === 'missed-checkpoint') toast(`Driver missed checkpoint ${w.checkpoint + 1}!`, 'bad');
      }),
      net.on('resumed', (r) => {
        this.race = r.room.race;
        if (r.lastTelemetry) this.pushTelemetry(r.lastTelemetry);
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
    const d = net.room?.driver;
    const dDot = this.els.driver.firstChild as HTMLElement;
    dDot.className = `status-dot ${d?.connected ? 'ok' : 'bad'}`;
    this.els.driver.lastChild!.textContent = d ? (d.connected ? `DRIVER: ${d.name}` : 'DRIVER DISCONNECTED') : 'NO DRIVER';
  }

  private applyRace() {
    const s = this.race;
    if (!s) return;
    const labels = { lobby: 'LOBBY', countdown: 'COUNTDOWN', racing: 'RACING', finished: 'FINISHED' } as const;
    this.els.phase.textContent = labels[s.phase];
    this.waitingEl.style.display = s.phase === 'lobby' ? 'flex' : 'none';
    this.els.cps.textContent = `${s.checkpointsPassed}/${this.stage.checkpoints.length}`;
    if (s.phase === 'finished' && s.result && this.resultRun !== s.runId) {
      this.resultRun = s.runId;
      audio.chime();
      this.showOverlay(
        resultsOverlay(s.result, this.stage, [
          { label: 'Restart stage', primary: true, onClick: () => void net.restartRace().catch((e) => toast(e.message, 'bad')) },
          { label: 'Back to lobby', onClick: () => void net.toLobby().catch((e) => toast(e.message, 'bad')) },
          { label: 'Close', onClick: () => this.closeOverlay() },
        ], () => this.standings(s.result!.timeMs)),
      );
    }
    if (s.phase !== 'finished') this.closeOverlay();
  }

  private standings(playerMs: number): Standing[] {
    const ai = this.interp.latest?.ai ?? [];
    const list: Standing[] = [{ name: net.room?.driver?.name ?? 'Driver', timeMs: playerMs, you: true }];
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
    const t = this.interp.sample(now);
    const s = this.race;
    const pnow = performance.now();
    const dt = Math.min(0.1, (pnow - this.lastFrame) / 1000);
    this.lastFrame = pnow;
    this.view?.update(dt, t);
    this.map.draw(t, s?.checkpointsPassed ?? 0);

    // timer from the authoritative race state
    let ms = 0;
    if (s?.phase === 'racing' && s.startAt) ms = Math.max(0, now - s.startAt);
    else if (s?.phase === 'finished' && s.result) ms = s.result.timeMs;
    if (s?.phase === 'countdown' && s.startAt) this.els.timer.textContent = `GO IN ${Math.max(0, Math.ceil((s.startAt - now) / 1000))}`;
    else this.els.timer.textContent = formatTime(ms);

    const age = performance.now() - this.lastPacketAt;
    if (!t) {
      this.els.mapStatus.textContent = net.room?.driver?.connected ? 'Waiting for telemetry…' : 'Driver offline';
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
