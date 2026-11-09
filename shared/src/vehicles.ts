/** Garage data. Add more cars to VEHICLES – the dealership, garage and physics read from here. */

export type Drivetrain = 'FWD' | 'RWD' | '4WD';
export type BodyStyle = 'hatch' | 'coupe' | 'truck';

export interface VehicleDef {
  id: string;
  name: string;
  class: string;
  description: string;
  /** Dealership price ($). 0 = the car you start with. */
  price: number;
  drive: Drivetrain;
  /** Share of engine force sent to the front axle. */
  frontDriveShare: number;
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
  /** 0..0.6 – fraction of crash damage absorbed (armour upgrades add to this). */
  armour: number;
  /** Seconds a gear change takes. */
  shiftTime: number;
  /** Suspension stiffness multiplier (stiffer = steadier, harsher). */
  suspension: number;
  /** Looks */
  body: { style: BodyStyle; model: CarModelId; length: number; width: number; height: number; wing: boolean };
  /** Display stats 0..10 */
  stats: { power: number; handling: number; braking: number; weight: number };
}

/** Which detailed 3D body + dashboard a car uses. */
export type CarModelId = 'kestrel' | 'sparrow' | 'dune' | 'bruno' | 'vortex';

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

export const STARTER_CAR_ID = 'kestrel-r5';

export const VEHICLES: VehicleDef[] = [
  {
    id: 'kestrel-r5',
    name: 'Kestrel R5',
    class: 'Rally2 · 4WD',
    description: 'A 1.6 turbo four-wheel-drive all-rounder, set up soft for loose forest gravel.',
    price: 0,
    drive: '4WD',
    frontDriveShare: 0.42,
    massKg: 1230,
    enginePowerN: 8200,
    maxRpm: 7600,
    idleRpm: 900,
    gearRatios: [3.2, 2.25, 1.72, 1.38, 1.15, 0.98],
    finalDrive: 1,
    brakeForce: 60,
    maxSteerRad: 0.55,
    grip: 2.1,
    armour: 0.1,
    shiftTime: 0.28,
    suspension: 1,
    body: { model: 'kestrel', style: 'hatch', length: 1, width: 1, height: 1, wing: true },
    stats: { power: 7, handling: 8, braking: 7, weight: 6 },
  },
  {
    id: 'sparrow-r2',
    name: 'Sparrow R2',
    class: 'Rally4 · FWD',
    description: 'Tiny, light front-wheel-drive hatch. Slow on the straights but very forgiving.',
    price: 12000,
    drive: 'FWD',
    frontDriveShare: 1,
    massKg: 1030,
    enginePowerN: 6000,
    maxRpm: 7800,
    idleRpm: 950,
    gearRatios: [3.4, 2.35, 1.8, 1.42, 1.17, 1.0],
    finalDrive: 1,
    brakeForce: 55,
    maxSteerRad: 0.58,
    grip: 2.05,
    armour: 0.05,
    shiftTime: 0.3,
    suspension: 0.95,
    body: { model: 'sparrow', style: 'hatch', length: 0.9, width: 0.95, height: 1.02, wing: false },
    stats: { power: 4, handling: 9, braking: 6, weight: 9 },
  },
  {
    id: 'dune-raider',
    name: 'Dune Raider',
    class: 'Rally-raid · 4WD',
    description: 'Heavy, armoured rally truck. Shrugs off sand, mud and big hits – lazy in tight corners.',
    price: 60000,
    drive: '4WD',
    frontDriveShare: 0.5,
    massKg: 1750,
    enginePowerN: 10800,
    maxRpm: 6200,
    idleRpm: 800,
    gearRatios: [3.4, 2.3, 1.7, 1.33, 1.08, 0.9],
    finalDrive: 1,
    brakeForce: 70,
    maxSteerRad: 0.5,
    grip: 2.0,
    armour: 0.35,
    shiftTime: 0.32,
    suspension: 1.15,
    body: { model: 'dune', style: 'truck', length: 1.12, width: 1.08, height: 1.15, wing: false },
    stats: { power: 7, handling: 5, braking: 6, weight: 3 },
  },
  {
    id: 'bruno-300',
    name: 'Bruno 300',
    class: 'Group B · RWD',
    description: 'A wild 80s rear-wheel-drive coupé. Huge power, loves to slide – treat the throttle gently.',
    price: 85000,
    drive: 'RWD',
    frontDriveShare: 0,
    massKg: 1170,
    enginePowerN: 10500,
    maxRpm: 8200,
    idleRpm: 1000,
    gearRatios: [3.0, 2.15, 1.65, 1.33, 1.1, 0.94],
    finalDrive: 1,
    brakeForce: 62,
    maxSteerRad: 0.56,
    grip: 2.05,
    armour: 0.08,
    shiftTime: 0.26,
    suspension: 1,
    body: { model: 'bruno', style: 'coupe', length: 1.0, width: 1.04, height: 0.92, wing: true },
    stats: { power: 9, handling: 6, braking: 7, weight: 7 },
  },
  {
    id: 'vortex-rx',
    name: 'Vortex RX',
    class: 'Rally1 · 4WD hybrid',
    description: 'Top-class hybrid 4WD with a big wing and huge grip. The fastest car in the game.',
    price: 120000,
    drive: '4WD',
    frontDriveShare: 0.45,
    massKg: 1260,
    enginePowerN: 11500,
    maxRpm: 8000,
    idleRpm: 900,
    gearRatios: [3.1, 2.2, 1.7, 1.37, 1.14, 0.97],
    finalDrive: 1,
    brakeForce: 72,
    maxSteerRad: 0.56,
    grip: 2.3,
    armour: 0.12,
    shiftTime: 0.18,
    suspension: 1.05,
    body: { model: 'vortex', style: 'hatch', length: 1.05, width: 1.06, height: 0.97, wing: true },
    stats: { power: 10, handling: 9, braking: 9, weight: 6 },
  },
];

export const vehicleById = (id: string) => VEHICLES.find((v) => v.id === id) ?? VEHICLES[0];

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
