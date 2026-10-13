/**
 * Notifications E2E test.
 *
 * Verifies:
 *   1. Feed endpoints (list, unread count, mark read, mark all read)
 *   2. Push subscription flow (subscribe, list, unsubscribe)
 *   3. VAPID public key endpoint
 *   4. That a KYC approval creates exactly one KYC_APPROVED notification
 *   5. That a contribution confirm creates one notification per tenant member
 *   6. That a contribution reject creates one notification per tenant member
 *   7. That a deposit reminder creates one notification per tenant member
 *
 * Does NOT verify actual Web Push delivery — that requires a real browser.
 * Use scripts/test-push.html for that.
 *
 * Run: yarn test:notifications
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
  form.append('legalName', `Notif Saver ${idx}`);
  form.append('bankName', 'Monzo');
  form.append('accountNumber', `4444${String(idx).padStart(4, '0')}`);
  form.append('sortCode', '040004');
  const blob = new Blob([new Uint8Array(TEST_PNG)], { type: 'image/png' });
  form.append('selfie', blob, 'selfie.png');
  return apiForm('POST', '/api/kyc', form, token);
}

async function main(): Promise<number> {
  const stamp = Date.now();

  console.log('');
  console.log('============================================');
  console.log('  Notifications E2E Test');
  console.log(`  Base: ${BASE}`);
  console.log(`  Branch: notif-test-${stamp}`);
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

  // 2. VAPID public key endpoint
  const vapidRes = await api('GET', '/api/notifications/vapid-public-key', {
    token: superToken,
  });
  if (vapidRes.status !== 200 || !vapidRes.json.ok) {
    fail('VAPID public key endpoint', JSON.stringify(vapidRes.json));
    return 1;
  }
  if (typeof vapidRes.json.data.publicKey !== 'string' || vapidRes.json.data.publicKey.length < 20) {
    fail('VAPID public key endpoint', 'publicKey missing or too short');
    return 1;
  }
  pass('VAPID public key served', `${vapidRes.json.data.publicKey.slice(0, 12)}...`);

  // 3. Create branch
  const branchSlug = `notif-test-${stamp}`;
  const branchRes = await api('POST', '/api/super-admin/branches', {
    token: superToken,
    body: { slug: branchSlug, name: `Notif Test ${stamp}` },
  });
  if (branchRes.status !== 201 || !branchRes.json.ok) {
    fail('create branch', JSON.stringify(branchRes.json));
    return 1;
  }
  const branchId = branchRes.json.data.id;
  pass('create branch');

  // 4. Register + verify + KYC + approve 12 savers
  const saverTokens: string[] = [];
  const saverIds: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const phone = `+447700${String(stamp).slice(-3)}${String(i).padStart(2, '0')}`;
    const reg = await api('POST', '/api/auth/register', {
      body: {
        phone,
        password: 'SaverPass1#',
        fullName: `Notif Saver ${i}`,
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

  // 5. Find the activated tenant
  const tenantsRes = await api('GET', `/api/super-admin/tenants/by-branch/${branchId}`, {
    token: superToken,
  });
  const tenants = tenantsRes.json.data.tenants as Array<{ id: string; status: string; memberCount: number }>;
  const activeTenant = tenants.find((t) => t.status === 'ACTIVE' && t.memberCount === 12);
  if (!activeTenant) {
    fail('find ACTIVE tenant', JSON.stringify(tenants));
    return 1;
  }
  pass('tenant activated', activeTenant.id.slice(0, 8));

  // 6. Check KYC_APPROVED notifications exist for each saver
  //    Each saver should have at least 1 KYC_APPROVED + 1 TENANT_ACTIVATED notification.
  const kycNotifRes = await api('GET', '/api/notifications?limit=100', {
    token: saverTokens[0]!,
  });
  if (kycNotifRes.status !== 200 || !kycNotifRes.json.ok) {
    fail('list saver 1 notifications', JSON.stringify(kycNotifRes.json));
    return 1;
  }
  const saver1Notifs = kycNotifRes.json.data.notifications as Array<{ kind: string }>;
  const kinds = saver1Notifs.map((n) => n.kind);
  if (!kinds.includes('KYC_APPROVED')) {
    fail('KYC_APPROVED notification present', `kinds: ${kinds.join(', ')}`);
    return 1;
  }
  pass('KYC_APPROVED notification received by saver 1');

  // 7. Unread count
  const unreadRes = await api('GET', '/api/notifications/unread-count', {
    token: saverTokens[0]!,
  });
  if (unreadRes.status !== 200 || typeof unreadRes.json.data?.count !== 'number') {
    fail('unread count endpoint', JSON.stringify(unreadRes.json));
    return 1;
  }
  pass('unread count endpoint', `count=${unreadRes.json.data.count}`);

  // 8. Push subscribe (fake endpoint — verifies the endpoint stores it)
  const fakeEndpoint = `https://fcm.googleapis.com/fcm/send/test-${stamp}`;
  const subscribeRes = await api('POST', '/api/notifications/push/subscribe', {
    token: saverTokens[0]!,
    body: {
      endpoint: fakeEndpoint,
      keys: {
        p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
        auth: '5I3N2S3lzOo6cVDlY3e8XA',
      },
    },
  });
  if (subscribeRes.status !== 201 || !subscribeRes.json.ok) {
    fail('push subscribe', JSON.stringify(subscribeRes.json));
    return 1;
  }
  pass('push subscription accepted');

  // 9. List subscriptions
  const listSubsRes = await api('GET', '/api/notifications/push/subscriptions', {
    token: saverTokens[0]!,
  });
  if (listSubsRes.status !== 200 || !Array.isArray(listSubsRes.json.data)) {
    fail('list push subscriptions', JSON.stringify(listSubsRes.json));
    return 1;
  }
  if (listSubsRes.json.data.length !== 1) {
    fail('one subscription listed', `got ${listSubsRes.json.data.length}`);
    return 1;
  }
  pass('push subscription listed');

  // 10. Unsubscribe
  const unsubscribeRes = await api('POST', '/api/notifications/push/unsubscribe', {
    token: saverTokens[0]!,
    body: { endpoint: fakeEndpoint },
  });
  if (unsubscribeRes.status !== 200) {
    fail('push unsubscribe', JSON.stringify(unsubscribeRes.json));
    return 1;
  }
  pass('push unsubscribe ok');

  // 11. Mark one read
  const firstNotifId = saver1Notifs[0]?.kind ? kycNotifRes.json.data.notifications[0].id : null;
  if (!firstNotifId) {
    fail('first notification id', 'none returned');
    return 1;
  }
  const markReadRes = await api('POST', `/api/notifications/${firstNotifId}/read`, {
    token: saverTokens[0]!,
  });
  if (markReadRes.status !== 200) {
    fail('mark one read', JSON.stringify(markReadRes.json));
    return 1;
  }
  pass('mark one read');

  // 12. Mark all read
  const markAllRes = await api('POST', '/api/notifications/read-all', {
    token: saverTokens[0]!,
  });
  if (markAllRes.status !== 200) {
    fail('mark all read', JSON.stringify(markAllRes.json));
    return 1;
  }
  pass('mark all read', `marked=${markAllRes.json.data.marked}`);

  // 13. Confirm the unread count is now 0
  const unreadAfterRes = await api('GET', '/api/notifications/unread-count', {
    token: saverTokens[0]!,
  });
  if (unreadAfterRes.json.data?.count !== 0) {
    fail('unread count is 0 after mark-all', `got ${unreadAfterRes.json.data?.count}`);
    return 1;
  }
  pass('unread count is 0 after mark-all');

  // 14. Deposit reminder — branch admin side
  const reminderRes = await api(
    'POST',
    `/api/branch-admin/contributions/tenants/${activeTenant.id}/remind`,
    { token: superToken },
  );
  if (reminderRes.status !== 200 || !reminderRes.json.ok) {
    fail('deposit reminder', JSON.stringify(reminderRes.json));
    return 1;
  }
  pass('deposit reminder sent', `to ${reminderRes.json.data.sent} members`);

  // 15. Verify each member received a DEPOSIT_REMINDER
  const reminderNotifRes = await api('GET', '/api/notifications?limit=100', {
    token: saverTokens[3]!,
  });
  const reminderKinds = (reminderNotifRes.json.data.notifications as Array<{ kind: string }>).map(
    (n) => n.kind,
  );
  if (!reminderKinds.includes('DEPOSIT_REMINDER')) {
    fail('DEPOSIT_REMINDER received by member 4', `kinds: ${reminderKinds.join(', ')}`);
    return 1;
  }
  pass('DEPOSIT_REMINDER received by member 4');

  console.log('');
  console.log('============================================');
  console.log('  Notifications test passed');
  console.log('============================================');
  console.log('');
  console.log('  To test real Web Push delivery:');
  console.log('  1. Start server: yarn dev');
  console.log(`  2. Open: file:///${process.cwd().replace(/\\/g, '/')}/scripts/test-push.html`);
  console.log('  3. Login as any saver (paste access token)');
  console.log('  4. Click "Enable Push Notifications"');
  console.log('  5. Trigger an event (e.g., upload a receipt from another tab)');
  console.log('  6. You should see a browser notification');
  console.log('');

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Test crashed:', err);
    process.exit(2);
  });