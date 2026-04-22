import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import Blog from './models/Blog.ts';
import Product from './models/Product.ts';
import { GoogleGenAI } from '@google/genai';

dotenv.config();
mongoose.set('strictQuery', true);

const hasCloudinaryConfig = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (hasCloudinaryConfig) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

const upload = hasCloudinaryConfig
  ? multer({
      storage: new CloudinaryStorage({
        cloudinary: cloudinary,
        params: async (_req, file) => ({
          folder: 'zfour_collections',
          format: 'webp',
          public_id: `${Date.now()}-${file.originalname.split('.')[0]}`,
        }),
      }),
    })
  : null;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('etag', 'strong');

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const isAllowedOrigin = (origin: string) => {
  if (!origin) return true;
  if (process.env.NODE_ENV !== 'production') return true;
  if (origin.includes('localhost') || origin.includes('vercel.app')) return true;
  return allowedOrigins.some((allowed) => origin === allowed || origin.startsWith(`${allowed}/`));
};

let dbConnectPromise: Promise<typeof mongoose> | null = null;

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

const createSimpleCache = <T>(ttlMs: number) => {
  let expiresAt = 0;
  let value: T | null = null;
  return {
    get: () => (Date.now() < expiresAt ? value : null),
    set: (nextValue: T) => {
      value = nextValue;
      expiresAt = Date.now() + ttlMs;
    },
    clear: () => {
      value = null;
      expiresAt = 0;
    }
  };
};

const blogListCache = createSimpleCache<any[]>(15_000);
const productListCache = createSimpleCache<any[]>(15_000);
const geminiApiKey = process.env.GEMINI_API_KEY;
const genAI = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

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
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user: any, done) => done(null, user));
passport.deserializeUser((user: any, done) => done(null, user));

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

app.get('/api/health', (_req, res) => res.json({ status: 'ok', env: process.env.NODE_ENV }));
app.get('/api/auth/user', (req, res) => res.json(req.user || null));

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
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ success: true });
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/blogs', async (req, res) => {
  try {
    await connectToDatabase();
    const newBlog = new Blog(req.body);
    await newBlog.save();
    blogListCache.clear();
    res.status(201).json(newBlog);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/blogs/:id', async (req, res) => {
  try {
    await connectToDatabase();
    const updatedBlog = await Blog.findOneAndUpdate(
      { _id: req.params.id },
      { ...req.body, updatedAt: Date.now() },
      { new: true }
    );
    blogListCache.clear();
    res.json(updatedBlog);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/blogs/:id', async (req, res) => {
  try {
    await connectToDatabase();
    await Blog.findOneAndDelete({ _id: req.params.id });
    blogListCache.clear();
    res.json({ success: true });
  } catch (error: any) {
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    await connectToDatabase();
    const newProduct = new Product(req.body);
    await newProduct.save();
    productListCache.clear();
    res.status(201).json(newProduct);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    await connectToDatabase();
    const updatedProduct = await Product.findOneAndUpdate(
      { _id: req.params.id },
      { ...req.body, updatedAt: Date.now() },
      { new: true }
    );
    productListCache.clear();
    res.json(updatedProduct);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await connectToDatabase();
    await Product.findOneAndDelete({ _id: req.params.id });
    productListCache.clear();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upload', (req: any, res: any, next: any) => {
  if (!upload) return res.status(500).json({ error: 'Cloudinary is not configured on the server.' });
  upload.single('image')(req, res, next);
}, (req: any, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: req.file.path });
});

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!genAI) return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });

  try {
    const response = await genAI.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: [...(history || []), { role: 'user', parts: [{ text: message }] }],
      config: {
        systemInstruction: `You are the AI Customer Assistant for "zFourCollections", a premium luxury boutique specializing in Girls' Clothing.
Your tone is sophisticated, helpful, and high-end.
Keep replies concise (under 3 sentences unless asked for details).`,
        temperature: 0.7,
      }
    });
    res.json({ text: response.text || "I'm sorry, I couldn't process that. How else can I help?" });
  } catch {
    res.status(500).json({ error: 'Failed to generate AI response' });
  }
});

app.use('/api/*', (_req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message || 'Internal Server Error' }));

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT as number, '0.0.0.0', () => {
    console.log(`Backend server running on ${PORT}`);
  });
}

export default app;

