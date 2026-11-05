import type { BuiltStage } from '@cdr/shared';
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
  private noteEl: HTMLElement;
  private noteText: HTMLElement;
  private noteDist: HTMLElement;
  private nextEl: HTMLElement;
  private callEl: HTMLElement;
  private callMsg: HTMLElement;
  private centerEl: HTMLElement;
  private warnEl: HTMLElement;
  private netEl: HTMLElement;
  private navEl: HTMLElement;
  private codeEl: HTMLElement;
  private dmgEl: HTMLElement;
  private noteTimer = 0;
  private callTimer = 0;
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
    this.noteText = h('div', { class: 'text' }, '');
    this.noteDist = h('div', { class: 'dist' }, '');
    this.noteEl = h('div', { class: 'hud-note' }, this.noteText, this.noteDist);
    this.nextEl = h('div', { class: 'v' }, '—');
    this.callMsg = h('div', { class: 'msg' }, '');
    this.callEl = h('div', { class: 'hud-call' }, h('div', { class: 'who' }, 'CO-DRIVER'), this.callMsg);
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
          h('div', { html: '<b>Space</b> Handbrake &nbsp; <b>C</b> Camera &nbsp; <b>R</b> Reset &nbsp; <b>Esc</b> Menu' }),
        )
      : null;

    this.root = h(
      'div',
      { class: 'hud' },
      h('div', { class: 'hud-top-left' }, h('div', { class: 'hud-chip' }, 'RALLY', this.codeEl), this.netEl, this.navEl),
      h('div', { class: 'hud-timer' }, this.timerEl, this.timerSub),
      h('div', { class: 'hud-progress' }, track, h('div', { class: 'labels' }, this.progLeft, this.progRight)),
      this.noteEl,
      h('div', { class: 'hud-next' }, h('div', { class: 'k' }, 'NEXT'), this.nextEl),
      this.callEl,
      this.centerEl,
      this.warnEl,
      h('div', { class: 'hud-dash' }, h('div', {}, this.gearEl, h('span', { class: 'hud-speed' }, this.speedEl, this.unitEl)), rpm, this.dmgEl),
      help,
    );
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
    this.dmgEl.textContent = `DAMAGE ${Math.round(damage * 100)}%`;
  }

  updateRace(timeMs: number, distance: number, remaining: number, progress01: number, cpPassed: number, nextText: string, toNext: number) {
    this.timerEl.textContent = formatTime(timeMs);
    this.fill.style.width = `${progress01 * 100}%`;
    this.cps.forEach((c, i) => c.classList.toggle('done', i < cpPassed));
    this.progLeft.textContent = formatDistance(Math.max(0, distance - this.stage.startDistance));
    this.progRight.textContent = `${formatDistance(remaining)} TO FINISH`;
    this.nextEl.textContent = nextText ? `${nextText} · ${Math.max(0, Math.round(toNext))}m` : 'FINISH';
  }

  showNote(text: string, dist: number) {
    this.noteText.textContent = text;
    this.noteDist.textContent = `${Math.max(0, Math.round(dist / 10) * 10)} M`;
    this.noteEl.classList.add('show');
    this.noteTimer = 2.6;
  }

  showCall(text: string, caution: boolean) {
    this.callMsg.textContent = text;
    this.callEl.classList.toggle('caution', caution);
    this.callEl.classList.add('show');
    this.callTimer = 3.8;
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
    if (this.noteTimer > 0 && (this.noteTimer -= dt) <= 0) this.noteEl.classList.remove('show');
    if (this.callTimer > 0 && (this.callTimer -= dt) <= 0) this.callEl.classList.remove('show');
    if (this.warnTimer > 0 && (this.warnTimer -= dt) <= 0) this.warnEl.classList.remove('show');
  }
}
