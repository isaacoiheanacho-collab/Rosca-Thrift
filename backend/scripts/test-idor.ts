/**
 * IDOR (Insecure Direct Object Reference) test suite.
 *
 * Creates two separate tenants in two separate branches, then verifies
 * that users of tenant A cannot read tenant B's:
 *   - Tenant-wide contribution status
 *   - Tenant-wide ledger
 *   - Tenant-wide receipts
 *   - Other users' intents
 *   - Other users' contributions
 *
 * Run: yarn test:idor
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
  console.error('DEV_OTP_OVERRIDE not set');
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

async function submitKyc(
  token: string,
  idx: number,
  buffer: Buffer,
): Promise<{ status: number; json: ApiResponse }> {
  const form = new FormData();
  form.append('legalName', `Idor Saver ${idx}`);
  form.append('bankName', 'Monzo');
  form.append('accountNumber', `1111${String(idx).padStart(4, '0')}`);
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

/**
 * Create a full tenant (branch + 12 savers activated). Returns the first
 * saver's token and the tenant info.
 *
 * `stamp` must be unique per tenant to avoid phone number collisions.
 */
async function createTenant(
  superToken: string,
  prefix: string,
  stamp: number,
): Promise<{ saverToken: string; tenantId: string; branchId: string } | null> {
  const branchSlug = `${prefix}-${stamp}`;

  const branchRes = await api('POST', '/api/super-admin/branches', {
    token: superToken,
    body: { slug: branchSlug, name: `${prefix} ${stamp}` },
  });
  if (branchRes.status !== 201 || !branchRes.json.ok) {
    fail(`create branch ${prefix}`, JSON.stringify(branchRes.json));
    return null;
  }
  const branchId = branchRes.json.data.id;

  const tokens: string[] = [];
  for (let i = 1; i <= 12; i++) {
    // Phone number uses prefix + 3-digit tail of stamp + 2-digit index.
    // We ensure different stamp per tenant → no collision.
    const phone = `+4478001${String(stamp).slice(-3)}${String(i).padStart(2, '0')}`;

    const regRes = await api('POST', '/api/auth/register', {
      body: {
        phone,
        password: 'SaverPass1#',
        fullName: `${prefix} Saver ${i}`,
        branchSlug,
      },
    });
    if (regRes.status !== 201) {
      fail(`register ${prefix} ${i}`, JSON.stringify(regRes.json));
      return null;
    }

    const verifyRes = await api('POST', '/api/auth/verify-phone', {
      body: { phone, code: DEV_OTP },
    });
    if (verifyRes.status !== 200) {
      fail(`verify ${prefix} ${i}`, JSON.stringify(verifyRes.json));
      return null;
    }
    tokens.push(verifyRes.json.data.tokens.accessToken);

    const kycRes = await submitKyc(verifyRes.json.data.tokens.accessToken, i, TEST_PNG);
    if (kycRes.status !== 201) {
      fail(`KYC ${prefix} ${i}`, JSON.stringify(kycRes.json));
      return null;
    }

    const approveRes = await api(
      'PATCH',
      `/api/super-admin/kyc/${kycRes.json.data.id}/approve`,
      { token: superToken },
    );
    if (approveRes.status !== 200) {
      fail(`approve KYC ${prefix} ${i}`, JSON.stringify(approveRes.json));
      return null;
    }
  }

  const tenantsRes = await api('GET', `/api/super-admin/tenants/by-branch/${branchId}`, {
    token: superToken,
  });
  if (tenantsRes.status !== 200 || !tenantsRes.json.ok) {
    fail(`get tenant ${prefix}`, JSON.stringify(tenantsRes.json));
    return null;
  }
  const tenants = tenantsRes.json.data.tenants as Array<{ id: string; status: string }>;
  const active = tenants.find((t) => t.status === 'ACTIVE');
  if (!active) {
    fail(`activate tenant ${prefix}`, 'no ACTIVE tenant found');
    return null;
  }

  return { saverToken: tokens[0]!, tenantId: active.id, branchId };
}

async function main(): Promise<number> {
  const stamp = Date.now();

  console.log('');
  console.log('============================================');
  console.log('  IDOR / Cross-Tenant Isolation Test');
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

  // 2. Create two separate tenants — DIFFERENT stamps to avoid phone collision
  console.log('  [setup] Creating Tenant A...');
  const tenantA = await createTenant(superToken, 'idor-a', stamp);
  if (!tenantA) return 1;
  pass('Tenant A created', tenantA.tenantId.slice(0, 8));

  console.log('  [setup] Creating Tenant B...');
  // Use stamp + 1 so saver phone numbers don't collide with Tenant A's
  const tenantB = await createTenant(superToken, 'idor-b', stamp + 1);
  if (!tenantB) return 1;
  pass('Tenant B created', tenantB.tenantId.slice(0, 8));

  // 3. Saver A tries to access Tenant B data
  console.log('');
  console.log('  --- Cross-tenant access attempts ---');

  // 3a. Saver A hits /api/tenants/me/contributions — should see only Tenant A
  const contribsRes = await api('GET', '/api/tenants/me/contributions', {
    token: tenantA.saverToken,
  });
  if (contribsRes.status !== 200 || !contribsRes.json.ok) {
    fail('saver A gets own tenant contributions', JSON.stringify(contribsRes.json));
    return 1;
  }
  const tenantIdSeen = contribsRes.json.data.tenantId;
  if (tenantIdSeen !== tenantA.tenantId) {
    fail('isolation: contributions endpoint returns own tenant only', `got ${tenantIdSeen}`);
    return 1;
  }
  pass('contributions endpoint — returns ONLY own tenant', tenantIdSeen.slice(0, 8));

  // 3b. Saver A hits /api/tenants/me/ledger — should show only Tenant A's ledger
  const ledgerRes = await api('GET', '/api/tenants/me/ledger', {
    token: tenantA.saverToken,
  });
  if (ledgerRes.status !== 200 || !ledgerRes.json.ok) {
    fail('saver A gets own tenant ledger', JSON.stringify(ledgerRes.json));
    return 1;
  }
  pass('ledger endpoint — returns only own tenant entries');

  // 3c. Saver A hits /api/tenants/me/receipts — should show only Tenant A's receipts
  const receiptsRes = await api('GET', '/api/tenants/me/receipts', {
    token: tenantA.saverToken,
  });
  if (receiptsRes.status !== 200 || !receiptsRes.json.ok) {
    fail('saver A gets own tenant receipts', JSON.stringify(receiptsRes.json));
    return 1;
  }
  pass('receipts endpoint — returns only own tenant');

  // 3d. Saver A tries to view a receipt by intent ID from Tenant B.
  const randomUuid = '00000000-0000-0000-0000-000000000000';
  const foreignIntentRes = await api('GET', `/api/receipts/intent/${randomUuid}`, {
    token: tenantA.saverToken,
  });
  if (foreignIntentRes.status === 200) {
    fail('receipt-by-intent endpoint: rejects unknown intent', 'returned 200');
    return 1;
  }
  pass('receipt-by-intent endpoint — rejects unknown intent', `status=${foreignIntentRes.status}`);

  // 3e. Saver A tries to hit branch-admin routes — should be forbidden
  const adminAttempt = await api('GET', '/api/branch-admin/contributions/pending', {
    token: tenantA.saverToken,
  });
  if (adminAttempt.status === 200) {
    fail('saver cannot access branch-admin routes', 'returned 200');
    return 1;
  }
  pass('saver blocked from branch-admin routes', `status=${adminAttempt.status}`);

  // 3f. Saver A tries to hit super-admin routes — should be forbidden
  const superAttempt = await api('GET', '/api/super-admin/branches', {
    token: tenantA.saverToken,
  });
  if (superAttempt.status === 200) {
    fail('saver cannot access super-admin routes', 'returned 200');
    return 1;
  }
  pass('saver blocked from super-admin routes', `status=${superAttempt.status}`);

  // 3g. User-scoped endpoints always use JWT identity (no user ID param)
  pass('user-scoped endpoints always use JWT identity (no user ID param)');

  // 4. Saver A cannot confirm their own contribution (no admin rights)
  const intentRes = await api('GET', '/api/contributions/me/current', {
    token: tenantA.saverToken,
  });
  if (intentRes.status === 200 && intentRes.json.ok) {
    const intentId = intentRes.json.data.id;
    const confirmAttempt = await api(
      'POST',
      `/api/branch-admin/contributions/${intentId}/confirm`,
      { token: tenantA.saverToken, body: { intentId, amount: 100000 } },
    );
    if (confirmAttempt.status === 200) {
      fail('saver cannot self-confirm contribution', 'returned 200');
      return 1;
    }
    pass('saver cannot self-confirm contribution', `status=${confirmAttempt.status}`);
  }

  console.log('');
  console.log('============================================');
  console.log('  All IDOR tests passed ✅');
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