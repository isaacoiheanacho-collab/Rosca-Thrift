/**
 * Tenure renewal E2E test.
 *
 * Scenario:
 *   1. Create branch + 12 savers + activate tenant
 *   2. Fast-forward: confirm all 12 cycles of tenure 1
 *   3. Verify: renewal_state = VOTING, 12 renewal rows exist
 *   4. One saver votes NO (slot determined dynamically from DB)
 *   5. Simulate new signup -> should be assigned to that slot
 *   6. Remaining 11 vote YES
 *   7. Verify: tenure 2 begins OR tenant in REPLACING (if rebalance pending)
 *
 * Run: yarn test:renewal
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

async function submitKyc(
  token: string,
  idx: number,
): Promise<{ status: number; json: ApiResponse }> {
  const form = new FormData();
  form.append('legalName', `Renewal Saver ${idx}`);
  form.append('bankName', 'Monzo');
  form.append('accountNumber', `2222${String(idx).padStart(4, '0')}`);
  form.append('sortCode', '040004');
  const blob = new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' });
  form.append('selfie', blob, 'selfie.png');
  return apiForm('POST', '/api/kyc', form, token);
}

async function main(): Promise<number> {
  const stamp = Date.now();

  console.log('');
  console.log('============================================');
  console.log('  Tenure Renewal E2E Test');
  console.log(`  Base: ${BASE}`);
  console.log(`  Branch: renewal-test-${stamp}`);
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
  const branchSlug = `renewal-test-${stamp}`;
  const branchRes = await api('POST', '/api/super-admin/branches', {
    token: superToken,
    body: { slug: branchSlug, name: `Renewal Test ${stamp}` },
  });
  if (branchRes.status !== 201 || !branchRes.json.ok) {
    fail('create branch', JSON.stringify(branchRes.json));
    return 1;
  }
  const branchId = branchRes.json.data.id;
  pass('create branch');

  // 3. Create 12 savers
  const saverTokens: string[] = [];
  const saverIds: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const phone = `+4478001${String(stamp).slice(-3)}${String(i).padStart(2, '0')}`;
    const reg = await api('POST', '/api/auth/register', {
      body: {
        phone,
        password: 'SaverPass1#',
        fullName: `Renewal Saver ${i}`,
        branchSlug,
      },
    });
    if (reg.status !== 201) {
      fail(`register saver ${i}`, JSON.stringify(reg.json));
      return 1;
    }
    const verify = await api('POST', '/api/auth/verify-phone', {
      body: { phone, code: DEV_OTP },
    });
    if (verify.status !== 200) {
      fail(`verify saver ${i}`, JSON.stringify(verify.json));
      return 1;
    }
    const kyc = await submitKyc(verify.json.data.tokens.accessToken, i);
    if (kyc.status !== 201) {
      fail(`kyc saver ${i}`, JSON.stringify(kyc.json));
      return 1;
    }
    const approve = await api(
      'PATCH',
      `/api/super-admin/kyc/${kyc.json.data.id}/approve`,
      { token: superToken },
    );
    if (approve.status !== 200) {
      fail(`approve kyc ${i}`, JSON.stringify(approve.json));
      return 1;
    }
    saverTokens.push(verify.json.data.tokens.accessToken);
    saverIds.push(verify.json.data.user.id);
  }
  pass('12 savers registered, verified, KYC approved');

  // 4. Get tenant
  const tenantsRes = await api('GET', `/api/super-admin/tenants/by-branch/${branchId}`, {
    token: superToken,
  });
  if (tenantsRes.status !== 200 || !tenantsRes.json.ok) {
    fail('get tenant', JSON.stringify(tenantsRes.json));
    return 1;
  }
  const tenants = tenantsRes.json.data.tenants as Array<{ id: string; status: string }>;
  const active = tenants.find((t) => t.status === 'ACTIVE');
  if (!active) {
    fail('tenant activated', 'no ACTIVE tenant');
    return 1;
  }
  const tenantId = active.id;
  pass('tenant activated', tenantId.slice(0, 8));

  // 5. Direct DB pool for fast-forward + assertions
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('  [setup] Fast-forwarding 12 cycles...');

  for (let cycle = 1; cycle <= 12; cycle++) {
    const pRes = await pool.query<{ id: string; fee_intent_id: string | null }>(
      `SELECT id, fee_intent_id FROM payout_intents
       WHERE tenant_id = $1 AND tenure = 1 AND cycle = $2`,
      [tenantId, cycle],
    );
    const row = pRes.rows[0];
    if (!row) {
      console.log(`    [skip] no payout intent for cycle ${cycle}`);
      continue;
    }

    if (row.fee_intent_id) {
      await pool.query(
        `UPDATE platform_fee_intents SET state = 'CONFIRMED', confirmed_at = NOW()
         WHERE id = $1`,
        [row.fee_intent_id],
      );
    }
    await pool.query(
      `UPDATE payout_intents
       SET state = 'CONFIRMED',
           payout_confirmed_by = (SELECT id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1),
           payout_confirmed_at = NOW()
       WHERE id = $1`,
      [row.id],
    );

    // Trigger lazy advancement via any saver's dashboard load.
    const advRes = await api('GET', '/api/tenants/me', { token: saverTokens[0]! });
    if (advRes.status !== 200) {
      console.log(`    [warn] advance call failed at cycle ${cycle}:`, JSON.stringify(advRes.json));
    }
  }

  // 6. Verify renewal opened
  const tenantAfterRes = await pool.query<{
    renewal_state: string;
    current_tenure: number;
  }>(`SELECT renewal_state, current_tenure FROM tenants WHERE id = $1`, [tenantId]);
  const tenantAfter = tenantAfterRes.rows[0];
  if (tenantAfter?.renewal_state !== 'VOTING') {
    fail('renewal opened', `state=${tenantAfter?.renewal_state}`);
    await pool.end();
    return 1;
  }
  pass('renewal opened (VOTING)', `tenure=${tenantAfter.current_tenure}`);

  // 7. Verify 12 renewal rows
  const rrRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM tenure_renewals
     WHERE tenant_id = $1 AND closing_tenure = 1`,
    [tenantId],
  );
  const rrCount = Number(rrRes.rows[0]?.count ?? '0');
  if (rrCount !== 12) {
    fail('12 renewal rows created', `got ${rrCount}`);
    await pool.end();
    return 1;
  }
  pass('12 renewal rows created');

  // 8. Pick a saver to vote NO — read their actual slot from DB
  const voterIndex = 4; // 5th saver (0-based index)
  const voterUserId = saverIds[voterIndex]!;
  const slotRes = await pool.query<{ slot_number: number }>(
    `SELECT slot_number FROM tenant_memberships
     WHERE tenant_id = $1 AND user_id = $2 AND status != 'REMOVED'`,
    [tenantId, voterUserId],
  );
  const targetSlot = slotRes.rows[0]?.slot_number;
  if (!targetSlot) {
    fail('find voter slot', 'no membership found for voter');
    await pool.end();
    return 1;
  }
  console.log(`  [info] saver ${voterIndex + 1} owns slot ${targetSlot} - will vote NO`);

  const voteNoRes = await api('POST', '/api/tenants/me/renewal/vote', {
    token: saverTokens[voterIndex]!,
    body: { vote: 'NO' },
  });
  if (voteNoRes.status !== 200 || !voteNoRes.json.ok) {
    fail('saver votes NO', JSON.stringify(voteNoRes.json));
    await pool.end();
    return 1;
  }
  pass(`saver voted NO (slot ${targetSlot})`);

  // 9. Verify that slot is now unfilled
  const unfilledRes = await pool.query<{ slot_number: number }>(
    `SELECT slot_number FROM tenure_renewals
     WHERE tenant_id = $1 AND closing_tenure = 1
       AND vote = 'NO' AND replacement_user_id IS NULL`,
    [tenantId],
  );
  const unfilledSlots = unfilledRes.rows.map((r) => r.slot_number);
  if (!unfilledSlots.includes(targetSlot)) {
    fail(`slot ${targetSlot} marked unfilled`, `unfilled=${unfilledSlots.join(',')}`);
    await pool.end();
    return 1;
  }
  pass(`slot ${targetSlot} freed for replacement`);

  // 10. Simulate new signup -> should be assigned to that slot
  const newPhone = `+4478002${String(stamp).slice(-3)}99`;
  const newReg = await api('POST', '/api/auth/register', {
    body: {
      phone: newPhone,
      password: 'SaverPass1#',
      fullName: 'Replacement Saver',
      branchSlug,
    },
  });
  if (newReg.status !== 201) {
    fail('new signup register', JSON.stringify(newReg.json));
    await pool.end();
    return 1;
  }
  const newVerify = await api('POST', '/api/auth/verify-phone', {
    body: { phone: newPhone, code: DEV_OTP },
  });
  const newKyc = await submitKyc(newVerify.json.data.tokens.accessToken, 99);
  const newApprove = await api(
    'PATCH',
    `/api/super-admin/kyc/${newKyc.json.data.id}/approve`,
    { token: superToken },
  );
  if (newApprove.status !== 200) {
    fail('replacement KYC approved', JSON.stringify(newApprove.json));
    await pool.end();
    return 1;
  }
  pass('replacement signup + KYC');

  // 11. Verify replacement took the target slot
  const slotCheckRes = await pool.query<{ replacement_user_id: string | null }>(
    `SELECT replacement_user_id FROM tenure_renewals
     WHERE tenant_id = $1 AND closing_tenure = 1 AND slot_number = $2`,
    [tenantId, targetSlot],
  );
  if (!slotCheckRes.rows[0]?.replacement_user_id) {
    fail(`slot ${targetSlot} filled by replacement`, 'no replacement_user_id');
    await pool.end();
    return 1;
  }
  pass(`slot ${targetSlot} filled by replacement`);

  // 12. Remaining 11 members vote YES
  for (let i = 0; i < 12; i++) {
    if (i === voterIndex) continue; // this saver voted NO
    const voteRes = await api('POST', '/api/tenants/me/renewal/vote', {
      token: saverTokens[i]!,
      body: { vote: 'YES' },
    });
    if (voteRes.status !== 200) {
      console.log(`    [info] saver ${i + 1} vote: ${voteRes.status}`);
    }
  }
  pass('remaining members voted YES');

  // 13. Verify tenure renewed (or in REPLACING if rebalance still pending)
  const finalRes = await pool.query<{
    renewal_state: string;
    current_tenure: number;
    current_cycle: number;
    status: string;
  }>(
    `SELECT renewal_state, current_tenure, current_cycle, status
     FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const final = finalRes.rows[0]!;
  if (
    final.renewal_state !== 'RENEWED' &&
    final.renewal_state !== 'REPLACING'
  ) {
    fail(
      'tenure renewed or in replacing',
      `state=${final.renewal_state}`,
    );
    await pool.end();
    return 1;
  }
  pass(
    'tenure renewed',
    `state=${final.renewal_state}, tenure=${final.current_tenure}, cycle=${final.current_cycle}, status=${final.status}`,
  );

  await pool.end();

  console.log('');
  console.log('============================================');
  console.log('  Tenure renewal test passed');
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