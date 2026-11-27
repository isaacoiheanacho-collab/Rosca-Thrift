/**
 * Pure payout arithmetic for the dynamic circle model.
 *
 * All monetary values are integer pence. TVC is a zero-sum position
 * adjustment spanning -50% to +50% of one configured contribution.
 * The platform maintenance fee is 0.5% (50 basis points), applied
 * after TVC. No global contribution or circle-size defaults are used.
 */

export const PLATFORM_MAINTENANCE_FEE_BPS = 50n;
const BASIS_POINTS = 10_000n;

export interface PayoutCalculationInput {
  contributionAmountPence: bigint;
  configuredCapacity: number;
  collectionPosition: number;
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
  return divideRounded(contributionAmountPence * positionFactor, denominator);
}

export function calculatePayout(input: PayoutCalculationInput): PayoutCalculation {
  const { contributionAmountPence, configuredCapacity, collectionPosition } = input;
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
    amountAfterTvcPence * PLATFORM_MAINTENANCE_FEE_BPS,
    BASIS_POINTS,
  );
  const netPayoutPence = amountAfterTvcPence - platformFeePence;

  return {
    grossPoolPence,
    tvcAdjustmentPence,
    amountAfterTvcPence,
    platformFeeBps: PLATFORM_MAINTENANCE_FEE_BPS,
    platformFeePence,
    netPayoutPence,
  };
}
