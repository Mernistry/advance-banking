import auditModel from '../models/audit.model.js';

// Inside a DB transaction: if the audit write fails, the whole operation rolls back.
export const auditInTx = (entry, session) => auditModel.create([entry], { session });

// Outside a transaction (security events): never let logging break the request.
export const logAudit = async (entry) => {
  try {
    await auditModel.create([entry]);
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
};
