import {
  CUSTOM_MESSAGE_MAX_LENGTH,
  DEFAULT_STAGE_ID,
  getStage,
  type BuiltStage,
  type NavCall,
  type NavCallRequest,
  type PaceNote,
  type RaceState,
  type RelayedTelemetry,
} from '@cdr/shared';
import { audio } from '../audio/AudioEngine';
import { net } from '../multiplayer/NetClient';
import { formatDistance, formatSpeed, formatTime } from '../settings';
import { h, toast } from '../ui/dom';
import { resultsOverlay } from '../ui/results';
import { Interpolator } from './Interpolator';
import { MapView } from './MapView';

const MODIFIERS = ['TIGHTENS', 'OPENS', 'LONG', "DON'T CUT", 'OVER CREST', 'INTO'];
const CAUTIONS = ['CAUTION: JUMP', 'BRAKE FOR HAIRPIN', 'CAUTION: ROCKS', 'CAUTION: NARROWS', 'SLOW DOWN', 'FLAT OUT'];

/**
 * Navigator (co-driver) interface – tablet-first, works on phones and
 * desktops. Everything shown here comes from live driver telemetry relayed
 * by the server.
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
  private notesBox: HTMLElement;
  private logBox: HTMLElement;
  private waitingEl: HTMLElement;
  private composeDir: 'LEFT' | 'RIGHT' = 'LEFT';
  private composeSev = '3';
  private composeMods = new Set<string>();
  private composePreview: HTMLElement;
  private lastNotesKey = '';
  private resultRun = -1;

  constructor(private readonly onExit: () => void) {
    this.stage = getStage(net.room?.race.stageId ?? DEFAULT_STAGE_ID)!;
    this.map = new MapView(this.stage);
    const v = (key: string, init = '—') => (this.els[key] = h('div', { class: 'v' }, init));

    // header
    this.els.code = h('span', { class: 'code' }, net.room?.code ?? '----');
    this.els.server = h('span', { class: 'chip' }, h('span', { class: 'status-dot' }), 'ONLINE');
    this.els.driver = h('span', { class: 'chip' }, h('span', { class: 'status-dot' }), 'DRIVER');
    this.els.timer = h('span', { class: 'timer', 'data-testid': 'nav-timer' }, '00:00.00');
    this.els.phase = h('span', { class: 'chip' }, 'LOBBY');
    const header = h(
      'div',
      { class: 'nav-header' },
      h('span', { class: 'brand' }, h('span', { class: 'co' }, 'CO-'), 'DRIVER'),
      h('span', { class: 'chip' }, 'ROOM'),
      this.els.code,
      this.els.server,
      this.els.driver,
      this.els.phase,
      this.els.timer,
      h('button', { class: 'back-btn', onclick: () => void this.leave() }, 'Leave'),
    );

    // map + data
    this.waitingEl = h('div', { class: 'nav-waiting' }, 'Waiting for the driver to start the stage…');
    this.els.mapStatus = h('div', { class: 'map-status' }, 'No telemetry yet');
    const followBtn = h('button', { class: 'sel' }, 'FOLLOW');
    const fullBtn = h('button', {}, 'FULL STAGE');
    followBtn.onclick = () => { this.map.mode = 'follow'; followBtn.classList.add('sel'); fullBtn.classList.remove('sel'); };
    fullBtn.onclick = () => { this.map.mode = 'full'; fullBtn.classList.add('sel'); followBtn.classList.remove('sel'); };
    const mapBox = h('div', { class: 'nav-map' }, this.map.canvas, h('div', { class: 'map-tools' }, followBtn, fullBtn), this.els.mapStatus, this.waitingEl);
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
      h('div', { class: 'nav-progress' }, this.els.progress),
    );
    const left = h('div', { class: 'nav-left' }, mapBox, data);

    // pace notes + controls
    this.notesBox = h('div', {});
    this.logBox = h('div', { class: 'call-log' });
    this.composePreview = h('div', { class: 'compose-preview' }, '');

    const dirRow = h('div', { class: 'ctl-row' });
    for (const d of ['LEFT', 'RIGHT'] as const) {
      const b = h('button', { class: `ctl ${d === this.composeDir ? 'sel' : ''}` }, d);
      b.onclick = () => { this.composeDir = d; dirRow.querySelectorAll('.ctl').forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); this.updatePreview(); };
      dirRow.append(b);
    }
    const sevRow = h('div', { class: 'ctl-row' });
    for (const s of ['1', '2', '3', '4', '5', '6', 'HAIRPIN']) {
      const b = h('button', { class: `ctl ${s === this.composeSev ? 'sel' : ''}` }, s);
      b.onclick = () => { this.composeSev = s; sevRow.querySelectorAll('.ctl').forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); this.updatePreview(); };
      sevRow.append(b);
    }
    const modRow = h('div', { class: 'ctl-row' });
    for (const m of MODIFIERS) {
      const b = h('button', { class: 'ctl' }, m);
      b.onclick = () => { if (this.composeMods.has(m)) this.composeMods.delete(m); else this.composeMods.add(m); b.classList.toggle('sel'); this.updatePreview(); };
      modRow.append(b);
    }
    const cautionRow = h('div', { class: 'ctl-row' });
    for (const c of CAUTIONS) cautionRow.append(h('button', { class: 'ctl warn', onclick: () => void this.send({ kind: 'caution', text: c }) }, c));

    const customInput = h('input', { class: 'input', maxlength: CUSTOM_MESSAGE_MAX_LENGTH, placeholder: 'Short message…', 'data-testid': 'custom-input' }) as HTMLInputElement;
    const sendCustom = () => {
      const text = customInput.value.trim();
      if (!text) return;
      void this.send({ kind: 'custom', text }).then((ok) => { if (ok) customInput.value = ''; });
    };
    customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCustom(); });

    const controls = h(
      'div',
      { class: 'nav-controls' },
      h(
        'div',
        { class: 'ctl-row' },
        h('button', { class: 'ctl send', 'data-testid': 'send-next', onclick: () => this.sendNext() }, 'CALL NEXT NOTE'),
        h('button', { class: 'ctl', 'data-testid': 'repeat', onclick: () => void this.send({ kind: 'repeat' }) }, '↻ REPEAT'),
      ),
      h(
        'div',
        { class: 'ctl-group' },
        h('div', { class: 'panel-title' }, 'Build a pace note'),
        dirRow,
        h('div', { style: 'height:6px' }),
        sevRow,
        h('div', { style: 'height:6px' }),
        modRow,
        this.composePreview,
        h('button', { class: 'ctl send', style: 'width:100%', onclick: () => void this.send({ kind: 'pacenote', text: this.composeText() }) }, 'SEND PACE NOTE'),
      ),
      h('div', { class: 'ctl-group' }, h('div', { class: 'panel-title' }, 'Caution'), cautionRow),
      h(
        'div',
        { class: 'ctl-group' },
        h('div', { class: 'panel-title' }, 'Custom message'),
        h('div', { class: 'ctl-row' }, customInput, h('button', { class: 'ctl send', 'data-testid': 'send-custom', onclick: sendCustom }, 'SEND')),
      ),
      h('div', { class: 'ctl-group' }, h('div', { class: 'panel-title' }, 'Calls sent'), this.logBox),
    );
    const right = h('div', { class: 'nav-right' }, h('div', { class: 'nav-notes' }, h('div', { class: 'panel-title' }, 'Upcoming pace notes · tap to call'), this.notesBox), controls);

    this.root = h('div', { class: 'nav' }, header, left, right);
    this.updatePreview();
    if (net.lastJoin) this.seed(net.lastJoin.lastTelemetry, net.lastJoin.callLog);

    this.race = net.room?.race ?? null;
    this.bind();
    this.updateConnection();
    this.applyRace();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Called with the join/resume result so we start with current data. */
  seed(lastTelemetry: RelayedTelemetry | null, callLog: NavCall[]) {
    if (lastTelemetry) {
      this.interp.push(lastTelemetry);
      this.lastPacketAt = performance.now();
    }
    this.logBox.innerHTML = '';
    callLog.forEach((c) => this.logCall(c));
  }

  private bind() {
    this.unsubs.push(
      net.on('telemetry', (p) => {
        if (this.race && p.runId !== this.race.runId) return;
        this.interp.push(p);
        this.lastPacketAt = performance.now();
      }),
      net.on('race', (s) => {
        const newRun = !this.race || this.race.runId !== s.runId;
        this.race = s;
        if (newRun) {
          this.interp.clear();
          this.map.clearTrail();
        }
        this.applyRace();
      }),
      net.on('room', (r) => {
        this.race = r.race;
        this.els.code.textContent = r.code;
        this.updateConnection();
        this.applyRace();
      }),
      net.on('status', () => this.updateConnection()),
      net.on('call', (c) => this.logCall(c)),
      net.on('checkpoint', (e) => toast(`Checkpoint ${e.index + 1} · ${formatTime(e.timeMs)}`, 'ok')),
      net.on('warning', (w) => {
        if (w.type === 'missed-checkpoint') toast(`Driver missed checkpoint ${w.checkpoint + 1}!`, 'bad');
      }),
      net.on('resumed', (r) => {
        this.race = r.room.race;
        this.seed(r.lastTelemetry, r.callLog);
        this.applyRace();
        toast('Reconnected – race data restored', 'ok');
      }),
      net.on('closed', (p) => {
        toast(p.reason, 'bad', 5000);
        this.onExit();
      }),
    );
  }

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
        ]),
      );
    }
    if (s.phase !== 'finished') this.closeOverlay();
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

  private composeText() {
    const sev = this.composeSev === 'HAIRPIN' ? `HAIRPIN ${this.composeDir}` : `${this.composeDir} ${this.composeSev}`;
    return [sev, ...MODIFIERS.filter((m) => this.composeMods.has(m))].join(' ');
  }
  private updatePreview() {
    this.composePreview.textContent = this.composeText();
  }

  private async send(req: NavCallRequest): Promise<boolean> {
    try {
      await net.sendCall(req);
      return true;
    } catch (e) {
      toast((e as Error).message, 'bad');
      return false;
    }
  }

  private currentDistance() {
    const t = this.interp.sample(net.serverNow());
    return t ? t.dist : this.stage.spawnDistance;
  }

  private upcomingNotes(count: number): PaceNote[] {
    const d = this.currentDistance();
    return this.stage.paceNotes.filter((n) => n.distance >= d - 2).slice(0, count);
  }

  private sendNext() {
    const next = this.upcomingNotes(1)[0];
    if (!next) return toast('No more notes – finish ahead!', 'info');
    void this.send({ kind: next.kind === 'hazard' ? 'caution' : 'pacenote', text: next.text, noteIndex: next.index });
  }

  private logCall(c: NavCall) {
    const time = new Date(c.serverTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.logBox.prepend(h('div', {}, `${time}  ${c.repeated ? '↻ ' : ''}${c.text}`));
    while (this.logBox.childElementCount > 20) this.logBox.lastElementChild?.remove();
  }

  private renderNotes(dist: number) {
    const notes = this.upcomingNotes(6);
    const key = notes.map((n) => `${n.index}:${Math.round((n.distance - dist) / 10)}`).join('|');
    if (key === this.lastNotesKey) return;
    this.lastNotesKey = key;
    this.notesBox.innerHTML = '';
    if (!notes.length) {
      this.notesBox.append(h('div', { class: 'note-card first' }, h('span', { class: 'txt' }, 'FINISH AHEAD')));
      return;
    }
    notes.forEach((n, i) => {
      const cls = n.kind === 'hazard' ? 'hazard' : `sev-${n.severity}`;
      const card = h(
        'button',
        { class: `note-card ${cls} ${i === 0 ? 'first' : ''}`, 'data-testid': i === 0 ? 'note-first' : undefined },
        h('span', { class: 'txt' }, n.text + (n.into ? ' →' : '')),
        h('span', { class: 'd' }, `${Math.max(0, Math.round(n.distance - dist))} m`),
      );
      card.onclick = () => void this.send({ kind: n.kind === 'hazard' ? 'caution' : 'pacenote', text: n.text, noteIndex: n.index });
      this.notesBox.append(card);
    });
  }

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    const now = net.serverNow();
    const t = this.interp.sample(now);
    const s = this.race;
    this.map.draw(t, s?.checkpointsPassed ?? 0);

    // timer from server-authoritative race state
    let ms = 0;
    if (s?.phase === 'racing' && s.startAt) ms = Math.max(0, now - s.startAt);
    else if (s?.phase === 'finished' && s.result) ms = s.result.timeMs;
    else if (s?.phase === 'countdown' && s.startAt) {
      this.els.timer.textContent = `GO IN ${Math.max(0, Math.ceil((s.startAt - now) / 1000))}`;
    }
    if (s?.phase !== 'countdown') this.els.timer.textContent = formatTime(ms);

    const age = performance.now() - this.lastPacketAt;
    if (!t) {
      this.els.mapStatus.textContent = net.room?.driver?.connected ? 'Waiting for telemetry…' : 'Driver offline';
    } else {
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
    }
    this.renderNotes(t ? t.dist : this.stage.spawnDistance);
  };

  private async leave() {
    await net.leave();
    this.onExit();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
  }
}
