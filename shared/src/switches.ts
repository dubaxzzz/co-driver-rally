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
