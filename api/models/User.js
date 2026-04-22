import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['super_admin', 'user'], default: 'user', index: true },
  loginFailures: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null }
}, {
  timestamps: true
});

UserSchema.index({ email: 1 }, { unique: true });

const User = mongoose.models.User || mongoose.model('User', UserSchema);
export default User;
