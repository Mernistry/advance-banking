// Usage: node scripts/create-superuser.js <email> [currency]
// The user must already have signed up through /api/auth/signup.
// Promotes them to SUPERUSER and makes sure they own a system account
// (the account deposits are issued from; its balance goes negative = total money issued).
import 'dotenv/config';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import userModel from '../src/models/user.model.js';
import accountModel from '../src/models/account.model.js';

const email = process.argv[2]?.trim().toLowerCase();
const currency = (process.argv[3] || 'INR').toUpperCase();

if (!email) {
  console.error('Usage: node scripts/create-superuser.js <email> [currency]');
  process.exit(1);
}

try {
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });

  const user = await userModel.findOne({ email });
  if (!user) {
    console.error(`No user with email ${email}. Sign up first, then run this again.`);
    process.exit(1);
  }

  await userModel.updateOne({ _id: user._id }, { role: 'SUPERUSER' });

  let system = await accountModel.findOne({ user: user._id, isSystem: true, currency });
  if (!system) {
    system = await accountModel.create({ user: user._id, type: 'ACTIVE', currency, isSystem: true });
    console.log(`Created system account ${system._id} (${currency})`);
  } else {
    console.log(`System account already exists: ${system._id} (${currency})`);
  }

  console.log(`${email} is now a SUPERUSER. Log in, then enable 2FA (POST /api/auth/2fa/setup then /2fa/enable): deposits and account-status changes need it.`);
} finally {
  await mongoose.disconnect();
}
