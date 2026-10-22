import express from 'express';
import bcrypt from 'bcryptjs';
import userModel from '../models/user.model.js';
import sessionModel from '../models/session.model.js';
import verifyJWT from '../middlewares/auth.middleware.js';
import { requireSuperuser } from '../middlewares/role.middleware.js';
import { authLimiter, adminLimiter } from '../middlewares/rateLimit.middleware.js';
import { checkOrigin } from '../middlewares/origin.middleware.js';
import { env } from '../config/env.js';
import {
  REFRESH_MAX_AGE,
  hashToken,
  signAccessToken,
  createSession,
  rotateSession,
} from '../services/session.service.js';
import { logAudit } from '../services/audit.service.js';
import { reqMeta } from '../utils/request-meta.js';
import {
  generateSecret, encryptSecret, decryptSecret, findValidStep, buildOtpauthUrl, base32Encode,
} from '../utils/totp.js';

const router = express.Router();

const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
const OBJECT_ID = /^[a-f\d]{24}$/i;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

/* ---------- helpers ---------- */
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

const cookieOptions = {
  httpOnly: true, // blocks client-side JS access (XSS)
  secure: env.isProd, // HTTPS only in production
  sameSite: 'strict', // CSRF protection
  path: '/api/auth', // cookie only sent to auth routes
};

const setRefreshCookie = (res, token) =>
  res.cookie('refreshToken', token, { ...cookieOptions, maxAge: REFRESH_MAX_AGE });

// Counts a failed password; locks the account after MAX_FAILED_LOGINS in a row
const registerFailedLogin = async (userId, req) => {
  const updated = await userModel
    .findOneAndUpdate({ _id: userId }, { $inc: { failedLoginCount: 1 } }, { new: true })
    .select('+failedLoginCount');
  if (updated && updated.failedLoginCount >= MAX_FAILED_LOGINS) {
    await userModel.updateOne(
      { _id: userId },
      { $set: { failedLoginCount: 0, lockUntil: new Date(Date.now() + LOCK_MS) } }
    );
    await logAudit({ actor: userId, action: 'LOGIN_LOCKED', ...reqMeta(req) });
  }
};

/* ---------- POST /api/auth/signup ---------- */
router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { email, name, password } = req.body ?? {};

    if (!isNonEmptyString(email) || !isNonEmptyString(name) || !isNonEmptyString(password)) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Only these three fields are read from the body, so nobody can self-assign a role
    const newUser = await userModel.create({ email, name, password });

    const { sid, refreshToken } = await createSession(req, newUser._id);

    setRefreshCookie(res, refreshToken);
    res.status(201).json({
      message: 'User created successfully',
      accessToken: signAccessToken(newUser._id, sid),
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const first = Object.values(err.errors)[0];
      return res.status(400).json({ message: first.message });
    }
    if (err.code === 11000) {
      return res.status(409).json({ message: 'User already registered' });
    }
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- POST /api/auth/login ---------- */
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body ?? {};

    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      return res.status(400).json({ message: 'Login credentials are required' });
    }

    const user = await userModel
      .findOne({ email: email.trim().toLowerCase() })
      .select('+password +failedLoginCount +lockUntil');

    // A locked account answers exactly like a wrong password, so attackers can't
    // tell which emails exist. A bcrypt compare always runs to keep timing equal.
    const locked = Boolean(user?.lockUntil && user.lockUntil > new Date());
    const valid = user && !locked
      ? await user.comparePassword(password)
      : await bcrypt.compare(password, DUMMY_HASH).then(() => false);

    if (!user || !valid) {
      if (user && !locked) await registerFailedLogin(user._id, req);
      return res.status(401).json({ message: 'Login credentials are invalid' });
    }

    if (user.failedLoginCount || user.lockUntil) {
      await userModel.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0 }, $unset: { lockUntil: 1 } });
    }

    // Each login creates its own session, so other devices stay logged in
    const { sid, refreshToken } = await createSession(req, user._id);

    setRefreshCookie(res, refreshToken);
    res.json({ accessToken: signAccessToken(user._id, sid) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- POST /api/auth/refresh (rotates the refresh token) ---------- */
router.post('/refresh', checkOrigin, async (req, res) => {
  const incomingRefreshToken = req.cookies?.refreshToken;
  if (!incomingRefreshToken || typeof incomingRefreshToken !== 'string') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await rotateSession(incomingRefreshToken);

    if (result.status === 'invalid') {
      if (result.reuse) {
        await logAudit({ actor: result.userId, action: 'REFRESH_TOKEN_REUSE', ...reqMeta(req) });
      }
      res.clearCookie('refreshToken', cookieOptions);
      return res.status(403).json({ error: 'Forbidden: Invalid refresh token' });
    }

    if (result.status === 'rotated') setRefreshCookie(res, result.refreshToken);
    // status 'grace': a parallel request already rotated; its cookie is on the way

    res.json({ accessToken: signAccessToken(result.userId, result.sid) });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      res.clearCookie('refreshToken', cookieOptions);
      return res.status(403).json({ error: 'Forbidden: Token expired or invalid' });
    }
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- POST /api/auth/logout (this device only) ---------- */
router.post('/logout', checkOrigin, async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken || typeof refreshToken !== 'string') return res.sendStatus(204);

  try {
    const hash = hashToken(refreshToken);
    await sessionModel.deleteOne({
      $or: [{ refreshTokenHash: hash }, { previousTokenHash: hash }],
    });
    res.clearCookie('refreshToken', cookieOptions);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- POST /api/auth/logout-all (every device) ---------- */
router.post('/logout-all', verifyJWT, async (req, res) => {
  try {
    await sessionModel.deleteMany({ user: req.userId });
    await logAudit({ actor: req.userId, action: 'LOGOUT_ALL', ...reqMeta(req) });
    res.clearCookie('refreshToken', cookieOptions);
    res.json({ message: 'Logged out from all devices' });
  } catch (err) {
    console.error('Logout-all error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- GET /api/auth/sessions (list my devices) ---------- */
router.get('/sessions', verifyJWT, async (req, res) => {
  try {
    const sessions = await sessionModel
      .find({ user: req.userId })
      .sort({ lastUsedAt: -1 })
      .select('userAgent ip lastUsedAt createdAt');

    res.json({
      sessions: sessions.map((s) => ({
        id: s._id,
        userAgent: s.userAgent,
        ip: s.ip,
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt,
        current: String(s._id) === String(req.sessionId),
      })),
    });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- DELETE /api/auth/sessions/:id (log out one device) ---------- */
router.delete('/sessions/:id', verifyJWT, async (req, res) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ message: 'Invalid session id' });

    const result = await sessionModel.deleteOne({ _id: req.params.id, user: req.userId });
    if (result.deletedCount === 0) return res.status(404).json({ message: 'Session not found' });

    res.json({ message: 'Session revoked' });
  } catch (err) {
    console.error('Revoke session error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- POST /api/auth/2fa/setup (superuser) ---------- */
// Returns the secret ONCE. Add it to an authenticator app (scan the otpauth URL as a QR),
// then confirm with /2fa/enable.
router.post('/2fa/setup', verifyJWT, requireSuperuser, adminLimiter, async (req, res) => {
  try {
    const user = await userModel.findById(req.userId).select('email totpEnabled');
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.totpEnabled) {
      return res.status(409).json({ message: '2FA is already enabled. Use scripts/reset-2fa.js to reset it.' });
    }

    const secret = generateSecret();
    await userModel.updateOne({ _id: user._id }, { totpSecretEnc: encryptSecret(secret) });
    res.json({ secret: base32Encode(secret), otpauthUrl: buildOtpauthUrl(user.email, secret) });
  } catch (err) {
    console.error('2FA setup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- POST /api/auth/2fa/enable (superuser) ---------- */
router.post('/2fa/enable', verifyJWT, requireSuperuser, adminLimiter, async (req, res) => {
  try {
    const code = req.body?.totpCode;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: 'totpCode (6 digits) is required' });
    }

    const user = await userModel.findById(req.userId).select('+totpSecretEnc totpEnabled');
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.totpEnabled) return res.status(409).json({ message: '2FA is already enabled' });
    if (!user.totpSecretEnc) return res.status(400).json({ message: 'Run /2fa/setup first' });

    const step = findValidStep(decryptSecret(user.totpSecretEnc), code);
    if (step === null) {
      await logAudit({ actor: user._id, action: 'TOTP_FAILED', details: '2fa/enable', ...reqMeta(req) });
      return res.status(401).json({ message: 'Invalid 2FA code' });
    }

    await userModel.updateOne({ _id: user._id }, { totpEnabled: true, totpLastStep: step });
    await logAudit({ actor: user._id, action: 'TOTP_ENABLED', ...reqMeta(req) });
    res.json({ message: '2FA enabled' });
  } catch (err) {
    console.error('2FA enable error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- GET /api/auth/me (protected; handy to test the middleware) ---------- */
router.get('/me', verifyJWT, async (req, res) => {
  try {
    const user = await userModel.findById(req.userId).select('email name role totpEnabled createdAt');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
