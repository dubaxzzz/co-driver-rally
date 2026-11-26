/**
 * Redeem codes (Settings → Codes). Every code stops working on its end date,
 * can be used once, and what it gives is limited too: cash is kept, the rest
 * runs out after a number of hours.
 */
export type CodeReward =
  | { kind: 'cash'; amount: number }
  /** Prize money is multiplied for a while. */
  | { kind: 'boost'; mult: number; hours: number }
  /** Borrow a car (it goes back when the time is up). */
  | { kind: 'loan'; carId: string; hours: number }
  /** Use a special paint for a while. */
  | { kind: 'paint'; paintId: string; hours: number };

export interface CodeDef {
  code: string;
  /** What it gives, in words. */
  description: string;
  /** Last day the code can be redeemed (end of this day, UTC). */
  validUntil: string;
  reward: CodeReward;
}

export const CODES: CodeDef[] = [
  // ---- cash (kept)
  { code: 'FRESHTYRES', description: '$5,000 cash (keep it)', validUntil: '2026-12-10', reward: { kind: 'cash', amount: 5000 } },
  { code: 'STARTERPACK', description: '$3,000 cash (keep it)', validUntil: '2026-12-31', reward: { kind: 'cash', amount: 3000 } },
  { code: 'SERVICEBAY', description: '$2,000 cash for repairs (keep it)', validUntil: '2026-12-20', reward: { kind: 'cash', amount: 2000 } },
  { code: 'PODIUMPAY', description: '$7,500 cash (keep it)', validUntil: '2027-01-15', reward: { kind: 'cash', amount: 7500 } },
  { code: 'NEWYEAR27', description: '$10,000 cash (keep it)', validUntil: '2027-01-07', reward: { kind: 'cash', amount: 10000 } },
  { code: 'WINTERCASH', description: '$4,000 cash (keep it)', validUntil: '2027-02-15', reward: { kind: 'cash', amount: 4000 } },
  // ---- prize money boosts (they run out)
  { code: 'DOUBLEUP', description: 'Double prize money for 1 hour', validUntil: '2026-12-31', reward: { kind: 'boost', mult: 2, hours: 1 } },
  { code: 'TRIPLEPAY', description: 'Triple prize money for 30 minutes', validUntil: '2026-12-18', reward: { kind: 'boost', mult: 3, hours: 0.5 } },
  { code: 'FASTMONEY', description: '1.5× prize money for 3 hours', validUntil: '2027-01-10', reward: { kind: 'boost', mult: 1.5, hours: 3 } },
  { code: 'NIGHTSHIFT', description: 'Double prize money for 90 minutes', validUntil: '2026-12-28', reward: { kind: 'boost', mult: 2, hours: 1.5 } },
  { code: 'PAYDAY', description: '1.5× prize money for 6 hours', validUntil: '2027-01-31', reward: { kind: 'boost', mult: 1.5, hours: 6 } },
  { code: 'WEEKENDRUSH', description: 'Double prize money for 2 hours', validUntil: '2027-02-28', reward: { kind: 'boost', mult: 2, hours: 2 } },
  // ---- loan cars (they go back)
  { code: 'LOANAPEX', description: 'Borrow the Apex Rally1 for 48 hours', validUntil: '2026-12-24', reward: { kind: 'loan', carId: 'apex-rally1', hours: 48 } },
  { code: 'LOANHARRIER', description: 'Borrow the Harrier WRC for 24 hours', validUntil: '2026-12-22', reward: { kind: 'loan', carId: 'harrier-wrc', hours: 24 } },
  { code: 'LOANMAMBA', description: 'Borrow the Mamba Quattro for 24 hours', validUntil: '2027-01-05', reward: { kind: 'loan', carId: 'mamba-quattro', hours: 24 } },
  { code: 'LOANSAND', description: 'Borrow the Sandstorm Pro for 24 hours', validUntil: '2027-01-12', reward: { kind: 'loan', carId: 'sandstorm-pro', hours: 24 } },
  { code: 'LOANVELA', description: 'Borrow the Vela Turbo for 36 hours', validUntil: '2027-01-20', reward: { kind: 'loan', carId: 'vela-turbo', hours: 36 } },
  { code: 'LOANZENITH', description: 'Borrow the Zenith Hybrid for 12 hours', validUntil: '2026-12-30', reward: { kind: 'loan', carId: 'zenith-hybrid', hours: 12 } },
  { code: 'LOANCORVO', description: 'Borrow the Corvo RS for 48 hours', validUntil: '2027-02-01', reward: { kind: 'loan', carId: 'corvo-rs', hours: 48 } },
  { code: 'LOANMESA', description: 'Borrow the Mesa T1 for 24 hours', validUntil: '2027-02-10', reward: { kind: 'loan', carId: 'mesa-t1', hours: 24 } },
  { code: 'LOANTEMPEST', description: 'Borrow the Tempest Prototype – the best car in the game – for 12 hours', validUntil: '2027-03-31', reward: { kind: 'loan', carId: 'tempest-proto', hours: 12 } },
  { code: 'LOANPIPIT', description: 'Borrow the Pipit 1300 for 72 hours', validUntil: '2027-03-01', reward: { kind: 'loan', carId: 'pipit-1300', hours: 72 } },
  // ---- special paints (they run out)
  { code: 'GOLDRUSH', description: 'Gold Rush paint for 24 hours', validUntil: '2026-12-15', reward: { kind: 'paint', paintId: 'gold-rush', hours: 24 } },
  { code: 'NEONLIME', description: 'Neon Lime paint for 24 hours', validUntil: '2026-12-19', reward: { kind: 'paint', paintId: 'neon-lime', hours: 24 } },
  { code: 'ROYALTY', description: 'Royal Purple paint for 48 hours', validUntil: '2027-01-02', reward: { kind: 'paint', paintId: 'royal-purple', hours: 48 } },
  { code: 'SUNSETPINK', description: 'Sunset Pink paint for 24 hours', validUntil: '2027-01-14', reward: { kind: 'paint', paintId: 'sunset-pink', hours: 24 } },
  { code: 'ICEBLUE', description: 'Ice Blue paint for 72 hours', validUntil: '2027-02-05', reward: { kind: 'paint', paintId: 'ice-blue', hours: 72 } },
  { code: 'CHROMEDUP', description: 'Chrome Silver paint for 48 hours', validUntil: '2027-02-20', reward: { kind: 'paint', paintId: 'chrome', hours: 48 } },
  { code: 'BANANA', description: 'Rally Yellow paint for 24 hours', validUntil: '2027-03-10', reward: { kind: 'paint', paintId: 'rally-yellow', hours: 24 } },
];

export const codeByText = (text: string) => CODES.find((c) => c.code === text.trim().toUpperCase().replace(/\s+/g, '')) ?? null;
/** True while the code can still be redeemed. */
export const codeActive = (c: CodeDef, now = Date.now()) => now < Date.parse(`${c.validUntil}T23:59:59Z`);
