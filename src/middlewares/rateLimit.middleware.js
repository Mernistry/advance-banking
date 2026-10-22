import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const base = {
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.isTest, // tests fire many requests from one IP
};
const message = { error: 'Too many requests, please try again later' };
const byUser = (req) => String(req.userId ?? 'anonymous'); // use only AFTER verifyJWT

// Everything under /api, per IP
export const apiLimiter = rateLimit({ ...base, windowMs: 60 * 1000, limit: 200, message });

// Signup / login, per IP
export const authLimiter = rateLimit({
  ...base, windowMs: 15 * 60 * 1000, limit: 10,
  message: { error: 'Too many attempts, please try again later' },
});

// Moving money / changing account status, per user
export const moneyLimiter = rateLimit({ ...base, windowMs: 60 * 1000, limit: 30, keyGenerator: byUser, message });

// Superuser + 2FA endpoints, per user (also slows down 2FA code guessing)
export const adminLimiter = rateLimit({ ...base, windowMs: 60 * 1000, limit: 10, keyGenerator: byUser, message });
