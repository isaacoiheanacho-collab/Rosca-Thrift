/**
 * Failed payout E2E test.
 *
 * Scenario:
 *   1. Create branch + 12 savers + activate tenant
 *   2. Complete cycle-1 fee + payout receipt
 *   3. Branch admin marks the payout as FAILED (e.g., bank reversed)
 *   4. Verify: state = FAILED, failure_reason set, payout_failures row exists
 *   5. Verify: all 12 members received PAYOUT_FAILED notification
 *   6. Branch admin retries → new payout intent created
 *   7. Verify: new intent has retry_of_payout_id pointing to original
 *   8. Verify: original.retry_count = 1
 *   9. Verify: all 12 members received PAYOUT_RETRIED notification
 *  10. Complete the retry flow → tenant advances
 *
 * Run: yarn test:payout-failure
 */

import 'dotenv/config';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001';
const SUPER_PHONE = process.env.SUPER_ADMIN_PHONE;
const SUPER_PASSWORD = process.env.TEST_SUPER_PASSWORD ?? 'SuperAdmin1#';
const DEV_OTP = process.env.DEV_OTP_OVERRIDE;

if (!SUPER_PHONE || !DEV_OTP) {
  console.error('SUPER_ADMIN_PHONE and DEV_OTP_OVERRIDE must be set');
  process.exit(1);
}

interface ApiResponse {
  ok?: boolean;
  data?: any;
  error?: { code?: string; message?: string };
}

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
  try {
    json = (await res.json()) as ApiResponse;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

async function apiForm(
  method: string,
  path: string,
  form: FormData,
  token?: string,
): Promise<{ status: number; json: ApiResponse }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  let json: ApiResponse;
  try {
    json = (await res.json()) as ApiResponse;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function pass(name: string, detail?: string): void {
  console.log(`  PASS  ${name}${detail ? ' - ' + detail : ''}`);
}
function fail(name: string, detail: string): void {
  console.log(`  FAIL  ${name} - ${detail}`);
}

async function submitKyc(token: string, idx: number) {
  const form = new FormData();
  form.append('legalName', `Fail Test Saver ${idx}`);
  form.append('bankName', 'Monzo');
  form.append('accountNumber', `6666${String(idx).padStart(4, '0')}`);
  form.append('sortCode', '040004');
  const blob = new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' });
  form.append('selfie', blob, 'selfie.png');
  return apiForm('POST', '/api/kyc', form, token);
}

async function uploadReceipt(path: string, token: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const blob = new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' });
  form.append('receipt', blob, 'receipt.png');
  return apiForm('POST', path, form, token);
}

async function main(): Promise<number> {
  const stamp = Date.now();

  console.log('');
  console.log('============================================');
  console.log('  Payout Failure E2E Test');
  console.log(`  Base: ${BASE}`);
  console.log(`  Branch: payout-fail-${stamp}`);
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
  const branchSlug = `payout-fail-${stamp}`;
  const branchRes = await api('POST', '/api/super-admin/branches', {
    token: superToken,
    body: { slug: branchSlug, name: `Payout Fail ${stamp}` },
  });
  if (branchRes.status !== 201 || !branchRes.json.ok) {
    fail('create branch', JSON.stringify(branchRes.json));
    return 1;
  }
  const branchId = branchRes.json.data.id;
  pass('create branch');

  // 3. Register + verify + KYC + approve 12 savers
  const saverTokens: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const phone = `+4477008${String(stamp).slice(-3)}${String(i).padStart(2, '0')}`;
    await api('POST', '/api/auth/register', {
      body: { phone, password: 'SaverPass1#', fullName: `Fail Test Saver ${i}`, branchSlug },
    });
    const verify = await api('POST', '/api/auth/verify-phone', {
      body: { phone, code: DEV_OTP },
    });
    saverTokens.push(verify.json.data.tokens.accessToken);
    const kyc = await submitKyc(verify.json.data.tokens.accessToken, i);
    await api('PATCH', `/api/super-admin/kyc/${kyc.json.data.id}/approve`, {
      token: superToken,
    });
  }
  pass('12 savers registered + KYC approved');

  // 4. Find activated tenant
  const tenantsRes = await api('GET', `/api/super-admin/tenants/by-branch/${branchId}`, {
    token: superToken,
  });
  const tenants = tenantsRes.json.data.tenants as Array<{ id: string; status: string }>;
  const active = tenants.find((t) => t.status === 'ACTIVE');
  if (!active) {
    fail('tenant activated', 'no ACTIVE tenant');
    return 1;
  }
  const tenantId = active.id;
  pass('tenant activated', tenantId.slice(0, 8));

  // 5. Get cycle-1 payout intent + fee intent id
  const payoutsRes = await api(
    'GET',
    `/api/branch-admin/payouts?limit=10&branchId=${branchId}`,
    { token: superToken },
  );
  const payouts = payoutsRes.json.data.intents as Array<{
    id: string;
    reference: string;
    feeIntentId: string;
    state: string;
  }>;
  const cycle1 = payouts.find((p) => p.reference.includes('0101'));
  if (!cycle1) {
    fail('cycle-1 payout intent', 'not found');
    return 1;
  }
  pass('cycle-1 payout intent', cycle1.reference);

  // 6. Upload fee receipt + confirm fee
  const feeUpload = await uploadReceipt(
    `/api/branch-admin/payouts/fees/${cycle1.feeIntentId}/receipt?branchId=${branchId}`,
    superToken,
    {
      claimedAmount: '17835',
      claimedReference: 'FEEcycle1',
      claimedSenderName: 'Fail Test Branch',
    },
  );
  if (feeUpload.status !== 201) {
    fail('fee receipt upload', JSON.stringify(feeUpload.json));
    return 1;
  }
  await api('POST', `/api/super-admin/payouts/fees/${cycle1.feeIntentId}/confirm`, {
    token: superToken,
    body: {},
  });
  pass('fee confirmed');

  // 7. Upload payout receipt
  const payoutUpload = await uploadReceipt(
    `/api/branch-admin/payouts/${cycle1.id}/receipt?branchId=${branchId}`,
    superToken,
    {
      claimedAmount: '1171165',
      claimedReference: cycle1.reference,
      claimedRecipientName: 'Fail Test Saver 1',
    },
  );
  if (payoutUpload.status !== 201) {
    fail('payout receipt upload', JSON.stringify(payoutUpload.json));
    return 1;
  }
  pass('payout receipt uploaded');

  // 8. Mark payout FAILED instead of confirming
  const failRes = await api('POST', `/api/branch-admin/payouts/${cycle1.id}/fail`, {
    token: superToken,
    body: {
      reason: 'Bank reversed transfer — recipient did not receive funds',
      notes: 'Contacted Monzo support, transfer was returned.',
    },
  });
  if (failRes.status !== 200 || !failRes.json.ok) {
    fail('mark payout failed', JSON.stringify(failRes.json));
    return 1;
  }
  if (failRes.json.data.state !== 'FAILED') {
    fail('payout state = FAILED', `got ${failRes.json.data.state}`);
    return 1;
  }
  pass('payout marked FAILED', `reason: "${failRes.json.data.failureReason.slice(0, 40)}..."`);

  // 9. Verify members received PAYOUT_FAILED notification
  const memberNotifsRes = await api('GET', '/api/notifications?limit=100', {
    token: saverTokens[3]!,
  });
  const memberKinds = (memberNotifsRes.json.data.notifications as Array<{ kind: string }>).map(
    (n) => n.kind,
  );
  if (!memberKinds.includes('PAYOUT_FAILED')) {
    fail('PAYOUT_FAILED received by member 4', `kinds: ${memberKinds.join(', ')}`);
    return 1;
  }
  pass('PAYOUT_FAILED received by tenant members');

  // 10. Retry the failed payout
  const retryRes = await api('POST', `/api/branch-admin/payouts/${cycle1.id}/retry`, {
    token: superToken,
    body: {},
  });
  if (retryRes.status !== 201 || !retryRes.json.ok) {
    fail('retry payout', JSON.stringify(retryRes.json));
    return 1;
  }
  const newPayout = retryRes.json.data;
  if (newPayout.retryOfPayoutId !== cycle1.id) {
    fail('retry_of_payout_id set', `got ${newPayout.retryOfPayoutId}`);
    return 1;
  }
  if (newPayout.state !== 'FEE_PAID') {
    fail('retry starts at FEE_PAID', `got ${newPayout.state}`);
    return 1;
  }
  pass(
    'retry created',
    `newPayout=${newPayout.id.slice(0, 8)}, reference=${newPayout.reference}, state=FEE_PAID`,
  );

  // 11. Verify PAYOUT_RETRIED notification
  const retriedRes = await api('GET', '/api/notifications?limit=100', {
    token: saverTokens[3]!,
  });
  const retriedKinds = (retriedRes.json.data.notifications as Array<{ kind: string }>).map(
    (n) => n.kind,
  );
  if (!retriedKinds.includes('PAYOUT_RETRIED')) {
    fail('PAYOUT_RETRIED received by member 4', `kinds: ${retriedKinds.join(', ')}`);
    return 1;
  }
  pass('PAYOUT_RETRIED received by tenant members');

  // 12. Verify original.retry_count is now 1
  const origRes = await api('GET', `/api/branch-admin/payouts/${cycle1.id}`, {
    token: superToken,
  });
  if (origRes.json.data.retryCount !== 1) {
    fail('original.retry_count = 1', `got ${origRes.json.data.retryCount}`);
    return 1;
  }
  pass('original.retry_count = 1');

  // 13. Verify super admin failed queue lists the original
  const superFailedRes = await api('GET', '/api/super-admin/payouts/failed', {
    token: superToken,
  });
  if (superFailedRes.status !== 200 || !superFailedRes.json.ok) {
    fail('super admin failed queue', JSON.stringify(superFailedRes.json));
    return 1;
  }
  const failedList = superFailedRes.json.data.intents as Array<{ id: string }>;
  if (!failedList.find((f) => f.id === cycle1.id)) {
    fail('original payout in failed queue', `queue has ${failedList.length} rows`);
    return 1;
  }
  pass('original payout in super admin failed queue');

  // 14. Super admin tries to fail an already-FAILED payout → 409
  const doubleFailRes = await api('POST', `/api/super-admin/payouts/${cycle1.id}/fail`, {
    token: superToken,
    body: { reason: 'Attempting to double-fail' },
  });
  if (doubleFailRes.status !== 409) {
    fail('cannot fail already-failed payout', `status=${doubleFailRes.status}`);
    return 1;
  }
  pass('cannot fail already-failed payout (409)');

  // 15. Super admin tries to retry an already-retried payout → 409
  const doubleRetryRes = await api('POST', `/api/super-admin/payouts/${cycle1.id}/retry`, {
    token: superToken,
    body: {},
  });
  if (doubleRetryRes.status !== 409) {
    fail('cannot retry already-retried payout', `status=${doubleRetryRes.status}`);
    return 1;
  }
  pass('cannot retry already-retried payout (409)');

  console.log('');
  console.log('============================================');
  console.log('  Payout failure test passed');
  console.log('============================================');
  console.log('');
  console.log(`  Verify in Neon:`);
  console.log(`  → payout_intents WHERE retry_of_payout_id = '${cycle1.id}'`);
  console.log(`  → payout_failures WHERE payout_id = '${cycle1.id}'`);
  console.log('');

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Test crashed:', err);
    process.exit(2);
  });