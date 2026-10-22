// Usage: node scripts/reset-2fa.js <email>
// For a superuser who lost their authenticator device. Needs server access (DB + .env),
// which is the point: it cannot be done through the API.
// Also revokes all of that user's sessions.
import 'dotenv/config';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import userModel from '../src/models/user.model.js';
import sessionModel from '../src/models/session.model.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: node scripts/reset-2fa.js <email>');
  process.exit(1);
}

try {
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const user = await userModel.findOne({ email });
  if (!user) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  await userModel.updateOne(
    { _id: user._id },
    { $set: { totpEnabled: false, totpLastStep: 0 }, $unset: { totpSecretEnc: 1 } }
  );
  await sessionModel.deleteMany({ user: user._id });
  console.log(`2FA reset for ${email}. Log in again and run /api/auth/2fa/setup.`);
} finally {
  await mongoose.disconnect();
}
