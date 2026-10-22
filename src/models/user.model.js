import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please fill a valid email address'],
    },
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters long'],
      // bcrypt only uses the first 72 bytes, so cap the length
      maxlength: [72, 'Password must be at most 72 characters long'],
      // Validates the PLAINTEXT password before it gets hashed
      match: [
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).+$/,
        'Password must contain at least one uppercase letter, one lowercase letter, one digit, and one special character.',
      ],
      select: false, // never returned unless explicitly requested
    },
    // Only set by an admin script (scripts/create-superuser.js), never via the API
    role: {
      type: String,
      enum: ['USER', 'SUPERUSER'],
      default: 'USER',
    },

    // Account lockout after repeated failed logins
    failedLoginCount: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, select: false },

    // Two-factor auth (TOTP). Required for superuser money/admin actions.
    totpEnabled: { type: Boolean, default: false },
    totpSecretEnc: { type: String, select: false }, // AES-256-GCM encrypted
    totpLastStep: { type: Number, default: 0, select: false }, // blocks code replay
  },
  { timestamps: true }
);

// Runs AFTER validation passes, right before saving to MongoDB
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// Note: the document must be loaded with .select('+password')
userSchema.methods.comparePassword = function (password) {
  return bcrypt.compare(password, this.password);
};

const userModel = mongoose.models.User || mongoose.model('User', userSchema);

export default userModel;
