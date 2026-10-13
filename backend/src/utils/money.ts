/**
 * Money helpers.
 *
 * All money is stored as integer pence in the DB. These helpers convert
 * to/from display formats.
 *
 * NEVER use floats for money in business logic. Only for display.
 */

/** Format integer pence as a GBP string, e.g. 100000n → "£1,000.00". */
export function formatPence(pence: bigint): string {
  const pounds = Number(pence) / 100;
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(pounds);
}

/** Convert a pounds number to integer pence (rounded to nearest penny). */
export function poundsToPence(pounds: number): bigint {
  return BigInt(Math.round(pounds * 100));
}

/** Convert integer pence to a pounds number. For display only. */
export function penceToPounds(pence: bigint): number {
  return Number(pence) / 100;
}