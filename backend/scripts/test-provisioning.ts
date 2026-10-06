/**
 * Provisioning end-to-end test.
 *
 * Creates a fresh branch, registers 12 savers, verifies each, submits KYC
 * for each, has super admin approve each. Confirms:
 *   - First 12 savers land in ONE tenant (12 slots filled)
 *   - The 12th approval activates the tenant (status = ACTIVE)
 *   - The 13th saver starts a SECOND tenant (FILLING)
 *
 * Run: yarn test:provisioning
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
  console.error('DEV_OTP_OVERRIDE not set (needs to be "000000")');
  process.exit(1);
}

const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

async function submitKyc(token: string, idx: number): Promise<ApiResponse> {
  const form = new FormData();
  form.append('legalName', `Provision Saver ${idx}`);
  form.append('bankName', 'Monzo');
  form.append('accountNumber', `1234567${String(idx).padStart(1, '0')}`.slice(0, 8));
  form.append('sortCode', '040004');
  const blob = new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' });
  form.append('selfie', blob, 'selfie.png');

  const res = await fetch(`${BASE}/api/kyc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, json: (await res.json()) as ApiResponse };
}

function pass(name: string, detail?: string): void {
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name: string, detail: string): void {
  console.log(`  FAIL  ${name} — ${detail}`);
}

async function main(): Promise<number> {
  const stamp = Date.now();
  const branchSlug = `prov-test-${stamp}`;

  console.log('');
  console.log('============================================');
  console.log('  Provisioning End-to-End Test');
  console.log(`  Base: ${BASE}`);
  console.log(`  Branch: ${branchSlug}`);
  console.log('============================================');
  console.log('');

  // 1. Super admin login
  const loginRes = await api('POST', '/api/auth/login', {
    body: { phone: SUPER_PHONE, password: SUPER_PASSWORD },
  });
  if (loginRes.status !== 200 || !loginRes.json.ok) {
    fail('super admin login', JSON.stringify(loginRes.json));
    return 1;
  }
  const superToken = loginRes.json.data.tokens.accessToken;
  pass('super admin login');

  // 2. Create branch
  const branchRes = await api('POST', '/api/super-admin/branches', {
    token: superToken,
    body: { slug: branchSlug, name: `Prov Test ${stamp}` },
  });
  if (branchRes.status !== 201 || !branchRes.json.ok) {
    fail('create branch', JSON.stringify(branchRes.json));
    return 1;
  }
  const branchId = branchRes.json.data.id;
  pass('create branch');

  // 3. Register + verify + submit KYC + approve 13 savers
  const saverTokens: string[] = [];
  for (let i = 1; i <= 13; i++) {
    const phone = `+4479000${String(stamp).slice(-3)}${String(i).padStart(2, '0')}`;

    // Register
    const regRes = await api('POST', '/api/auth/register', {
      body: {
        phone,
        password: 'SaverPass1#',
        fullName: `Provision Saver ${i}`,
        branchSlug,
      },
    });
    if (regRes.status !== 201) {
      fail(`register saver ${i}`, JSON.stringify(regRes.json));
      return 1;
    }

    // Verify (dev override)
    const verifyRes = await api('POST', '/api/auth/verify-phone', {
      body: { phone, code: DEV_OTP },
    });
    if (verifyRes.status !== 200) {
      fail(`verify saver ${i}`, JSON.stringify(verifyRes.json));
      return 1;
    }
    const saverToken = verifyRes.json.data.tokens.accessToken;
    saverTokens.push(saverToken);

    // Submit KYC
    const kycRes = await submitKyc(saverToken, i);
    if (kycRes.status !== 201) {
      fail(`submit KYC saver ${i}`, JSON.stringify(kycRes.json));
      return 1;
    }
    const submissionId = kycRes.json.data.id;

    // Super admin approves → triggers provisioning
    const approveRes = await api(
      'PATCH',
      `/api/super-admin/kyc/${submissionId}/approve`,
      { token: superToken },
    );
    if (approveRes.status !== 200) {
      fail(`approve KYC saver ${i}`, JSON.stringify(approveRes.json));
      return 1;
    }
  }
  pass('registered + verified + KYC-approved 13 savers');

  // 4. Check the branch's tenants
  const listRes = await api(
    'GET',
    `/api/super-admin/tenants/by-branch/${branchId}`,
    { token: superToken },
  );
  if (listRes.status !== 200 || !listRes.json.ok) {
    fail('list branch tenants', JSON.stringify(listRes.json));
    return 1;
  }
  const tenants = listRes.json.data.tenants as Array<{
    id: string;
    status: string;
    memberCount: number;
  }>;

  if (tenants.length !== 2) {
    fail('expected 2 tenants', `got ${tenants.length}`);
    return 1;
  }
  pass('two tenants exist', `count=${tenants.length}`);

  const active = tenants.find((t) => t.status === 'ACTIVE');
  const filling = tenants.find((t) => t.status === 'FILLING');

  if (!active) {
    fail('one tenant should be ACTIVE', 'none found');
    return 1;
  }
  if (active.memberCount !== 12) {
    fail('ACTIVE tenant should have 12 members', `got ${active.memberCount}`);
    return 1;
  }
  pass('first tenant ACTIVE with 12 members', `id=${active.id.slice(0, 8)}`);

  if (!filling) {
    fail('second tenant should be FILLING', 'none found');
    return 1;
  }
  if (filling.memberCount !== 1) {
    fail('FILLING tenant should have 1 member', `got ${filling.memberCount}`);
    return 1;
  }
  pass('second tenant FILLING with 1 member', `id=${filling.id.slice(0, 8)}`);

  console.log('');
  console.log('============================================');
  console.log('  All provisioning tests passed ✅');
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