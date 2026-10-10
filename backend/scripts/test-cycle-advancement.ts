/**
 * Cycle advancement end-to-end test.
 *
 * Runs a fresh branch + tenant, completes cycle 1, and verifies that the
 * tenant is automatically advanced to cycle 2 with new payout + fee intents.
 *
 * Also verifies idempotency: running the advancement twice has no effect.
 *
 * Run: yarn test:cycle-advance
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
  const branchSlug = `cycle-test-${stamp}`;

  console.log('');
  console.log('============================================');
  console.log('  Cycle Advancement E2E Test');
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
    body: { slug: branchSlug, name: `Cycle Test ${stamp}` },
  });
  if (branchRes.status !== 201) { fail('create branch', JSON.stringify(branchRes.json)); return 1; }
  const branchId = branchRes.json.data.id;
  pass('create branch');

  // 3. Register + verify + KYC + approve 12 savers
  const saverTokens: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const phone = `+4478003${String(stamp).slice(-3)}${String(i).padStart(2, '0')}`;

    const regRes = await api('POST', '/api/auth/register', {
      body: { phone, password: 'SaverPass1#', fullName: `Cycle Saver ${i}`, branchSlug },
    });
    if (regRes.status !== 201) { fail(`register ${i}`, JSON.stringify(regRes.json)); return 1; }

    const verifyRes = await api('POST', '/api/auth/verify-phone', {
      body: { phone, code: DEV_OTP },
    });
    if (verifyRes.status !== 200) { fail(`verify ${i}`, JSON.stringify(verifyRes.json)); return 1; }
    saverTokens.push(verifyRes.json.data.tokens.accessToken);

    const form = new FormData();
    form.append('legalName', `Cycle Saver ${i}`);
    form.append('bankName', 'Monzo');
    form.append('accountNumber', `3333${String(i).padStart(4, '0')}`);
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

  // 5. Verify cycle-1 payout intent exists
  const payoutsRes1 = await api(
    'GET',
    `/api/branch-admin/payouts?limit=10&branchId=${branchId}`,
    { token: superToken },
  );
  if (payoutsRes1.status !== 200 || !payoutsRes1.json.ok) {
    fail('list payouts (cycle 1)', JSON.stringify(payoutsRes1.json));
    return 1;
  }
  const payouts1 = payoutsRes1.json.data.intents as Array<{
    id: string;
    reference: string;
    state: string;
    feeIntentId: string;
  }>;
  const cycle1Payout = payouts1.find((p) => p.reference.includes('0101'));
  if (!cycle1Payout) {
    fail('cycle-1 payout intent exists', `not found`);
    return 1;
  }
  pass('cycle-1 payout intent exists', cycle1Payout.reference);

  // 6. Complete cycle 1: fee → payout
  // Upload fee receipt
  const feeReceiptRes = await uploadFile(
    `/api/branch-admin/payouts/fees/${cycle1Payout.feeIntentId}/receipt?branchId=${branchId}`,
    superToken,
    {
      claimedAmount: '17835',
      claimedReference: 'FEEcycle1',
      claimedSenderName: 'Cycle Test Branch',
    },
    { buffer: TEST_PNG, filename: 'fee-receipt.png', contentType: 'image/png' },
  );
  if (feeReceiptRes.status !== 201) { fail('fee receipt upload', JSON.stringify(feeReceiptRes.json)); return 1; }
  pass('fee receipt uploaded');

  // Confirm fee
  const confirmFeeRes = await api(
    'POST',
    `/api/super-admin/payouts/fees/${cycle1Payout.feeIntentId}/confirm`,
    { token: superToken, body: {} },
  );
  if (confirmFeeRes.status !== 200) { fail('fee confirm', JSON.stringify(confirmFeeRes.json)); return 1; }
  pass('fee confirmed');

  // Upload payout receipt
  const payoutReceiptRes = await uploadFile(
    `/api/branch-admin/payouts/${cycle1Payout.id}/receipt?branchId=${branchId}`,
    superToken,
    {
      claimedAmount: '1171165',
      claimedReference: cycle1Payout.reference,
      claimedRecipientName: 'Cycle Saver 1',
    },
    { buffer: TEST_PNG, filename: 'payout-receipt.png', contentType: 'image/png' },
  );
  if (payoutReceiptRes.status !== 201) { fail('payout receipt upload', JSON.stringify(payoutReceiptRes.json)); return 1; }
  pass('payout receipt uploaded');

  // Confirm payout → triggers advancement
  const confirmPayoutRes = await api(
    'POST',
    `/api/branch-admin/payouts/${cycle1Payout.id}/confirm?branchId=${branchId}`,
    { token: superToken },
  );
  if (confirmPayoutRes.status !== 200) { fail('payout confirm', JSON.stringify(confirmPayoutRes.json)); return 1; }
  pass('payout confirmed — advancement should have been triggered');

  // 7. Verify tenant advanced to cycle 2
  const afterRes = await api('GET', `/api/super-admin/tenants/by-branch/${branchId}`, {
    token: superToken,
  });
  const tenantsAfter = afterRes.json.data.tenants as Array<{
    id: string;
    status: string;
    memberCount: number;
    currentCycle?: number;
  }>;
  const tenantAfter = tenantsAfter.find((t) => t.id === activeTenant.id);
  if (!tenantAfter) { fail('tenant still exists', 'not found'); return 1; }

  // currentCycle may not be in the DTO. Let's check via the raw list.
  // The super-admin tenants DTO (from earlier phases) doesn't include
  // currentCycle — we need to hit the payouts list again to see if cycle-2
  // intents were generated.
  const payoutsRes2 = await api(
    'GET',
    `/api/branch-admin/payouts?limit=10&branchId=${branchId}`,
    { token: superToken },
  );
  const payouts2 = payoutsRes2.json.data.intents as Array<{
    id: string;
    reference: string;
    state: string;
    recipientSlot: number;
  }>;
  const cycle2Payout = payouts2.find((p) => p.reference.includes('0102'));
  if (!cycle2Payout) {
    fail(
      'cycle-2 payout intent exists',
      `not found among ${payouts2.length} payouts. References: ${payouts2.map((p) => p.reference).join(', ')}`,
    );
    return 1;
  }
  pass('cycle-2 payout intent auto-generated', cycle2Payout.reference);

  if (cycle2Payout.recipientSlot !== 2) {
    fail('cycle-2 recipient = slot 2', `got slot ${cycle2Payout.recipientSlot}`);
    return 1;
  }
  pass('cycle-2 recipient = slot 2 (correct rotation)');

  if (cycle2Payout.state !== 'PENDING') {
    fail('cycle-2 payout state = PENDING', `got ${cycle2Payout.state}`);
    return 1;
  }
  pass('cycle-2 payout is PENDING (awaiting next cycle)');

  // 8. Idempotency check — lazy advancement on dashboard load should NOT
  //    create a third cycle or duplicate intents.
  const beforeCount = payouts2.length;
  const _lazyRes = await api('GET', '/api/tenants/me', { token: saverTokens[0]! });
  const payoutsRes3 = await api(
    'GET',
    `/api/branch-admin/payouts?limit=10&branchId=${branchId}`,
    { token: superToken },
  );
  const payouts3 = payoutsRes3.json.data.intents as unknown[];
  if (payouts3.length !== beforeCount) {
    fail('idempotency: no duplicate intents after lazy trigger', `before=${beforeCount}, after=${payouts3.length}`);
    return 1;
  }
  pass('idempotency: no duplicate intents after lazy trigger');

  console.log('');
  console.log('============================================');
  console.log('  Cycle advancement test passed ✅');
  console.log('============================================');
  console.log('');
  console.log('  Verify in Neon:');
  console.log(`  → tenant_id = ${activeTenant.id}`);
  console.log(`  → payout_intents WHERE tenant_id = '${activeTenant.id}'`);
  console.log('  Should show 2 rows: cycle 1 (CONFIRMED) + cycle 2 (PENDING)');
  console.log('');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Test crashed:', err);
    process.exit(2);
  });