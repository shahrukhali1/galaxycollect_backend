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

dotenv.config();
mongoose.set('strictQuery', true);

const hasCloudinaryConfig = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

const app = express();
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
  origin: (origin, callback) => {
    if (!origin || isAllowedOrigin(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
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
      shippingAddress
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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend server running on ${PORT}`);
  });
}

export default app;
