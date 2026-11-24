import assert from 'node:assert/strict';
import { calculateTvc, calculateFee } from '../src/modules/payouts/tvc.service';

function verifyCircle(memberCount: number, contributionPence: bigint) {
  const gross = contributionPence * BigInt(memberCount);
  let totalAdjustment = 0n;
  const adjustments: bigint[] = [];
  for (let position = 1; position <= memberCount; position++) {
    const result = calculateTvc(gross, position, contributionPence, memberCount);
    adjustments.push(result.adjustment);
    totalAdjustment += result.adjustment;
    assert.equal(result.grossPot, gross);
    assert.equal(result.potAfterTvc, gross + result.adjustment);
  }
  assert.equal(totalAdjustment, 0n, 'TVC adjustments must balance to zero');
  assert.ok(adjustments[0]! <= 0n, 'first position must not receive a positive adjustment');
  assert.ok(adjustments[memberCount - 1]! >= 0n, 'last position must not receive a negative adjustment');

  const halfContribution = contributionPence / 2n;
  assert.ok(adjustments[0]! >= -halfContribution - 1n, 'first position adjustment is capped at approximately 50%');
  assert.ok(adjustments[memberCount - 1]! <= halfContribution + 1n, 'last position adjustment is capped at approximately 50%');

  const midpoint = (memberCount + 1) / 2;
  if (Number.isInteger(midpoint)) {
    assert.equal(adjustments[midpoint - 1], 0n, 'middle position has no TVC adjustment');
  }
}

for (const n of [3, 5, 6, 10, 12]) {
  verifyCircle(n, 100000n);
}

const three = calculateTvc(300000n, 1, 100000n, 3);
assert.equal(three.adjustment, -50000n);
const sixFirst = calculateTvc(600000n, 1, 100000n, 6);
const sixLast = calculateTvc(600000n, 6, 100000n, 6);
assert.equal(sixFirst.adjustment, -50000n);
assert.equal(sixLast.adjustment, 50000n);

const fee = calculateFee(950000n, 150);
assert.equal(fee.fee, 14250n);
assert.equal(fee.net, 935750n);

assert.throws(() => calculateTvc(100000n, 1, 100000n, 1));
assert.throws(() => calculateTvc(300000n, 4, 100000n, 3));

console.log('Dynamic TVC tests passed for 3, 5, 6, 10 and 12-member circles.');
