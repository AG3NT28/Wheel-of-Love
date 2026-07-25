/**
 * Wheel of Love — Café du L'Amour
 * -------------------------------
 * A tiny, dependency-light Express server that:
 *   1) Serves the public spin page and the admin dashboard
 *   2) Exposes a public API to fetch active wheel segments and spin the wheel
 *   3) Exposes a password-protected admin API to edit segments/probabilities
 *      and review the spin log.
 *
 * All state lives in flat JSON files under /data — good enough for a
 * single-café, single-event deployment, and trivial to inspect or back up.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lamour2026';
const SESSION_SECRET = process.env.SESSION_SECRET || 'cdl-wheel-of-love-secret-change-me';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/wheel-of-love';

const DATA_DIR = path.join(__dirname, 'data');
const SEGMENTS_FILE = path.join(DATA_DIR, 'segments.json');
const DEFAULT_SEGMENTS_FILE = path.join(DATA_DIR, 'segments.default.json');

// ---------------------------------------------------------------------------
// MongoDB Connection & Spin Schema
// ---------------------------------------------------------------------------
mongoose.connect(MONGODB_URI).catch(err => {
  console.warn('MongoDB connection warning:', err.message);
  console.warn('Spin log will be stored in memory (not persistent) until MongoDB connects.');
});

const spinSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  code: { type: String, required: true },
  segmentId: { type: String, required: true },
  segmentLabel: { type: String, required: true },
  name: String,
  phone: String,
  timestamp: { type: String, required: true },
}, { timestamps: false });

const Spin = mongoose.model('Spin', spinSchema);

// Fallback in-memory storage if MongoDB isn't connected
let spinsFallback = [];

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
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getSegments() {
  return readJSON(SEGMENTS_FILE, []);
}

function saveSegments(segments) {
  writeJSON(SEGMENTS_FILE, segments);
}

async function getSpins() {
  try {
    if (mongoose.connection.readyState === 1) {
      return await Spin.find({}).sort({ timestamp: -1 }).lean();
    }
  } catch (err) {
    console.error('Error reading spins from MongoDB:', err.message);
  }
  return spinsFallback;
}

async function saveSpin(spin) {
  try {
    if (mongoose.connection.readyState === 1) {
      await Spin.updateOne({ id: spin.id }, spin, { upsert: true });
      spinsFallback = [spin, ...spinsFallback];
      return;
    }
  } catch (err) {
    console.error('Error saving spin to MongoDB:', err.message);
  }
  spinsFallback.unshift(spin);
}

async function clearSpins() {
  try {
    if (mongoose.connection.readyState === 1) {
      await Spin.deleteMany({});
    }
  } catch (err) {
    console.error('Error clearing spins from MongoDB:', err.message);
  }
  spinsFallback = [];
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

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '256kb' }));
app.use(
  session({
    name: 'wol.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 12 * 60 * 60 * 1000, // 12 hours — comfortably covers one event day
      httpOnly: true,
      sameSite: 'lax',
    },
  })
);
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authenticated.' });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Wheel-facing data only: no weights, no reward copy (kept as a surprise).
app.get('/api/segments', (req, res) => {
  const segments = getSegments()
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
});

app.post('/api/spin', async (req, res) => {
  const segments = getSegments()
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
    timestamp: new Date().toISOString(),
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
});

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password && password === ADMIN_PASSWORD) {
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

// ---------------------------------------------------------------------------
// Admin: segments (full detail, editable)
// ---------------------------------------------------------------------------
app.get('/api/admin/segments', requireAdmin, (req, res) => {
  const segments = getSegments().sort((a, b) => a.order - b.order);
  res.json({ segments });
});

app.put('/api/admin/segments', requireAdmin, (req, res) => {
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

  saveSegments(cleaned);
  res.json({ segments: cleaned });
});

app.post('/api/admin/segments/reset', requireAdmin, (req, res) => {
  const defaults = readJSON(DEFAULT_SEGMENTS_FILE, []);
  saveSegments(defaults);
  res.json({ segments: defaults });
});

// ---------------------------------------------------------------------------
// Admin: spin log
// ---------------------------------------------------------------------------
app.get('/api/admin/spins', requireAdmin, async (req, res) => {
  try {
    const spins = await getSpins();
    const counts = {};
    for (const s of spins) counts[s.segmentId] = (counts[s.segmentId] || 0) + 1;
    res.json({ spins, total: spins.length, counts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch spins.' });
  }
});

app.delete('/api/admin/spins', requireAdmin, async (req, res) => {
  try {
    await clearSpins();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear spins.' });
  }
});

app.get('/api/admin/spins/export', requireAdmin, async (req, res) => {
  try {
    const spins = await getSpins();
    const header = 'Timestamp,Name,Phone,Prize,Code\n';
    const rows = spins
      .map((s) => {
        const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
        return [esc(s.timestamp), esc(s.name), esc(s.phone), esc(s.segmentLabel), esc(s.code)].join(',');
      })
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="wheel-of-love-spins.csv"');
    res.send(header + rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export spins.' });
  }
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Wheel of Love running → http://localhost:${PORT}`);
  console.log(`Admin dashboard        → http://localhost:${PORT}/admin.html`);
});
