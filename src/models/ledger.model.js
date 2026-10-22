import mongoose from 'mongoose';
import { makeImmutable } from '../utils/immutable.js';

const ledgerSchema = new mongoose.Schema({
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Account',
    index: true,
    required: [true, 'Account is required for creating a ledger'],
    immutable: true
  },
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    index: true,
    required: [true, 'Transaction id is required for creating a ledger'],
    immutable: true
  },
  amount: {
    type: Number,
    required: [true, 'Amount is required for creating a ledger'],
    min: [1, 'Amount must be at least 1'],
    validate: { validator: Number.isSafeInteger, message: 'Amount must be an integer (minor units, e.g. paise)' },
    immutable: true
  },
  type: {
    type: String,
    required: [true, 'Ledger type is required for creating a ledger'],
    enum: {
      values: ['CREDIT', 'DEBIT'],
      message: 'Ledger type either be CREDIT or DEBIT'
    },
    immutable: true
  },
  // Per-account sequence number (see Account.lastSeq)
  seq: {
    type: Number,
    required: [true, 'Sequence number is required for creating a ledger'],
    immutable: true
  },
}, { timestamps: true });

// One entry per (account, seq): a safety net if the lock ever fails.
ledgerSchema.index({ account: 1, seq: 1 }, { unique: true });

makeImmutable(ledgerSchema);

const ledgerModel = mongoose.models.Ledger || mongoose.model('Ledger', ledgerSchema);

export default ledgerModel;
