/**
 * Bank-transfer reference generator and parser.
 *
 * Format (14 chars, pure alphanumeric, UK bank-safe):
 *
 *   IN{tenant6}{slot2}{tenure2}{cycle2}      Contribution
 *   OUT{tenant6}{slot2}{tenure2}{cycle2}     Payout
 *   FEE{tenant6}{tenure2}                    Platform fee
 *
 * Where:
 *   tenant6 = first 6 hex characters of the tenant UUID (lowercase)
 *   slot2   = slot number, 01-12
 *   tenure2 = tenure number, 01-99
 *   cycle2  = cycle number, 01-12
 *
 * The tenant portion is always lowercase hex. The prefix is always
 * uppercase (IN/OUT/FEE). The parser is case-insensitive on input.
 */

export type ReferenceKind = 'IN' | 'OUT' | 'FEE';

export interface ParsedContributionReference {
  kind: 'IN' | 'OUT';
  tenantShort: string;
  slot: number;
  tenure: number;
  cycle: number;
}

export interface ParsedFeeReference {
  kind: 'FEE';
  tenantShort: string;
  tenure: number;
}

export type ParsedReference = ParsedContributionReference | ParsedFeeReference;

function shortTenant(tenantId: string): string {
  const cleaned = tenantId.replace(/-/g, '').toLowerCase();
  return cleaned.slice(0, 6);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function buildContributionReference(
  tenantId: string,
  slot: number,
  tenure: number,
  cycle: number,
): string {
  if (slot < 1 || slot > 12) throw new Error(`Invalid slot: ${slot}`);
  if (tenure < 1 || tenure > 99) throw new Error(`Invalid tenure: ${tenure}`);
  if (cycle < 1 || cycle > 12) throw new Error(`Invalid cycle: ${cycle}`);
  return `IN${shortTenant(tenantId)}${pad2(slot)}${pad2(tenure)}${pad2(cycle)}`;
}

export function buildPayoutReference(
  tenantId: string,
  slot: number,
  tenure: number,
  cycle: number,
): string {
  if (slot < 1 || slot > 12) throw new Error(`Invalid slot: ${slot}`);
  if (tenure < 1 || tenure > 99) throw new Error(`Invalid tenure: ${tenure}`);
  if (cycle < 1 || cycle > 12) throw new Error(`Invalid cycle: ${cycle}`);
  return `OUT${shortTenant(tenantId)}${pad2(slot)}${pad2(tenure)}${pad2(cycle)}`;
}

export function buildFeeReference(tenantId: string, tenure: number): string {
  if (tenure < 1 || tenure > 99) throw new Error(`Invalid tenure: ${tenure}`);
  return `FEE${shortTenant(tenantId)}${pad2(tenure)}`;
}

// Case-insensitive on the hex portion AND the prefix.
// Prefix is captured, normalized to uppercase when reading kind.
const CONTRIBUTION_RE = /^(IN|OUT)([0-9a-fA-F]{6})(\d{2})(\d{2})(\d{2})$/;
const FEE_RE = /^FEE([0-9a-fA-F]{6})(\d{2})$/i;

export function parseReference(input: string): ParsedReference | null {
  const ref = input.trim();

  const contributionMatch = CONTRIBUTION_RE.exec(ref);
  if (contributionMatch) {
    return {
      kind: contributionMatch[1]!.toUpperCase() as 'IN' | 'OUT',
      tenantShort: contributionMatch[2]!.toLowerCase(),
      slot: Number(contributionMatch[3]),
      tenure: Number(contributionMatch[4]),
      cycle: Number(contributionMatch[5]),
    };
  }

  const feeMatch = FEE_RE.exec(ref);
  if (feeMatch) {
    return {
      kind: 'FEE',
      tenantShort: feeMatch[1]!.toLowerCase(),
      tenure: Number(feeMatch[2]),
    };
  }

  return null;
}

export function isValidReference(input: string): boolean {
  return parseReference(input) !== null;
}