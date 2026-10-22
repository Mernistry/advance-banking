import accountModel from '../models/account.model.js';
import { processTransfer } from '../services/transfer.service.js';
import { HttpError } from '../utils/http-error.js';
import { reqMeta } from '../utils/request-meta.js';
import { env } from '../config/env.js';
import { parseMoneyBody, sendResult, handleError } from './transaction.controller.js';

/* ---------- POST /api/admin/deposits (superuser + 2FA) ---------- */
// Body: { toAccount, amount (paise), idempotencyKey, totpCode }
// Money is issued from the superuser's own system account in the target's currency.
const depositController = async (req, res) => {
  try {
    const actorId = String(req.userId);
    const { amount, idempotencyKey, ids } = parseMoneyBody(req.body ?? {}, ['toAccount'], env.MAX_DEPOSIT);

    const target = await accountModel.findById(ids.toAccount).select('currency type');
    if (!target) throw new HttpError(404, 'Destination account not found');

    const systemAccount = await accountModel.findOne({
      user: actorId,
      isSystem: true,
      currency: target.currency,
      type: 'ACTIVE',
    });
    if (!systemAccount) {
      throw new HttpError(400, `No active system account for ${target.currency}. Run scripts/create-superuser.js`);
    }

    const result = await processTransfer({
      actorId,
      fromAccount: String(systemAccount._id),
      toAccount: ids.toAccount,
      amount,
      idempotencyKey,
      kind: 'DEPOSIT',
      audit: { action: 'DEPOSIT', ...reqMeta(req) },
    });
    return sendResult(res, result, 'Deposit Successful');
  } catch (err) {
    return handleError(res, err, 'Deposit Controller Error');
  }
};

export default depositController;
