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
  body: {
    style: BodyStyle;
    model: CarModelId;
    length: number;
    width: number;
    height: number;
    wing: boolean;
    /** Body width multiplier for variants of a model (wide-arch versions etc.). */
    widthScale?: number;
    /** Door number, sponsor name and its colours (background, text) – defaults per model. */
    number?: string;
    sponsor?: [string, string, string];
    /** Bolt-on parts that make a variant look different. */
    extras?: CarExtra[];
  };
  /** Display stats 0..10 */
  stats: { power: number; handling: number; braking: number; weight: number };
}

export type CarExtra = 'rack' | 'lightbar' | 'scoop' | 'mudguards' | 'snorkel';

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

const ORIGINALS: VehicleDef[] = [
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
    price: 50000,
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
    price: 260000,
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
    price: 380000,
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
    description: 'Top-class hybrid 4WD with a big wing and huge grip. One of the fastest cars in the game.',
    price: 950000,
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

/** The five chassis the other cars are built on. */
const BASES = Object.fromEntries(ORIGINALS.map((v) => [v.body.model, v])) as Record<CarModelId, VehicleDef>;

export const VEHICLES: VehicleDef[] = [...ORIGINALS, ...MORE_CARS()].sort((a, b) => a.price - b.price);

/**
 * Twenty more cars, built on the five chassis (each keeps its chassis' cockpit
 * and body, with its own tune, livery and bolt-on parts).
 */
function MORE_CARS(): VehicleDef[] {
  type Base = Omit<VehicleDef, 'id' | 'name' | 'class' | 'description' | 'price' | 'stats'>;
  const base = (model: CarModelId): Base => {
    const b = BASES[model];
    return { ...b, gearRatios: [...b.gearRatios], body: { ...b.body } };
  };
  const car = (
    model: CarModelId,
    id: string,
    name: string,
    cls: string,
    description: string,
    price: number,
    tune: Partial<Base>,
    looks: Partial<VehicleDef['body']>,
    stats: VehicleDef['stats'],
  ): VehicleDef => {
    const b = base(model);
    return { ...b, ...tune, id, name, class: cls, description, price, body: { ...b.body, ...looks }, stats };
  };
  return [
    // ---- small hatches (Sparrow chassis) ----
    car('sparrow', 'pipit-1300', 'Pipit 1300', 'Historic · FWD', 'A tiny 70s rally hatch with a 1.3 carburettor engine. Slow, light and huge fun.', 45000,
      { enginePowerN: 5400, massKg: 960, grip: 1.95, maxRpm: 7200 }, { number: '63', sponsor: ['PIPIT', '#f4e3b2', '#7a2a12'], extras: ['mudguards'] },
      { power: 3, handling: 8, braking: 5, weight: 10 }),
    car('sparrow', 'finch-rallye', 'Finch Rallye', 'Rally5 · FWD', 'Entry-level club car with a lamp bar for night stages.', 70000,
      { enginePowerN: 6300, massKg: 1010 }, { number: '21', sponsor: ['FINCH', '#1a1a1a', '#ffd400'], extras: ['lightbar'] },
      { power: 5, handling: 8, braking: 6, weight: 9 }),
    car('sparrow', 'wren-gt', 'Wren GT', 'Historic · RWD', 'Rear-wheel-drive classic coupé-hatch. Tail-happy on gravel.', 85000,
      { drive: 'RWD', frontDriveShare: 0, enginePowerN: 6900, massKg: 1060, grip: 2.0 }, { number: '17', sponsor: ['WREN', '#0d3b2e', '#e8e2c8'] },
      { power: 5, handling: 6, braking: 6, weight: 8 }),
    car('sparrow', 'sparrow-r4', 'Sparrow R4 Kit', 'Rally3 · 4WD', 'The little Sparrow with wide arches and a four-wheel-drive kit.', 140000,
      { drive: '4WD', frontDriveShare: 0.45, enginePowerN: 7400, massKg: 1100, grip: 2.15 }, { number: '4', widthScale: 1.06, sponsor: ['SPARROW', '#c8102e', '#ffffff'], extras: ['mudguards', 'scoop'] },
      { power: 6, handling: 9, braking: 7, weight: 8 }),
    // ---- modern hatches (Kestrel chassis) ----
    car('kestrel', 'merlin-s1600', 'Merlin S1600', 'Super 1600 · FWD', 'High-revving front-drive hatch. Brilliant in tight hairpins.', 95000,
      { drive: 'FWD', frontDriveShare: 1, enginePowerN: 7300, massKg: 1080, maxRpm: 8600 }, { number: '16', sponsor: ['MERLIN', '#3a0d5c', '#ffffff'] },
      { power: 6, handling: 8, braking: 7, weight: 8 }),
    car('kestrel', 'kestrel-r5-evo', 'Kestrel R5 Evo', 'Rally2 · 4WD', 'The starter car\'s big brother: more boost, quicker gearbox.', 160000,
      { enginePowerN: 9000, shiftTime: 0.24, grip: 2.15 }, { number: '77', sponsor: ['KESTREL', '#ffcc00', '#111111'], extras: ['lightbar'] },
      { power: 8, handling: 8, braking: 7, weight: 6 }),
    car('kestrel', 'osprey-rally2', 'Osprey Rally2', 'Rally2 · 4WD', 'A stiff, precise works Rally2 car built for fast gravel.', 230000,
      { enginePowerN: 9300, suspension: 1.1, grip: 2.2, shiftTime: 0.22 }, { number: '9', sponsor: ['OSPREY', '#0b3d91', '#7fd3ff'] },
      { power: 8, handling: 9, braking: 8, weight: 6 }),
    car('kestrel', 'harrier-wrc', 'Harrier WRC', 'WRC · 4WD', 'Wide-body world rally car from the late 2010s. Massive aero, massive grip.', 420000,
      { enginePowerN: 10400, grip: 2.25, brakeForce: 70, shiftTime: 0.2 }, { number: '3', widthScale: 1.07, sponsor: ['HARRIER', '#101010', '#ff3b1f'], extras: ['scoop'] },
      { power: 9, handling: 9, braking: 9, weight: 6 }),
    // ---- rally-raid trucks (Dune chassis) ----
    car('dune', 'bushman-4x4', 'Bushman 4x4', 'Bush basher · 4WD', 'An old farm ute turned rally truck. Tough as nails, slow as a tractor.', 110000,
      { enginePowerN: 8600, massKg: 1820, armour: 0.4, shiftTime: 0.36 }, { number: '88', sponsor: ['BUSHMAN', '#4b3a1e', '#f2c14e'], extras: ['rack', 'snorkel'] },
      { power: 5, handling: 4, braking: 5, weight: 2 }),
    car('dune', 'dune-lr', 'Dune Raider LR', 'Rally-raid · 4WD', 'Long-range Dune with roof rack, spare tyres and extra fuel.', 340000,
      { enginePowerN: 11200, armour: 0.4, massKg: 1820 }, { number: '45', sponsor: ['DUNE', '#ff8a00', '#2b2b2b'], extras: ['rack', 'lightbar'] },
      { power: 7, handling: 5, braking: 6, weight: 2 }),
    car('dune', 'mesa-t1', 'Mesa T1', 'T1 prototype · 4WD', 'A desert prototype with long-travel suspension and a big V8.', 480000,
      { enginePowerN: 12000, massKg: 1700, grip: 2.1, suspension: 1.2 }, { number: '301', widthScale: 1.05, sponsor: ['MESA', '#c2410c', '#fff7ed'], extras: ['lightbar', 'snorkel'] },
      { power: 8, handling: 6, braking: 7, weight: 3 }),
    car('dune', 'sandstorm-pro', 'Sandstorm Pro', 'Ultimate · 4WD', 'Dakar-winning monster truck. Nothing stops it.', 650000,
      { enginePowerN: 12800, massKg: 1680, armour: 0.45, grip: 2.15, shiftTime: 0.26 }, { number: '500', widthScale: 1.06, sponsor: ['SANDSTORM', '#111111', '#ffd400'], extras: ['lightbar', 'rack', 'snorkel'] },
      { power: 9, handling: 6, braking: 7, weight: 3 }),
    // ---- 80s coupés (Bruno chassis) ----
    car('bruno', 'corvo-rs', 'Corvo RS', 'Group 4 · RWD', 'Light, short and twitchy – the car that made rear-drive rallying famous.', 520000,
      { enginePowerN: 10000, massKg: 1080, maxSteerRad: 0.6 }, { number: '14', sponsor: ['CORVO', '#006b3c', '#ffffff'] },
      { power: 8, handling: 6, braking: 7, weight: 8 }),
    car('bruno', 'bruno-evo2', 'Bruno 300 Evo 2', 'Group B · RWD', 'The final Bruno: more boost, bigger wing, even more sideways.', 720000,
      { enginePowerN: 11800, grip: 2.1, shiftTime: 0.22 }, { number: '31', widthScale: 1.05, sponsor: ['BRUNO', '#ffffff', '#0a2a6b'], extras: ['scoop'] },
      { power: 10, handling: 6, braking: 7, weight: 7 }),
    car('bruno', 'vela-turbo', 'Vela Turbo', 'Group B · 4WD', 'Four-wheel-drive Group B monster with a giant turbo. Lag, then everything.', 900000,
      { drive: '4WD', frontDriveShare: 0.38, enginePowerN: 12200, grip: 2.2, massKg: 1150 }, { number: '6', sponsor: ['VELA', '#d10000', '#ffe600'], extras: ['lightbar'] },
      { power: 10, handling: 8, braking: 8, weight: 7 }),
    car('bruno', 'mamba-quattro', 'Mamba Quattro', 'Group S · 4WD', 'The prototype that was too fast to be allowed to race. Until now.', 1100000,
      { drive: '4WD', frontDriveShare: 0.42, enginePowerN: 12800, grip: 2.28, shiftTime: 0.2, brakeForce: 72 }, { number: '2', widthScale: 1.06, sponsor: ['MAMBA', '#0a0a0a', '#9dff00'], extras: ['scoop', 'lightbar'] },
      { power: 10, handling: 9, braking: 9, weight: 7 }),
    // ---- top class (Vortex chassis) ----
    car('vortex', 'zenith-hybrid', 'Zenith Hybrid', 'Rally1 · 4WD hybrid', 'A works hybrid with a smoother power curve – easier to drive fast.', 1200000,
      { enginePowerN: 11800, grip: 2.32, maxSteerRad: 0.58 }, { number: '8', sponsor: ['ZENITH', '#ffffff', '#5b21b6'] },
      { power: 10, handling: 10, braking: 9, weight: 6 }),
    car('vortex', 'vortex-rx-evo', 'Vortex RX Evo', 'Rally1 · 4WD hybrid', 'Lighter, stiffer and quicker than the Vortex RX.', 1400000,
      { enginePowerN: 12300, massKg: 1220, grip: 2.35, shiftTime: 0.16 }, { number: '11', widthScale: 1.04, sponsor: ['VORTEX', '#06121c', '#00c2ff'], extras: ['scoop'] },
      { power: 10, handling: 10, braking: 10, weight: 7 }),
    car('vortex', 'apex-rally1', 'Apex Rally1', 'Rally1 · 4WD hybrid', 'The championship-winning car of the current era.', 1600000,
      { enginePowerN: 12600, massKg: 1230, grip: 2.38, brakeForce: 76, shiftTime: 0.15 }, { number: '33', sponsor: ['APEX', '#e11d48', '#ffffff'], extras: ['lightbar'] },
      { power: 10, handling: 10, braking: 10, weight: 7 }),
    car('vortex', 'tempest-proto', 'Tempest Prototype', 'Unlimited · 4WD', 'A no-rules hill-climb prototype. The most expensive – and fastest – car in the game.', 2500000,
      { enginePowerN: 13800, massKg: 1150, grip: 2.45, brakeForce: 80, shiftTime: 0.12, suspension: 1.12 }, { number: '0', widthScale: 1.08, sponsor: ['TEMPEST', '#000000', '#ff6a00'], extras: ['scoop', 'lightbar'] },
      { power: 10, handling: 10, braking: 10, weight: 8 }),
  ];
}

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
