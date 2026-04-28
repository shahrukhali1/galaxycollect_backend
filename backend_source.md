# ZFourCollections Backend Source Code

This document contains the complete backend source code for the ZFourCollections e-commerce application.

## 1. Package Configuration
### package.json
```json
{
  "name": "zfour-backend",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20.19.0"
  },
  "scripts": {
    "dev": "tsx api/index.js",
    "start": "node api/index.js",
    "seed:super-admin": "node scripts/seedSuperAdmin.js"
  },
  "dependencies": {
    "@google/genai": "^1.29.0",
    "bcryptjs": "^3.0.2",
    "cloudinary": "^1.41.3",
    "connect-mongo": "^5.1.0",
    "cookie-parser": "^1.4.7",
    "cors": "^2.8.6",
    "dotenv": "^17.4.2",
    "express": "^4.22.1",
    "express-session": "^1.19.0",
    "mongoose": "^8.23.0",
    "multer": "^2.1.1",
    "multer-storage-cloudinary": "^4.0.0",
    "passport": "^0.7.0",
    "passport-google-oauth20": "^2.0.0",
    "socket.io": "^4.8.3"
  },
  "devDependencies": {
    "@types/cookie-parser": "^1.4.10",
    "@types/cors": "^2.8.19",
    "@types/express": "^4.17.21",
    "@types/express-session": "^1.19.0",
    "@types/node": "^22.14.0",
    "@types/passport": "^1.0.17",
    "@types/passport-google-oauth20": "^2.0.17",
    "tsx": "^4.21.0",
    "typescript": "~5.8.2"
  }
}
```

## 2. API Routes & Server Logic
### api/index.js
```javascript
import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import Blog from './models/Blog.js';
import Product from './models/Product.js';
import User from './models/User.js';
import Order from './models/Order.js';
import Banner from './models/Banner.js';
import Category from './models/Category.js';
import Wishlist from './models/Wishlist.js';
import Coupon from './models/Coupon.js';
import http from 'http';
import { Server } from 'socket.io';

dotenv.config();
mongoose.set('strictQuery', true);

const hasCloudinaryConfig = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  socket.on('join_chat', (userId) => {
    socket.join(userId);
  });

  socket.on('send_message', (data) => {
    // data: { senderId, receiverId, message, timestamp }
    io.to(data.receiverId).emit('new_message', data);
    io.to(data.senderId).emit('message_sent', data);
  });
});

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('etag', 'strong');

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (process.env.NODE_ENV !== 'production') return true;
  if (origin.includes('localhost') || origin.includes('vercel.app')) return true;
  return allowedOrigins.some((allowed) => origin === allowed || origin.startsWith(`${allowed}/`));
};

let dbConnectPromise = null;

async function connectToDatabase() {
  if (mongoose.connection.readyState === 1) return;
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured on the server.');

  if (!dbConnectPromise) {
    dbConnectPromise = mongoose.connect(process.env.MONGO_URI, {
      family: 4,
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 20),
      minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 5),
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000),
      socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000)
    }).catch((err) => {
      dbConnectPromise = null;
      throw err;
    });
  }
  await dbConnectPromise;
}

const createSimpleCache = (ttlMs) => {
  let expiresAt = 0;
  let value = null;
  return {
    get: () => (Date.now() < expiresAt ? value : null),
    set: (nextValue) => {
      value = nextValue;
      expiresAt = Date.now() + ttlMs;
    },
    clear: () => {
      value = null;
      expiresAt = 0;
    }
  };
};

const blogListCache = createSimpleCache(15_000);
const productListCache = createSimpleCache(15_000);
const bannerListCache = createSimpleCache(30_000);
const categoryListCache = createSimpleCache(60_000);
let uploadMiddlewarePromise = null;
let genAIClientPromise = null;
const loginAttempts = new Map();
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS || 5);
const LOGIN_LOCK_DURATION_MS = Number(process.env.LOGIN_LOCK_DURATION_MS || 30 * 60 * 1000);

const makeError = (error, code, message) => ({ error, code, message });
const toPublicUser = (user) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  role: user.role
});

const consumeLoginAttempt = (ip, email) => {
  const key = `${ip}:${email}`;
  const now = Date.now();
  const attempt = loginAttempts.get(key);

  if (!attempt || now > attempt.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS });
    return false;
  }

  attempt.count += 1;
  loginAttempts.set(key, attempt);
  return attempt.count > LOGIN_RATE_LIMIT_MAX_ATTEMPTS;
};

const clearLoginAttempt = (ip, email) => {
  loginAttempts.delete(`${ip}:${email}`);
};

const getSessionUser = (req) => req.session?.authUser || null;
const requireAuthenticatedUser = (req, res, next) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json(makeError('Unauthorized', 'UNAUTHORIZED', 'Unauthorized'));
  return next();
};

const requireSuperAdmin = (req, res, next) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json(makeError('Unauthorized', 'UNAUTHORIZED', 'Authentication required'));
  }
  if (user.role !== 'super_admin') {
    return res.status(403).json(makeError('Forbidden', 'FORBIDDEN', 'Super admin access required'));
  }
  return next();
};

const auditAdminAction = (action) => (req, _res, next) => {
  const actor = getSessionUser(req);
  console.info('[ADMIN_AUDIT]', {
    action,
    userId: actor?.id || null,
    email: actor?.email || null,
    method: req.method,
    path: req.originalUrl,
    at: new Date().toISOString()
  });
  next();
};

const getUploadMiddleware = async () => {
  if (!hasCloudinaryConfig) return null;
  if (!uploadMiddlewarePromise) {
    uploadMiddlewarePromise = (async () => {
      const [{ v2: cloudinary }, multerModule, cloudinaryStorageModule] = await Promise.all([
        import('cloudinary'),
        import('multer'),
        import('multer-storage-cloudinary')
      ]);
      const multer = multerModule.default;
      const { CloudinaryStorage } = cloudinaryStorageModule;

      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
      });

      return multer({
        storage: new CloudinaryStorage({
          cloudinary,
          params: async (_req, file) => ({
            folder: 'zfour_collections',
            format: 'webp',
            public_id: `${Date.now()}-${file.originalname.split('.')[0]}`
          })
        })
      });
    })().catch((error) => {
      uploadMiddlewarePromise = null;
      throw error;
    });
  }

  return uploadMiddlewarePromise;
};

const getGenAIClient = async () => {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) return null;
  if (!genAIClientPromise) {
    genAIClientPromise = import('@google/genai')
      .then(({ GoogleGenAI }) => new GoogleGenAI({ apiKey: geminiApiKey }))
      .catch((error) => {
        genAIClientPromise = null;
        throw error;
      });
  }

  return genAIClientPromise;
};

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'zfour-secret-key',
  store: process.env.MONGO_URI ? MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    ttl: 24 * 60 * 60,
    autoRemove: 'native'
  }) : undefined,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? (process.env.SESSION_COOKIE_SAME_SITE || 'none') : 'lax',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/auth/google/callback',
    passReqToCallback: true
  }, (_req, _accessToken, _refreshToken, profile, done) => {
    done(null, {
      uid: profile.id,
      email: profile.emails?.[0].value,
      displayName: profile.displayName,
      photoURL: profile.photos?.[0].value,
      provider: 'google'
    });
  }));
}

app.get('/', (_req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});
app.get('/api/health', (_req, res) => res.json({ status: 'ok', env: process.env.NODE_ENV }));
app.get('/api/auth/user', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json(makeError('Unauthorized', 'UNAUTHORIZED', 'Unauthorized'));
  return res.json(user);
});

app.post('/api/auth/super-admin/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(401).json(makeError('Unauthorized', 'INVALID_CREDENTIALS', 'Invalid email or password'));
    }

    const tooManyAttempts = consumeLoginAttempt(req.ip, email);
    if (tooManyAttempts) {
      return res.status(429).json(makeError('Too Many Requests', 'TOO_MANY_ATTEMPTS', 'Too many login attempts'));
    }

    await connectToDatabase();
    const user = await User.findOne({ email });
    const isPasswordValid = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !isPasswordValid) {
      if (user) {
        const failures = (user.loginFailures || 0) + 1;
        const shouldLock = failures >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS;
        await User.updateOne(
          { _id: user._id },
          {
            $set: {
              loginFailures: failures,
              ...(shouldLock ? { lockedUntil: new Date(Date.now() + LOGIN_LOCK_DURATION_MS) } : {})
            }
          }
        );
      }
      return res.status(401).json(makeError('Unauthorized', 'INVALID_CREDENTIALS', 'Invalid email or password'));
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return res.status(429).json(makeError('Too Many Requests', 'ACCOUNT_LOCKED', 'Account temporarily locked'));
    }

    if (user.role !== 'super_admin') {
      return res.status(403).json(makeError('Forbidden', 'FORBIDDEN', 'Super admin access required'));
    }

    const sessionUser = toPublicUser(user);
    req.session.authUser = sessionUser;
    clearLoginAttempt(req.ip, email);
    await User.updateOne({ _id: user._id }, { $set: { loginFailures: 0, lockedUntil: null } });

    return res.status(200).json({ ok: true, user: sessionUser });
  } catch (error) {
    return res.status(500).json(makeError('Internal Server Error', 'INTERNAL_SERVER_ERROR', error.message));
  }
});

app.get('/api/auth/google/url', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'Google Client ID not configured' });
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'profile email',
    prompt: 'select_account'
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get(['/auth/google/callback', '/auth/google/callback/'],
  passport.authenticate('google', { failureRedirect: '/login-failure' }),
  (req, res) => {
    res.send(`<html><body><script>
      if (window.opener) {
        window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', user: ${JSON.stringify(req.user)} }, '*');
        window.close();
      } else { window.location.href = '/'; }
    </script></body></html>`);
  }
);

app.post('/api/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json(makeError('Internal Server Error', 'LOGOUT_FAILED', 'Logout failed'));
    req.session.destroy((sessionErr) => {
      if (sessionErr) return res.status(500).json(makeError('Internal Server Error', 'LOGOUT_FAILED', 'Logout failed'));
      res.clearCookie('connect.sid', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? (process.env.SESSION_COOKIE_SAME_SITE || 'none') : 'lax'
      });
      return res.status(200).json({ ok: true });
    });
  });
});

app.get('/api/blogs', async (_req, res) => {
  try {
    const cachedBlogs = blogListCache.get();
    if (cachedBlogs) return res.json(cachedBlogs);

    await connectToDatabase();
    const blogs = await Blog.find().sort({ createdAt: -1 }).lean();
    blogListCache.set(blogs);
    res.json(blogs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/blogs', requireSuperAdmin, auditAdminAction('blog_create'), async (req, res) => {
  try {
    await connectToDatabase();
    const newBlog = new Blog(req.body);
    await newBlog.save();
    blogListCache.clear();
    res.status(201).json(newBlog);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/blogs/:id', requireSuperAdmin, auditAdminAction('blog_update'), async (req, res) => {
  try {
    await connectToDatabase();
    const updatedBlog = await Blog.findOneAndUpdate(
      { _id: req.params.id },
      { ...req.body, updatedAt: Date.now() },
      { new: true }
    );
    blogListCache.clear();
    res.json(updatedBlog);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/blogs/:id', requireSuperAdmin, auditAdminAction('blog_delete'), async (req, res) => {
  try {
    await connectToDatabase();
    await Blog.findOneAndDelete({ _id: req.params.id });
    blogListCache.clear();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/products', async (_req, res) => {
  try {
    const cachedProducts = productListCache.get();
    if (cachedProducts) return res.json(cachedProducts);

    await connectToDatabase();
    const products = await Product.find().sort({ createdAt: -1 }).lean();
    productListCache.set(products);
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products', requireSuperAdmin, auditAdminAction('product_create'), async (req, res) => {
  try {
    await connectToDatabase();
    const newProduct = new Product(req.body);
    await newProduct.save();
    productListCache.clear();
    res.status(201).json(newProduct);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/products/:id', requireSuperAdmin, auditAdminAction('product_update'), async (req, res) => {
  try {
    await connectToDatabase();
    const updatedProduct = await Product.findOneAndUpdate(
      { _id: req.params.id },
      { ...req.body, updatedAt: Date.now() },
      { new: true }
    );
    productListCache.clear();
    res.json(updatedProduct);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/products/:id', requireSuperAdmin, auditAdminAction('product_delete'), async (req, res) => {
  try {
    await connectToDatabase();
    await Product.findOneAndDelete({ _id: req.params.id });
    productListCache.clear();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/categories', async (_req, res) => {
  try {
    const cached = categoryListCache.get();
    if (cached) return res.json(cached);

    await connectToDatabase();
    const categories = await Category.find().sort({ name: 1 }).lean();
    categoryListCache.set(categories);
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/categories', requireSuperAdmin, auditAdminAction('category_create'), async (req, res) => {
  try {
    await connectToDatabase();
    const newCategory = new Category(req.body);
    await newCategory.save();
    categoryListCache.clear();
    res.status(201).json(newCategory);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/categories/:id', requireSuperAdmin, auditAdminAction('category_update'), async (req, res) => {
  try {
    await connectToDatabase();
    const updated = await Category.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
      { new: true }
    );
    categoryListCache.clear();
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/categories/:id', requireSuperAdmin, auditAdminAction('category_delete'), async (req, res) => {
  try {
    await connectToDatabase();
    await Category.findByIdAndDelete(req.params.id);
    categoryListCache.clear();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/banners', async (_req, res) => {
  try {
    const cachedBanners = bannerListCache.get();
    if (cachedBanners) return res.json(cachedBanners);

    await connectToDatabase();
    const banners = await Banner.find({ isActive: true }).sort({ createdAt: -1 }).lean();
    bannerListCache.set(banners);
    return res.json(banners);
  } catch (error) {
    return res.status(500).json(makeError('Internal Server Error', 'INTERNAL_SERVER_ERROR', error.message));
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    await connectToDatabase();
    const payload = req.body || {};
    const sessionUser = getSessionUser(req);
    const customerId = sessionUser?.id || String(payload.customerId || '').trim();
    const customerName = String(payload.customerName || '').trim();
    const email = String(payload.email || sessionUser?.email || '').trim().toLowerCase();
    const paymentMethod = String(payload.paymentMethod || '').trim();
    const items = Array.isArray(payload.items) ? payload.items : [];
    const shippingAddress = payload.shippingAddress || {};
    const providedTotal = Number(payload.total);
    const totalFromItems = items.reduce((sum, item) => {
      const price = Number(item?.price || 0);
      const quantity = Number(item?.quantity || 0);
      return sum + (price * quantity);
    }, 0);
    const total = Number.isFinite(providedTotal) && providedTotal > 0 ? providedTotal : totalFromItems;

    if (!customerId || !customerName || !email || !paymentMethod || !items.length || !shippingAddress?.address || !shippingAddress?.city || !shippingAddress?.zipCode || !shippingAddress?.phone) {
      return res.status(400).json(makeError('Bad Request', 'VALIDATION_ERROR', 'Missing required order fields'));
    }

    const order = await Order.create({
      orderId: `ORD-${Date.now()}${Math.floor(Math.random() * 1000)}`,
      customerId,
      customerName,
      email,
      items,
      total,
      status: String(payload.status || 'Pending'),
      paymentMethod,
      shippingAddress,
      couponCode: String(payload.couponCode || '').trim(),
      discountAmount: Number(payload.discountAmount || 0)
    });

    return res.status(201).json({
      id: String(order._id),
      orderId: order.orderId,
      customerId: order.customerId,
      customerName: order.customerName,
      email: order.email,
      items: order.items,
      total: order.total,
      status: order.status,
      paymentMethod: order.paymentMethod,
      shippingAddress: order.shippingAddress,
      createdAt: order.createdAt
    });
  } catch (error) {
    return res.status(500).json(makeError('Internal Server Error', 'INTERNAL_SERVER_ERROR', error.message));
  }
});

app.get('/api/wishlist/:userId', async (req, res) => {
  try {
    await connectToDatabase();
    const wishlist = await Wishlist.findOne({ userId: req.params.userId }).populate('products').lean();
    res.json(wishlist || { userId: req.params.userId, products: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/wishlist/toggle', async (req, res) => {
  try {
    await connectToDatabase();
    const { userId, productId } = req.body;
    let wishlist = await Wishlist.findOne({ userId });
    if (!wishlist) {
      wishlist = new Wishlist({ userId, products: [productId] });
    } else {
      const index = wishlist.products.indexOf(productId);
      if (index > -1) {
        wishlist.products.splice(index, 1);
      } else {
        wishlist.products.push(productId);
      }
    }
    await wishlist.save();
    res.json(wishlist);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/coupons/:code', async (req, res) => {
  try {
    await connectToDatabase();
    const coupon = await Coupon.findOne({ 
      code: req.params.code.toUpperCase(),
      isActive: true 
    }).lean();
    if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
    res.json(coupon);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/coupons', requireSuperAdmin, async (_req, res) => {
  try {
    await connectToDatabase();
    const coupons = await Coupon.find().sort({ createdAt: -1 }).lean();
    res.json(coupons);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/coupons', requireSuperAdmin, auditAdminAction('coupon_create'), async (req, res) => {
  try {
    await connectToDatabase();
    const { code, discountPercentage, isActive } = req.body;
    const newCoupon = new Coupon({ 
      code: code.toUpperCase(), 
      discountPercentage, 
      isActive 
    });
    await newCoupon.save();
    res.status(201).json(newCoupon);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/coupons/:id', requireSuperAdmin, auditAdminAction('coupon_delete'), async (req, res) => {
  try {
    await connectToDatabase();
    await Coupon.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/banners', async (_req, res) => {
  try {
    await connectToDatabase();
    const banners = await Banner.find({ isActive: true }).sort({ order: 1 }).lean();
    res.json(banners);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/banners', requireSuperAdmin, async (_req, res) => {
  try {
    await connectToDatabase();
    const banners = await Banner.find().sort({ order: 1 }).lean();
    res.json(banners);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/banners', requireSuperAdmin, auditAdminAction('banner_create'), async (req, res) => {
  try {
    await connectToDatabase();
    const newBanner = new Banner(req.body);
    await newBanner.save();
    res.status(201).json(newBanner);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/banners/:id', requireSuperAdmin, auditAdminAction('banner_delete'), async (req, res) => {
  try {
    await connectToDatabase();
    await Banner.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/orders', requireSuperAdmin, auditAdminAction('order_list'), async (_req, res) => {
  try {
    await connectToDatabase();
    const orders = await Order.find().sort({ createdAt: -1 }).lean();
    return res.json(orders.map((order) => ({
      id: String(order._id),
      ...order
    })));
  } catch (error) {
    return res.status(500).json(makeError('Internal Server Error', 'INTERNAL_SERVER_ERROR', error.message));
  }
});

app.get('/api/orders/my', requireAuthenticatedUser, async (req, res) => {
  try {
    await connectToDatabase();
    const user = getSessionUser(req);
    const orders = await Order.find({ customerId: user.id }).sort({ createdAt: -1 }).lean();
    return res.json(orders.map((order) => ({
      id: String(order._id),
      ...order
    })));
  } catch (error) {
    return res.status(500).json(makeError('Internal Server Error', 'INTERNAL_SERVER_ERROR', error.message));
  }
});

app.patch('/api/orders/:id/status', requireSuperAdmin, auditAdminAction('order_status_update'), async (req, res) => {
  try {
    await connectToDatabase();
    const status = String(req.body?.status || '').trim();
    if (!status) return res.status(400).json(makeError('Bad Request', 'VALIDATION_ERROR', 'Status is required'));
    const updatedOrder = await Order.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true }).lean();
    if (!updatedOrder) return res.status(404).json(makeError('Not Found', 'NOT_FOUND', 'Order not found'));
    return res.json({ id: String(updatedOrder._id), ...updatedOrder });
  } catch (error) {
    return res.status(500).json(makeError('Internal Server Error', 'INTERNAL_SERVER_ERROR', error.message));
  }
});

app.delete('/api/orders/:id', requireSuperAdmin, auditAdminAction('order_delete'), async (req, res) => {
  try {
    await connectToDatabase();
    const deletedOrder = await Order.findByIdAndDelete(req.params.id).lean();
    if (!deletedOrder) return res.status(404).json(makeError('Not Found', 'NOT_FOUND', 'Order not found'));
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json(makeError('Internal Server Error', 'INTERNAL_SERVER_ERROR', error.message));
  }
});

app.post('/api/upload', requireSuperAdmin, auditAdminAction('upload_create'), async (req, res, next) => {
  try {
    const upload = await getUploadMiddleware();
    if (!upload) return res.status(500).json(makeError('Internal Server Error', 'UPLOAD_UNAVAILABLE', 'Cloudinary is not configured on the server.'));
    upload.single('image')(req, res, next);
  } catch (error) {
    return res.status(500).json(makeError('Internal Server Error', 'UPLOAD_UNAVAILABLE', error.message || 'Upload service is unavailable.'));
  }
}, (req, res) => {
  if (!req.file) return res.status(400).json(makeError('Bad Request', 'NO_FILE_UPLOADED', 'No file uploaded'));
  res.json({ url: req.file.path });
});

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  const genAI = await getGenAIClient();
  if (!genAI) return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });

  try {
    const response = await genAI.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: [...(history || []), { role: 'user', parts: [{ text: message }] }],
      config: {
        systemInstruction: `You are the AI Customer Assistant for "zFourCollections", a premium luxury boutique specializing in Girls' Clothing.
Your tone is sophisticated, helpful, and high-end.
Keep replies concise (under 3 sentences unless asked for details).`,
        temperature: 0.7
      }
    });
    res.json({ text: response.text || "I'm sorry, I couldn't process that. How else can I help?" });
  } catch {
    res.status(500).json({ error: 'Failed to generate AI response' });
  }
});

app.use('/api/admin/*', requireSuperAdmin);

app.use('/api/*', (_req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message || 'Internal Server Error' }));

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend server with Socket.io running on ${PORT}`);
  });
}

export default app;
```

## 3. Database Models
### api/models/Banner.js
```javascript
import mongoose from 'mongoose';

const BannerSchema = new mongoose.Schema({
  title: { type: String, required: true },
  subtitle: { type: String, required: true },
  description: { type: String, required: true },
  image: { type: String, required: true },
  cta: { type: String, required: true },
  color: { type: String, default: 'bg-blue-50' },
  isActive: { type: Boolean, default: true, index: true }
}, {
  timestamps: true
});

BannerSchema.index({ isActive: 1, createdAt: -1 });

const Banner = mongoose.models.Banner || mongoose.model('Banner', BannerSchema);
export default Banner;
```

### api/models/Blog.js
```javascript
import mongoose from 'mongoose';

const BlogSchema = new mongoose.Schema({
  title: { type: String, required: true },
  imageURL: { type: String, required: true },
  description: { type: String, required: true },
  category: { type: String, required: true }
}, {
  timestamps: true
});

BlogSchema.index({ createdAt: -1 });

const Blog = mongoose.models.Blog || mongoose.model('Blog', BlogSchema);
export default Blog;
```

### api/models/Category.js
```javascript
import mongoose from 'mongoose';

const CategorySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  image: { type: String },
  isPopular: { type: Boolean, default: false },
  status: { type: String, default: 'Active' }
}, {
  timestamps: true
});

const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
export default Category;
```

### api/models/Order.js
```javascript
import mongoose from 'mongoose';

const OrderItemSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true },
  image: { type: String }
}, { _id: false });

const ShippingAddressSchema = new mongoose.Schema({
  address: { type: String, required: true },
  city: { type: String, required: true },
  zipCode: { type: String, required: true },
  phone: { type: String, required: true }
}, { _id: false });

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true, index: true },
  customerId: { type: String, required: true, index: true },
  customerName: { type: String, required: true },
  email: { type: String, required: true },
  items: { type: [OrderItemSchema], required: true },
  total: { type: Number, required: true },
  status: { type: String, default: 'Pending', index: true },
  paymentMethod: { type: String, required: true },
  shippingAddress: { type: ShippingAddressSchema, required: true },
  couponCode: { type: String },
  discountAmount: { type: Number, default: 0 }
}, {
  timestamps: true
});

OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ customerId: 1, createdAt: -1 });

const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);
export default Order;
```

### api/models/Product.js
```javascript
import mongoose from 'mongoose';

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mainImage: { type: String, required: true },
  category: { type: String, required: true },
  regularPrice: { type: Number, required: true },
  salePrice: { type: Number },
  fullDescription: { type: String, required: true },
  stockStatus: { type: String, default: 'In Stock' },
  quantity: { type: Number, required: true },
  isBestSeller: { type: Boolean, default: false },
  isNewArrival: { type: Boolean, default: false },
  isSpecialOffer: { type: Boolean, default: false },
  status: { type: String, default: 'Active' }
}, {
  timestamps: true
});

ProductSchema.index({ createdAt: -1 });
ProductSchema.index({ category: 1, createdAt: -1 });

const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema);
export default Product;
```

### api/models/User.js
```javascript
import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({

const WishlistSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }]
}, {
  timestamps: true
});

const Wishlist = mongoose.models.Wishlist || mongoose.model('Wishlist', WishlistSchema);
export default Wishlist;
```

### api/models/Coupon.js
```javascript
import mongoose from 'mongoose';

const CouponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true },
  discountPercentage: { type: Number, required: true },
  isActive: { type: Boolean, default: true }
}, {
  timestamps: true
});

const Coupon = mongoose.models.Coupon || mongoose.model('Coupon', CouponSchema);
export default Coupon;
```

## 4. Scripts
### scripts/seedSuperAdmin.js
```javascript
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
```

## 5. Deployment & Configuration
### vercel.json
```json
{
  "version": 2,
  "rewrites": [
    {
      "source": "/",
      "destination": "/api/[...all].js"
    },
    {
      "source": "/api/(.*)",
      "destination": "/api/[...all].js"
    },
    {
      "source": "/auth/(.*)",
      "destination": "/api/[...all].js"
    }
  ]
}
```

### .env.example
```bash
# MongoDB
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/zfour?retryWrites=true&w=majority

# Cloudinary
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# Secret for session
SESSION_SECRET=zfour-secret-key-very-secret

# Gemini AI
GEMINI_API_KEY=your_key_here

# CORS allowlist (comma separated)
ALLOWED_ORIGINS=https://galaxycollection.vercel.app
```

## 6. Frontend API Integration
### src/lib/api.ts
```typescript
const DEFAULT_API_BASE_URL = 'https://galaxycollect-backend.vercel.app';
const rawApiBaseUrl = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL).trim();

const normalizedApiBaseUrl = rawApiBaseUrl.replace(/\/+$/, '');

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (!path.startsWith('/')) return `${normalizedApiBaseUrl}/${path}`;
  return `${normalizedApiBaseUrl}${path}`;
}

export function apiFetch(path: string, init: RequestInit = {}) {
  return fetch(apiUrl(path), {
    credentials: 'include',
    ...init,
  });
}
```
### api/models/Banner.js
```javascript
import mongoose from 'mongoose';

const BannerSchema = new mongoose.Schema({
  title: { type: String, required: true },
  subtitle: { type: String },
  description: { type: String },
  image: { type: String, required: true },
  cta: { type: String, default: 'Shop Now' },
  link: { type: String, default: '/shop' },
  color: { type: String, default: 'bg-stone-50' },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true }
}, {
  timestamps: true
});

const Banner = mongoose.models.Banner || mongoose.model('Banner', BannerSchema);
export default Banner;
```
