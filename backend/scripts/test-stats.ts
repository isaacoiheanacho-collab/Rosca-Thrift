/**
 * Stats E2E test.
 *
 * Verifies:
 *   1. Super admin stats endpoint returns expected shape
 *   2. Super admin monthly volume returns 12 rows
 *   3. Branch admin stats endpoint (using super admin + branchId)
 *   4. Counts increment correctly as events happen
 *
 * Run: yarn test:stats
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
  form.append('legalName', `Stats Saver ${idx}`);
  form.append('bankName', 'Monzo');
  form.append('accountNumber', `5555${String(idx).padStart(4, '0')}`);
  form.append('sortCode', '040004');
  const blob = new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' });
  form.append('selfie', blob, 'selfie.png');
  return apiForm('POST', '/api/kyc', form, token);
}

async function main(): Promise<number> {
  const stamp = Date.now();

  console.log('');
  console.log('============================================');
  console.log('  Stats E2E Test');
  console.log(`  Base: ${BASE}`);
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

  // 2. Get baseline platform stats (before we add anything)
  const baselineRes = await api('GET', '/api/super-admin/stats', { token: superToken });
  if (baselineRes.status !== 200 || !baselineRes.json.ok) {
    fail('baseline platform stats', JSON.stringify(baselineRes.json));
    return 1;
  }
  const baseline = baselineRes.json.data;
  if (
    typeof baseline.branches?.total !== 'number' ||
    typeof baseline.tenants?.total !== 'number' ||
    typeof baseline.members?.total !== 'number'
  ) {
    fail('baseline stats shape', JSON.stringify(baseline));
    return 1;
  }
  pass('baseline platform stats fetched', `branches=${baseline.branches.total}, tenants=${baseline.tenants.total}`);

  // 3. Monthly volume endpoint
  const volumeRes = await api('GET', '/api/super-admin/stats/monthly-volume', {
    token: superToken,
  });
  if (volumeRes.status !== 200 || !Array.isArray(volumeRes.json.data)) {
    fail('monthly volume', JSON.stringify(volumeRes.json));
    return 1;
  }
  if (volumeRes.json.data.length !== 12) {
    fail('monthly volume has 12 rows', `got ${volumeRes.json.data.length}`);
    return 1;
  }
  const firstMonth = volumeRes.json.data[0];
  if (typeof firstMonth.month !== 'string' || !/^\d{4}-\d{2}$/.test(firstMonth.month)) {
    fail('monthly volume row shape', JSON.stringify(firstMonth));
    return 1;
  }
  pass('monthly volume returns 12 rows', `latest=${volumeRes.json.data[11].month}`);

  // 4. Create a branch + 1 saver → verify counts go up
  const branchSlug = `stats-test-${stamp}`;
  const branchRes = await api('POST', '/api/super-admin/branches', {
    token: superToken,
    body: { slug: branchSlug, name: `Stats Test ${stamp}` },
  });
  if (branchRes.status !== 201 || !branchRes.json.ok) {
    fail('create branch', JSON.stringify(branchRes.json));
    return 1;
  }
  const branchId = branchRes.json.data.id;
  pass('create branch');

  // 5. Register + verify + KYC + approve 1 saver
  const phone = `+4477009${String(stamp).slice(-3)}01`;
  await api('POST', '/api/auth/register', {
    body: { phone, password: 'SaverPass1#', fullName: 'Stats Saver 1', branchSlug },
  });
  const verify = await api('POST', '/api/auth/verify-phone', {
    body: { phone, code: DEV_OTP },
  });
  const kyc = await submitKyc(verify.json.data.tokens.accessToken, 1);
  const approve = await api(
    'PATCH',
    `/api/super-admin/kyc/${kyc.json.data.id}/approve`,
    { token: superToken },
  );
  if (approve.status !== 200) {
    fail('approve kyc', JSON.stringify(approve.json));
    return 1;
  }
  pass('1 saver registered + KYC approved');

  // 6. Re-fetch platform stats → should show +1 branch, +1 tenant, +1 member
  const afterRes = await api('GET', '/api/super-admin/stats', { token: superToken });
  const after = afterRes.json.data;

  if (after.branches.total !== baseline.branches.total + 1) {
    fail('branches.total incremented', `before=${baseline.branches.total} after=${after.branches.total}`);
    return 1;
  }
  pass('branches.total incremented', `${baseline.branches.total} → ${after.branches.total}`);

  if (after.tenants.total !== baseline.tenants.total + 1) {
    fail('tenants.total incremented', `before=${baseline.tenants.total} after=${after.tenants.total}`);
    return 1;
  }
  pass('tenants.total incremented', `${baseline.tenants.total} → ${after.tenants.total}`);

  if (after.members.total !== baseline.members.total + 1) {
    fail('members.total incremented', `before=${baseline.members.total} after=${after.members.total}`);
    return 1;
  }
  pass('members.total incremented', `${baseline.members.total} → ${after.members.total}`);

  // 7. Branch-scoped stats (super admin with branchId query param)
  const branchStatsRes = await api(
    'GET',
    `/api/branch-admin/stats?branchId=${branchId}`,
    { token: superToken },
  );
  if (branchStatsRes.status !== 200 || !branchStatsRes.json.ok) {
    fail('branch stats', JSON.stringify(branchStatsRes.json));
    return 1;
  }
  const bs = branchStatsRes.json.data;
  if (bs.tenants.total !== 1) {
    fail('branch tenants.total = 1', `got ${bs.tenants.total}`);
    return 1;
  }
  if (bs.members.total !== 1) {
    fail('branch members.total = 1', `got ${bs.members.total}`);
    return 1;
  }
  pass('branch stats scoped correctly', `tenants=${bs.tenants.total}, members=${bs.members.total}`);

  // 8. Confirm the branch is not counted in another branch's stats
  //    (we can verify by checking a random UUID returns zeroes without error)
  const fakeBranchStatsRes = await api(
    'GET',
    `/api/branch-admin/stats?branchId=00000000-0000-0000-0000-000000000000`,
    { token: superToken },
  );
  // Should be 404 (branch doesn't exist) OR return zeros — either is fine.
  if (fakeBranchStatsRes.status === 200) {
    const fake = fakeBranchStatsRes.json.data;
    if (fake.tenants?.total !== 0 || fake.members?.total !== 0) {
      fail('unknown branch returns zeroes', JSON.stringify(fake));
      return 1;
    }
    pass('unknown branch returns zeroes (no crash)');
  } else if (fakeBranchStatsRes.status === 404) {
    pass('unknown branch returns 404 (no crash)');
  } else {
    fail('unknown branch handles gracefully', `status=${fakeBranchStatsRes.status}`);
    return 1;
  }

  console.log('');
  console.log('============================================');
  console.log('  Stats test passed');
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