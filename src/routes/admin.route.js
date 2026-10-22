import express from 'express';
import verifyJWT from '../middlewares/auth.middleware.js';
import { requireSuperuser } from '../middlewares/role.middleware.js';
import { requireTotp } from '../middlewares/totp.middleware.js';
import { adminLimiter } from '../middlewares/rateLimit.middleware.js';
import depositController from '../controllers/deposit.controller.js';
import { setAccountStatus, listAudit, reconcile } from '../controllers/admin.controller.js';

const router = express.Router();

router.use(verifyJWT, requireSuperuser, adminLimiter);

// State-changing actions need a fresh 2FA code (body.totpCode)
router.post('/deposits', requireTotp, depositController);
router.patch('/accounts/:id/status', requireTotp, setAccountStatus);

// Read-only
router.get('/audit', listAudit);
router.get('/reconcile', reconcile);

export default router;
