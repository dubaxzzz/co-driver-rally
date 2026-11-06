/** User preferences + garage selection (local to this device). */
import { DEFAULT_CONFIG, PAINTS, VEHICLES, WHEELS, type RallyConfig } from '@cdr/shared';

export interface Settings {
  playerName: string;
  audioEnabled: boolean;
  volume: number; // 0..1
  voiceCalls: boolean; // speak pace notes with speech synthesis
  autoNotes: 'always' | 'solo' | 'off';
  quality: 'high' | 'low';
  units: 'kmh' | 'mph';
  camera: number;
  showHelp: boolean;
  /** How far the driver can see through the night fog. */
  visibility: 'verylow' | 'low' | 'normal';
  wipers: 0 | 1 | 2; // off / slow / fast
  /** Last stage / weather / AI choice (used by PLAY and the lobby). */
  rally: RallyConfig;
}

export interface GarageSelection {
  vehicleId: string;
  paintId: string;
  wheelId: string;
}

const SETTINGS_KEY = 'cdr.settings';
const GARAGE_KEY = 'cdr.garage';

const defaults: Settings = {
  playerName: '',
  audioEnabled: true,
  volume: 0.7,
  voiceCalls: true,
  autoNotes: 'solo',
  quality: 'high',
  units: 'kmh',
  camera: 0,
  showHelp: true,
  visibility: 'verylow',
  wipers: 1,
  rally: { ...DEFAULT_CONFIG },
};

function load<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...fallback };
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return { ...fallback };
  }
}

type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();
let current = load(SETTINGS_KEY, defaults);

export const settings = {
  get: (): Settings => current,
  update(patch: Partial<Settings>) {
    current = { ...current, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(current));
    } catch {
      /* storage unavailable (private mode) – keep in memory */
    }
    listeners.forEach((l) => l(current));
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

let garage = load<GarageSelection>(GARAGE_KEY, {
  vehicleId: VEHICLES[0].id,
  paintId: PAINTS[0].id,
  wheelId: WHEELS[0].id,
});

export const garageStore = {
  get: () => garage,
  update(patch: Partial<GarageSelection>) {
    garage = { ...garage, ...patch };
    try {
      localStorage.setItem(GARAGE_KEY, JSON.stringify(garage));
    } catch {
      /* ignore */
    }
  },
  resolve() {
    return {
      vehicle: VEHICLES.find((v) => v.id === garage.vehicleId) ?? VEHICLES[0],
      paint: PAINTS.find((p) => p.id === garage.paintId) ?? PAINTS[0],
      wheel: WHEELS.find((w) => w.id === garage.wheelId) ?? WHEELS[0],
    };
  },
};

/** Fog density for the chosen visibility (multiplies the stage's base fog). */
export function fogMultiplier(): number {
  return current.visibility === 'normal' ? 0.35 : current.visibility === 'low' ? 0.65 : 1;
}

export function formatSpeed(ms: number): { value: string; unit: string } {
  const kmh = Math.abs(ms) * 3.6;
  return current.units === 'mph'
    ? { value: String(Math.round(kmh * 0.621371)), unit: 'MPH' }
    : { value: String(Math.round(kmh)), unit: 'KM/H' };
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.max(0, Math.round(m))} m`;
}
