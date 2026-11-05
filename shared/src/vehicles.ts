/** Garage data. Add more cars to VEHICLES – the garage and physics read from here. */

export interface VehicleDef {
  id: string;
  name: string;
  class: string;
  description: string;
  /** Physics */
  massKg: number;
  enginePowerN: number; // peak drive force at the wheels
  maxRpm: number;
  idleRpm: number;
  gearRatios: number[]; // forward gears 1..n
  finalDrive: number;
  brakeForce: number;
  maxSteerRad: number;
  grip: number; // tyre friction slip
  /** Display stats 0..10 */
  stats: { power: number; handling: number; braking: number; weight: number };
}

export interface PaintOption {
  id: string;
  name: string;
  body: number;
  accent: number;
}

export interface WheelOption {
  id: string;
  name: string;
  rim: number;
  /** Rim style: number of spokes */
  spokes: number;
  /** Small handling tweak so the choice matters. */
  gripMultiplier: number;
}

export const VEHICLES: VehicleDef[] = [
  {
    id: 'kestrel-r5',
    name: 'Kestrel R5',
    class: 'Rally2 · 4WD',
    description: 'A 1.6 turbo four-wheel-drive rally weapon, set up soft for loose forest gravel.',
    massKg: 1230,
    enginePowerN: 8200,
    maxRpm: 7600,
    idleRpm: 900,
    gearRatios: [3.2, 2.25, 1.72, 1.38, 1.15, 0.98],
    finalDrive: 1,
    brakeForce: 60,
    maxSteerRad: 0.55,
    grip: 2.1,
    stats: { power: 8, handling: 8, braking: 7, weight: 6 },
  },
];

export const PAINTS: PaintOption[] = [
  { id: 'ember', name: 'Ember Red', body: 0xd8261c, accent: 0xf2f2f2 },
  { id: 'arctic', name: 'Arctic White', body: 0xeeeeee, accent: 0xff6a00 },
  { id: 'midnight', name: 'Midnight Blue', body: 0x13284d, accent: 0xffc400 },
  { id: 'forest', name: 'Forest Green', body: 0x1f5a32, accent: 0xf2f2f2 },
  { id: 'carbon', name: 'Carbon Black', body: 0x1a1a1c, accent: 0xff3b1f },
  { id: 'solar', name: 'Solar Orange', body: 0xff7417, accent: 0x111111 },
];

export const WHEELS: WheelOption[] = [
  { id: 'gravel-white', name: 'Gravel Spec · White', rim: 0xf0f0f0, spokes: 5, gripMultiplier: 1.0 },
  { id: 'gravel-gold', name: 'Gravel Spec · Gold', rim: 0xc9a227, spokes: 6, gripMultiplier: 1.0 },
  { id: 'lightweight', name: 'Lightweight Forged', rim: 0x2b2b2e, spokes: 10, gripMultiplier: 0.97 },
  { id: 'soft-compound', name: 'Soft Compound', rim: 0x8a8f96, spokes: 8, gripMultiplier: 1.06 },
];
