import { calculateFee, calculateTvc } from '../src/modules/payouts/tvc.service';

function eq(actual: bigint, expected: bigint, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  console.log(`PASS ${label}`);
}

const gross = 1_200_000n;
const expected = [
  -49_995n, -40_905n, -31_815n, -22_725n, -13_635n, -4_545n,
  4_545n, 13_635n, 22_725n, 31_815n, 40_905n, 49_995n,
];
let total = 0n;

for (let slot = 1; slot <= 12; slot++) {
  const result = calculateTvc(gross, slot, 909);
  eq(result.adjustment, expected[slot - 1]!, `slot ${slot} TVC adjustment`);
  eq(result.potAfterTvc, gross + expected[slot - 1]!, `slot ${slot} adjusted pool`);
  total += result.adjustment;
}

eq(total, 0n, '12-slot TVC adjustments sum to zero');

const early = calculateTvc(gross, 1, 909);
const earlyFee = calculateFee(early.potAfterTvc, 150);
eq(earlyFee.fee, 17_250n, 'slot 1 maintenance fee £172.50');
eq(earlyFee.net, 1_132_755n, 'slot 1 final payout £11,327.55');

const late = calculateTvc(gross, 12, 909);
const lateFee = calculateFee(late.potAfterTvc, 150);
eq(lateFee.fee, 18_750n, 'slot 12 maintenance fee £187.50');
eq(lateFee.net, 1_231_245n, 'slot 12 final payout £12,312.45');

console.log('All TVC tests passed.');
