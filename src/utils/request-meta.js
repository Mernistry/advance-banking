export const reqMeta = (req) => ({
  ip: req.ip || '',
  userAgent: (req.get('user-agent') || '').slice(0, 200),
});
