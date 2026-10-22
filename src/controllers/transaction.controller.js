import transactionModel from '../models/transaction.model.js';
import { processTransfer } from '../services/transfer.service.js';
import { HttpError } from '../utils/http-error.js';
import { env } from '../config/env.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const MAX_KEY_LENGTH = 128;

// Shared by the transfer and deposit controllers
export const parseMoneyBody = (body, idFields, maxAmount) => {
  const isId = (v) => typeof v === 'string' && OBJECT_ID.test(v);
  for (const field of idFields) {
    if (!isId(body[field])) throw new HttpError(400, `Valid ${idFields.join(' and ')} ids are required`);
  }
  if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim() ||
      body.idempotencyKey.length > MAX_KEY_LENGTH) {
    throw new HttpError(400, `idempotencyKey is required (max ${MAX_KEY_LENGTH} chars)`);
  }
  if (!Number.isSafeInteger(body.amount) || body.amount <= 0) {
    throw new HttpError(400, 'Amount must be a positive integer in minor units (paise)');
  }
  if (body.amount > maxAmount) {
    throw new HttpError(400, `Amount exceeds the per-request limit of ${maxAmount} paise`);
  }
  return {
    amount: body.amount,
    idempotencyKey: body.idempotencyKey.trim(),
    ids: Object.fromEntries(idFields.map((f) => [f, body[f].toLowerCase()])),
  };
};

export const sendResult = (res, { transaction, replayed }, message) =>
  replayed
    ? res.status(200).json({ message: 'Transaction already processed', replayed: true, transaction })
    : res.status(201).json({ message, transaction });

export const handleError = (res, err, label) => {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Internal Server Error' });
};

/* ---------- POST /api/transactions ---------- */
const transactionController = async (req, res) => {
  try {
    const { amount, idempotencyKey, ids } = parseMoneyBody(
      req.body ?? {}, ['fromAccount', 'toAccount'], env.MAX_TRANSFER
    );
    if (ids.fromAccount === ids.toAccount) throw new HttpError(400, 'Cannot transfer to the same account');

    const result = await processTransfer({
      actorId: String(req.userId),
      fromAccount: ids.fromAccount,
      toAccount: ids.toAccount,
      amount,
      idempotencyKey,
      kind: 'TRANSFER',
    });
    return sendResult(res, result, 'Transaction Successful');
  } catch (err) {
    return handleError(res, err, 'Transaction Controller Error');
  }
};

/* ---------- GET /api/transactions/status/:idempotencyKey ---------- */
export const getTransactionStatus = async (req, res) => {
  try {
    const tx = await transactionModel
      .findOne({ initiatedBy: req.userId, idempotencyKey: req.params.idempotencyKey })
      .select('status type amount fromAccount toAccount createdAt');
    if (!tx) return res.status(404).json({ message: 'Transaction not found' });
    return res.json({ status: tx.status, transaction: tx });
  } catch (err) {
    return handleError(res, err, 'Transaction status error');
  }
};

export default transactionController;
