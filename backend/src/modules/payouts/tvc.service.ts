/**
 * TVC (Time-Value Collection) calculation service.
 * Standard annual rate = 1/11 (9.090909…%); monthly rate = 1/132.
 * All money calculations use integer pence and rational arithmetic.
 */
export interface TvcCalculation {
  grossPot: bigint;
  adjustment: bigint;
  potAfterTvc: bigint;
  rateNumerator: number;
  rateDenominator: number;
  /** Rounded legacy basis-point representation for older consumers. */
  rateBps: number;
}

export function calculateTvc(
  grossPotPence: bigint,
  position: number,
  annualRateNumerator: number,
  annualRateDenominator = 11,
): TvcCalculation {
  if (!Number.isInteger(position) || position < 1 || position > 12) {
    throw new Error(`Invalid position: ${position}. Must be an integer from 1-12.`);
  }
  if (
    !Number.isSafeInteger(annualRateNumerator) || annualRateNumerator <= 0 ||
    !Number.isSafeInteger(annualRateDenominator) || annualRateDenominator <= 0
  ) {
    throw new Error('TVC rate numerator and denominator must be positive safe integers.');
  }
  if (grossPotPence <= 0n) throw new Error('Gross pot must be greater than zero.');

  // annualRate × (position - 6.5) / 12 = annualRate × (2T - 13) / 24.
  const numerator = grossPotPence * BigInt(annualRateNumerator) * BigInt(2 * position - 13);
  const denominator = BigInt(annualRateDenominator) * 24n;
  const half = denominator / 2n;
  const adjustment = numerator >= 0n
    ? (numerator + half) / denominator
    : (numerator - half) / denominator;

  return {
    grossPot: grossPotPence,
    adjustment,
    potAfterTvc: grossPotPence + adjustment,
    rateNumerator: annualRateNumerator,
    rateDenominator: annualRateDenominator,
    rateBps: Math.round((annualRateNumerator / annualRateDenominator) * 10000),
  };
}

export function calculateFee(
  potAfterTvcPence: bigint,
  feeBps: number,
): { fee: bigint; net: bigint; rateBps: number } {
  if (potAfterTvcPence <= 0n) throw new Error('Post-TVC pot must be greater than zero.');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
    throw new Error('Fee rate must be an integer between 0 and 10000 basis points.');
  }
  const numerator = potAfterTvcPence * BigInt(feeBps);
  const fee = (numerator + 5000n) / 10000n;
  return { fee, net: potAfterTvcPence - fee, rateBps: feeBps };
}
