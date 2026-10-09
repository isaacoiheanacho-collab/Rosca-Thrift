/**
 * Phase 1.5c — Tenant visibility + admin pending queue test.
 *
 * Runs a fresh full flow:
 *   1. Create a new branch + 12 savers + tenant activation
 *   2. One saver creates intent + uploads receipt (left UNCONFIRMED)
 *   3. Verify super admin pending queue shows it (with receipt attached)
 *   4. Verify the saver can see tenant-wide contributions/ledger/receipts
 *   5. Confirm the contribution and re-check ledger
 *
 * Run: yarn test:visibility
 */

import 'dotenv/config';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001';
const SUPER_PHONE = process.env.SUPER_ADMIN_PHONE;
const SUPER_PASSWORD = process.env.TEST_SUPER_PASSWORD ?? 'SuperAdmin1#';
const DEV_OTP = process.env.DEV_OTP_OVERRIDE;

if (!SUPER_PHONE) {
  console.error('SUPER_ADMIN_PHONE not set');
  process.exit(1);
}
if (!DEV_OTP) {
  console.error('DEV_OTP_OVERRIDE not set (should be "000000")');
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

async function uploadReceipt(
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
  try {
    json = (await res.json()) as ApiResponse;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

async function submitKyc(
  token: string,
  idx: number,
  buffer: Buffer,
): Promise<{ status: number; json: ApiResponse }> {
  const form = new FormData();
  form.append('legalName', `Visibility Saver ${idx}`);
  form.append('bankName', 'Monzo');
  form.append('accountNumber', `9999${String(idx).padStart(4, '0')}`);
  form.append('sortCode', '040004');
  const blob = new Blob([new Uint8Array(buffer)], { type: 'image/png' });
  form.append('selfie', blob, 'selfie.png');

  const res = await fetch(`${BASE}/api/kyc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
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
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name: string, detail: string): void {
  console.log(`  FAIL  ${name} — ${detail}`);
}

async function main(): Promise<number> {
  const stamp = Date.now();
  const branchSlug = `vis-test-${stamp}`;

  console.log('');
  console.log('============================================');
  console.log('  Tenant Visibility & Admin Queue Test');
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
    body: { slug: branchSlug, name: `Visibility Test ${stamp}` },
  });
  if (branchRes.status !== 201 || !branchRes.json.ok) {
    fail('create branch', JSON.stringify(branchRes.json));
    return 1;
  }
  const branchId = branchRes.json.data.id;
  pass('create branch');

  // 3. Register + verify + KYC-approve 12 savers
  const saverTokens: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const phone = `+4477001${String(stamp).slice(-3)}${String(i).padStart(2, '0')}`;

    const regRes = await api('POST', '/api/auth/register', {
      body: {
        phone,
        password: 'SaverPass1#',
        fullName: `Visibility Saver ${i}`,
        branchSlug,
      },
    });
    if (regRes.status !== 201) {
      fail(`register saver ${i}`, JSON.stringify(regRes.json));
      return 1;
    }

    const verifyRes = await api('POST', '/api/auth/verify-phone', {
      body: { phone, code: DEV_OTP },
    });
    if (verifyRes.status !== 200) {
      fail(`verify saver ${i}`, JSON.stringify(verifyRes.json));
      return 1;
    }
    saverTokens.push(verifyRes.json.data.tokens.accessToken);

    const kycRes = await submitKyc(verifyRes.json.data.tokens.accessToken, i, TEST_PNG);
    if (kycRes.status !== 201) {
      fail(`submit KYC saver ${i}`, JSON.stringify(kycRes.json));
      return 1;
    }

    // FIX: access via .json, not .data
    const approveRes = await api(
      'PATCH',
      `/api/super-admin/kyc/${kycRes.json.data.id}/approve`,
      { token: superToken },
    );
    if (approveRes.status !== 200) {
      fail(`approve KYC saver ${i}`, JSON.stringify(approveRes.json));
      return 1;
    }
  }
  pass('12 savers registered + verified + KYC approved');

  // 4. Find the ACTIVE tenant
  const tenantsRes = await api('GET', `/api/super-admin/tenants/by-branch/${branchId}`, {
    token: superToken,
  });
  if (tenantsRes.status !== 200 || !tenantsRes.json.ok) {
    fail('list tenants', JSON.stringify(tenantsRes.json));
    return 1;
  }
  const tenants = tenantsRes.json.data.tenants as Array<{
    id: string;
    status: string;
    memberCount: number;
  }>;
  const activeTenant = tenants.find((t) => t.status === 'ACTIVE' && t.memberCount === 12);
  if (!activeTenant) {
    fail('find ACTIVE tenant', JSON.stringify(tenants));
    return 1;
  }
  pass('tenant activated', activeTenant.id.slice(0, 8));

  // 5. Saver 1 creates intent + uploads receipt — LEAVE UNCONFIRMED
  const saver1Token = saverTokens[0]!;
  const intentRes = await api('GET', '/api/contributions/me/current', { token: saver1Token });
  if (intentRes.status !== 200 || !intentRes.json.ok) {
    fail('saver gets intent', JSON.stringify(intentRes.json));
    return 1;
  }
  const intent = intentRes.json.data;
  pass('saver got intent', intent.reference);

  const receiptRes = await uploadReceipt(
    '/api/contributions/me/receipt',
    saver1Token,
    {
      intentId: intent.id,
      claimedAmount: '100000',
      claimedReference: intent.reference,
      claimedSenderName: 'Visibility Saver 1',
    },
    { buffer: TEST_PNG, filename: 'receipt.png', contentType: 'image/png' },
  );
  if (receiptRes.status !== 201) {
    fail('upload receipt', JSON.stringify(receiptRes.json));
    return 1;
  }
  pass('receipt uploaded (pending)');

  // 6. Super admin pending queue should show it, with receipt attached
  const pendingRes = await api(
    'GET',
    '/api/branch-admin/contributions/pending?limit=50',
    { token: superToken },
  );
  if (pendingRes.status !== 200 || !pendingRes.json.ok) {
    fail('pending queue', JSON.stringify(pendingRes.json));
    return 1;
  }
  const pending = pendingRes.json.data.intents as Array<{
    reference: string;
    receipt: unknown;
  }>;
  const foundPending = pending.find((p) => p.reference === intent.reference);
  if (!foundPending) {
    fail('pending queue contains intent', `not found in ${pending.length} pending`);
    return 1;
  }
  if (!foundPending.receipt) {
    fail('pending queue has receipt attached', 'receipt was null');
    return 1;
  }
  pass('pending queue has intent with receipt attached');

  // 7. Saver 1 sees tenant-wide contribution status
  const contribsRes = await api('GET', '/api/tenants/me/contributions', { token: saver1Token });
  if (contribsRes.status !== 200 || !contribsRes.json.ok) {
    fail('tenant contributions view', JSON.stringify(contribsRes.json));
    return 1;
  }
  const members = contribsRes.json.data.members as Array<{
    slotNumber: number;
    intentState: string | null;
    hasReceipt: boolean;
  }>;
  if (members.length !== 12) {
    fail('tenant contributions view has 12 members', `got ${members.length}`);
    return 1;
  }
  const memberWithReceipt = members.find((m) => m.hasReceipt);
  if (!memberWithReceipt) {
    fail('tenant contributions view shows receipt flag', 'no member flagged');
    return 1;
  }
  pass('tenant contributions view — 12 members, receipt visible');

  // 8. Saver 1 sees tenant receipts gallery
  const receiptsRes = await api('GET', '/api/tenants/me/receipts', { token: saver1Token });
  if (receiptsRes.status !== 200 || !receiptsRes.json.ok) {
    fail('tenant receipts view', JSON.stringify(receiptsRes.json));
    return 1;
  }
  const receiptsList = receiptsRes.json.data as unknown[];
  if (receiptsList.length < 1) {
    fail('tenant receipts view has entries', `got ${receiptsList.length}`);
    return 1;
  }
  pass('tenant receipts view', `count=${receiptsList.length}`);

  // 9. Saver 1 sees tenant ledger (empty so far — receipt unconfirmed)
  const ledgerRes = await api('GET', '/api/tenants/me/ledger', { token: saver1Token });
  if (ledgerRes.status !== 200 || !ledgerRes.json.ok) {
    fail('tenant ledger view', JSON.stringify(ledgerRes.json));
    return 1;
  }
  pass('tenant ledger view works');

  // 10. Confirm contribution then re-check ledger
  const confirmRes = await api(
    'POST',
    `/api/branch-admin/contributions/${intent.id}/confirm`,
    { token: superToken, body: { intentId: intent.id, amount: 100000 } },
  );
  if (confirmRes.status !== 200 || !confirmRes.json.ok) {
    fail('confirm contribution', JSON.stringify(confirmRes.json));
    return 1;
  }
  pass('contribution confirmed');

  const ledger2Res = await api('GET', '/api/tenants/me/ledger', { token: saver1Token });
  if (ledger2Res.status !== 200 || !ledger2Res.json.ok) {
    fail('ledger view after confirm', JSON.stringify(ledger2Res.json));
    return 1;
  }
  const ledgerEntries = ledger2Res.json.data as Array<{
    reference: string;
    entryType: string;
    amountGbp: string;
  }>;
  const foundLedger = ledgerEntries.find((e) => e.reference === intent.reference);
  if (!foundLedger) {
    fail('ledger shows contribution after confirm', `not found in ${ledgerEntries.length} entries`);
    return 1;
  }
  pass('ledger shows contribution', `${foundLedger.entryType} £${foundLedger.amountGbp}`);

  console.log('');
  console.log('============================================');
  console.log('  All visibility tests passed ✅');
  console.log('============================================');
  console.log('');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Test crashed:', err);
    process.exit(2);
  });