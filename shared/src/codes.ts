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
  { code: 'DOUBLEUP', description: 'Double prize money for 1 hour', validUntil: '2026-12-31', reward: { kind: 'boost', mult: 2, hours: 1 } },
  { code: 'LOANAPEX', description: 'Borrow the Apex Rally1 for 48 hours', validUntil: '2026-12-24', reward: { kind: 'loan', carId: 'apex-rally1', hours: 48 } },
  { code: 'GOLDRUSH', description: 'Gold Rush paint for 24 hours', validUntil: '2026-12-15', reward: { kind: 'paint', paintId: 'gold-rush', hours: 24 } },
  { code: 'FRESHTYRES', description: '$5,000 cash (keep it)', validUntil: '2026-12-10', reward: { kind: 'cash', amount: 5000 } },
];

export const codeByText = (text: string) => CODES.find((c) => c.code === text.trim().toUpperCase().replace(/\s+/g, '')) ?? null;
/** True while the code can still be redeemed. */
export const codeActive = (c: CodeDef, now = Date.now()) => now < Date.parse(`${c.validUntil}T23:59:59Z`);
