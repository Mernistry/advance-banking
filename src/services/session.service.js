import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import sessionModel from '../models/session.model.js';
import { env } from '../config/env.js';

export const REFRESH_MAX_AGE = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_SESSIONS = 5; // max devices logged in at once; the least recently used is dropped

// Algorithm and issuer are pinned on both sign and verify (blocks "alg: none" style tricks)
const SIGN_OPTS = { algorithm: 'HS256', issuer: env.JWT_ISSUER };
export const VERIFY_OPTS = { algorithms: ['HS256'], issuer: env.JWT_ISSUER };

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export const signAccessToken = (userId, sid) =>
  jwt.sign({ userId: String(userId), sid: String(sid) }, env.ACCESS_SECRET, { ...SIGN_OPTS, expiresIn: '15m' });

// jwtid makes every refresh token unique, even if two are signed in the same second
const signRefreshToken = (userId, sid) =>
  jwt.sign({ userId: String(userId), sid: String(sid) }, env.REFRESH_SECRET, {
    ...SIGN_OPTS,
    expiresIn: '3d',
    jwtid: crypto.randomUUID(),
  });

/** New login on a device => new session. */
export const createSession = async (req, userId) => {
  const sid = new mongoose.Types.ObjectId();
  const refreshToken = signRefreshToken(userId, sid);

  await sessionModel.create({
    _id: sid,
    user: userId,
    refreshTokenHash: hashToken(refreshToken),
    userAgent: (req.get('user-agent') || '').slice(0, 200),
    ip: req.ip || '',
    expiresAt: new Date(Date.now() + REFRESH_MAX_AGE),
  });

  // Keep only the MAX_SESSIONS most recently used devices
  const stale = await sessionModel
    .find({ user: userId })
    .sort({ lastUsedAt: -1 })
    .skip(MAX_SESSIONS)
    .select('_id');
  if (stale.length) await sessionModel.deleteMany({ _id: { $in: stale.map((s) => s._id) } });

  return { sid, refreshToken };
};

/**
 * Rotates a refresh token. Result status:
 *  - 'rotated': normal case, caller must set the new refresh cookie
 *  - 'grace'  : token was rotated moments ago by a parallel request; caller gets a
 *               new access token only (the winning request already set the cookie)
 *  - 'invalid': unknown/reused token. `reuse: true` means a real session existed and
 *               was revoked (possible token theft), so the caller should audit it.
 * Throws a jwt error if the token is expired or malformed.
 */
export const rotateSession = async (incomingToken) => {
  const decoded = jwt.verify(incomingToken, env.REFRESH_SECRET, VERIFY_OPTS);
  const { userId, sid } = decoded;
  const incomingHash = hashToken(incomingToken);
  const now = new Date();
  const newToken = signRefreshToken(userId, sid);

  // Atomic compare-and-swap: only ONE of several parallel requests can win this.
  const rotated = await sessionModel.findOneAndUpdate(
    { _id: sid, user: userId, refreshTokenHash: incomingHash },
    {
      $set: {
        refreshTokenHash: hashToken(newToken),
        previousTokenHash: incomingHash,
        previousValidUntil: new Date(now.getTime() + env.REFRESH_GRACE_MS),
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + REFRESH_MAX_AGE),
      },
    },
    { new: true }
  );
  if (rotated) return { status: 'rotated', userId, sid, refreshToken: newToken };

  const session = await sessionModel.findOne({ _id: sid, user: userId }).select('+previousTokenHash');
  if (session && session.previousTokenHash === incomingHash && session.previousValidUntil > now) {
    return { status: 'grace', userId, sid };
  }

  // Old token used after the grace window => likely stolen. Kill this device's session.
  if (session) await sessionModel.deleteOne({ _id: session._id });
  return { status: 'invalid', userId, reuse: Boolean(session) };
};
