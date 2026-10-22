import { test } from 'node:test';
import assert from 'node:assert/strict';

// env.js validates these at import time
Object.assign(process.env, {
  MONGO_URI: 'mongodb://localhost/test',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  TOTP_ENCRYPTION_KEY: 'ab'.repeat(32),
});

const { hotp, base32Encode, findValidStep, encryptSecret, decryptSecret, generateSecret } =
  await import('../src/utils/totp.js');

const RFC_SECRET = Buffer.from('12345678901234567890'); // RFC 6238 test secret (SHA-1)

test('hotp matches RFC 6238 test vectors (last 6 digits)', () => {
  assert.equal(hotp(RFC_SECRET, Math.floor(59 / 30)), '287082');
  assert.equal(hotp(RFC_SECRET, Math.floor(1111111109 / 30)), '081804');
  assert.equal(hotp(RFC_SECRET, Math.floor(1234567890 / 30)), '005924');
});

test('base32 matches RFC 4648 (no padding)', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Encode(Buffer.from('fo')), 'MZXQ');
});

test('findValidStep accepts current +-1 step and rejects others', () => {
  const now = 1234567890 * 1000;
  const step = Math.floor(now / 30000);
  assert.equal(findValidStep(RFC_SECRET, hotp(RFC_SECRET, step), now), step);
  assert.equal(findValidStep(RFC_SECRET, hotp(RFC_SECRET, step - 1), now), step - 1);
  assert.equal(findValidStep(RFC_SECRET, hotp(RFC_SECRET, step + 1), now), step + 1);
  assert.equal(findValidStep(RFC_SECRET, hotp(RFC_SECRET, step + 5), now), null);
  assert.equal(findValidStep(RFC_SECRET, '12345', now), null);
});

test('secret encryption round-trips and detects tampering', () => {
  const secret = generateSecret();
  const stored = encryptSecret(secret);
  assert.deepEqual(decryptSecret(stored), secret);
  assert.notEqual(encryptSecret(secret), stored); // random IV each time

  const [iv, tag, ct] = stored.split('.');
  const flipped = ct.slice(0, -1) + (ct.endsWith('0') ? '1' : '0');
  assert.throws(() => decryptSecret([iv, tag, flipped].join('.')));
});
