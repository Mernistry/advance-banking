import mongoose from 'mongoose';
import { env } from './env.js';

const connectDB = async (retries = 5, delay = 5000) => {
  let conn;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      conn = await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      console.log(`MongoDB connected: ${conn.connection.host}`);
      break;
    } catch (error) {
      console.error(`Attempt ${attempt}/${retries} failed:`, error.message);

      if (attempt === retries) {
        throw new Error('All MongoDB connection attempts failed');
      }

      console.log(`Retrying in ${delay / 1000} seconds...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }

  // Transactions only work on a replica set (or sharded cluster). Atlas always is;
  // for local MongoDB start it with --replSet and run rs.initiate().
  const hello = await conn.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    console.warn('WARNING: MongoDB is not a replica set. Transfers will fail until you enable one.');
  }

  // Older versions made idempotencyKey globally unique. Keys are now unique per
  // user (initiatedBy + idempotencyKey), so drop the legacy index if it exists.
  try {
    const indexes = await conn.connection.collection('transactions').indexes();
    if (indexes.some((i) => i.name === 'idempotencyKey_1')) {
      await conn.connection.collection('transactions').dropIndex('idempotencyKey_1');
      console.log('Dropped legacy index transactions.idempotencyKey_1');
    }
  } catch (err) {
    if (err.codeName !== 'NamespaceNotFound') console.warn('Legacy index check failed:', err.message);
  }

  // Unique indexes (idempotency key, ledger account+seq) are part of the
  // correctness guarantees, so make sure they exist before serving requests.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
};

export default connectDB;
