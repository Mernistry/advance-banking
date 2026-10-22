// Blocks NoSQL operator injection (e.g. {"email": {"$ne": null}}) and prototype pollution.
// Our inputs are plain strings/numbers, so any key starting with "$" or containing "."
// is rejected outright instead of being "cleaned".
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isUnsafe = (value, depth = 0) => {
  if (depth > 6) return true;
  if (Array.isArray(value)) return value.some((v) => isUnsafe(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, val]) => key.startsWith('$') || key.includes('.') || FORBIDDEN_KEYS.has(key) || isUnsafe(val, depth + 1)
    );
  }
  return false;
};

export const rejectMongoOperators = (req, res, next) => {
  if (isUnsafe(req.body) || isUnsafe(req.query) || isUnsafe(req.params)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  next();
};
