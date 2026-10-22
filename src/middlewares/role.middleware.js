import userModel from '../models/user.model.js';

// Use AFTER verifyJWT. Role is read from the database (not the token), so a
// demoted user loses access immediately.
export const requireSuperuser = async (req, res, next) => {
  try {
    const user = await userModel.findById(req.userId).select('role');
    if (!user || user.role !== 'SUPERUSER') {
      return res.status(403).json({ error: 'Superuser access required' });
    }
    next();
  } catch (err) {
    next(err);
  }
};
