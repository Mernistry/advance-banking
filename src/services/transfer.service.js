import mongoose from 'mongoose';
import transactionModel from '../models/transaction.model.js';
import accountModel from '../models/account.model.js';
import ledgerModel from '../models/ledger.model.js';
import { HttpError } from '../utils/http-error.js';
import { auditInTx } from './audit.service.js';
import { env } from '../config/env.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Thrown inside the DB transaction to abort it and replay an earlier result.
class Replay extends Error {
  constructor(transaction) {
    super('Replay');
    this.transaction = transaction;
  }
}

const sameRequest = (tx, { fromAccount, toAccount, amount, kind }) =>
  String(tx.fromAccount) === fromAccount &&
  String(tx.toAccount) === toAccount &&
  tx.amount === amount &&
  tx.type === kind;

const replayOf = (tx, params) => {
  if (!sameRequest(tx, params)) {
    throw new HttpError(422, 'Idempotency key was already used with different parameters');
  }
  return { transaction: tx, replayed: true };
};

/**
 * Moves money between two accounts, atomically and idempotently.
 *  kind 'TRANSFER': source must be the actor's own NON-system account; balance and
 *                   daily limit are checked.
 *  kind 'DEPOSIT' : source must be the actor's system account (may go negative);
 *                   destination must be a normal account.
 * `audit` ({ action, ip, userAgent }) writes an audit entry inside the same DB transaction.
 * All inputs must already be validated/normalized (lowercase hex ids, integer amount).
 * Returns { transaction, replayed }. Throws HttpError for expected failures.
 */
export const processTransfer = async ({
  actorId, fromAccount, toAccount, amount, idempotencyKey, kind = 'TRANSFER', audit = null,
}) => {
  const params = { fromAccount, toAccount, amount, kind };

  // Fast path: key already processed
  const existing = await transactionModel.findOne({ initiatedBy: actorId, idempotencyKey });
  if (existing) return replayOf(existing, params);

  const session = await mongoose.startSession();
  try {
    let transaction;

    // withTransaction auto-retries on transient errors (e.g. write conflicts).
    // The callback may run more than once, so keep it free of side effects.
    await session.withTransaction(async () => {
      // 1. LOCK both accounts (sorted order => fewer conflicts) and bump seq.
      //    A write on the same document makes concurrent transfers conflict
      //    instead of both reading the same stale balance (write skew).
      const [firstId, secondId] = [fromAccount, toAccount].sort();
      const lock = (id) =>
        accountModel
          .findOneAndUpdate({ _id: id }, { $inc: { lastSeq: 1 } }, { new: true, session })
          .select('+isSystem');
      const first = await lock(firstId);
      const second = await lock(secondId);
      const from = firstId === fromAccount ? first : second;
      const to = firstId === fromAccount ? second : first;

      // 2. Idempotency re-check inside the transaction. A concurrent request
      //    with the same key may have committed while we were waiting.
      const dup = await transactionModel
        .findOne({ initiatedBy: actorId, idempotencyKey })
        .session(session);
      if (dup) {
        replayOf(dup, params); // throws 422 on mismatch
        throw new Replay(dup); // aborts this txn, nothing is written
      }

      // 3. Validate accounts
      if (!from || !to) throw new HttpError(404, 'Account not found');
      if (String(from.user) !== actorId) throw new HttpError(403, 'You do not own the source account');
      if (from.type !== 'ACTIVE' || to.type !== 'ACTIVE') {
        throw new HttpError(400, 'Accounts are invalid or not active');
      }
      if (from.currency !== to.currency) throw new HttpError(400, 'Currency mismatch between accounts');

      if (kind === 'DEPOSIT') {
        if (!from.isSystem) throw new HttpError(403, 'Deposits must come from a system account');
        if (to.isSystem) throw new HttpError(400, 'Cannot deposit into a system account');
      } else {
        if (from.isSystem) throw new HttpError(403, 'System accounts can only be used through the deposit API');

        // 4. Balance check
        const balance = await from.getBalance(session);
        if (balance < amount) throw new HttpError(400, 'Insufficient Balance');

        // 5. Daily limit (race-safe: the source account is locked above)
        const [spent] = await transactionModel.aggregate([
          {
            $match: {
              fromAccount: new mongoose.Types.ObjectId(fromAccount),
              type: 'TRANSFER',
              status: 'COMPLETED',
              createdAt: { $gte: new Date(Date.now() - DAY_MS) },
            },
          },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]).session(session);
        if ((spent?.total ?? 0) + amount > env.DAILY_TRANSFER_LIMIT) {
          throw new HttpError(403, 'Daily transfer limit exceeded');
        }
      }

      // 6. Create transaction + ledger entries (+ audit entry) atomically
      [transaction] = await transactionModel.create(
        [{ fromAccount, toAccount, amount, idempotencyKey, initiatedBy: actorId, type: kind, status: 'COMPLETED' }],
        { session }
      );

      await ledgerModel.create(
        [
          { account: fromAccount, transactionId: transaction._id, type: 'DEBIT', amount, seq: from.lastSeq },
          { account: toAccount, transactionId: transaction._id, type: 'CREDIT', amount, seq: to.lastSeq },
        ],
        { session, ordered: true }
      );

      if (audit) {
        await auditInTx(
          {
            actor: actorId,
            action: audit.action,
            target: toAccount,
            transactionId: transaction._id,
            amount,
            ip: audit.ip,
            userAgent: audit.userAgent,
          },
          session
        );
      }
    });

    return { transaction, replayed: false };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Replay) return { transaction: err.transaction, replayed: true };

    // Duplicate key race: another request with the same key won
    if (err.code === 11000) {
      const existing = await transactionModel.findOne({ initiatedBy: actorId, idempotencyKey });
      if (existing) return replayOf(existing, params);
      throw new HttpError(409, 'Conflicting request, please retry');
    }

    // Retries exhausted under heavy contention
    if (err.hasErrorLabel?.('TransientTransactionError') || err.code === 112) {
      throw new HttpError(503, 'Server busy, please retry with the same idempotencyKey');
    }

    throw err;
  } finally {
    session.endSession();
  }
};
