import 'dotenv/config';
import mongoose from 'mongoose';
import app from './src/app.js';
import connectDB from './src/config/db.js';

const PORT = process.env.PORT || 3000;

process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

connectDB()
  .then(() => {
    const server = app.listen(PORT, () => console.log(`Express Server is listening on ${PORT}`));

    // Graceful shutdown: finish in-flight requests (and DB transactions) before exiting
    const shutdown = (signal) => {
      console.log(`${signal} received, shutting down...`);
      server.close(async () => {
        await mongoose.disconnect();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
