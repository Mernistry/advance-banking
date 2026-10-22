import mongoose from 'mongoose';

// One document = one logged-in device. This is what enables multi-device login.
const sessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // SHA-256 of the CURRENT refresh token (the raw token is never stored)
  refreshTokenHash: { type: String, required: true, index: true, select: false },

  // The token that was just rotated out. Still accepted for a few seconds so that
  // two parallel /refresh calls (two tabs, retries) don't look like token theft.
  previousTokenHash: { type: String, select: false },
  previousValidUntil: { type: Date },

  userAgent: { type: String, default: '' },
  ip: { type: String, default: '' },
  lastUsedAt: { type: Date, default: Date.now },

  // MongoDB deletes the document automatically after this date (TTL index)
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });

const sessionModel = mongoose.models.Session || mongoose.model('Session', sessionSchema);

export default sessionModel;
