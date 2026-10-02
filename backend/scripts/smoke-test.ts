/**
 * ROSCA Backend - Smoke Test
 *
 * Runs 10 checks against the auth flow. Prints PASS/FAIL for each.
 * Requires: server running on http://localhost:4001
 *
 * Run with: npm run smoke
 */

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001';

// ---- Tiny test harness ----

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: TestResult[] = [];

function pass(name: string): void {
  results.push({ name, passed: true });
  console.log(`  PASS  ${name}`);
}

function fail(name: string, detail: string): void {
  results.push({ name, passed: false, detail });
  console.log(`  FAIL  ${name}`);
  console.log(`        ${detail}`);
}

// ---- HTTP helper ----

interface ApiResponse {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

async function api(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: ApiResponse }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: ApiResponse;
  try {
    json = (await res.json()) as ApiResponse;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

// ---- Typed accessors for responses ----

interface AuthSuccess {
  ok: true;
  data: {
    user: { id: string; email: string | null; fullName: string };
    tokens: { accessToken: string; refreshToken: string };
  };
}

interface AuthError {
  ok: false;
  error: { code: string; message: string };
}

function isAuthSuccess(r: ApiResponse): r is AuthSuccess {
  return r.ok === true && typeof r.data === 'object' && r.data !== null;
}

// ---- Test runner ----

async function run(): Promise<number> {
  const email = `smoke${Math.floor(Math.random() * 90000 + 10000)}@rosca.local`;
  const password = 'SecurePass1#';
  const fullName = 'Smoke Tester';

  console.log('');
  console.log('============================================');
  console.log('  ROSCA Backend Smoke Test');
  console.log(`  Target: ${BASE}`);
  console.log(`  Test user: ${email}`);
  console.log('============================================');
  console.log('');

  // 1 — health
  {
    const r = await api('GET', '/health');
    if (r.status === 200 && r.json.ok === true) pass('health check');
    else fail('health check', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 2 — register
  let refreshToken = '';
  {
    const r = await api('POST', '/api/auth/register', { email, password, fullName });
    if (r.status === 201 && isAuthSuccess(r.json)) {
      pass('register new user');
      refreshToken = r.json.data.tokens.refreshToken;
    } else {
      fail('register new user', `status=${r.status} body=${JSON.stringify(r.json)}`);
    }
  }

  // 3 — weak password rejected
  {
    const r = await api('POST', '/api/auth/register', {
      email: `weak${Date.now()}@rosca.local`,
      password: 'short',
      fullName: 'Weak',
    });
    if (r.status === 400 && r.json.error?.code === 'VALIDATION_ERROR')
      pass('weak password rejected');
    else fail('weak password rejected', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 4 — duplicate email rejected
  {
    const r = await api('POST', '/api/auth/register', { email, password, fullName: 'Clone' });
    if (r.status === 409 && r.json.error?.code === 'AUTH_EMAIL_TAKEN')
      pass('duplicate email rejected');
    else fail('duplicate email rejected', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 5 — login
  {
    const r = await api('POST', '/api/auth/login', { email, password });
    if (r.status === 200 && isAuthSuccess(r.json)) {
      pass('login');
      refreshToken = r.json.data.tokens.refreshToken;
    } else {
      fail('login', `status=${r.status} body=${JSON.stringify(r.json)}`);
    }
  }

  // 6 — wrong password rejected
  {
    const r = await api('POST', '/api/auth/login', { email, password: 'WrongPass1#' });
    if (r.status === 401 && r.json.error?.code === 'AUTH_INVALID_CREDENTIALS')
      pass('wrong password rejected');
    else fail('wrong password rejected', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 7 — refresh rotates
  let rotatedToken = '';
  {
    const r = await api('POST', '/api/auth/refresh', { refreshToken });
    if (
      r.status === 200 &&
      isAuthSuccess(r.json) &&
      r.json.data.tokens.refreshToken !== refreshToken
    ) {
      pass('refresh token rotates');
      rotatedToken = r.json.data.tokens.refreshToken;
    } else {
      fail('refresh token rotates', `status=${r.status} body=${JSON.stringify(r.json)}`);
    }
  }

  // 8 — reuse detection
  {
    const r = await api('POST', '/api/auth/refresh', { refreshToken });
    if (r.status === 401 && r.json.error?.code === 'AUTH_TOKEN_REUSED')
      pass('reuse detection fires');
    else fail('reuse detection fires', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 9 — after reuse, the rotated token is also dead
  {
    const r = await api('POST', '/api/auth/refresh', { refreshToken: rotatedToken });
    if (r.status === 401 && r.json.error?.code === 'AUTH_TOKEN_REUSED')
      pass('all sessions revoked after reuse');
    else fail('all sessions revoked after reuse', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 10 — 404 for unknown route
  {
    const r = await api('GET', '/api/does-not-exist');
    if (r.status === 404 && r.json.error?.code === 'ROUTE_NOT_FOUND')
      pass('unknown route returns 404');
    else fail('unknown route returns 404', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  console.log('');
  console.log('============================================');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('  Failed:');
    for (const r of results.filter((x) => !x.passed)) {
      console.log(`    - ${r.name}: ${r.detail ?? ''}`);
    }
  }
  console.log('============================================');
  console.log('');

  return failed === 0 ? 0 : 1;
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Smoke test crashed:', err);
    process.exit(2);
  });