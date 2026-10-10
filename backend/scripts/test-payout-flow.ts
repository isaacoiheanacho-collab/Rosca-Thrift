/**
 * Payout flow end-to-end test.
 *
 * Run: yarn test:payout
 */

import 'dotenv/config';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001';
const SUPER_PHONE = process.env.SUPER_ADMIN_PHONE;
const SUPER_PASSWORD = process.env.TEST_SUPER_PASSWORD ?? 'SuperAdmin1#';
const DEV_OTP = process.env.DEV_OTP_OVERRIDE;

if (!SUPER_PHONE) { console.error('SUPER_ADMIN_PHONE not set'); process.exit(1); }
if (!DEV_OTP) { console.error('DEV_OTP_OVERRIDE not set'); process.exit(1); }

interface ApiResponse { ok?: boolean; data?: any; error?: { code?: string; message?: string }; }

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: ApiResponse }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: ApiResponse;
  try { json = (await res.json()) as ApiResponse; } catch { json = {}; }
  return { status: res.status, json };
}

async function uploadFile(
  path: string,
  token: string,
  fields: Record<string, string>,
  file: { buffer: Buffer; filename: string; contentType: string },
): Promise<{ status: number; json: ApiResponse }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const blob = new Blob([new Uint8Array(file.buffer)], { type: file.contentType });
  form.append('receipt', blob, file.filename);

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let json: ApiResponse;
  try { json = (await res.json()) as ApiResponse; } catch { json = {}; }
  return { status: res.status, json };
}

const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function pass(name: string, detail?: string): void {
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name: string, detail: string): void {
  console.log(`  FAIL  ${name} — ${detail}`);
}

async function main(): Promise<number> {
  const stamp = Date.now();
  const branchSlug = `payout-test-${stamp}`;

  console.log('');
  console.log('============================================');
  console.log('  Payout Flow E2E Test');
  console.log(`  Base: ${BASE}`);
  console.log(`  Branch: ${branchSlug}`);
  console.log('============================================');
  console.log('');

  // 1. Super admin login
  const superLogin = await api('POST', '/api/auth/login', {
    body: { phone: SUPER_PHONE, password: SUPER_PASSWORD },
  });
  if (superLogin.status !== 200 || !superLogin.json.ok) {
    fail('super admin login', JSON.stringify(superLogin.json));
    return 1;
  }
  const superToken = superLogin.json.data.tokens.accessToken;
  pass('super admin login');

  // 2. Create branch
  const branchRes = await api('POST', '/api/super-admin/branches', {
    token: superToken,
    body: { slug: branchSlug, name: `Payout Test ${stamp}` },
  });
  if (branchRes.status !== 201) { fail('create branch', JSON.stringify(branchRes.json)); return 1; }
  const branchId = branchRes.json.data.id;
  pass('create branch');

  // 3. Register + verify + KYC + approve 12 savers
  const saverTokens: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const phone = `+4477002${String(stamp).slice(-3)}${String(i).padStart(2, '0')}`;

    const regRes = await api('POST', '/api/auth/register', {
      body: { phone, password: 'SaverPass1#', fullName: `Payout Saver ${i}`, branchSlug },
    });
    if (regRes.status !== 201) { fail(`register ${i}`, JSON.stringify(regRes.json)); return 1; }

    const verifyRes = await api('POST', '/api/auth/verify-phone', {
      body: { phone, code: DEV_OTP },
    });
    if (verifyRes.status !== 200) { fail(`verify ${i}`, JSON.stringify(verifyRes.json)); return 1; }
    saverTokens.push(verifyRes.json.data.tokens.accessToken);

    const form = new FormData();
    form.append('legalName', `Payout Saver ${i}`);
    form.append('bankName', 'Monzo');
    form.append('accountNumber', `2222${String(i).padStart(4, '0')}`);
    form.append('sortCode', '040004');
    const blob = new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' });
    form.append('selfie', blob, 'selfie.png');
    const kycRes = await fetch(`${BASE}/api/kyc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${verifyRes.json.data.tokens.accessToken}` },
      body: form,
    });
    const kycJson = (await kycRes.json()) as ApiResponse;
    if (kycRes.status !== 201) { fail(`KYC ${i}`, JSON.stringify(kycJson)); return 1; }

    const approveRes = await api('PATCH', `/api/super-admin/kyc/${kycJson.data.id}/approve`, {
      token: superToken,
    });
    if (approveRes.status !== 200) { fail(`approve KYC ${i}`, JSON.stringify(approveRes.json)); return 1; }
  }
  pass('12 savers registered, verified, KYC approved');

  // 4. Find the activated tenant
  const tenantsRes = await api('GET', `/api/super-admin/tenants/by-branch/${branchId}`, {
    token: superToken,
  });
  const tenants = tenantsRes.json.data.tenants as Array<{ id: string; status: string; memberCount: number }>;
  const activeTenant = tenants.find((t) => t.status === 'ACTIVE' && t.memberCount === 12);
  if (!activeTenant) { fail('find ACTIVE tenant', JSON.stringify(tenants)); return 1; }
  pass('tenant activated', activeTenant.id.slice(0, 8));

  // 5. Verify payout + fee intents were auto-generated on activation
  //    Super admin MUST supply ?branchId=<id> on branch-admin routes.
  const payoutsRes = await api(
    'GET',
    `/api/branch-admin/payouts?limit=10&branchId=${branchId}`,
    { token: superToken },
  );
  if (payoutsRes.status !== 200 || !payoutsRes.json.ok) {
    fail('list payouts after activation', JSON.stringify(payoutsRes.json));
    return 1;
  }
  const payouts = payoutsRes.json.data.intents as Array<{
    id: string;
    reference: string;
    state: string;
    grossPence: string;
    netAmountPence: string;
    feeIntentId: string;
    recipientSlot: number;
  }>;
  const cycle1Payout = payouts.find((p) => p.reference.includes('0101'));
  if (!cycle1Payout) {
    fail('cycle-1 payout intent exists', `not found in ${payouts.length} payouts`);
    return 1;
  }
  pass('cycle-1 payout intent auto-generated', cycle1Payout.reference);

  const gross = BigInt(cycle1Payout.grossPence);
  const net = BigInt(cycle1Payout.netAmountPence);
  if (gross !== 1_200_000n) {
    fail('gross amount = £12,000', `got ${gross} pence`);
    return 1;
  }
  pass('gross = £12,000');

  if (cycle1Payout.recipientSlot !== 1) {
    fail('cycle-1 recipient is slot 1', `got slot ${cycle1Payout.recipientSlot}`);
    return 1;
  }
  pass('cycle-1 recipient = slot 1');

  // Slot 1 → TVC -£110, fee 1.5% of £11,890 = £178.35, net = £11,711.65
  if (net !== 1_171_165n) {
    fail('net amount = £11,711.65', `got ${net} pence = £${Number(net) / 100}`);
    return 1;
  }
  pass('net amount = £11,711.65 (slot 1, TVC -£110, fee 1.5%)');

  // 6. Upload fee receipt (via super admin + branchId param)
  const feeReceiptRes = await uploadFile(
    `/api/branch-admin/payouts/fees/${cycle1Payout.feeIntentId}/receipt?branchId=${branchId}`,
    superToken,
    {
      claimedAmount: '17835',
      claimedReference: 'FEEfee12301',
      claimedSenderName: 'Payout Test Branch',
    },
    { buffer: TEST_PNG, filename: 'fee-receipt.png', contentType: 'image/png' },
  );
  if (feeReceiptRes.status !== 201) {
    fail('upload fee receipt', JSON.stringify(feeReceiptRes.json));
    return 1;
  }
  pass('fee receipt uploaded');

  // 7. Super admin confirms fee
  const confirmFeeRes = await api(
    'POST',
    `/api/super-admin/payouts/fees/${cycle1Payout.feeIntentId}/confirm`,
    { token: superToken, body: {} },
  );
  if (confirmFeeRes.status !== 200 || !confirmFeeRes.json.ok) {
    fail('confirm fee', JSON.stringify(confirmFeeRes.json));
    return 1;
  }
  pass('fee confirmed — payout unlocked');
  const unlockedPayout = confirmFeeRes.json.data.payout;
  if (unlockedPayout.state !== 'FEE_PAID') {
    fail('payout state = FEE_PAID', `got ${unlockedPayout.state}`);
    return 1;
  }
  pass('payout state transitioned to FEE_PAID');

  // 8. Upload payout receipt
  const payoutReceiptRes = await uploadFile(
    `/api/branch-admin/payouts/${cycle1Payout.id}/receipt?branchId=${branchId}`,
    superToken,
    {
      claimedAmount: net.toString(),
      claimedReference: cycle1Payout.reference,
      claimedRecipientName: 'Payout Saver 1',
    },
    { buffer: TEST_PNG, filename: 'payout-receipt.png', contentType: 'image/png' },
  );
  if (payoutReceiptRes.status !== 201) {
    fail('upload payout receipt', JSON.stringify(payoutReceiptRes.json));
    return 1;
  }
  pass('payout receipt uploaded');

  // 9. Confirm payout
  const confirmPayoutRes = await api(
    'POST',
    `/api/branch-admin/payouts/${cycle1Payout.id}/confirm?branchId=${branchId}`,
    { token: superToken },
  );
  if (confirmPayoutRes.status !== 200 || !confirmPayoutRes.json.ok) {
    fail('confirm payout', JSON.stringify(confirmPayoutRes.json));
    return 1;
  }
  pass('payout confirmed — ledger debited');

  // 10. Verify tenant ledger has the debit
  const saver1Token = saverTokens[0]!;
  const ledgerRes = await api('GET', '/api/tenants/me/ledger', { token: saver1Token });
  if (ledgerRes.status !== 200 || !ledgerRes.json.ok) {
    fail('tenant ledger', JSON.stringify(ledgerRes.json));
    return 1;
  }
  const ledgerEntries = ledgerRes.json.data as Array<{
    reference: string;
    entryType: string;
    entryKind: string;
    amountGbp: string;
  }>;
  const payoutDebit = ledgerEntries.find(
    (e) => e.reference === cycle1Payout.reference && e.entryType === 'DEBIT',
  );
  if (!payoutDebit) {
    fail('ledger has payout DEBIT', `not found in ${ledgerEntries.length} entries`);
    return 1;
  }
  pass('ledger has payout DEBIT', `£${payoutDebit.amountGbp}`);

  // 11. Verify payout_intent state
  const finalPayoutRes = await api(
    'GET',
    `/api/super-admin/payouts/${cycle1Payout.id}`,
    { token: superToken },
  );
  if (finalPayoutRes.status !== 200 || !finalPayoutRes.json.ok) {
    fail('get final payout state', JSON.stringify(finalPayoutRes.json));
    return 1;
  }
  if (finalPayoutRes.json.data.state !== 'CONFIRMED') {
    fail('payout state = CONFIRMED', `got ${finalPayoutRes.json.data.state}`);
    return 1;
  }
  pass('payout state = CONFIRMED');

  console.log('');
  console.log('============================================');
  console.log('  All payout flow tests passed ✅');
  console.log('============================================');
  console.log('');
  console.log('  To view in Neon:');
  console.log(`  → v_ledger_full: filter reference = ${cycle1Payout.reference}`);
  console.log(`  → payout_intents: filter id = ${cycle1Payout.id}`);
  console.log('');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Test crashed:', err);
    process.exit(2);
  });