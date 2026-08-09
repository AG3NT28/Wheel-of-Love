/**
 * Wheel of Love — Café du L'Amour
 * -------------------------------
 * A tiny, dependency-light Express server that:
 *   1) Serves the public spin page and the admin dashboard
 *   2) Exposes a public API to fetch active wheel segments and spin the wheel
 *   3) Exposes a password-protected admin API to edit segments/probabilities
 *      and review the spin log.
 *
 * Segments live in a flat JSON file under /data — good enough for a
 * single-café, single-event deployment. Spins and admin sessions live in
 * MongoDB when configured, with a local-JSON / in-memory fallback so the
 * app still works (degraded) if the database is briefly unreachable.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo').default || require('connect-mongo');
const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Environment / configuration
// ---------------------------------------------------------------------------
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;

// Dev-only convenience defaults. These are NOT credentials for any real
// service — just placeholders so `npm start` works locally without a
// .env file. There is deliberately no fallback for MONGODB_URI: a real
// database connection string must never live in source control.
const DEV_FALLBACKS = {
  ADMIN_PASSWORD: 'change-this-password',
  SESSION_SECRET: 'dev-only-insecure-secret-change-me',
};

function validateEnv() {
  const required = { MONGODB_URI, SESSION_SECRET, ADMIN_PASSWORD };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (!missing.length) return;

  if (IS_PRODUCTION) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
      'Set these in your hosting environment (e.g. Render → Environment) before starting the server.'
    );
  }

  log('warn', `Missing environment variable(s): ${missing.join(', ')}. Using insecure development defaults — do NOT deploy this way.`);
}

const effectiveAdminPassword = ADMIN_PASSWORD || DEV_FALLBACKS.ADMIN_PASSWORD;
const effectiveSessionSecret = SESSION_SECRET || DEV_FALLBACKS.SESSION_SECRET;

const DATA_DIR = path.join(__dirname, 'data');
const SEGMENTS_FILE = path.join(DATA_DIR, 'segments.json');
const DEFAULT_SEGMENTS_FILE = path.join(DATA_DIR, 'segments.default.json');
const SPINS_FILE = path.join(DATA_DIR, 'spins.json');

// Render (and similar PaaS free tiers) use an ephemeral filesystem that is
// wiped on every cold start. When MongoDB is connected it is the single source
// of truth; the JSON files are only used as a last-resort fallback for local
// development without a database.

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(level, ...args) {
  const stamp = new Date().toISOString();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${stamp}] [${level}]`, ...args);
}

// ---------------------------------------------------------------------------
// Small JSON file helpers (synchronous — fine for this scale of traffic)
// ---------------------------------------------------------------------------
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    // On ephemeral filesystems (e.g. Render free tier) this may fail — that is
    // acceptable because MongoDB is the primary store when connected.
    log('warn', `writeJSON(${path.basename(file)}): ${err.message}`);
  }
}

function generateCode() {
  // Avoids visually ambiguous characters (0/O, 1/I)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return `LOVE-${code}`;
}

function weightedPick(segments) {
  const active = segments.filter((s) => s.active && Number(s.weight) > 0);
  const total = active.reduce((sum, s) => sum + Number(s.weight), 0);
  if (!active.length || total <= 0) return null;

  let roll = Math.random() * total;
  for (const seg of active) {
    roll -= Number(seg.weight);
    if (roll <= 0) return seg;
  }
  return active[active.length - 1];
}

function validateSegment(seg) {
  if (typeof seg !== 'object' || seg === null) return false;
  if (typeof seg.label !== 'string' || !seg.label.trim()) return false;
  if (typeof seg.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(seg.color)) return false;
  if (typeof seg.weight !== 'number' || Number.isNaN(seg.weight) || seg.weight < 0) return false;
  return true;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// MongoDB connection, spin schema & segment schema
// ---------------------------------------------------------------------------
let mongoReady = false;

const spinSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  code: { type: String, required: true },
  segmentId: { type: String, required: true },
  segmentLabel: { type: String, required: true },
  name: String,
  phone: String,
  todayReward: String,
  futureReward: String,
  timestamp: { type: Date, required: true },
}, { timestamps: false });

const Spin = mongoose.model('Spin', spinSchema);

// Segments stored in MongoDB so admin edits survive Render free-tier cold starts.
const segmentSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  label: { type: String, required: true },
  shortLabel: String,
  icon: String,
  color: String,
  colorLight: String,
  weight: { type: Number, default: 0 },
  todayReward: String,
  futureReward: String,
  validityDays: { type: Number, default: 90 },
}, { timestamps: false });

const SegmentModel = mongoose.model('Segment', segmentSchema);

// ---------------------------------------------------------------------------
// Segment helpers — async, MongoDB-first with JSON file fallback
// ---------------------------------------------------------------------------
async function getSegments() {
  try {
    if (mongoReady && mongoose.connection.readyState === 1) {
      const docs = await SegmentModel.find({}).sort({ order: 1 }).lean();
      if (docs.length > 0) return docs;
      // MongoDB collection is empty — fall through to JSON file seed below
    }
  } catch (err) {
    log('error', 'Error reading segments from MongoDB:', err.message);
  }
  return readJSON(SEGMENTS_FILE, []);
}

async function saveSegments(segments) {
  try {
    if (mongoReady && mongoose.connection.readyState === 1) {
      const ops = segments.map((seg) => ({
        updateOne: {
          filter: { id: seg.id },
          update: { $set: seg },
          upsert: true,
        },
      }));
      await SegmentModel.bulkWrite(ops);
      // Remove any segments no longer in the list
      const ids = segments.map((s) => s.id);
      await SegmentModel.deleteMany({ id: { $nin: ids } });
      return; // MongoDB is the source of truth — skip disk write
    }
  } catch (err) {
    log('error', 'Error saving segments to MongoDB:', err.message);
  }
  // Fallback: local JSON (development without MongoDB)
  writeJSON(SEGMENTS_FILE, segments);
}

// Seed MongoDB segments from the JSON file if the collection is empty.
// Called once at boot after a successful MongoDB connection.
async function seedSegmentsIfEmpty() {
  try {
    const count = await SegmentModel.countDocuments();
    if (count === 0) {
      const fromFile = readJSON(SEGMENTS_FILE, readJSON(DEFAULT_SEGMENTS_FILE, []));
      if (fromFile.length > 0) {
        await SegmentModel.insertMany(fromFile, { ordered: false });
        log('info', `[segments] Seeded ${fromFile.length} segment(s) from JSON file into MongoDB.`);
      }
    }
  } catch (err) {
    log('error', '[segments] Error seeding segments into MongoDB:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Spin fallback — only used when MongoDB is unavailable
// ---------------------------------------------------------------------------
// In-memory cache. Populated from MongoDB at boot (when connected) or from
// the JSON file (local dev fallback). The JSON file is ephemeral on Render
// free tier and is only a last-resort safety net.
let spinsFallback = readJSON(SPINS_FILE, []);

function persistSpinsFallback() {
  // Only write to disk in fallback mode (no MongoDB). On Render the disk is
  // ephemeral and writing is pointless — MongoDB is the real store.
  if (!mongoReady) {
    writeJSON(SPINS_FILE, spinsFallback);
  }
}

// These fire on every state change for the life of the process, so they
// cover automatic reconnection after a dropped connection — not just the
// initial connect attempt at boot.
mongoose.connection.on('connected', () => {
  mongoReady = true;
  log('info', '[mongo] connected');
});

mongoose.connection.on('disconnected', () => {
  mongoReady = false;
  log('warn', '[mongo] disconnected — spins will use local JSON storage until it reconnects');
});

mongoose.connection.on('reconnected', () => {
  mongoReady = true;
  log('info', '[mongo] reconnected');
});

mongoose.connection.on('error', (err) => {
  log('error', '[mongo] connection error:', err.message);
});

async function connectMongo() {
  if (!MONGODB_URI) {
    log('warn', '[mongo] No MONGODB_URI configured — spins will be stored locally in JSON, and admin sessions will use in-memory storage (will not survive restarts).');
    return false;
  }
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    mongoReady = mongoose.connection.readyState === 1;
    return mongoReady;
  } catch (err) {
    mongoReady = false;
    log('error', '[mongo] initial connection failed:', err.message);
    log('warn', '[mongo] the driver will keep retrying in the background; spins/sessions use local fallback until it succeeds.');
    return false;
  }
}

// Re-hydrate the in-memory spin cache from MongoDB so we have a warm copy
// from the very first request after a cold start.
async function warmSpinsFallback() {
  try {
    if (mongoReady && mongoose.connection.readyState === 1) {
      const spins = await Spin.find({}).sort({ timestamp: -1 }).lean();
      spinsFallback = spins.map((s) => ({
        ...s,
        timestamp: s.timestamp instanceof Date ? s.timestamp.toISOString() : s.timestamp,
      }));
      log('info', `[spins] Warmed in-memory cache with ${spinsFallback.length} spin(s) from MongoDB.`);
    }
  } catch (err) {
    log('error', '[spins] Error warming spinsFallback from MongoDB:', err.message);
  }
}

async function getSpins() {
  try {
    if (mongoReady && mongoose.connection.readyState === 1) {
      const spins = await Spin.find({}).sort({ timestamp: -1 }).lean();
      // Normalize timestamp to ISO string for consistent frontend display
      const normalized = spins.map((s) => ({
        ...s,
        timestamp: s.timestamp instanceof Date ? s.timestamp.toISOString() : s.timestamp,
      }));
      // Keep in-memory cache in sync
      spinsFallback = normalized;
      return normalized;
    }
  } catch (err) {
    log('error', 'Error reading spins from MongoDB:', err.message);
  }
  // Fallback: in-memory cache (already warmed at boot, or from JSON file in dev)
  return spinsFallback;
}

async function saveSpin(spin) {
  try {
    if (mongoReady && mongoose.connection.readyState === 1) {
      await Spin.updateOne({ id: spin.id }, spin, { upsert: true });
      // Update in-memory cache — no disk write needed when MongoDB is live
      spinsFallback.unshift(spin);
      return;
    }
  } catch (err) {
    log('error', 'Error saving spin to MongoDB:', err.message);
  }
  // Fallback (no MongoDB): keep in-memory cache and persist to disk
  spinsFallback.unshift(spin);
  persistSpinsFallback();
}

async function clearSpins() {
  try {
    if (mongoReady && mongoose.connection.readyState === 1) {
      await Spin.deleteMany({});
      spinsFallback = [];
      return;
    }
  } catch (err) {
    log('error', 'Error clearing spins from MongoDB:', err.message);
  }
  spinsFallback = [];
  persistSpinsFallback();
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authenticated.' });
}

function registerRoutes() {
  // Lightweight centralized request logging.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      log('info', `${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  // Wheel-facing data only: no weights, no reward copy (kept as a surprise).
  app.get('/api/segments', asyncHandler(async (req, res) => {
    const segments = (await getSegments())
      .filter((s) => s.active)
      .sort((a, b) => a.order - b.order)
      .map((s) => ({
        id: s.id,
        label: s.label,
        shortLabel: s.shortLabel || s.label,
        icon: s.icon || 'star',
        color: s.color,
        colorLight: s.colorLight || s.color,
      }));
    res.json({ segments });
  }));

  app.post('/api/spin', asyncHandler(async (req, res) => {
    const segments = (await getSegments())
      .filter((s) => s.active)
      .sort((a, b) => a.order - b.order);

    const winner = weightedPick(segments);
    if (!winner) {
      return res.status(409).json({ error: 'The wheel has no active prizes configured right now.' });
    }

    const index = segments.findIndex((s) => s.id === winner.id);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim().slice(0, 20) : '';
    const code = generateCode();
    const spinId = crypto.randomUUID();

    const spin = {
      id: spinId,
      code,
      segmentId: winner.id,
      segmentLabel: winner.label,
      name,
      phone,
      todayReward: winner.todayReward || '',
      futureReward: winner.futureReward || '',
      timestamp: new Date(),
    };

    await saveSpin(spin);

    res.json({
      index,
      segmentCount: segments.length,
      result: {
        id: winner.id,
        label: winner.label,
        shortLabel: winner.shortLabel || winner.label,
        icon: winner.icon || 'star',
        color: winner.color,
        colorLight: winner.colorLight || winner.color,
        todayReward: winner.todayReward || '',
        futureReward: winner.futureReward || '',
        validityDays: winner.validityDays || 90,
        code,
      },
    });
  }));

  // -------------------------------------------------------------------------
  // Admin auth
  // -------------------------------------------------------------------------
  app.post('/api/admin/login', (req, res) => {
    const { password } = req.body || {};
    if (password && password === effectiveAdminPassword) {
      req.session.isAdmin = true;
      return res.json({ ok: true });
    }
    return res.status(401).json({ error: 'Incorrect password.' });
  });

  app.post('/api/admin/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get('/api/admin/check', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.isAdmin) });
  });

  // -------------------------------------------------------------------------
  // Admin: segments (full detail, editable)
  // -------------------------------------------------------------------------
  app.get('/api/admin/segments', requireAdmin, asyncHandler(async (req, res) => {
    const segments = (await getSegments()).sort((a, b) => a.order - b.order);
    res.json({ segments });
  }));

  app.put('/api/admin/segments', requireAdmin, asyncHandler(async (req, res) => {
    const incoming = req.body?.segments;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ error: 'Provide a non-empty array of segments.' });
    }
    for (const seg of incoming) {
      if (!validateSegment(seg)) {
        return res.status(400).json({ error: `Invalid segment data for "${seg?.label || 'unnamed'}".` });
      }
    }

    const cleaned = incoming.map((seg, i) => ({
      id: seg.id || `seg-${Date.now()}-${i}`,
      order: i,
      active: seg.active !== false,
      label: seg.label.trim(),
      shortLabel: (seg.shortLabel || seg.label).trim(),
      icon: seg.icon === 'diamond' ? 'diamond' : 'star',
      color: seg.color,
      colorLight: /^#[0-9A-Fa-f]{6}$/.test(seg.colorLight) ? seg.colorLight : seg.color,
      weight: Math.max(0, Number(seg.weight) || 0),
      todayReward: (seg.todayReward || '').toString().slice(0, 200),
      futureReward: (seg.futureReward || '').toString().slice(0, 220),
      validityDays: Math.max(1, Number(seg.validityDays) || 90),
    }));

    await saveSegments(cleaned);
    res.json({ segments: cleaned });
  }));

  app.post('/api/admin/segments/reset', requireAdmin, asyncHandler(async (req, res) => {
    const defaults = readJSON(DEFAULT_SEGMENTS_FILE, []);
    await saveSegments(defaults);
    res.json({ segments: defaults });
  }));

  // -------------------------------------------------------------------------
  // Admin: spin log
  // -------------------------------------------------------------------------
  app.get('/api/admin/spins', requireAdmin, asyncHandler(async (req, res) => {
    const spins = await getSpins();
    const counts = {};
    for (const s of spins) counts[s.segmentId] = (counts[s.segmentId] || 0) + 1;
    res.json({ spins, total: spins.length, counts });
  }));

  app.delete('/api/admin/spins', requireAdmin, asyncHandler(async (req, res) => {
    await clearSpins();
    res.json({ ok: true });
  }));

  // NOTE: /export must be registered BEFORE /:id to prevent 'export' being
  // interpreted as a spin ID by the parameterised DELETE route below.
  app.get('/api/admin/spins/export', requireAdmin, asyncHandler(async (req, res) => {
    const spins = await getSpins();
    const header = 'Name,Phone,Coupon Code,Rewards\n';
    const rows = spins
      .map((s) => {
        const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
        const rewardText = [s.todayReward, s.futureReward].filter(Boolean).join(' | ') || s.segmentLabel || '';
        return [esc(s.name), esc(s.phone), esc(s.code), esc(rewardText)].join(',');
      })
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="wheel-of-love-spins.csv"');
    res.send(header + rows);
  }));

  app.delete('/api/admin/spins/:id', requireAdmin, asyncHandler(async (req, res) => {
    const spinId = req.params.id;
    if (!spinId) {
      return res.status(400).json({ error: 'Missing spin ID.' });
    }

    try {
      if (mongoReady && mongoose.connection.readyState === 1) {
        await Spin.deleteOne({ id: spinId });
      }
    } catch (err) {
      log('error', 'Error deleting spin from MongoDB:', err.message);
    }

    spinsFallback = spinsFallback.filter((spin) => spin.id !== spinId);
    persistSpinsFallback();
    res.json({ ok: true });
  }));

  // Centralized error handler — always last.
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      log('error', `Unhandled error after headers sent on ${req.method} ${req.originalUrl}:`, err?.message || err);
      return;
    }

    log('error', `Unhandled error on ${req.method} ${req.originalUrl}:`, err?.stack || err?.message || err);
    res.status(err?.statusCode || 500).json({
      error: IS_PRODUCTION
        ? 'Something went wrong. Please try again later.'
        : err?.message || 'Something went wrong. Please try again later.',
    });
  });
}

// ---------------------------------------------------------------------------
// Startup sequence: validate env → connect to MongoDB → configure Express →
// start listening. Keeping this order means the session store and spin
// storage know whether Mongo is available before the app starts accepting
// traffic, instead of racing an async connection against incoming requests.
// ---------------------------------------------------------------------------
let httpServer = null;

async function main() {
  validateEnv();

  const mongoConnected = await connectMongo();

  if (mongoConnected) {
    // One-time migration: seed MongoDB segments from the JSON file if the
    // collection is empty (first deploy, or after a DB wipe).
    await seedSegmentsIfEmpty();
    // Warm the in-memory spin cache so the very first admin request after a
    // cold start already has data — no wait for the first getSpins() call.
    await warmSpinsFallback();
  }

  // connect-mongo manages its own MongoClient independently of mongoose, so
  // it will keep retrying in the background even if the connectMongo()
  // attempt above hasn't succeeded yet by the time we boot.
  const sessionStore = mongoConnected
    ? new MongoStore({
        mongoUrl: MONGODB_URI,
        collectionName: 'sessions',
        ttl: 12 * 60 * 60, // seconds — matches the cookie maxAge below
        touchAfter: 60 * 60, // only rewrite the session doc at most once/hour on reads
        autoRemove: 'native', // let MongoDB expire old sessions via a TTL index
      })
    : new session.MemoryStore();

  if (MONGODB_URI) {
    sessionStore.on('error', (err) => log('error', '[session-store] error:', err.message));
  }

  // Render (and most PaaS hosts) terminate TLS at a proxy in front of the
  // app, so Express needs to trust the X-Forwarded-* headers to correctly
  // detect HTTPS — required for `cookie.secure: 'auto'` to behave properly.
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '256kb' }));
  app.use(session({
    name: 'wol.sid',
    secret: effectiveSessionSecret,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      maxAge: 12 * 60 * 60 * 1000, // 12 hours — comfortably covers one event day
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto', // sends the cookie over HTTPS only when the connection is actually secure
    },
  }));
  app.use(express.static(path.join(__dirname, 'public')));

  registerRoutes();

  httpServer = app.listen(PORT, () => {
    log('info', `Wheel of Love running → http://localhost:${PORT}`);
    log('info', `Admin dashboard        → http://localhost:${PORT}/admin.html`);
    log('info', `MongoDB status         → ${mongoConnected ? 'connected' : 'unavailable at boot (using local fallback, will keep retrying)'}`);
  });

  httpServer.on('error', (err) => {
    log('error', '[http] server error:', err.message);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
  log('info', `received ${signal}, shutting down gracefully...`);

  const forceExitTimer = setTimeout(() => {
    log('error', 'graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  const finish = async (exitCode) => {
    try {
      await mongoose.connection.close();
      log('info', '[mongo] connection closed');
    } catch (err) {
      log('error', '[mongo] error while closing connection:', err.message);
    } finally {
      clearTimeout(forceExitTimer);
      process.exit(exitCode);
    }
  };

  if (httpServer) {
    httpServer.close((err) => {
      if (err) log('error', '[http] error while closing server:', err.message);
      finish(err ? 1 : 0);
    });
  } else {
    finish(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  log('error', 'unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  log('error', 'uncaught exception:', err?.stack || err?.message || err);
  process.exit(1);
});

main().catch((err) => {
  log('error', 'fatal startup error:', err.message);
  process.exit(1);
});