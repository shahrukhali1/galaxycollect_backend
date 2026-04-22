import dotenv from 'dotenv';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import User from '../api/models/User.js';

dotenv.config();
mongoose.set('strictQuery', true);

async function seedSuperAdmin() {
  const mongoUri = process.env.MONGO_URI;
  const email = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD || '';
  const name = process.env.SUPER_ADMIN_NAME || 'Super Admin';

  if (!mongoUri) throw new Error('MONGO_URI is not configured.');
  if (!email || !password) {
    throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD are required.');
  }

  await mongoose.connect(mongoUri, { family: 4 });
  const passwordHash = await bcrypt.hash(password, 12);

  const user = await User.findOneAndUpdate(
    { email },
    {
      $set: {
        name,
        email,
        passwordHash,
        role: 'super_admin',
        loginFailures: 0,
        lockedUntil: null
      }
    },
    { new: true, upsert: true }
  ).lean();

  console.log(`Super admin ready: ${user.email}`);
}

seedSuperAdmin()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Failed to seed super admin:', error.message);
    await mongoose.disconnect();
    process.exit(1);
  });
