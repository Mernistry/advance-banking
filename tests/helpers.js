import crypto from 'crypto';
import mongoose from 'mongoose';

export const PASSWORD = 'Passw0rd!x';

// Gives every test file its own throwaway database name, so parallel test files
// never touch each other (or your real data) on a shared cluster.
const withUniqueDb = (uri) => {
  const dbName = `banking_test_${crypto.randomBytes(6).toString('hex')}`;
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?/, `$1/${dbName}`);
};

// Two modes:
//  1. TEST_MONGO_URI set  -> use that replica set (e.g. MongoDB Atlas). Works on Termux.
//  2. not set             -> start an in-memory replica set (mongodb-memory-server).
export const startTestEnv = async () => {
  let replSet = null;
  let mongoUri;
  
  if (process.env.TEST_MONGO_URI) {
    mongoUri = withUniqueDb(process.env.TEST_MONGO_URI);
  } else {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    mongoUri = replSet.getUri();
  }
  
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: mongoUri,
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
      if (replSet) {
        await mongoose.disconnect();
        await replSet.stop();
        return;
      }
      // External cluster: clean up our temporary database
      try {
        const { db } = mongoose.connection;
        for (const { name } of await db.listCollections().toArray()) {
          await db.dropCollection(name);
        }
      } catch (err) {
        console.warn('Test cleanup failed, delete the banking_test_* database manually:', err.message);
      }
      await mongoose.disconnect();
    },
  };
};