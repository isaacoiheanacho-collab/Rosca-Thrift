const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculatePayout,
  calculateTvcAdjustmentPence,
} = require('../dist/modules/payouts/payout-calculator.js');

test('matches the documented five-position TVC example', () => {
  const adjustments = [1, 2, 3, 4, 5].map((position) =>
    calculateTvcAdjustmentPence(10_000n, 5, position),
  );
  assert.deepEqual(adjustments, [-5_000n, -2_500n, 0n, 2_500n, 5_000n]);
  assert.equal(adjustments.reduce((sum, value) => sum + value, 0n), 0n);
});

test('uses symmetric zero-sum adjustments for odd and even capacities', () => {
  for (const capacity of [2, 3, 4, 5, 6, 7, 10, 20]) {
    const values = Array.from({ length: capacity }, (_, index) =>
      calculateTvcAdjustmentPence(12_345n, capacity, index + 1),
    );
    assert.equal(values.reduce((sum, value) => sum + value, 0n), 0n);
    for (let i = 0; i < capacity; i += 1) {
      assert.equal(values[i], -values[capacity - 1 - i]);
    }
  }
});

test('capacity one has no TVC adjustment', () => {
  assert.equal(calculateTvcAdjustmentPence(10_000n, 1, 1), 0n);
});

test('applies 0.5% fee after TVC and returns each component', () => {
  const result = calculatePayout({
    contributionAmountPence: 10_000n,
    platformFeeBps: 50n,
    configuredCapacity: 5,
    collectionPosition: 1,
  });
  assert.equal(result.grossPoolPence, 50_000n);
  assert.equal(result.tvcAdjustmentPence, -5_000n);
  assert.equal(result.amountAfterTvcPence, 45_000n);
  assert.equal(result.platformFeeBps, 50n);
  assert.equal(result.platformFeePence, 225n);
  assert.equal(result.netPayoutPence, 44_775n);
});

test('rejects invalid amounts, capacities and positions', () => {
  assert.throws(() => calculateTvcAdjustmentPence(0n, 5, 1), /positive/);
  assert.throws(() => calculateTvcAdjustmentPence(100n, 0, 1), /capacity/);
  assert.throws(() => calculateTvcAdjustmentPence(100n, 5, 6), /position/);
});

test('never exceeds half a contribution for odd penny amounts', () => {
  const adjustments = [1, 2, 3, 4, 5].map((position) =>
    calculateTvcAdjustmentPence(10_001n, 5, position),
  );
  assert.deepEqual(adjustments, [-5_000n, -2_500n, 0n, 2_500n, 5_000n]);
  assert.equal(adjustments.reduce((sum, value) => sum + value, 0n), 0n);
  assert.ok(adjustments.every((value) => value * 2n <= 10_001n && value * 2n >= -10_001n));
});


test('applies the configured 1% fee after TVC', () => {
  const result = calculatePayout({
    contributionAmountPence: 10_000n,
    platformFeeBps: 100n,
    configuredCapacity: 5,
    collectionPosition: 1,
  });

  assert.equal(result.grossPoolPence, 50_000n);
  assert.equal(result.amountAfterTvcPence, 45_000n);
  assert.equal(result.platformFeeBps, 100n);
  assert.equal(result.platformFeePence, 450n);
  assert.equal(result.netPayoutPence, 44_550n);
});

test('rejects an invalid platform fee rate', () => {
  assert.throws(() => calculatePayout({
    contributionAmountPence: 10_000n,
    platformFeeBps: 10_001n,
    configuredCapacity: 5,
    collectionPosition: 1,
  }));

  assert.throws(() => calculatePayout({
    contributionAmountPence: 10_000n,
    platformFeeBps: -1n,
    configuredCapacity: 5,
    collectionPosition: 1,
  }));
});
