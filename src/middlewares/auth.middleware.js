import jwt from 'jsonwebtoken';
import sessionModel from '../models/session.model.js';
import { env } from '../config/env.js';
import { VERIFY_OPTS } from '../services/session.service.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;

// Verifies the access token AND that its session still exists in the database.
// So logout, logout-all and "revoke device" take effect immediately, not after 15 minutes.
const verifyJWT = async (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Access token missing' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, env.ACCESS_SECRET, VERIFY_OPTS);
  } catch (err) {
    // 401 so the client knows it should call /refresh
    const message = err.name === 'TokenExpiredError' ? 'Access token expired' : 'Access token invalid';
    return res.status(401).json({ error: message });
  }

  if (!OBJECT_ID.test(String(decoded.userId)) || !OBJECT_ID.test(String(decoded.sid))) {
    return res.status(401).json({ error: 'Access token invalid' });
  }

  try {
    const alive = await sessionModel.exists({ _id: decoded.sid, user: decoded.userId });
    if (!alive) return res.status(401).json({ error: 'Session revoked, please log in again' });
  } catch (err) {
    return next(err);
  }

  req.userId = decoded.userId;
  req.sessionId = decoded.sid;
  next();
};

export default verifyJWT;
