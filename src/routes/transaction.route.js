import express from 'express';
import verifyJWT from '../middlewares/auth.middleware.js';
import { moneyLimiter } from '../middlewares/rateLimit.middleware.js';
import transactionController, { getTransactionStatus } from '../controllers/transaction.controller.js';

const router = express.Router();

router.use(verifyJWT);

router.post('/', moneyLimiter, transactionController);
router.get('/status/:idempotencyKey', getTransactionStatus);

export default router;
