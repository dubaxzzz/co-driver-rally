import type { BuiltStage } from '@cdr/shared';
import type { DamageZones } from '../game/vehicle/Vehicle';
import { formatDistance, formatSpeed, formatTime, settings } from '../settings';
import { h } from './dom';

/** Driver head-up display (DOM overlay). */
export class Hud {
  readonly root: HTMLDivElement;
  private speedEl: HTMLElement;
  private unitEl: HTMLElement;
  private gearEl: HTMLElement;
  private rpmBars: HTMLElement[] = [];
  private timerEl: HTMLElement;
  private timerSub: HTMLElement;
  private fill: HTMLElement;
  private cps: HTMLElement[] = [];
  private progLeft: HTMLElement;
  private progRight: HTMLElement;
  private centerEl: HTMLElement;
  private warnEl: HTMLElement;
  private netEl: HTMLElement;
  private navEl: HTMLElement;
  private codeEl: HTMLElement;
  private dmgEl: HTMLElement;
  private warnTimer = 0;

  constructor(private stage: BuiltStage) {
    this.speedEl = h('span', {}, '0');
    this.unitEl = h('small', {}, 'KM/H');
    this.gearEl = h('div', { class: 'hud-gear' }, '1');
    const rpm = h('div', { class: 'hud-rpm' });
    for (let i = 0; i < 16; i++) {
      const b = h('i', { class: i >= 13 ? 'high' : i >= 10 ? 'mid' : '' });
      this.rpmBars.push(b);
      rpm.append(b);
    }
    this.dmgEl = h('div', { class: 'hud-damage' }, 'DAMAGE 0%');
    this.timerEl = h('div', { class: 't' }, '00:00.00');
    this.timerSub = h('div', { class: 'sub' }, stage.def.name.toUpperCase());
    this.fill = h('div', { class: 'fill' });
    const track = h('div', { class: 'track' }, this.fill);
    const span = stage.finishDistance - stage.startDistance;
    for (const cp of stage.checkpoints) {
      const m = h('div', { class: 'cp' });
      m.style.left = `${((cp.distance - stage.startDistance) / span) * 100}%`;
      track.append(m);
      this.cps.push(m);
    }
    this.progLeft = h('span', {}, '0 m');
    this.progRight = h('span', {}, '');
    this.centerEl = h('div', { class: 'hud-center-msg' }, '');
    this.warnEl = h('div', { class: 'hud-warning' }, '');
    this.netEl = h('div', { class: 'hud-chip' }, h('span', { class: 'status-dot' }), 'ONLINE');
    this.navEl = h('div', { class: 'hud-chip' }, h('span', { class: 'status-dot' }), 'NAVIGATOR');
    this.codeEl = h('span', { class: 'code' }, '----');

    const help = settings.get().showHelp
      ? h(
          'div',
          { class: 'hud-controls-help' },
          h('div', { html: '<b>W/↑</b> Throttle &nbsp; <b>S/↓</b> Brake/Reverse &nbsp; <b>A D</b> Steer' }),
          h('div', { html: '<b>Space</b> Handbrake &nbsp; <b>R</b> Reset &nbsp; <b>Esc</b> Menu &nbsp; <b>Mouse</b> click the switches in the car' }),
        )
      : null;

    this.root = h(
      'div',
      { class: 'hud' },
      h('div', { class: 'hud-top-left' }, h('div', { class: 'hud-chip' }, 'RALLY', this.codeEl), this.netEl, this.navEl),
      h('div', { class: 'hud-timer' }, this.timerEl, this.timerSub),
      h('div', { class: 'hud-progress' }, track, h('div', { class: 'labels' }, this.progLeft, this.progRight)),
      this.centerEl,
      this.warnEl,
      this.checkEl,
      h('div', { class: 'hud-dash' }, h('div', {}, this.gearEl, h('span', { class: 'hud-speed' }, this.speedEl, this.unitEl)), rpm, this.dmgEl),
      help,
    );
  }

  private checkEl = h('div', { class: 'hud-checklist', 'data-testid': 'checklist' });
  private lastCheck = '';
  /** Pre-stage checklist (ignition, start, lights…). `null` hides it. */
  setChecklist(title: string, items: Array<{ label: string; done: boolean }> | null) {
    const key = items ? title + items.map((i) => `${i.label}${i.done}`).join() : '';
    if (key === this.lastCheck) return;
    this.lastCheck = key;
    this.checkEl.innerHTML = '';
    this.checkEl.style.display = items ? 'block' : 'none';
    if (!items) return;
    this.checkEl.append(
      h('div', { class: 'cl-title' }, title),
      ...items.map((i) => h('div', { class: `cl-item ${i.done ? 'done' : ''}` }, h('span', { class: 'cl-box' }, i.done ? '✓' : ''), i.label)),
    );
  }

  private lastDamageKey = '';
  /** Damage per zone (green → amber → red) plus the surface you're on. */
  setDamage(d: DamageZones, surface: string) {
    const zones: Array<[string, number]> = [['FRONT', d.front], ['L', d.left], ['R', d.right], ['REAR', d.rear], ['GLASS', d.windscreen], ['ENGINE', d.engine]];
    const key = surface + zones.map(([, v]) => Math.round(v * 10)).join();
    if (key === this.lastDamageKey) return;
    this.lastDamageKey = key;
    this.dmgEl.innerHTML = '';
    this.dmgEl.append(surface.toUpperCase());
    const row = h('div', { class: 'zones' });
    for (const [label, v] of zones) {
      if (v < 0.05) continue;
      row.append(h('i', { class: v > 0.6 ? 'b' : 'w' }, `${label} ${Math.round(v * 100)}%`));
    }
    this.dmgEl.append(row);
  }

  setRoom(code: string) {
    this.codeEl.textContent = code;
  }

  setConnection(server: 'ok' | 'warn' | 'bad', navigator: 'ok' | 'warn' | 'bad' | 'none', navLabel: string) {
    (this.netEl.firstChild as HTMLElement).className = `status-dot ${server}`;
    (this.navEl.firstChild as HTMLElement).className = `status-dot ${navigator === 'none' ? '' : navigator}`;
    this.navEl.lastChild!.textContent = navLabel;
  }

  updateDash(speedMs: number, gear: number, rpm: number, maxRpm: number, damage: number) {
    const s = formatSpeed(speedMs);
    this.speedEl.textContent = s.value;
    this.unitEl.textContent = s.unit;
    this.gearEl.textContent = gear === -1 ? 'R' : gear === 0 ? 'N' : String(gear);
    const lit = Math.round((rpm / maxRpm) * this.rpmBars.length);
    this.rpmBars.forEach((b, i) => b.classList.toggle('on', i < lit));
    void damage;
  }

  updateRace(timeMs: number, distance: number, remaining: number, progress01: number, cpPassed: number) {
    this.timerEl.textContent = formatTime(timeMs);
    this.fill.style.width = `${progress01 * 100}%`;
    this.cps.forEach((c, i) => c.classList.toggle('done', i < cpPassed));
    this.progLeft.textContent = formatDistance(Math.max(0, distance - this.stage.startDistance));
    this.progRight.textContent = `${formatDistance(remaining)} TO FINISH`;
  }

  center(text: string) {
    this.centerEl.textContent = text;
    this.centerEl.classList.remove('pop');
    void this.centerEl.offsetWidth; // restart animation
    this.centerEl.classList.add('pop');
  }

  warn(text: string, seconds = 3) {
    this.warnEl.textContent = text;
    this.warnEl.classList.add('show');
    this.warnTimer = seconds;
  }

  tick(dt: number) {
    if (this.warnTimer > 0 && (this.warnTimer -= dt) <= 0) this.warnEl.classList.remove('show');
  }
}
