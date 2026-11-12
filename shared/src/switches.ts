/**
 * Cockpit switches. The driver's game owns the car's switch state and sends it
 * in telemetry (as a bitmask) so the navigator's cockpit shows the same; the
 * navigator can flip the shared ones, which goes to the driver via the server.
 */
export interface CarSwitches {
  ignition: boolean;
  /** Engine running (set by holding START with the ignition on). */
  engine: boolean;
  wipers: 0 | 1 | 2;
  headlights: boolean;
  pod: boolean;
  hazards: boolean;
  demister: boolean;
  /** Cabin light – helps reading, but reflects in the windscreen. */
  interior: boolean;
  horn: boolean;
}

/** Switches the navigator may operate on the driver's car. */
export const SHARED_SWITCHES = ['wipers', 'headlights', 'pod', 'hazards', 'demister', 'interior', 'horn'] as const;
export type SharedSwitch = (typeof SHARED_SWITCHES)[number];

export const defaultSwitches = (): CarSwitches => ({
  ignition: false,
  engine: false,
  wipers: 0,
  headlights: false,
  pod: false,
  hazards: false,
  demister: false,
  interior: false,
  horn: false,
});

export function encodeSwitches(s: CarSwitches): number {
  return (
    (s.ignition ? 1 : 0) |
    (s.engine ? 2 : 0) |
    (s.wipers << 2) |
    (s.headlights ? 16 : 0) |
    (s.pod ? 32 : 0) |
    (s.hazards ? 64 : 0) |
    (s.demister ? 128 : 0) |
    (s.interior ? 256 : 0) |
    (s.horn ? 512 : 0)
  );
}

export function decodeSwitches(n: number): CarSwitches {
  return {
    ignition: !!(n & 1),
    engine: !!(n & 2),
    wipers: (((n >> 2) & 3) % 3) as 0 | 1 | 2,
    headlights: !!(n & 16),
    pod: !!(n & 32),
    hazards: !!(n & 64),
    demister: !!(n & 128),
    interior: !!(n & 256),
    horn: !!(n & 512),
  };
}

/** What a press of a shared switch does (horn: `down` = pressed/released). */
export function applySharedSwitch(s: CarSwitches, id: SharedSwitch, down = true): CarSwitches {
  const n = { ...s };
  if (id === 'wipers') n.wipers = ((s.wipers + 1) % 3) as 0 | 1 | 2;
  else if (id === 'horn') n.horn = down;
  else n[id] = !s[id];
  return n;
}

// ------------------------------------------------------------------ car systems
/**
 * The co-driver's jobs. The driver's game runs these (and sends them in
 * telemetry as `sys` + `tmp`); the navigator changes them from the tablet's
 * CAR page. With no navigator in the car they run on "auto", which is safe
 * but slower than a co-driver who keeps on top of them.
 */
export const FUSES = ['LIGHTS', 'WIPERS', 'POD', 'FAN', 'DEMIST', 'HORN'] as const;
export type FuseName = (typeof FUSES)[number];
export const ENGINE_MAPS = ['ECO', 'NORMAL', 'ATTACK'] as const;
export const TYRE_PRESSURES = ['LOW', 'MID', 'HIGH'] as const;

export interface CarSystems {
  /** Radiator flaps open (more cooling). */
  flaps: boolean;
  /** Anti-lag: more punch, much more heat. */
  als: boolean;
  /** 0 eco, 1 normal, 2 attack. */
  map: 0 | 1 | 2;
  /** 0 low, 1 mid, 2 high. */
  tyres: 0 | 1 | 2;
  /** Index into FUSES of a blown fuse, or -1. */
  fuse: number;
  /** Coolant temperature (°C). */
  temp: number;
}

export type SysCommand =
  | { key: 'flaps'; value: boolean }
  | { key: 'als'; value: boolean }
  | { key: 'map'; value: 0 | 1 | 2 }
  | { key: 'tyres'; value: 0 | 1 | 2 }
  | { key: 'fuse'; value: number };

export const defaultSystems = (): CarSystems => ({ flaps: false, als: false, map: 1, tyres: 1, fuse: -1, temp: 70 });

export function encodeSystems(s: CarSystems): number {
  return (s.flaps ? 1 : 0) | (s.als ? 2 : 0) | (s.map << 2) | (s.tyres << 4) | ((s.fuse < 0 ? 7 : s.fuse) << 6);
}

export function decodeSystems(n: number, temp: number): CarSystems {
  const f = (n >> 6) & 7;
  return {
    flaps: !!(n & 1),
    als: !!(n & 2),
    map: (((n >> 2) & 3) % 3) as 0 | 1 | 2,
    tyres: (((n >> 4) & 3) % 3) as 0 | 1 | 2,
    fuse: f >= FUSES.length ? -1 : f,
    temp,
  };
}

/** Validates a navigator's command. */
export function validateSysCommand(p: unknown): SysCommand | null {
  if (!p || typeof p !== 'object') return null;
  const { key, value } = p as { key?: unknown; value?: unknown };
  if ((key === 'flaps' || key === 'als') && typeof value === 'boolean') return { key, value };
  if ((key === 'map' || key === 'tyres') && (value === 0 || value === 1 || value === 2)) return { key, value };
  if (key === 'fuse' && Number.isInteger(value) && (value as number) >= 0 && (value as number) < FUSES.length) return { key, value: value as number };
  return null;
}

/** Engine power multiplier from the map, anti-lag and temperature. */
export function systemsPower(s: CarSystems): number {
  let p = [0.92, 1, 1.07][s.map] * (s.als ? 1.05 : 1);
  if (s.temp < 62) p *= 0.94; // cold engine: rich and lazy
  if (s.temp > 110) p *= Math.max(0.65, 1 - (s.temp - 110) * 0.02); // too hot: the ECU pulls power
  return p;
}

/** Tyre grip multiplier: soft pressures for loose surfaces, hard for tarmac. */
export function systemsGrip(s: CarSystems, surface: string): number {
  const loose = surface !== 'tarmac' && surface !== 'wood';
  if (surface === 'snow') return [1.08, 1, 0.9][s.tyres];
  return loose ? [1.06, 1, 0.92][s.tyres] : [0.92, 1, 1.05][s.tyres];
}

export interface SystemsStepInput {
  /** 0..1 engine load (throttle × rpm fraction). */
  load: number;
  /** Car speed (m/s). */
  speed: number;
  /** Outside temperature (°C). */
  ambient: number;
  engineOn: boolean;
}

/** Equilibrium coolant temperature for the current conditions. */
export function systemsTargetTemp(s: CarSystems, i: SystemsStepInput): number {
  if (!i.engineOn) return i.ambient;
  const heat = 25 + 70 * i.load * [0.85, 1, 1.15][s.map] * (s.als ? 1.3 : 1);
  const fanBlown = FUSES[s.fuse] === 'FAN';
  const cool = (s.flaps ? 1 : 0.7) * (0.5 + i.speed / 25) * (fanBlown ? 0.75 : 1);
  return i.ambient + heat / cool;
}

/** Advances the coolant temperature (time constant ~20 s). */
export function stepSystems(s: CarSystems, dt: number, i: SystemsStepInput): void {
  const target = systemsTargetTemp(s, i);
  s.temp += (target - s.temp) * Math.min(1, dt / 20);
}

/** "Auto" mode when there is no co-driver: safe, never optimal. */
export function autoSystems(s: CarSystems): void {
  if (s.temp > 92) s.flaps = true;
  else if (s.temp < 80) s.flaps = false;
  s.map = 1;
  s.als = false;
  s.tyres = 1;
}
