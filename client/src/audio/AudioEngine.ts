import { settings } from '../settings';

/**
 * Fully synthesised audio (no asset files): engine note that follows RPM,
 * gravel roar, tyre skid, gear-change blips, impacts, countdown beeps and
 * navigator chimes. Optional speech synthesis reads pace notes aloud.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engine: { o1: OscillatorNode; o2: OscillatorNode; o3: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private gravel: { filter: BiquadFilterNode; gain: GainNode } | null = null;
  private skid: { filter: BiquadFilterNode; gain: GainNode } | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private running = false;

  constructor() {
    settings.subscribe(() => this.applyVolume());
    // Browsers only allow audio after a user gesture.
    const unlock = () => {
      this.ensure();
      void this.ctx?.resume();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private ensure() {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.applyVolume();
    return this.ctx;
  }

  private applyVolume() {
    if (!this.master || !this.ctx) return;
    const s = settings.get();
    this.master.gain.setTargetAtTime(s.audioEnabled ? s.volume : 0, this.ctx.currentTime, 0.05);
    if (!s.audioEnabled) window.speechSynthesis?.cancel();
  }

  private noiseSource() {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    return src;
  }

  /** Starts the continuous engine/tyre loops (called when driving begins). */
  startDriving() {
    const ctx = this.ensure();
    if (!ctx || this.running || !this.master) return;
    this.running = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    filter.Q.value = 4;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 2.5);
    }
    shaper.curve = curve;
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    const o3 = ctx.createOscillator();
    o3.type = 'triangle';
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    const g3 = ctx.createGain();
    g3.gain.value = 0.5;
    o1.connect(shaper);
    o2.connect(g2).connect(shaper);
    o3.connect(g3).connect(shaper);
    shaper.connect(filter).connect(gain).connect(this.master);
    o1.start();
    o2.start();
    o3.start();
    this.engine = { o1, o2, o3, filter, gain };

    const gsrc = this.noiseSource();
    const gf = ctx.createBiquadFilter();
    gf.type = 'bandpass';
    gf.frequency.value = 900;
    gf.Q.value = 0.7;
    const gg = ctx.createGain();
    gg.gain.value = 0;
    gsrc.connect(gf).connect(gg).connect(this.master);
    gsrc.start();
    this.gravel = { filter: gf, gain: gg };

    const ssrc = this.noiseSource();
    const sf = ctx.createBiquadFilter();
    sf.type = 'highpass';
    sf.frequency.value = 2200;
    const sg = ctx.createGain();
    sg.gain.value = 0;
    ssrc.connect(sf).connect(sg).connect(this.master);
    ssrc.start();
    this.skid = { filter: sf, gain: sg };
  }

  stopDriving() {
    if (!this.running || !this.ctx) return;
    this.running = false;
    const t = this.ctx.currentTime;
    for (const node of [this.engine?.gain, this.gravel?.gain, this.skid?.gain]) node?.gain.setTargetAtTime(0, t, 0.05);
    const e = this.engine;
    setTimeout(() => {
      try {
        e?.o1.stop();
        e?.o2.stop();
        e?.o3.stop();
      } catch {
        /* already stopped */
      }
    }, 300);
    this.engine = null;
    this.gravel = null;
    this.skid = null;
  }

  /** Per-frame update from the vehicle simulation. */
  update(rpm: number, throttle: number, speed: number, slip: number, onGravel: boolean, grounded: boolean) {
    if (!this.ctx || !this.engine || !this.gravel || !this.skid) return;
    const t = this.ctx.currentTime;
    const fire = (rpm / 60) * 2; // 4-cylinder firing frequency
    this.engine.o1.frequency.setTargetAtTime(fire, t, 0.03);
    this.engine.o2.frequency.setTargetAtTime(fire * 0.5, t, 0.03);
    this.engine.o3.frequency.setTargetAtTime(fire * 1.5, t, 0.03);
    this.engine.filter.frequency.setTargetAtTime(500 + rpm * 0.35 + throttle * 900, t, 0.05);
    this.engine.gain.gain.setTargetAtTime(0.05 + throttle * 0.09, t, 0.05);
    const sp = Math.min(1, Math.abs(speed) / 35);
    this.gravel.gain.gain.setTargetAtTime(grounded ? sp * (onGravel ? 0.35 : 0.15) : 0, t, 0.08);
    this.gravel.filter.frequency.setTargetAtTime(600 + sp * 900, t, 0.1);
    this.skid.gain.gain.setTargetAtTime(grounded ? Math.min(0.25, slip * 0.3) : 0, t, 0.05);
  }

  private beep(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.3, when = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  countdown(n: number) {
    if (n > 0) this.beep(520, 0.25, 'square', 0.18);
    else this.beep(1040, 0.6, 'square', 0.22);
  }

  gearChange(up: boolean) {
    if (this.engine && this.ctx) {
      const g = this.engine.gain.gain;
      const t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(0.02, t);
      g.linearRampToValueAtTime(0.1, t + 0.18);
    }
    this.beep(up ? 140 : 110, 0.08, 'square', 0.12);
  }

  impact(strength: number) {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 500 + strength * 900;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(Math.min(0.9, 0.2 + strength * 0.5), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.4);
    this.beep(70, 0.25, 'sine', Math.min(0.6, strength * 0.5));
  }

  chime(caution = false) {
    if (caution) {
      this.beep(880, 0.14, 'square', 0.15);
      this.beep(880, 0.14, 'square', 0.15, 0.18);
    } else {
      this.beep(988, 0.18, 'sine', 0.22);
      this.beep(1319, 0.3, 'sine', 0.2, 0.12);
    }
  }

  speak(text: string) {
    const s = settings.get();
    if (!s.audioEnabled || !s.voiceCalls || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text.toLowerCase().replace(/[:–-]/g, ', '));
    u.rate = 1.25;
    u.pitch = 0.95;
    u.volume = Math.min(1, s.volume + 0.2);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }
}

export const audio = new AudioEngine();
