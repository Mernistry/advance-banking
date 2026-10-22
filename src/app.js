import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import authRoute from './routes/auth.route.js';
import accountRoute from './routes/account.route.js';
import transactionRoute from './routes/transaction.route.js';
import adminRoute from './routes/admin.route.js';
import { apiLimiter } from './middlewares/rateLimit.middleware.js';
import { rejectMongoOperators } from './middlewares/sanitize.middleware.js';
import { env } from './config/env.js';

const app = express();

app.disable('x-powered-by');

// If deployed behind a reverse proxy (Nginx, Render, Railway...), uncomment so
// rate limiting sees the real client IP:
// app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: env.CLIENT_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(rejectMongoOperators);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Never let browsers/proxies cache API responses (balances, tokens...)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', apiLimiter);

app.use('/api/auth', authRoute);
app.use('/api/accounts', accountRoute);
app.use('/api/transactions', transactionRoute);
app.use('/api/admin', adminRoute);

// 404
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Central error handler (also catches malformed JSON bodies)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

export default app;
