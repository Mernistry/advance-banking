// TOTP (RFC 6238, SHA-1, 6 digits, 30s) implemented with node:crypto only.
// Secrets are stored AES-256-GCM encrypted using TOTP_ENCRYPTION_KEY.
import crypto from 'crypto';
import { env } from '../config/env.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

export const generateSecret = () => crypto.randomBytes(20);

export const base32Encode = (buf) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};

export const hotp = (secret, counter, digits = 6) => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const bin =
    ((hash[offset] & 0x7f) << 24) |
    (hash[offset + 1] << 16) |
    (hash[offset + 2] << 8) |
    hash[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
};

export const currentStep = (now = Date.now()) => Math.floor(now / STEP_MS);

// Returns the matching time-step (so it can be marked as used), or null.
// Accepts the previous, current and next step to tolerate clock drift.
export const findValidStep = (secret, code, now = Date.now(), window = 1) => {
  const base = currentStep(now);
  let match = null;
  for (let d = -window; d <= window; d++) {
    const step = base + d;
    const expected = Buffer.from(hotp(secret, step));
    const given = Buffer.from(String(code));
    if (given.length === expected.length && crypto.timingSafeEqual(expected, given)) match = step;
  }
  return match;
};

export const buildOtpauthUrl = (email, secret) => {
  const label = encodeURIComponent(`Banking:${email}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=Banking&algorithm=SHA1&digits=6&period=30`;
};

export const encryptSecret = (secret) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', env.TOTP_KEY, iv);
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('hex')).join('.');
};

export const decryptSecret = (stored) => {
  const [iv, tag, ct] = stored.split('.').map((h) => Buffer.from(h, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', env.TOTP_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
};
