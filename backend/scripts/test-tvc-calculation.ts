import { calculateFee, calculateTvc } from '../src/modules/payouts/tvc.service';

function eq(actual: bigint, expected: bigint, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  console.log(`PASS ${label}`);
}
const gross = 1_200_000n;
const expected = [-50000n,-40909n,-31818n,-22727n,-13636n,-4545n,4545n,13636n,22727n,31818n,40909n,50000n];
let total = 0n;
for (let slot=1; slot<=12; slot++) {
  const result = calculateTvc(gross, slot, 1, 11);
  eq(result.adjustment, expected[slot-1]!, `slot ${slot} TVC`);
  total += result.adjustment;
}
eq(total, 0n, '12-slot TVC adjustments sum to zero');
const early = calculateTvc(gross, 1, 1, 11);
const earlyFee = calculateFee(early.potAfterTvc, 150);
eq(earlyFee.fee, 17250n, 'slot 1 maintenance fee £172.50');
eq(earlyFee.net, 1132750n, 'slot 1 final payout £11,327.50');
const late = calculateTvc(gross, 12, 1, 11);
const lateFee = calculateFee(late.potAfterTvc, 150);
eq(lateFee.fee, 18750n, 'slot 12 maintenance fee £187.50');
eq(lateFee.net, 1231250n, 'slot 12 final payout £12,312.50');
eq(calculateTvc(gross, 1, 200, 10000).adjustment, -11000n, 'legacy 2% tenure snapshot');
console.log('All TVC tests passed.');
