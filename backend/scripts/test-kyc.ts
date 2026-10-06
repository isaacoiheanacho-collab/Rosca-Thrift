/**
 * KYC end-to-end test.
 *
 * Flow:
 *   1. Log in as SUPER_ADMIN
 *   2. Create a test branch
 *   3. Register + verify a test saver on that branch (using dev OTP override)
 *   4. Saver submits KYC with a small generated test image
 *   5. Saver checks their own status
 *   6. Super Admin lists pending submissions
 *   7. Super Admin approves
 *   8. Saver sees status = APPROVED
 *
 * Run with: yarn test:kyc
 */

import 'dotenv/config';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001';
const SUPER_PHONE = process.env.SUPER_ADMIN_PHONE;
const SUPER_PASSWORD = process.env.TEST_SUPER_PASSWORD ?? 'SuperAdmin1#';

if (!SUPER_PHONE) {
  console.error('SUPER_ADMIN_PHONE is not set in .env');
  process.exit(1);
}

interface ApiResponse {
  ok?: boolean;
  data?: unknown;
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

async function apiMultipart(
  path: string,
  token: string,
  fields: Record<string, string>,
  file: { fieldName: string; filename: string; contentType: string; buffer: Buffer },
): Promise<{ status: number; json: ApiResponse }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);

  const blob = new Blob([new Uint8Array(file.buffer)], { type: file.contentType });
  form.append(file.fieldName, blob, file.filename);

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

function pass(name: string, detail?: string): void {
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name: string, detail: string): void {
  console.log(`  FAIL  ${name} — ${detail}`);
}

// Tiny 1x1 transparent PNG. Real image, tiny payload.
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function main(): Promise<number> {
  const stamp = Date.now();
  const branchSlug = `test-branch-${stamp}`;
  const saverPhone = `+4479000${String(stamp).slice(-5)}`; // fake UK number, we won't verify via SMS

  console.log('');
  console.log('============================================');
  console.log('  KYC End-to-End Test');
  console.log(`  Base:   ${BASE}`);
  console.log(`  Branch: ${branchSlug}`);
  console.log('============================================');
  console.log('');

  // 1. Log in as SUPER_ADMIN
  const loginRes = await api('POST', '/api/auth/login', {
    body: { phone: SUPER_PHONE, password: SUPER_PASSWORD },
  });
  if (loginRes.status !== 200 || !loginRes.json.ok) {
    fail('super admin login', JSON.stringify(loginRes.json));
    return 1;
  }
  const superToken = (loginRes.json.data as { tokens: { accessToken: string } }).tokens.accessToken;
  pass('super admin login');

  // 2. Create test branch
  const branchRes = await api('POST', '/api/super-admin/branches', {
    token: superToken,
    body: { slug: branchSlug, name: `Test Branch ${stamp}` },
  });
  if (branchRes.status !== 201 || !branchRes.json.ok) {
    fail('create branch', JSON.stringify(branchRes.json));
    return 1;
  }
  const branchId = (branchRes.json.data as { id: string }).id;
  pass('create branch', branchSlug);

  // 3. Register saver (uses dev OTP override '000000' if set; otherwise we need real OTP)
  const regRes = await api('POST', '/api/auth/register', {
    body: {
      phone: saverPhone,
      password: 'SaverPass1#',
      fullName: 'KYC Test Saver',
      branchSlug,
    },
  });
  if (regRes.status !== 201 || !regRes.json.ok) {
    fail('register saver', JSON.stringify(regRes.json));
    return 1;
  }
  pass('register saver', saverPhone);

  // 4. Verify saver's phone using DEV_OTP_OVERRIDE
  const devOverride = process.env.DEV_OTP_OVERRIDE;
  if (!devOverride) {
    console.log('');
    console.log('  DEV_OTP_OVERRIDE is not set in .env.');
    console.log('  Set DEV_OTP_OVERRIDE=000000 and restart the server, then re-run.');
    console.log(`  Or verify ${saverPhone} manually with the code from the server log.`);
    return 1;
  }
  const verifyRes = await api('POST', '/api/auth/verify-phone', {
    body: { phone: saverPhone, code: devOverride },
  });
  if (verifyRes.status !== 200 || !verifyRes.json.ok) {
    fail('verify saver phone', JSON.stringify(verifyRes.json));
    return 1;
  }
  const saverToken = (verifyRes.json.data as { tokens: { accessToken: string } }).tokens
    .accessToken;
  pass('verify saver phone');

  // 5. Saver submits KYC
  const kycRes = await apiMultipart(
    '/api/kyc',
    saverToken,
    {
      legalName: 'KYC Test Saver',
      bankName: 'Monzo',
      accountNumber: '12345678',
      sortCode: '040004',
    },
    {
      fieldName: 'selfie',
      filename: 'selfie.png',
      contentType: 'image/png',
      buffer: TEST_PNG,
    },
  );
  if (kycRes.status !== 201 || !kycRes.json.ok) {
    fail('saver submits KYC', JSON.stringify(kycRes.json));
    return 1;
  }
  const submission = kycRes.json.data as { id: string; status: string; selfieUrl: string };
  pass('saver submits KYC', `id=${submission.id}, status=${submission.status}`);

  // 6. Saver views own status
  const myRes = await api('GET', '/api/kyc/me', { token: saverToken });
  if (myRes.status !== 200 || !myRes.json.ok) {
    fail('saver view own status', JSON.stringify(myRes.json));
    return 1;
  }
  pass('saver views own status');

  // 7. Super Admin lists pending
  const listRes = await api('GET', '/api/super-admin/kyc?status=PENDING', { token: superToken });
  if (listRes.status !== 200 || !listRes.json.ok) {
    fail('super admin list pending', JSON.stringify(listRes.json));
    return 1;
  }
  const listData = listRes.json.data as { submissions: { id: string }[]; total: number };
  const found = listData.submissions.find((s) => s.id === submission.id);
  if (!found) {
    fail('super admin list pending', `submission ${submission.id} not in list`);
    return 1;
  }
  pass('super admin lists pending', `${listData.total} total`);

  // 8. Super Admin approves
  const approveRes = await api('PATCH', `/api/super-admin/kyc/${submission.id}/approve`, {
    token: superToken,
  });
  if (approveRes.status !== 200 || !approveRes.json.ok) {
    fail('super admin approves', JSON.stringify(approveRes.json));
    return 1;
  }
  pass('super admin approves');

  // 9. Saver re-checks status
  const checkRes = await api('GET', '/api/kyc/me', { token: saverToken });
  if (checkRes.status !== 200 || !checkRes.json.ok) {
    fail('saver re-checks status', JSON.stringify(checkRes.json));
    return 1;
  }
  const checkData = checkRes.json.data as { status: string } | null;
  if (!checkData || checkData.status !== 'APPROVED') {
    fail('saver sees APPROVED', `got status=${checkData?.status}`);
    return 1;
  }
  pass('saver sees APPROVED');

  console.log('');
  console.log('============================================');
  console.log('  All KYC tests passed ✅');
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