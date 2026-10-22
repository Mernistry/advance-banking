import crypto from 'crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// Starts an in-memory MongoDB replica set (transactions need one), sets the env
// vars, and loads the app AFTER that (env.js reads process.env when imported).
export const startTestEnv = async () => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });

  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: replSet.getUri(),
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    TOTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    CLIENT_ORIGIN: 'http://localhost:5173',
    REFRESH_GRACE_MS: '300',
  });

  const { default: app } = await import('../src/app.js');
  const { default: connectDB } = await import('../src/config/db.js');
  await connectDB(1, 0);

  return {
    app,
    stop: async () => {
      await mongoose.disconnect();
      await replSet.stop();
    },
  };
};

export const PASSWORD = 'Passw0rd!x';
