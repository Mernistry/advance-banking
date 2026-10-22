import express from 'express';
import verifyJWT from '../middlewares/auth.middleware.js';
import { moneyLimiter } from '../middlewares/rateLimit.middleware.js';
import accountModel from '../models/account.model.js';
import ledgerModel from '../models/ledger.model.js';
import { changeAccountStatus } from '../services/account.service.js';
import { reqMeta } from '../utils/request-meta.js';
import { handleError } from '../controllers/transaction.controller.js';

const router = express.Router();
const OBJECT_ID = /^[a-f\d]{24}$/i;
const MAX_ACCOUNTS_PER_USER = 10;

router.use(verifyJWT);

/* ---------- POST /api/accounts ---------- */
router.post('/', async (req, res) => {
  try {
    const currency = typeof req.body?.currency === 'string' ? req.body.currency.trim() : undefined;

    if ((await accountModel.countDocuments({ user: req.userId })) >= MAX_ACCOUNTS_PER_USER) {
      return res.status(400).json({ message: `You can have at most ${MAX_ACCOUNTS_PER_USER} accounts` });
    }

    // user and status are always set by the server, never from the request body
    const account = await accountModel.create({ user: req.userId, type: 'ACTIVE', ...(currency && { currency }) });
    res.status(201).json({ account });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: Object.values(err.errors)[0].message });
    }
    console.error('Create account error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- GET /api/accounts ---------- */
router.get('/', async (req, res) => {
  try {
    const accounts = await accountModel.find({ user: req.userId }).select('-lastSeq');
    res.json({ accounts });
  } catch (err) {
    console.error('List accounts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- GET /api/accounts/:id/balance ---------- */
router.get('/:id/balance', async (req, res) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ message: 'Invalid account id' });

    // Filtering by user makes other people's accounts look like "not found"
    const account = await accountModel.findOne({ _id: req.params.id, user: req.userId });
    if (!account) return res.status(404).json({ message: 'Account not found' });

    const balance = await account.getBalance(); // no session needed for a plain read
    res.json({ accountId: account._id, currency: account.currency, balance });
  } catch (err) {
    console.error('Balance error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- GET /api/accounts/:id/ledger?limit=20&before=<seq> ---------- */
// Statement, newest first. Pass the previous response's `nextBefore` as `before` for the next page.
router.get('/:id/ledger', async (req, res) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ message: 'Invalid account id' });

    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const filter = {};
    if (req.query.before !== undefined) {
      const before = typeof req.query.before === 'string' ? Number(req.query.before) : NaN;
      if (!Number.isSafeInteger(before) || before < 1) {
        return res.status(400).json({ message: 'before must be a positive integer' });
      }
      filter.seq = { $lt: before };
    }

    const account = await accountModel.findOne({ _id: req.params.id, user: req.userId }).select('_id');
    if (!account) return res.status(404).json({ message: 'Account not found' });

    const rows = await ledgerModel
      .find({ ...filter, account: account._id })
      .sort({ seq: -1 })
      .limit(limit + 1)
      .select('seq type amount transactionId createdAt')
      .lean();

    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;
    res.json({ entries, nextBefore: hasMore ? entries[entries.length - 1].seq : null });
  } catch (err) {
    console.error('Ledger error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- POST /api/accounts/:id/freeze (owner can freeze; only a superuser can unfreeze) ---------- */
router.post('/:id/freeze', moneyLimiter, async (req, res) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ message: 'Invalid account id' });

    const account = await changeAccountStatus({
      actorId: String(req.userId),
      isAdmin: false,
      accountId: req.params.id.toLowerCase(),
      newStatus: 'FROZEN',
      meta: reqMeta(req),
    });
    res.json({ account });
  } catch (err) {
    handleError(res, err, 'Freeze account error');
  }
});

export default router;
