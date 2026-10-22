import userModel from '../models/user.model.js';
import { decryptSecret, findValidStep } from '../utils/totp.js';
import { logAudit } from '../services/audit.service.js';
import { reqMeta } from '../utils/request-meta.js';

// Step-up authentication: every sensitive admin action needs a fresh 6-digit code
// in the request body as `totpCode`. A code can only be used once.
export const requireTotp = async (req, res, next) => {
  try {
    const code = req.body?.totpCode;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return res.status(401).json({ message: 'totpCode (6 digits) is required' });
    }

    const user = await userModel.findById(req.userId).select('+totpSecretEnc totpEnabled');
    if (!user?.totpEnabled) {
      return res.status(403).json({ message: 'Enable 2FA first (POST /api/auth/2fa/setup)' });
    }

    const step = findValidStep(decryptSecret(user.totpSecretEnc), code);
    if (step === null) {
      await logAudit({ actor: user._id, action: 'TOTP_FAILED', details: req.originalUrl.slice(0, 100), ...reqMeta(req) });
      return res.status(401).json({ message: 'Invalid 2FA code' });
    }

    // Atomically claim this time-step: a second use of the same code matches nothing
    const claimed = await userModel.findOneAndUpdate(
      { _id: user._id, totpLastStep: { $lt: step } },
      { $set: { totpLastStep: step } }
    );
    if (!claimed) return res.status(401).json({ message: '2FA code already used, wait for the next one' });

    next();
  } catch (err) {
    next(err);
  }
};
