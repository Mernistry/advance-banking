import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startTestEnv, PASSWORD } from './helpers.js';

let app;
let stop;

before(async () => {
  ({ app, stop } = await startTestEnv());
});
after(async () => {
  await stop();
});

const cookieFrom = (res) =>
  res.headers['set-cookie']?.find((c) => c.startsWith('refreshToken='))?.split(';')[0];
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const signup = async (email) => {
  const res = await request(app).post('/api/auth/signup').send({ email, name: 'Test', password: PASSWORD });
  assert.equal(res.status, 201);
  return { accessToken: res.body.accessToken, cookie: cookieFrom(res) };
};
const refresh = (cookie) => request(app).post('/api/auth/refresh').set('Cookie', cookie);

test('two parallel refreshes both succeed, only one rotates the cookie', async () => {
  const { cookie } = await signup('par@test.com');
  const [a, b] = await Promise.all([refresh(cookie), refresh(cookie)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal([a, b].filter((r) => cookieFrom(r)).length, 1);
});

test('old refresh token after the grace window is rejected and revokes the session', async () => {
  const { cookie } = await signup('reuse@test.com');
  const first = await refresh(cookie);
  const newCookie = cookieFrom(first);
  assert.ok(newCookie);

  await sleep(500); // grace window is 300ms in tests
  assert.equal((await refresh(cookie)).status, 403); // reused old token
  assert.equal((await refresh(newCookie)).status, 403); // session was revoked
});

test('multiple devices, listing sessions, and logout-all revokes access tokens immediately', async () => {
  await signup('multi@test.com');
  const l1 = await request(app).post('/api/auth/login').send({ email: 'multi@test.com', password: PASSWORD });
  const l2 = await request(app).post('/api/auth/login').send({ email: 'multi@test.com', password: PASSWORD });
  assert.equal(l1.status, 200);
  assert.equal(l2.status, 200);

  const list = await request(app).get('/api/auth/sessions').set(auth(l1.body.accessToken));
  assert.equal(list.body.sessions.length, 3);
  assert.equal(list.body.sessions.filter((s) => s.current).length, 1);

  assert.equal((await request(app).get('/api/accounts').set(auth(l2.body.accessToken))).status, 200);
  assert.equal((await request(app).post('/api/auth/logout-all').set(auth(l1.body.accessToken))).status, 200);
  assert.equal((await request(app).get('/api/accounts').set(auth(l2.body.accessToken))).status, 401);
});

test('account locks after 5 wrong passwords, even for the right password', async () => {
  await signup('lock@test.com');
  for (let i = 0; i < 5; i++) {
    const res = await request(app).post('/api/auth/login').send({ email: 'lock@test.com', password: 'Wrong0ne!x' });
    assert.equal(res.status, 401);
  }
  const res = await request(app).post('/api/auth/login').send({ email: 'lock@test.com', password: PASSWORD });
  assert.equal(res.status, 401);
});

test('NoSQL operator injection is rejected', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: { $ne: null }, password: 'x' });
  assert.equal(res.status, 400);
});

test('refresh from a foreign Origin is rejected', async () => {
  const { cookie } = await signup('origin@test.com');
  const res = await refresh(cookie).set('Origin', 'https://evil.example');
  assert.equal(res.status, 403);
});
