// Imported after dotenv/config (see server.js), so process.env is already populated.
const required = ['MONGO_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'TOTP_ENCRYPTION_KEY'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const { JWT_ACCESS_SECRET: accessSecret, JWT_REFRESH_SECRET: refreshSecret, TOTP_ENCRYPTION_KEY: totpKey } = process.env;

if (accessSecret.length < 32 || refreshSecret.length < 32) {
  throw new Error('JWT secrets must be at least 32 characters long (try: openssl rand -base64 48)');
}
if (accessSecret === refreshSecret) {
  throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
}
if (!/^[a-f0-9]{64}$/i.test(totpKey)) {
  throw new Error('TOTP_ENCRYPTION_KEY must be 64 hex characters (try: openssl rand -hex 32)');
}

const positiveInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
};

export const env = {
  MONGO_URI: process.env.MONGO_URI,
  ACCESS_SECRET: accessSecret,
  REFRESH_SECRET: refreshSecret,
  TOTP_KEY: Buffer.from(totpKey, 'hex'),
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  JWT_ISSUER: 'banking-api',
  isProd: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',

  // All money values are in minor units (paise)
  MAX_TRANSFER: positiveInt('MAX_TRANSFER_PAISE', 100_000_000), // Rs 10 lakh per transfer
  MAX_DEPOSIT: positiveInt('MAX_DEPOSIT_PAISE', 1_000_000_000), // Rs 1 crore per deposit
  DAILY_TRANSFER_LIMIT: positiveInt('DAILY_TRANSFER_LIMIT_PAISE', 500_000_000), // Rs 50 lakh / account / 24h

  // How long a just-rotated refresh token is still accepted (parallel refresh tolerance)
  REFRESH_GRACE_MS: positiveInt('REFRESH_GRACE_MS', 10_000),
};
