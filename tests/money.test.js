import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startTestEnv, PASSWORD } from './helpers.js';

let app;
let stop;
let User;
let Account;
let totp;
let adminToken;
let adminId;
let secret;
let systemAccountId;
let counter = 0;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const stepCode = () => totp.hotp(secret, totp.currentStep());
// A TOTP code works once; tests reset the replay guard so they can reuse the current code
const resetTotpGuard = () => User.updateOne({ _id: adminId }, { totpLastStep: 0 });

const newUser = async () => {
  const email = `user${++counter}@test.com`;
  const res = await request(app).post('/api/auth/signup').send({ email, name: 'Test', password: PASSWORD });
  assert.equal(res.status, 201);
  const token = res.body.accessToken;
  const acc = await request(app).post('/api/accounts').set(auth(token)).send({});
  return { email, token, account: acc.body.account._id };
};

const deposit = async (toAccount, amount, key = `dep-${++counter}`) => {
  await resetTotpGuard();
  return request(app).post('/api/admin/deposits').set(auth(adminToken))
    .send({ toAccount, amount, idempotencyKey: key, totpCode: stepCode() });
};
const transfer = (token, fromAccount, toAccount, amount, key = `tx-${++counter}`) =>
  request(app).post('/api/transactions').set(auth(token)).send({ fromAccount, toAccount, amount, idempotencyKey: key });
const balanceOf = async (token, account) =>
  (await request(app).get(`/api/accounts/${account}/balance`).set(auth(token))).body.balance;

before(async () => {
  ({ app, stop } = await startTestEnv());
  User = (await import('../src/models/user.model.js')).default;
  Account = (await import('../src/models/account.model.js')).default;
  totp = await import('../src/utils/totp.js');

  // Create a superuser with a system account and 2FA enabled
  const admin = await newUser();
  adminToken = admin.token;
  const adminDoc = await User.findOneAndUpdate({ email: admin.email }, { role: 'SUPERUSER' }, { new: true });
  adminId = adminDoc._id;
  const system = await Account.create({ user: adminId, type: 'ACTIVE', currency: 'INR', isSystem: true });
  systemAccountId = String(system._id);

  const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
  assert.equal(setup.status, 200);
  const stored = await User.findById(adminId).select('+totpSecretEnc');
  secret = totp.decryptSecret(stored.totpSecretEnc);
  const enable = await request(app).post('/api/auth/2fa/enable').set(auth(adminToken)).send({ totpCode: stepCode() });
  assert.equal(enable.status, 200);
});
after(async () => {
  await stop();
});

test('only a superuser can deposit', async () => {
  const alice = await newUser();
  const res = await request(app).post('/api/admin/deposits').set(auth(alice.token))
    .send({ toAccount: alice.account, amount: 100, idempotencyKey: 'x', totpCode: '123456' });
  assert.equal(res.status, 403);
});

test('deposit needs a valid 2FA code, and a code cannot be replayed', async () => {
  const alice = await newUser();
  const noCode = await request(app).post('/api/admin/deposits').set(auth(adminToken))
    .send({ toAccount: alice.account, amount: 100, idempotencyKey: 'k1' });
  assert.equal(noCode.status, 401);

  await resetTotpGuard();
  const code = stepCode();
  const body = (key) => ({ toAccount: alice.account, amount: 100, idempotencyKey: key, totpCode: code });
  assert.equal((await request(app).post('/api/admin/deposits').set(auth(adminToken)).send(body('k2'))).status, 201);
  assert.equal((await request(app).post('/api/admin/deposits').set(auth(adminToken)).send(body('k3'))).status, 401);
});

test('deposit credits the account, is idempotent, and respects the cap', async () => {
  const alice = await newUser();
  const first = await deposit(alice.account, 10000, 'dep-same');
  assert.equal(first.status, 201);
  const again = await deposit(alice.account, 10000, 'dep-same');
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(await balanceOf(alice.token, alice.account), 10000);

  const tooBig = await deposit(alice.account, 1_000_000_001);
  assert.equal(tooBig.status, 400);
});

test('parallel transfers cannot overdraw an account', async () => {
  const alice = await newUser();
  const bob = await newUser();
  assert.equal((await deposit(alice.account, 10000)).status, 201);

  const results = await Promise.all(
    Array.from({ length: 5 }, () => transfer(alice.token, alice.account, bob.account, 8000))
  );
  const ok = results.filter((r) => r.status === 201);
  assert.equal(ok.length, 1);
  results.filter((r) => r.status !== 201).forEach((r) => assert.ok([400, 503].includes(r.status)));

  assert.equal(await balanceOf(alice.token, alice.account), 2000);
  assert.equal(await balanceOf(bob.token, bob.account), 8000);
});

test('the same idempotency key in parallel creates exactly one transaction', async () => {
  const alice = await newUser();
  const bob = await newUser();
  await deposit(alice.account, 10000);

  const results = await Promise.all(
    Array.from({ length: 5 }, () => transfer(alice.token, alice.account, bob.account, 1000, 'same-key'))
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  results.filter((r) => r.status !== 201).forEach((r) => assert.equal(r.status, 200));
  assert.equal(await balanceOf(alice.token, alice.account), 9000);
});

test('same key with different parameters is rejected', async () => {
  const alice = await newUser();
  const bob = await newUser();
  await deposit(alice.account, 10000);
  assert.equal((await transfer(alice.token, alice.account, bob.account, 100, 'k')).status, 201);
  assert.equal((await transfer(alice.token, alice.account, bob.account, 200, 'k')).status, 422);
});

test('you cannot move money out of someone else\'s account', async () => {
  const alice = await newUser();
  const bob = await newUser();
  await deposit(alice.account, 10000);
  assert.equal((await transfer(bob.token, alice.account, bob.account, 100)).status, 403);
  assert.equal(await balanceOf(alice.token, alice.account), 10000);
});

test('system accounts cannot be used through the normal transfer API', async () => {
  const alice = await newUser();
  const res = await transfer(adminToken, systemAccountId, alice.account, 100);
  assert.equal(res.status, 403);
});

test('owner can freeze; frozen accounts cannot send; only a superuser can unfreeze', async () => {
  const alice = await newUser();
  const bob = await newUser();
  await deposit(alice.account, 10000);

  assert.equal((await request(app).post(`/api/accounts/${alice.account}/freeze`).set(auth(alice.token))).status, 200);
  assert.equal((await transfer(alice.token, alice.account, bob.account, 100)).status, 400);

  await resetTotpGuard();
  const unfreeze = await request(app).patch(`/api/admin/accounts/${alice.account}/status`).set(auth(adminToken))
    .send({ status: 'ACTIVE', totpCode: stepCode() });
  assert.equal(unfreeze.status, 200);
  assert.equal((await transfer(alice.token, alice.account, bob.account, 100)).status, 201);
});

test('ledger statement paginates and reconciliation is balanced', async () => {
  const alice = await newUser();
  const bob = await newUser();
  await deposit(alice.account, 10000);
  await transfer(alice.token, alice.account, bob.account, 100);
  await transfer(alice.token, alice.account, bob.account, 200);

  const page1 = await request(app).get(`/api/accounts/${alice.account}/ledger?limit=2`).set(auth(alice.token));
  assert.equal(page1.status, 200);
  assert.equal(page1.body.entries.length, 2);
  assert.ok(page1.body.nextBefore);

  const page2 = await request(app)
    .get(`/api/accounts/${alice.account}/ledger?limit=2&before=${page1.body.nextBefore}`).set(auth(alice.token));
  assert.equal(page2.body.entries.length, 1);
  assert.equal(page2.body.nextBefore, null);

  const rec = await request(app).get('/api/admin/reconcile').set(auth(adminToken));
  assert.equal(rec.status, 200);
  assert.equal(rec.body.balanced, true);
  assert.deepEqual(rec.body.negativeBalanceAccounts, []);
});

test('deposits are written to the audit log', async () => {
  const alice = await newUser();
  await deposit(alice.account, 500);
  const res = await request(app).get('/api/admin/audit?limit=20').set(auth(adminToken));
  assert.equal(res.status, 200);
  assert.ok(res.body.entries.some((e) => e.action === 'DEPOSIT' && e.target === alice.account));
});
