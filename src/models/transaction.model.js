import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  status: {
    type: String,
    required: [true, 'Transaction status is required'],
    enum: {
      values: ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'],
      message: 'Transaction status must be PENDING, COMPLETED, FAILED or REVERSED'
    },
    default: 'PENDING',
  },
  fromAccount: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Account',
    required: [true, 'Origin Account is required'],
  },
  toAccount: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Account',
    required: [true, 'Destination Account is required'],
  },
  type: {
    type: String,
    enum: ['TRANSFER', 'DEPOSIT'],
    default: 'TRANSFER',
  },
  // Amount in minor units (paise), always an integer. Avoids float rounding errors.
  amount: {
    type: Number,
    required: [true, 'Amount is required'],
    min: [1, 'Amount must be at least 1'],
    validate: { validator: Number.isSafeInteger, message: 'Amount must be an integer (minor units, e.g. paise)' },
  },
  // Who initiated the transfer. Idempotency keys are scoped per user.
  initiatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Initiating user is required'],
  },
  idempotencyKey: {
    type: String,
    required: [true, 'Idempotency key is required'],
  }
}, { timestamps: true });

// Same user + same key => same transaction. Different users can reuse a key.
transactionSchema.index({ initiatedBy: 1, idempotencyKey: 1 }, { unique: true });

// Used by the daily transfer limit check
transactionSchema.index({ fromAccount: 1, createdAt: -1 });

const transactionModel = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);

export default transactionModel;
