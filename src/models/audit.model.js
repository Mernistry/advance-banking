import mongoose from 'mongoose';
import { makeImmutable } from '../utils/immutable.js';

export const AUDIT_ACTIONS = [
  'DEPOSIT',
  'ACCOUNT_STATUS_CHANGED',
  'TOTP_ENABLED',
  'TOTP_FAILED',
  'REFRESH_TOKEN_REUSE',
  'LOGIN_LOCKED',
  'LOGOUT_ALL',
];

const auditSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: { type: String, enum: AUDIT_ACTIONS, required: true, index: true },
  target: { type: mongoose.Schema.Types.ObjectId }, // e.g. the account affected
  transactionId: { type: mongoose.Schema.Types.ObjectId },
  amount: { type: Number },
  details: { type: String, maxlength: 300 },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
}, { timestamps: { createdAt: true, updatedAt: false } });

makeImmutable(auditSchema);

const auditModel = mongoose.models.Audit || mongoose.model('Audit', auditSchema);

export default auditModel;
