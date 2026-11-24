/**
 * Time-Value Collection (TVC).
 *
 * The earliest collection position receives -50% of one contribution;
 * the final position receives +50%. Intermediate positions are linear.
 * The adjustments sum to zero across the complete circle.
 */
export interface TvcCalculation {
  grossPot: bigint;
  adjustment: bigint;
  potAfterTvc: bigint;
  rateBps: number; // retained for payout-record compatibility; TVC is no longer a rate
}

export function calculateTvc(
  grossPotPence: bigint,
  position: number,
  contributionPence: bigint,
  memberCount: number,
): TvcCalculation {
  if (!Number.isInteger(memberCount) || memberCount < 2) {
    throw new Error('Circle must contain at least 2 co-savers');
  }
  if (!Number.isInteger(position) || position < 1 || position > memberCount) {
    throw new Error(`Invalid collection position: ${position}. Must be 1-${memberCount}.`);
  }
  if (contributionPence <= 0n || grossPotPence !== contributionPence * BigInt(memberCount)) {
    throw new Error('Gross pool must equal individual contribution multiplied by circle size');
  }

  // adjustment = M * (T - midpoint) / (N - 1)
  // Equivalent integer form avoids floating-point currency arithmetic.
  const numerator = contributionPence * BigInt(2 * position - (memberCount + 1));
  const denominator = BigInt(2 * (memberCount - 1));
  const half = denominator / 2n;
  const adjustment = numerator >= 0n
    ? (numerator + half) / denominator
    : (numerator - half) / denominator;

  return {
    grossPot: grossPotPence,
    adjustment,
    potAfterTvc: grossPotPence + adjustment,
    rateBps: 0,
  };
}

/** Platform maintenance fee remains a separate percentage of the adjusted payout. */
export function calculateFee(
  potAfterTvcPence: bigint,
  feeBps: number,
): { fee: bigint; net: bigint; rateBps: number } {
  const numerator = potAfterTvcPence * BigInt(feeBps);
  const denominator = 10000n;
  const half = denominator / 2n;
  const fee = (numerator + half) / denominator;
  return { fee, net: potAfterTvcPence - fee, rateBps: feeBps };
}
