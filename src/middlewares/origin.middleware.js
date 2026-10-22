import { env } from '../config/env.js';

// Extra CSRF defence for cookie-based endpoints (/refresh, /logout) on top of
// SameSite=Strict: browsers always send Origin on POST, so reject foreign origins.
export const checkOrigin = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin !== env.CLIENT_ORIGIN) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
};
