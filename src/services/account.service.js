import mongoose from 'mongoose';
import accountModel from '../models/account.model.js';
import { HttpError } from '../utils/http-error.js';
import { auditInTx } from './audit.service.js';

/**
 * Status rules:
 *  - owner can FREEZE their own ACTIVE account
 *  - only a superuser can unfreeze (FROZEN -> ACTIVE) or CLOSE (balance must be 0)
 *  - CLOSED is final; system accounts can never be changed
 * The account is locked (seq bump) so a concurrent transfer conflicts instead of
 * slipping through while the status changes.
 */
export const changeAccountStatus = async ({ actorId, isAdmin, accountId, newStatus, meta }) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const acc = await accountModel
        .findOneAndUpdate({ _id: accountId }, { $inc: { lastSeq: 1 } }, { new: true, session })
        .select('+isSystem');

      if (!acc) throw new HttpError(404, 'Account not found');
      // Hide other people's accounts from non-admins
      if (!isAdmin && String(acc.user) !== actorId) throw new HttpError(404, 'Account not found');
      if (acc.isSystem) throw new HttpError(403, 'System accounts cannot be changed');

      const current = acc.type;
      if (current === newStatus) throw new HttpError(400, `Account is already ${newStatus}`);
      if (current === 'CLOSED') throw new HttpError(400, 'Closed accounts cannot be reopened');
      if (!isAdmin && !(current === 'ACTIVE' && newStatus === 'FROZEN')) {
        throw new HttpError(403, 'Only a superuser can do this');
      }
      if (newStatus === 'CLOSED' && (await acc.getBalance(session)) !== 0) {
        throw new HttpError(400, 'Balance must be zero to close an account');
      }

      await accountModel.updateOne({ _id: accountId }, { type: newStatus }, { session });
      await auditInTx(
        {
          actor: actorId,
          action: 'ACCOUNT_STATUS_CHANGED',
          target: accountId,
          details: `${current} -> ${newStatus}`,
          ...meta,
        },
        session
      );
    });

    return { id: accountId, type: newStatus };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err.hasErrorLabel?.('TransientTransactionError') || err.code === 112) {
      throw new HttpError(503, 'Server busy, please retry');
    }
    throw err;
  } finally {
    session.endSession();
  }
};
