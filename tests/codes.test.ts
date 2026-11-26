/** Redeem codes: unique, typed in capitals, and every car and paint they hand out really exists. */
import { CODES, PAINTS, VEHICLES, codeActive, codeByText } from '../shared/src/index';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

check(CODES.length >= 25, `${CODES.length} codes`);
check(new Set(CODES.map((c) => c.code)).size === CODES.length, 'every code is different');
check(CODES.every((c) => /^[A-Z0-9]{4,16}$/.test(c.code)), 'codes are 4–16 capital letters and digits');
check(CODES.every((c) => Number.isFinite(Date.parse(`${c.validUntil}T00:00:00Z`))), 'every end date is a real date');
check(CODES.every((c) => c.description.length > 5), 'every code says what it gives');

const bad: string[] = [];
for (const c of CODES) {
  const r = c.reward;
  if (r.kind === 'loan' && !VEHICLES.some((v) => v.id === r.carId)) bad.push(`${c.code}: no car ${r.carId}`);
  if (r.kind === 'loan' && !(r.hours > 0)) bad.push(`${c.code}: loan time`);
  if (r.kind === 'paint' && !PAINTS.some((p) => p.id === r.paintId && p.codeOnly)) bad.push(`${c.code}: no code-only paint ${r.paintId}`);
  if (r.kind === 'paint' && !(r.hours > 0)) bad.push(`${c.code}: paint time`);
  if (r.kind === 'boost' && !(r.mult > 1 && r.mult <= 3 && r.hours > 0 && r.hours <= 12)) bad.push(`${c.code}: boost size`);
  if (r.kind === 'cash' && !(r.amount > 0 && r.amount <= 10000)) bad.push(`${c.code}: cash amount`);
}
check(bad.length === 0, bad.length ? `problems: ${bad.join('; ')}` : 'every car, paint, boost and cash amount is valid');
const best = [...VEHICLES].sort((a, b) => b.price - a.price)[0];
check(CODES.some((c) => c.reward.kind === 'loan' && c.reward.carId === best.id && c.reward.hours === 12), `a 12-hour loan code for the best car (${best.name})`);
check(PAINTS.filter((p) => p.codeOnly).every((p) => CODES.some((c) => c.reward.kind === 'paint' && c.reward.paintId === p.id)), 'every code-only paint can be won with a code');
check(codeByText('  neon lime ')?.code === 'NEONLIME', 'codes ignore capitals and spaces');
check(codeByText('nope') === null, 'a wrong code finds nothing');
check(codeActive(CODES[0], Date.parse('2020-01-01')) && !codeActive(CODES[0], Date.parse('2099-01-01')), 'a code stops working after its end date');

console.log(failures ? `\n${failures} check(s) failed` : '\nCodes OK');
process.exit(failures ? 1 : 0);
