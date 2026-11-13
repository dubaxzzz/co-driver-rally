/** Keyboard + gamepad input with smoothed steering. */
export interface DriveInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (also reverse when stopped)
  steer: number; // -1..1, positive = left
  handbrake: boolean;
}

type Action = 'reset' | 'pause' | 'push';

export class Input {
  private keys = new Set<string>();
  private steerValue = 0;
  private actionHandlers = new Map<Action, () => void>();
  private padPrev: boolean[] = [];
  readonly state: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  enabled = true;

  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const code = e.code;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(code)) e.preventDefault();
    if (!e.repeat) {
      if (code === 'KeyR') this.fire('reset');
      if (code === 'KeyH') this.fire('push');
      if (code === 'Escape' || code === 'KeyP') this.fire('pause');
    }
    this.keys.add(code);
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onBlur = () => this.keys.clear();

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  on(action: Action, fn: () => void) {
    this.actionHandlers.set(action, fn);
  }
  private fire(a: Action) {
    this.actionHandlers.get(a)?.();
  }

  /** Call once per frame. speed in m/s for speed-sensitive steering. */
  update(dt: number, speed: number) {
    const k = this.keys;
    let throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    let brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    let steerTarget = (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
    let handbrake = k.has('Space');
    let analogSteer: number | null = null;

    // Gamepad (standard mapping)
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.15) analogSteer = -Math.sign(ax) * ((Math.abs(ax) - 0.15) / 0.85); // wide deadzone: worn sticks drift
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (rt > 0.05) throttle = Math.max(throttle, rt);
      if (lt > 0.05) brake = Math.max(brake, lt);
      if (pad.buttons[0]?.pressed || pad.buttons[1]?.pressed) handbrake = true;
      const pressed = (i: number) => !!pad.buttons[i]?.pressed;
      const edge = (i: number, a: Action) => {
        if (pressed(i) && !this.padPrev[i]) this.fire(a);
      };
      edge(2, 'reset'); // X
      edge(3, 'push'); // Y
      edge(9, 'pause'); // Start
      this.padPrev = pad.buttons.map((b) => b.pressed);
      break;
    }

    if (!this.enabled) {
      throttle = 0;
      brake = 0;
      steerTarget = 0;
      handbrake = false;
      analogSteer = null;
    }

    // Speed-sensitive steering: full lock at low speed, less at high speed.
    const limit = 1 / (1 + Math.abs(speed) / 22);
    if (analogSteer !== null) {
      this.steerValue = analogSteer * Math.max(0.35, limit);
    } else {
      const target = steerTarget * Math.max(0.3, limit);
      const rate = steerTarget === 0 || Math.sign(target) !== Math.sign(this.steerValue) ? 6 : 3.2;
      const diff = target - this.steerValue;
      this.steerValue += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    }
    this.state.throttle = throttle;
    this.state.brake = brake;
    this.state.steer = this.steerValue;
    this.state.handbrake = handbrake;
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}
