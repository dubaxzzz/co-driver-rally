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
/** Spare fuses carried per stage – once they're gone, a blown circuit stays dead. */
export const SPARE_FUSES = 2;
/** What each spare fuse used costs (taken off the stage prize). */
export const FUSE_COST = 350;
/** A full set of new tyres; a stage's wear is charged pro rata. */
export const TYRE_SET_COST = 1600;
/** Tyre wear 0..1 for one fixed step: distance, sliding, wheelspin, surface and pressures. */
export function tyreWearStep(dt: number, o: { speed: number; slip: number; loose: number; handbrake: boolean; surface: string; pressureGrip: number }) {
  const abrasive = o.surface === 'tarmac' ? 1.35 : o.surface === 'gravel' ? 1 : o.surface === 'wood' ? 0.9 : 0.6;
  const wrongPressure = o.pressureGrip < 0.99 ? 1.25 : 1;
  const rolling = Math.min(40, Math.abs(o.speed)) * 0.000045; // ~4% per km of steady driving
  const scrub = Math.min(1.5, o.slip) * 0.0035 + o.loose * 0.004 + (o.handbrake && Math.abs(o.speed) > 3 ? 0.003 : 0);
  return dt * (rolling + scrub) * abrasive * wrongPressure;
}
/** Grip left on worn tyres (new = 1, bald ≈ 0.7). */
export const wornGrip = (wear: number) => 1 - 0.3 * Math.min(1, Math.max(0, wear));
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
  | { key: 'fuse'; value: number }
  /** Roadside fix of a mechanical failure: start it, then report it done. */
  | { key: 'fix'; value: number }
  | { key: 'fixdone'; value: number }
  /** Arm the push-to-pass boost. */
  | { key: 'boost'; value: boolean };

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
  if ((key === 'fix' || key === 'fixdone') && Number.isInteger(value) && (value as number) >= 0 && (value as number) < FAILURES.length) return { key, value: value as number };
  if (key === 'boost' && value === true) return { key, value };
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


// ---------------------------------------------------------------- tyre compounds
export const TYRE_COMPOUNDS = ['soft', 'hard', 'wet', 'snow'] as const;
export type TyreCompound = (typeof TYRE_COMPOUNDS)[number];
export const COMPOUND_INFO: Record<TyreCompound, { name: string; short: string; desc: string; price: number }> = {
  soft: { name: 'Soft', short: 'SOFT', desc: 'Most grip on dry roads – but wears out fast.', price: 1.3 },
  hard: { name: 'Hard', short: 'HARD', desc: 'Less grip, lasts for ages. For long stages.', price: 0.8 },
  wet: { name: 'Wet', short: 'WET', desc: 'Deep grooves: grips in the rain, slides in the dry.', price: 1.1 },
  snow: { name: 'Snow (studded)', short: 'SNOW', desc: 'Studs bite into snow and ice. Hopeless on tarmac.', price: 1.2 },
};
/** Sets of each compound per championship season. */
export const SEASON_TYRE_SETS: Record<TyreCompound, number> = { soft: 3, hard: 3, wet: 2, snow: 2 };

/** Grip multiplier for a compound on a surface; `wet` = 0..1 how wet the road is. */
export function compoundGrip(c: TyreCompound, surface: string, wet: number): number {
  const snowy = surface === 'snow' || surface === 'snowbank';
  switch (c) {
    case 'soft':
      return (snowy ? 0.95 : 1.06) * (1 - 0.06 * wet);
    case 'hard':
      return snowy ? 0.93 : 0.96;
    case 'wet':
      return snowy ? 1.0 : 0.94 + 0.16 * wet;
    case 'snow':
      return snowy ? 1.3 : surface === 'tarmac' || surface === 'wood' ? 0.84 : 0.94;
  }
}

/** How fast a compound wears compared with the old all-round tyre. */
export function compoundWear(c: TyreCompound, surface: string, wet: number): number {
  const hard = surface === 'tarmac' || surface === 'wood';
  switch (c) {
    case 'soft':
      return 1.8;
    case 'hard':
      return 0.55;
    case 'wet':
      return wet > 0.3 ? 1 : 1.4;
    case 'snow':
      return hard ? 2.2 : 1;
  }
}

/** A sensible compound for the weather/surface (the AI and first-time players). */
export function suggestedCompound(surface: string, weatherRain: number, weatherSnow: number): TyreCompound {
  if (weatherSnow > 0 || surface === 'snow') return 'snow';
  if (weatherRain > 0.4) return 'wet';
  return 'soft';
}

// ---------------------------------------------------------------- mechanical failures
export const FAILURES = ['punctureFL', 'punctureFR', 'punctureRL', 'punctureRR', 'gearbox', 'steering', 'turbo'] as const;
export type Failure = (typeof FAILURES)[number];
export const FAILURE_INFO: Record<Failure, { name: string; fix: number }> = {
  punctureFL: { name: 'PUNCTURE – FRONT LEFT', fix: 22 },
  punctureFR: { name: 'PUNCTURE – FRONT RIGHT', fix: 22 },
  punctureRL: { name: 'PUNCTURE – REAR LEFT', fix: 22 },
  punctureRR: { name: 'PUNCTURE – REAR RIGHT', fix: 22 },
  gearbox: { name: 'GEARBOX – A GEAR HAS GONE', fix: 18 },
  steering: { name: 'POWER STEERING FAILED', fix: 14 },
  turbo: { name: 'TURBO PIPE OFF – NO BOOST', fix: 12 },
};
/** One spare wheel per stage: a second puncture can't be fixed on the road. */
export const SPARE_WHEELS = 1;
export const encodeFailures = (f: Set<Failure>) => FAILURES.reduce((n, k, i) => (f.has(k) ? n | (1 << i) : n), 0);
export const decodeFailures = (n: number) => new Set(FAILURES.filter((_, i) => n & (1 << i)));

// ---------------------------------------------------------------- push-to-pass
/** Seconds of overboost per stage, and how much power it adds. */
export const BOOST_SECONDS = 15;
export const BOOST_POWER = 1.12;
/** 0 = not armed, 1 = armed (driver presses B), 2 = running, 3 = used up. */
export type BoostState = 0 | 1 | 2 | 3;

// ---------------------------------------------------------------- engine & gearbox life (championship)
/**
 * Wear on the engine and gearbox over a stage (0..1 of their life). Revving
 * hard, overheating and overboost wear the engine; shifting and jumps the gearbox.
 */
export function engineWearStep(dt: number, o: { rpmFrac: number; temp: number; boost: boolean }) {
  return dt * (0.00002 + Math.max(0, o.rpmFrac - 0.85) * 0.00018 + (o.temp > 112 ? 0.0004 : 0) + (o.boost ? 0.0003 : 0));
}
export const GEARBOX_WEAR_PER_SHIFT = 0.00012;
export const GEARBOX_WEAR_PER_LANDING = 0.004;
/** Power left from a tired engine. */
export const enginePower = (life: number) => 0.86 + 0.14 * Math.max(0, Math.min(1, life));
/** Rebuild prices at the championship service park. */
export const ENGINE_REBUILD = 9000;
export const GEARBOX_REBUILD = 6000;
