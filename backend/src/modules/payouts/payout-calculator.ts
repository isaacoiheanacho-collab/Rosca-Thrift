/**
 * Pure payout arithmetic for the dynamic circle model.
 *
 * All monetary values are integer pence. TVC is a zero-sum position
 * adjustment spanning -50% to +50% of one configured contribution.
 * The platform maintenance fee is supplied by the circle configuration,
 * in basis points and applied after TVC. No global fee default is used.
 */

const BASIS_POINTS = 10_000n;

export interface PayoutCalculationInput {
  contributionAmountPence: bigint;
  configuredCapacity: number;
  collectionPosition: number;
  platformFeeBps: bigint;
}

export interface PayoutCalculation {
  grossPoolPence: bigint;
  tvcAdjustmentPence: bigint;
  amountAfterTvcPence: bigint;
  platformFeeBps: bigint;
  platformFeePence: bigint;
  netPayoutPence: bigint;
}

/** Round a signed rational value to the nearest integer, ties away from zero. */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('Denominator must be positive');
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return sign * ((absolute + denominator / 2n) / denominator);
}

/**
 * Calculate the TVC adjustment for a 1-based collection position.
 *
 * For capacity N > 1:
 * adjustment = contribution * (2 * position - N - 1) / (2 * (N - 1))
 *
 * This produces symmetric, zero-sum adjustments. Capacity one has no
 * relative position, so its adjustment is zero.
 */
export function calculateTvcAdjustmentPence(
  contributionAmountPence: bigint,
  configuredCapacity: number,
  collectionPosition: number,
): bigint {
  if (contributionAmountPence <= 0n) {
    throw new RangeError('Contribution amount must be positive');
  }
  if (!Number.isSafeInteger(configuredCapacity) || configuredCapacity < 1) {
    throw new RangeError('Configured capacity must be a positive safe integer');
  }
  if (
    !Number.isSafeInteger(collectionPosition) ||
    collectionPosition < 1 ||
    collectionPosition > configuredCapacity
  ) {
    throw new RangeError('Collection position must be within the configured capacity');
  }
  if (configuredCapacity === 1) return 0n;

  const positionFactor = BigInt(2 * collectionPosition - configuredCapacity - 1);
  const denominator = 2n * BigInt(configuredCapacity - 1);
  const rounded = divideRounded(contributionAmountPence * positionFactor, denominator);
  // Integer-pence cap is rounded down so the adjustment never exceeds 50%
  // of a single contribution, including odd-penny contribution amounts.
  const cap = contributionAmountPence / 2n;
  if (rounded > cap) return cap;
  if (rounded < -cap) return -cap;
  return rounded;
}

export function calculatePayout(input: PayoutCalculationInput): PayoutCalculation {
  const { contributionAmountPence, configuredCapacity, collectionPosition, platformFeeBps } = input;
  if (platformFeeBps < 0n || platformFeeBps > BASIS_POINTS) {
    throw new RangeError('Platform maintenance fee must be between 0 and 10000 basis points');
  }
  const tvcAdjustmentPence = calculateTvcAdjustmentPence(
    contributionAmountPence,
    configuredCapacity,
    collectionPosition,
  );

  const grossPoolPence = contributionAmountPence * BigInt(configuredCapacity);
  const amountAfterTvcPence = grossPoolPence + tvcAdjustmentPence;
  if (amountAfterTvcPence < 0n) {
    throw new RangeError('Payout amount after TVC cannot be negative');
  }

  const platformFeePence = divideRounded(
    amountAfterTvcPence * platformFeeBps,
    BASIS_POINTS,
  );
  const netPayoutPence = amountAfterTvcPence - platformFeePence;

  return {
    grossPoolPence,
    tvcAdjustmentPence,
    amountAfterTvcPence,
    platformFeeBps,
    platformFeePence,
    netPayoutPence,
  };
}
