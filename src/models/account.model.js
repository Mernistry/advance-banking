import mongoose from 'mongoose';
import ledgerModel from './ledger.model.js';

const accountSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    required: [true, 'User is required for an account']
  },
  // Account status (ACTIVE / CLOSED / FROZEN)
  type: {
    type: String,
    required: true,
    enum: ['ACTIVE', 'CLOSED', 'FROZEN'],
    default: 'ACTIVE'
  },
  currency: {
    type: String,
    required: true,
    default: 'INR',
    uppercase: true
  },
  // Per-account sequence counter. Every transfer increments it inside the
  // transaction, which (1) locks the account against concurrent transfers
  // (fixes write skew / overdraft race) and (2) gives each ledger entry a
  // monotonic, gap-tolerant order for future balance checkpoints.
  lastSeq: {
    type: Number,
    default: 0
  },
  isSystem: {
    type: Boolean,
    default: false,
    immutable: true,
    select: false
  }
}, { timestamps: true });

// Balance = sum(CREDIT) - sum(DEBIT). Ledger is the single source of truth.
// Pass `session` when calling inside a transaction.
accountSchema.methods.getBalance = async function (session = null) {
  const agg = ledgerModel.aggregate([
    { $match: { account: this._id } },
    {
      $group: {
        _id: null,
        totalDebits: {
          $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] },
        },
        totalCredits: {
          $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] },
        },
      },
    },
    {
      $project: {
        _id: 0,
        balance: { $subtract: ['$totalCredits', '$totalDebits'] },
      },
    },
  ]);

  if (session) agg.session(session);

  const balanceData = await agg;
  return balanceData.length === 0 ? 0 : balanceData[0].balance;
};

const accountModel = mongoose.models.Account || mongoose.model('Account', accountSchema);

export default accountModel;
