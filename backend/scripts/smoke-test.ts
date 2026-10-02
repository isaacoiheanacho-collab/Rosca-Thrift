/**
 * ROSCA Backend - Smoke Test
 *
 * Runs 11 checks against the API. Prints PASS/FAIL for each.
 * Requires:
 *   - server running on http://localhost:4001 (npm run dev)
 *   - REDIS_URL set in .env (for test 11)
 *
 * Run with: yarn smoke
 */

import 'dotenv/config';
import { Queue, QueueEvents } from 'bullmq';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001';
const REDIS_URL = process.env.REDIS_URL;

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

interface AuthSuccess {
  ok: true;
  data: {
    user: { id: string; email: string | null; fullName: string };
    tokens: { accessToken: string; refreshToken: string };
  };
}

function isAuthSuccess(r: ApiResponse): r is AuthSuccess {
  return r.ok === true && typeof r.data === 'object' && r.data !== null;
}

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

  // 1 - health
  {
    const r = await api('GET', '/health');
    if (r.status === 200 && r.json.ok === true) pass('health check');
    else fail('health check', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 2 - register
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

  // 3 - weak password rejected
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

  // 4 - duplicate email rejected
  {
    const r = await api('POST', '/api/auth/register', { email, password, fullName: 'Clone' });
    if (r.status === 409 && r.json.error?.code === 'AUTH_EMAIL_TAKEN')
      pass('duplicate email rejected');
    else fail('duplicate email rejected', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 5 - login
  {
    const r = await api('POST', '/api/auth/login', { email, password });
    if (r.status === 200 && isAuthSuccess(r.json)) {
      pass('login');
      refreshToken = r.json.data.tokens.refreshToken;
    } else {
      fail('login', `status=${r.status} body=${JSON.stringify(r.json)}`);
    }
  }

  // 6 - wrong password rejected
  {
    const r = await api('POST', '/api/auth/login', { email, password: 'WrongPass1#' });
    if (r.status === 401 && r.json.error?.code === 'AUTH_INVALID_CREDENTIALS')
      pass('wrong password rejected');
    else fail('wrong password rejected', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 7 - refresh rotates
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

  // 8 - reuse detection
  {
    const r = await api('POST', '/api/auth/refresh', { refreshToken });
    if (r.status === 401 && r.json.error?.code === 'AUTH_TOKEN_REUSED')
      pass('reuse detection fires');
    else fail('reuse detection fires', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 9 - all sessions revoked after reuse
  {
    const r = await api('POST', '/api/auth/refresh', { refreshToken: rotatedToken });
    if (r.status === 401 && r.json.error?.code === 'AUTH_TOKEN_REUSED')
      pass('all sessions revoked after reuse');
    else
      fail(
        'all sessions revoked after reuse',
        `status=${r.status} body=${JSON.stringify(r.json)}`,
      );
  }

  // 10 - 404 for unknown route
  {
    const r = await api('GET', '/api/does-not-exist');
    if (r.status === 404 && r.json.error?.code === 'ROUTE_NOT_FOUND')
      pass('unknown route returns 404');
    else fail('unknown route returns 404', `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 11 - BullMQ queue: enqueue a job and wait for the worker to process it
  if (!REDIS_URL) {
    fail('bullmq job processed', 'REDIS_URL not set in .env');
  } else {
    try {
      const testQueue = new Queue('notifications', {
        connection: { url: REDIS_URL } as never,
      });
      const queueEvents = new QueueEvents('notifications', {
        connection: { url: REDIS_URL } as never,
      });

      const job = await testQueue.add('notification.send', {
        type: 'notification.send',
        userId: 'smoke-test-user',
        channel: 'in-app',
        title: 'Smoke test',
        body: 'If you see this, BullMQ works.',
      });

      const jobId = job.id;
      let completed = false;

      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      const done = new Promise<void>((resolve) => {
        queueEvents.on('completed', (event) => {
          if (event.jobId === jobId) {
            completed = true;
            resolve();
          }
        });
      });

      await Promise.race([done, timeout]);

      await queueEvents.close();
      await testQueue.close();

      if (completed) pass('bullmq job processed');
      else fail('bullmq job processed', 'Timed out waiting for worker to process job');
    } catch (err) {
      fail('bullmq job processed', `Error: ${(err as Error).message}`);
    }
  }

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