import accountModel from '../models/account.model.js';
import auditModel from '../models/audit.model.js';
import ledgerModel from '../models/ledger.model.js';
import { changeAccountStatus } from '../services/account.service.js';
import { HttpError } from '../utils/http-error.js';
import { reqMeta } from '../utils/request-meta.js';
import { handleError } from './transaction.controller.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const STATUSES = ['ACTIVE', 'FROZEN', 'CLOSED'];

/* ---------- PATCH /api/admin/accounts/:id/status (superuser + 2FA) ---------- */
export const setAccountStatus = async (req, res) => {
  try {
    const { status } = req.body ?? {};
    if (!OBJECT_ID.test(req.params.id)) throw new HttpError(400, 'Invalid account id');
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);

    const account = await changeAccountStatus({
      actorId: String(req.userId),
      isAdmin: true,
      accountId: req.params.id.toLowerCase(),
      newStatus: status,
      meta: reqMeta(req),
    });
    res.json({ account });
  } catch (err) {
    handleError(res, err, 'Set account status error');
  }
};

/* ---------- GET /api/admin/audit?limit=&before= ---------- */
export const listAudit = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const filter = {};
    if (req.query.before !== undefined) {
      if (typeof req.query.before !== 'string' || !OBJECT_ID.test(req.query.before)) {
        throw new HttpError(400, 'before must be an audit entry id');
      }
      filter._id = { $lt: req.query.before };
    }

    const rows = await auditModel.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;
    res.json({ entries, nextBefore: hasMore ? entries[entries.length - 1]._id : null });
  } catch (err) {
    handleError(res, err, 'List audit error');
  }
};

/* ---------- GET /api/admin/reconcile ---------- */
// Integrity check. In double-entry bookkeeping total credits == total debits, and
// no normal (non-system) account may ever have a negative balance.
export const reconcile = async (req, res) => {
  try {
    const credit = { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] };
    const debit = { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] };

    const [totals] = await ledgerModel.aggregate([
      { $group: { _id: null, credits: { $sum: credit }, debits: { $sum: debit } } },
    ]);

    const negative = await ledgerModel.aggregate([
      { $group: { _id: '$account', balance: { $sum: { $subtract: [credit, debit] } } } },
      { $match: { balance: { $lt: 0 } } },
      { $lookup: { from: accountModel.collection.name, localField: '_id', foreignField: '_id', as: 'acc' } },
      { $match: { 'acc.isSystem': { $ne: true } } },
      { $project: { balance: 1 } },
      { $limit: 100 },
    ]);

    const totalCredits = totals?.credits ?? 0;
    const totalDebits = totals?.debits ?? 0;
    res.json({
      totalCredits,
      totalDebits,
      balanced: totalCredits === totalDebits,
      negativeBalanceAccounts: negative.map((n) => ({ account: n._id, balance: n.balance })),
    });
  } catch (err) {
    handleError(res, err, 'Reconcile error');
  }
};
