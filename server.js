const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();

// Render (and most hosts) inject the port to listen on via process.env.PORT
// — this was missing entirely, which is why the server crashed on startup
// with "PORT is not defined" the moment it reached app.listen below.
const PORT = process.env.PORT || 3000;

// ─── CORS CONFIGURATION ──────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control'],
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));

// ─── STRICT CACHE CONTROL ──────────────────────────────────────
app.use((req, res, next) => {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.header('Pragma', 'no-cache');
  res.header('Expires', '0');
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ─── MongoDB connection ──────────────────────────────────────
const MONGODB_URI = 'mongodb+srv://elitecinezo_db_user:g485P3ELoeP8REkD@cluster0.tsw1i0i.mongodb.net/subscription_hub?retryWrites=true&w=majority';
const DB_NAME = 'subscription_hub';

let db;
let subscriptionsCollection;
let otpsCollection;
let usersCollection;
let dealsCollection;
let promotionsCollection;
let waitingCollection;
let customGrantsCollection;
let faqsCollection;
let processedPurchasesCollection;
let creditHistoryCollection;
let adminSettingsCollection;
let noticesCollection;
let jarvisMemoryCollection;
let socialServicesCollection;
let socialOrdersCollection;
let socialCartCollection;

// ─── SUBSCRIPTION COSTS (Monthly) ──────────────────────────
const SUBSCRIPTION_COSTS = {
  netflix: 1250,
  amazon: 250,
  youtube: 150,
  spotify: 0,
  chatgpt: 1000,
  canva: 250,
  capcut: 200,
  hbomax: 300,
  crunchyroll: 200,
  chaupal: 150,
  custom: 0
};

async function connectDB() {
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  db = client.db(DB_NAME);
  subscriptionsCollection = db.collection('subscriptions');
  otpsCollection = db.collection('otps');
  usersCollection = db.collection('users');
  dealsCollection = db.collection('deals');
  promotionsCollection = db.collection('promotions');
  waitingCollection = db.collection('waitingCustomers');
  customGrantsCollection = db.collection('customGrants');
  faqsCollection = db.collection('faqs');
  processedPurchasesCollection = db.collection('processedPurchases');
  creditHistoryCollection = db.collection('creditHistory');
  adminSettingsCollection = db.collection('adminSettings');
  noticesCollection = db.collection('notices');
  jarvisMemoryCollection = db.collection('jarvisMemory');
  socialServicesCollection = db.collection('socialServices');
  socialOrdersCollection = db.collection('socialOrders');
  socialCartCollection = db.collection('socialCart');
  await ensureAuthSecret(); // load or create the server-only token-signing secret
  await ensureCredKey(); // load or create the server-only customer-password encryption key
  console.log('✅ Connected to MongoDB');
}

// ─── Idempotency guard ──────────────────────────────────────
// Prevents the exact same purchase step (e.g. "deduct credits for purchase
// X" or "save allocation for purchase X, account Y, screen Z") from ever
// being applied twice, no matter what causes a duplicate request to reach
// the server — a double-click that slipped past the frontend guard, a
// stale cached page re-submitting, a flaky network retry, two open tabs,
// etc. It works by trying to insert a document whose _id IS the dedup key;
// MongoDB's built-in _id uniqueness makes the "has this already happened?"
// check and the "claim it" step a single atomic operation — there's no
// window for two concurrent requests to both think they're first.
async function claimIdempotencyKey(key) {
  if (!key) return true; // no key supplied (older client) — behave as before, always allow
  try {
    await processedPurchasesCollection.insertOne({ _id: key, createdAt: new Date() });
    return true; // first time we've seen this key — go ahead
  } catch (err) {
    if (err.code === 11000) return false; // already claimed — this is a duplicate, skip the side effect
    throw err;
  }
}

// ─── Admin settings (password + recovery number) ────────────
// Stored server-side (a single shared document) instead of only in each
// browser's localStorage, so changing the admin password from one device
// takes effect for every device, not just the one that made the change.
const ADMIN_SETTINGS_ID = 'main';

// ─── Netflix tiered pricing (screens × duration) ────────────
// Mirrors the identically-named calculation in the client (index.html) —
// see the comment there for the full explanation of how the two admin-set
// tables (per screen-count, per duration) combine. This copy is what
// actually authorizes the charge, so it must stay in sync with the client's
// version; the client version exists only to show the price before purchase.
function getNetflixPriceServer(sub, screens, months) {
  const basePrice = Number(sub?.sellingPrice) || 0;
  const screenCount = Number(screens) || 1;
  const totalMonths = Number(months) || 1;
  const screenTable = (sub?.netflixPricing && sub.netflixPricing.screens) || {};
  const monthTable = (sub?.netflixPricing && sub.netflixPricing.months) || {};

  const screenPrice = screenTable[screenCount] != null
    ? Number(screenTable[screenCount])
    : basePrice * screenCount;

  let monthPrice;
  if (monthTable[totalMonths] != null) {
    monthPrice = Number(monthTable[totalMonths]);
  } else if (totalMonths > 12 && Object.keys(monthTable).length) {
    const enteredMonths = Object.keys(monthTable).map(Number).sort((a, b) => a - b);
    const last = enteredMonths[enteredMonths.length - 1];
    const prev = enteredMonths[enteredMonths.length - 2];
    const step = prev != null ? (Number(monthTable[last]) - Number(monthTable[prev])) / (last - prev) : basePrice;
    monthPrice = Number(monthTable[last]) + step * (totalMonths - last);
  } else {
    monthPrice = basePrice * totalMonths;
  }

  if (!basePrice) return Math.round(screenPrice + monthPrice - basePrice);
  return Math.round((screenPrice * monthPrice) / basePrice);
}

// Remove sensitive fields before sending a user document to the browser.
// The password must never leave the server in a response — the client has
// no legitimate reason to ever see it, and anything sent to the browser is
// visible in the Network tab.
function sanitizeUser(user) {
  if (!user) return user;
  const { password, ...safe } = user;
  return safe;
}

// Load the admin settings document, seeding sensible defaults the first
// time the app ever runs.
async function getAdminSettings() {
  let settings = await adminSettingsCollection.findOne({ _id: ADMIN_SETTINGS_ID });
  if (!settings) {
    settings = { _id: ADMIN_SETTINGS_ID, password: 'admin123', recoveryNumber: '359609', theme: 'classic' };
    await adminSettingsCollection.insertOne(settings);
  }
  return settings;
}

// ─── Password hashing (scrypt, built-in — no extra dependency) ──────
// Passwords are stored as `scrypt$<salt>$<hash>` instead of plain text, so
// even if the database is ever leaked the real passwords can't be read out.
// verifyPassword also still accepts old plain-text values so nobody who
// signed up before this change is locked out — those get upgraded to a hash
// automatically the next time they log in (see the login routes).
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}
function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith('scrypt$');
}
function verifyPassword(plain, stored) {
  if (stored == null) return false;
  if (isHashed(stored)) {
    const [, salt, hash] = stored.split('$');
    let derived;
    try { derived = crypto.scryptSync(String(plain), salt, 64).toString('hex'); } catch { return false; }
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(derived, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return String(plain) === String(stored); // legacy plain-text (pre-hashing)
}

// ─── Reversible encryption for CUSTOMER passwords ───────────────────
// The admin password above uses a one-way hash on purpose — nobody, not
// even the admin, should ever be able to recover it, only reset it.
// Customer passwords are different: admin has a legitimate day-to-day need
// to actually look one up (e.g. reminding a customer what they signed up
// with), which a one-way hash can never allow no matter how it's called.
// AES-256-GCM keeps them encrypted at rest — safe if the database is ever
// exposed — while still letting the server decrypt the real value back out
// for an authorized viewer. The key lives only in the database, never in
// the code, and is generated once the first time the server ever runs.
let CRED_KEY = null;
async function ensureCredKey() {
  const doc = await adminSettingsCollection.findOne({ _id: 'credKey' });
  if (doc && doc.key) { CRED_KEY = Buffer.from(doc.key, 'hex'); return; }
  CRED_KEY = crypto.randomBytes(32);
  await adminSettingsCollection.updateOne({ _id: 'credKey' }, { $set: { key: CRED_KEY.toString('hex') } }, { upsert: true });
}
function encryptCustomerPassword(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CRED_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc$${iv.toString('hex')}$${tag.toString('hex')}$${encrypted.toString('hex')}`;
}
function isEncrypted(stored) {
  return typeof stored === 'string' && stored.startsWith('enc$');
}
// Returns the real plaintext password, or null if it can't be decrypted
// (wrong format, tampered, or key mismatch).
function decryptCustomerPassword(stored) {
  if (!isEncrypted(stored)) return null;
  const parts = stored.split('$');
  if (parts.length !== 4) return null;
  const [, ivHex, tagHex, dataHex] = parts;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', CRED_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}
// Verifies a login attempt against whatever format the stored value
// happens to be in — encrypted (current), scrypt-hashed (briefly used),
// or legacy plain-text (original) — so nobody who signed up under an
// older version of this code is ever locked out.
function verifyCustomerPassword(plain, stored) {
  if (stored == null) return false;
  if (isEncrypted(stored)) {
    const decrypted = decryptCustomerPassword(stored);
    return decrypted !== null && decrypted === String(plain);
  }
  if (isHashed(stored)) {
    const [, salt, hash] = stored.split('$');
    let derived;
    try { derived = crypto.scryptSync(String(plain), salt, 64).toString('hex'); } catch { return false; }
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(derived, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return String(plain) === String(stored);
}

// ─── Auth tokens (stateless, HMAC-signed) ───────────────────────────
// On login the server hands the browser a signed token. The token proves
// "this request is from user X" (or the admin) without the password ever
// being re-sent. It is signed with a server-only secret, so the browser
// can't forge or tamper with it. This is what lets the server safely show
// a customer their own account credentials while hiding everyone else's.
let AUTH_SECRET = null;
const TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

async function ensureAuthSecret() {
  const doc = await adminSettingsCollection.findOne({ _id: 'authSecret' });
  if (doc && doc.secret) { AUTH_SECRET = doc.secret; return; }
  AUTH_SECRET = crypto.randomBytes(48).toString('hex');
  await adminSettingsCollection.updateOne(
    { _id: 'authSecret' },
    { $set: { secret: AUTH_SECRET } },
    { upsert: true }
  );
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || !payload.iat || (Date.now() - payload.iat) > TOKEN_MAX_AGE_MS) return null;
  return payload; // { u: username, r: 'user' | 'admin', iat }
}
// Returns { u, r } for a valid request, or null. `r` is 'admin' or 'user'.
function getAuth(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return verifyToken(token);
}
// Hard gate for admin-only routes — several management endpoints (users
// list, OTP log, income, FAQs/deals/promotions/waiting writes, etc.) only
// checked auth loosely or not at all, meaning anyone who knew the URL
// could call them without ever logging in as admin. This closes that gap.
function requireAdmin(req, res, next) {
  const auth = getAuth(req);
  if (!auth || auth.r !== 'admin') {
    return res.status(401).json({ error: 'Admin login required' });
  }
  next();
}

// Short-lived, single-purpose token proving "this caller just verified
// their WhatsApp number matches this username" — issued by
// /api/users/verify-whatsapp and required by PUT /api/users/:username
// before a password reset. Without this, anyone who knew a username could
// change its password with no verification at all. Deliberately separate
// from the normal login token (which lasts 30 days): this one expires in
// minutes and is only ever accepted for the one username it was issued
// for. It's not single-use (no server-side storage, to keep this route
// stateless like the rest of the auth here) but the short window keeps
// the exposure small.
const RESET_TOKEN_MAX_AGE_MS = 1000 * 60 * 10; // 10 minutes
function signResetToken(username) {
  const body = Buffer.from(JSON.stringify({ u: username, t: 'reset', iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyResetToken(token, username) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return false; }
  if (!payload || payload.t !== 'reset' || payload.u !== username) return false;
  if (!payload.iat || (Date.now() - payload.iat) > RESET_TOKEN_MAX_AGE_MS) return false;
  return true;
}

// ─── Subscription credential masking ────────────────────────────────
// Account email/password and screen PIN are the actual "keys" being sold.
// They must only reach the admin, and each customer's own account. For
// everyone else these values are blanked out before the subscription list
// leaves the server — so they can never be read from the browser Network
// tab. The shape of the data is left exactly the same (same accounts,
// screens, customers) so the app keeps working; only the secret VALUES are
// removed for people who aren't entitled to see them.
function maskSubscriptionForViewer(sub, auth) {
  if (auth && auth.r === 'admin') return sub; // admin sees everything
  const username = auth && auth.r === 'user' ? auth.u : null;
  const accounts = (sub.accounts || []).map(acc => {
    const screens = (acc.screens || []).map(scr => {
      const screenOwned = !!username && (scr.customers || []).some(c => c.username === username);
      return {
        ...scr,
        pin: screenOwned ? (scr.pin || '') : '',
        // Never expose any customer's stored password to other viewers.
        customers: (scr.customers || []).map(c => ({ ...c, password: '' }))
      };
    });
    const accountOwned = !!username && (acc.screens || []).some(scr =>
      (scr.customers || []).some(c => c.username === username));
    return {
      ...acc,
      password: accountOwned ? (acc.password || '') : '',
      screens
    };
  });
  return { ...sub, accounts };
}

// The real account credentials for one specific slot — used only to hand a
// customer the details for the exact slot they just purchased.
function slotCredentials(sub, accountId, screenId) {
  const acc = (sub && sub.accounts || []).find(a => a.id === accountId);
  const scr = acc && (acc.screens || []).find(s => s.id === screenId);
  return {
    email: acc ? (acc.email || '') : '',
    password: acc ? (acc.password || '') : '',
    pin: scr ? (scr.pin || '') : ''
  };
}
const BLANK_CREDENTIALS = { email: '', password: '', pin: '' };

// Never send the actual admin password or recovery number to the browser —
// only whether they have been set. The password is verified server-side by
// POST /api/admin/login below.
app.get('/api/admin/settings', async (req, res) => {
  try {
    const settings = await getAdminSettings();
    res.json({
      hasPassword: !!settings.password,
      hasRecoveryNumber: !!settings.recoveryNumber,
      theme: settings.theme || 'classic'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin login: the entered password is checked here on the server and only
// a yes/no result is returned. The real password never reaches the browser.
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, error: 'Password is required' });
    const settings = await getAdminSettings();
    if (!verifyPassword(password, settings.password)) {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }
    // Upgrade a legacy plain-text admin password to a hash on first login.
    if (!isHashed(settings.password)) {
      await adminSettingsCollection.updateOne({ _id: ADMIN_SETTINGS_ID }, { $set: { password: hashPassword(password) } });
    }
    res.json({ success: true, token: signToken({ u: 'admin', r: 'admin' }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/settings', async (req, res) => {
  try {
    const { password, recoveryNumber, theme } = req.body;
    const update = {};
    if (password !== undefined && password !== '') update.password = hashPassword(password);
    if (recoveryNumber !== undefined) update.recoveryNumber = recoveryNumber;
    // Only ever store a theme id we actually ship — an unrecognized value
    // here would otherwise silently break every visitor's page.
    const VALID_THEMES = ['classic', 'spiderman', 'pakistan'];
    if (theme !== undefined) {
      if (!VALID_THEMES.includes(theme)) {
        return res.status(400).json({ error: 'Unknown theme' });
      }
      update.theme = theme;
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    await adminSettingsCollection.updateOne({ _id: ADMIN_SETTINGS_ID }, { $set: update }, { upsert: true });
    const settings = await adminSettingsCollection.findOne({ _id: ADMIN_SETTINGS_ID });
    res.json({
      success: true,
      hasPassword: !!settings.password,
      hasRecoveryNumber: !!settings.recoveryNumber,
      theme: settings.theme || 'classic'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forgot-password recovery: verified entirely server-side against the
// stored recovery number, so the correct number is never sent to (or
// checked in) the browser — only whether it matched.
app.post('/api/admin/recover', async (req, res) => {
  try {
    const { recoveryNumber, newPassword } = req.body;
    if (!recoveryNumber || !newPassword) {
      return res.status(400).json({ error: 'Recovery number and new password are required' });
    }
    if (newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters' });
    }
    const settings = await adminSettingsCollection.findOne({ _id: ADMIN_SETTINGS_ID });
    if (!settings || !settings.recoveryNumber) {
      return res.status(400).json({ error: 'No recovery number has been set up for this admin account' });
    }
    if (String(settings.recoveryNumber).trim() !== String(recoveryNumber).trim()) {
      return res.status(400).json({ error: 'Incorrect recovery number' });
    }
    await adminSettingsCollection.updateOne({ _id: ADMIN_SETTINGS_ID }, { $set: { password: hashPassword(newPassword) } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


async function seedData() {
  try {
    // Only seed the very first time the app ever runs (i.e. the
    // subscriptions collection is completely empty). If it already
    // has documents in it, it means this app has been initialized
    // before, so we skip seeding entirely. This prevents any
    // subscription you intentionally delete (e.g. Chaupal) from
    // being silently re-inserted the next time the server restarts
    // or you redeploy.
    const existingCount = await subscriptionsCollection.countDocuments();
    if (existingCount > 0) {
      console.log('ℹ️ Subscriptions already initialized, skipping seed.');
      return;
    }

    const subscriptionDefs = [
      {
        id: '1',
        name: 'Netflix',
        type: 'netflix',
        costPerMonth: 1250,
        sellingPrice: 0,
        description: 'Watch unlimited movies & TV shows',
        importantNote: 'Shared account – 5 screens available',
        logo: '',
        slots: 10,
        askFor: ['name', 'number'],
        accounts: [
          {
            id: 'a1',
            email: 'netflix1@example.com',
            password: 'Mvpcm$263@986',
            screens: [
              { id: 's1', name: 'Screen 1', pin: '3273', customers: [] },
              { id: 's2', name: 'Screen 2', pin: '2222', customers: [] },
              { id: 's3', name: 'Screen 3', pin: '3333', customers: [] },
              { id: 's4', name: 'Screen 4', pin: '4444', customers: [] },
              { id: 's5', name: 'Screen 5', pin: '5555', customers: [] }
            ]
          },
          {
            id: 'a2',
            email: 'netflix2@example.com',
            password: 'pass2',
            screens: [
              { id: 's6', name: 'Screen 1', pin: '6666', customers: [] },
              { id: 's7', name: 'Screen 2', pin: '7777', customers: [] },
              { id: 's8', name: 'Screen 3', pin: '8888', customers: [] },
              { id: 's9', name: 'Screen 4', pin: '9999', customers: [] },
              { id: 's10', name: 'Screen 5', pin: '1010', customers: [] }
            ]
          }
        ]
      },
      {
        id: '2',
        name: 'Amazon Prime',
        type: 'amazon',
        costPerMonth: 250,
        sellingPrice: 0,
        description: 'Prime Video, Music & Free Delivery',
        importantNote: '6 slots available',
        logo: '',
        slots: 6,
        askFor: ['name', 'number'],
        accounts: [
          {
            id: 'a3',
            email: 'amazon1@example.com',
            password: 'pass3',
            screens: Array.from({ length: 6 }, (_, i) => ({
              id: `s_${i+1}`,
              name: `Slot ${i+1}`,
              pin: '',
              customers: []
            }))
          }
        ]
      },
      {
        id: '3',
        name: 'YouTube Premium',
        type: 'youtube',
        costPerMonth: 150,
        sellingPrice: 0,
        description: 'Ad-free & offline',
        importantNote: '',
        logo: '',
        slots: 5,
        askFor: ['name', 'number'],
        accounts: []
      },
      {
        id: '4',
        name: 'Spotify Premium',
        type: 'spotify',
        costPerMonth: 0,
        sellingPrice: 0,
        description: 'Music & podcasts',
        importantNote: '',
        logo: '',
        slots: 1,
        askFor: ['name', 'number'],
        accounts: [
          {
            id: 'a4',
            email: 'spotify1@example.com',
            password: 'pass4',
            screens: [
              { id: 's1', name: 'Premium 1', pin: '', customers: [] }
            ]
          }
        ]
      },
      {
        id: '5',
        name: 'ChatGPT Plus',
        type: 'chatgpt',
        costPerMonth: 1000,
        sellingPrice: 0,
        description: 'GPT-4 access',
        importantNote: '',
        logo: '',
        slots: 1,
        askFor: ['name', 'number', 'email'],
        accounts: [
          {
            id: 'a5',
            email: 'chatgpt1@example.com',
            password: 'pass5',
            screens: [
              { id: 's1', name: 'Pro 1', pin: '', customers: [] }
            ]
          }
        ]
      },
      {
        id: '6',
        name: 'Canva Pro',
        type: 'canva',
        costPerMonth: 20.83,
        sellingPrice: 0,
        description: 'Design & creative',
        importantNote: 'Yearly plan only',
        logo: '',
        slots: 1,
        askFor: ['name', 'number', 'email'],
        accounts: [
          {
            id: 'a6',
            email: 'canva1@example.com',
            password: 'pass6',
            screens: [
              { id: 's1', name: 'Canva Pro 1', pin: '', customers: [] }
            ]
          }
        ]
      },
      {
        id: '7',
        name: 'Capcut Pro',
        type: 'capcut',
        costPerMonth: 200,
        sellingPrice: 0,
        description: 'Video editing',
        importantNote: '',
        logo: '',
        slots: 1,
        askFor: ['name', 'number'],
        accounts: []
      },
      {
        id: '8',
        name: 'HBO Max',
        type: 'hbomax',
        costPerMonth: 300,
        sellingPrice: 0,
        description: 'Movies & series',
        importantNote: '',
        logo: '',
        slots: 5,
        askFor: ['name', 'number'],
        accounts: []
      },
      {
        id: '9',
        name: 'Crunchyroll',
        type: 'crunchyroll',
        costPerMonth: 200,
        sellingPrice: 0,
        description: 'Anime & manga',
        importantNote: '',
        logo: '',
        slots: 4,
        askFor: ['name', 'number'],
        accounts: []
      },
      {
        id: '10',
        name: 'Chaupal',
        type: 'chaupal',
        costPerMonth: 150,
        sellingPrice: 0,
        description: 'Regional entertainment',
        importantNote: '',
        logo: '',
        slots: 3,
        askFor: ['name', 'number'],
        accounts: []
      }
    ];

    for (const def of subscriptionDefs) {
      const existing = await subscriptionsCollection.findOne({ id: def.id });
      if (!existing) {
        await subscriptionsCollection.insertOne(def);
        console.log(`✅ Inserted subscription: ${def.name}`);
      }
      // If it already exists, leave it completely alone. This runs on every
      // server restart (i.e. every deploy), so previously this block was
      // silently overwriting whatever cost/sellingPrice/logo/etc. had been
      // set manually in the admin panel back to these hardcoded defaults.
      // Seeding should only ever create missing subscriptions, never touch
      // ones that already exist — manual edits now persist across deploys
      // until you change them again yourself.
    }

    const dealCount = await dealsCollection.countDocuments();
    if (dealCount === 0) {
      const defaultDeals = [
        {
          id: 'd1',
          subscriptionIds: ['1'],
          title: 'Netflix Premium',
          description: 'Watch unlimited movies & TV shows',
          actualPrice: 500,
          discountPrice: 350,
          active: true,
          createdAt: new Date()
        },
        {
          id: 'd2',
          subscriptionIds: ['2'],
          title: 'Amazon Prime',
          description: 'Prime Video, Music & Free Delivery',
          actualPrice: 200,
          discountPrice: 150,
          active: true,
          createdAt: new Date()
        },
        {
          id: 'd3',
          subscriptionIds: ['1', '2'],
          title: 'Netflix + Amazon Combo',
          description: 'Get both Netflix and Amazon Prime together',
          actualPrice: 700,
          discountPrice: 450,
          active: true,
          createdAt: new Date()
        }
      ];
      await dealsCollection.insertMany(defaultDeals);
      console.log('✅ Default deals seeded');
    }

    const userCount = await usersCollection.countDocuments();
    if (userCount === 0) {
      await usersCollection.insertOne({
        username: 'admin',
        password: 'admin123',
        whatsapp: '+923079163485',
        purchaseCount: 0,
        credits: 1000,
        createdAt: new Date()
      });
      console.log('✅ Default admin user created');
    }
  } catch (err) {
    console.error('Error seeding data:', err);
  }
}

// ─── Routes ──────────────────────────────────────────────────

app.get('/api/subscriptions', async (req, res) => {
  try {
    const auth = getAuth(req);
    const subs = await subscriptionsCollection.find({}).toArray();
    // Account passwords / PINs are blanked for anyone who isn't the admin or
    // the customer that owns the slot — see maskSubscriptionForViewer.
    res.json(subs.map(s => maskSubscriptionForViewer(s, auth)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subscriptions/:id', async (req, res) => {
  try {
    const sub = await subscriptionsCollection.findOne({ id: req.params.id });
    if (!sub) return res.status(404).json({ error: 'Not found' });
    res.json(maskSubscriptionForViewer(sub, getAuth(req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/subscriptions', requireAdmin, async (req, res) => {
  try {
    const { id, name, type, accounts, costPerMonth, sellingPrice, slots, askFor, description, importantNote, logo } = req.body;
    const existing = await subscriptionsCollection.findOne({ id });
    if (existing) {
      return res.status(400).json({ error: 'Subscription id already exists' });
    }
    const newSub = {
      id,
      name,
      type,
      accounts: dedupeAccounts(accounts || []),
      costPerMonth: costPerMonth || SUBSCRIPTION_COSTS[type] || 0,
      sellingPrice: sellingPrice || 0,
      slots: slots || 0,
      askFor: askFor || ['name', 'number'],
      description: description || '',
      importantNote: importantNote || '',
      logo: logo || '',
      createdAt: new Date()
    };
    await subscriptionsCollection.insertOne(newSub);
    res.json(newSub);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accounts are uniquely identified by their login email — a duplicate email
// means the same real-world account got submitted twice (e.g. a double-
// tapped Save button before the UI gave feedback). Left alone, every
// duplicate gets counted again in the cost calculation below, which is how
// "2 accounts" quietly becomes "8 accounts" worth of cost. This merges any
// duplicates back into one entry, combining their screens (so no customer
// data is lost) rather than just discarding the extra one blindly.
function dedupeAccounts(accounts) {
  if (!Array.isArray(accounts)) return accounts;
  const byEmail = new Map();
  const order = [];
  for (const acc of accounts) {
    const key = (acc.email || '').trim().toLowerCase();
    if (!key) { order.push(acc); continue; } // no email — nothing safe to match on, keep as-is
    if (!byEmail.has(key)) {
      const clone = { ...acc, screens: [...(acc.screens || [])] };
      byEmail.set(key, clone);
      order.push(clone);
    } else {
      const existing = byEmail.get(key);
      const seenScreenIds = new Set(existing.screens.map(s => s.id));
      for (const scr of (acc.screens || [])) {
        if (!seenScreenIds.has(scr.id)) {
          existing.screens.push(scr);
          seenScreenIds.add(scr.id);
        }
      }
    }
  }
  return order;
}

app.put('/api/subscriptions/:id', requireAdmin, async (req, res) => {
  try {
    const { name, type, accounts, costPerMonth, sellingPrice, slots, askFor, description, importantNote, logo } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (type !== undefined) update.type = type;
    if (accounts !== undefined) update.accounts = dedupeAccounts(accounts);
    if (costPerMonth !== undefined) update.costPerMonth = costPerMonth;
    if (sellingPrice !== undefined) update.sellingPrice = sellingPrice;
    if (slots !== undefined) update.slots = slots;
    if (askFor !== undefined) update.askFor = askFor;
    if (description !== undefined) update.description = description;
    if (importantNote !== undefined) update.importantNote = importantNote;
    if (logo !== undefined) update.logo = logo;
    const result = await subscriptionsCollection.updateOne(
      { id: req.params.id },
      { $set: update }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    const updated = await subscriptionsCollection.findOne({ id: req.params.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-click cleanup for subscriptions that already have duplicate accounts
// from before this guard existed — re-runs the same dedupe against
// whatever's currently saved and reports how many were merged away.
app.post('/api/subscriptions/:id/dedupe-accounts', requireAdmin, async (req, res) => {
  try {
    const sub = await subscriptionsCollection.findOne({ id: req.params.id });
    if (!sub) return res.status(404).json({ error: 'Not found' });
    const before = (sub.accounts || []).length;
    const deduped = dedupeAccounts(sub.accounts || []);
    const duplicatesRemoved = before - deduped.length;
    if (duplicatesRemoved > 0) {
      await subscriptionsCollection.updateOne({ id: req.params.id }, { $set: { accounts: deduped } });
    }
    const updated = await subscriptionsCollection.findOne({ id: req.params.id });
    res.json({ ...updated, duplicatesRemoved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/subscriptions/:id', requireAdmin, async (req, res) => {
  try {
    const result = await subscriptionsCollection.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Customer allocation (atomic — never overwrites the whole subscription doc) ----
// This is what fixes purchase details "disappearing": every purchase, edit, or delete
// below only touches the exact account/screen it targets instead of replacing the
// entire accounts array, so two things happening at once can never wipe each other out.

app.post('/api/subscriptions/:id/allocate', async (req, res) => {
  try {
    const { accountId, screenId, customer, purchaseId } = req.body;
    if (!accountId || !screenId || !customer || !customer.username) {
      return res.status(400).json({ error: 'accountId, screenId and customer are required' });
    }

    // The real slot credentials are only returned to the logged-in customer
    // buying it for themselves (or the admin). Everyone else gets blanks —
    // this stops the allocate endpoint being used to harvest account keys.
    const auth = getAuth(req);
    const maySeeCreds = !!auth && (auth.r === 'admin' || auth.u === customer.username);

    // Same purchase step submitted twice? Don't add the customer a second
    // time — just return the subscription as it already stands.
    const key = purchaseId ? `allocate:${purchaseId}:${accountId}:${screenId}` : null;
    const claimed = await claimIdempotencyKey(key);
    if (!claimed) {
      const existing = await subscriptionsCollection.findOne({ id: req.params.id });
      return res.json({
        ...maskSubscriptionForViewer(existing, auth),
        claimedCredentials: maySeeCreds ? slotCredentials(existing, accountId, screenId) : BLANK_CREDENTIALS
      });
    }

    const customerToInsert = {
      name: customer.name || '',
      username: customer.username,
      password: customer.password || '',
      whatsapp: customer.whatsapp || '',
      expiryDate: customer.expiryDate || '',
      months: customer.months || 0,
      days: customer.days || 0,
      screens: customer.screens || 1,
      email: customer.email || '',
      purchasedAt: customer.purchasedAt || new Date().toISOString()
    };
    const result = await subscriptionsCollection.updateOne(
      { id: req.params.id },
      { $push: { 'accounts.$[acc].screens.$[scr].customers': customerToInsert } },
      { arrayFilters: [{ 'acc.id': accountId }, { 'scr.id': screenId }] }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Subscription, account, or screen not found' });
    }
    const updated = await subscriptionsCollection.findOne({ id: req.params.id });
    res.json({
      ...maskSubscriptionForViewer(updated, auth),
      claimedCredentials: maySeeCreds ? slotCredentials(updated, accountId, screenId) : BLANK_CREDENTIALS
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/subscriptions/:id/accounts/:accountId/screens/:screenId/customers/:username', requireAdmin, async (req, res) => {
  try {
    const { name, password, whatsapp, expiryDate, months, days, email, newUsername } = req.body;
    const setObj = {};
    if (name !== undefined) setObj['accounts.$[acc].screens.$[scr].customers.$[cust].name'] = name;
    if (password !== undefined) setObj['accounts.$[acc].screens.$[scr].customers.$[cust].password'] = password;
    if (whatsapp !== undefined) setObj['accounts.$[acc].screens.$[scr].customers.$[cust].whatsapp'] = whatsapp;
    if (expiryDate !== undefined) setObj['accounts.$[acc].screens.$[scr].customers.$[cust].expiryDate'] = expiryDate;
    if (months !== undefined) setObj['accounts.$[acc].screens.$[scr].customers.$[cust].months'] = months;
    if (days !== undefined) setObj['accounts.$[acc].screens.$[scr].customers.$[cust].days'] = days;
    if (email !== undefined) setObj['accounts.$[acc].screens.$[scr].customers.$[cust].email'] = email;
    if (newUsername !== undefined && newUsername !== req.params.username) {
      setObj['accounts.$[acc].screens.$[scr].customers.$[cust].username'] = newUsername;
    }
    if (Object.keys(setObj).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    const result = await subscriptionsCollection.updateOne(
      { id: req.params.id },
      { $set: setObj },
      { arrayFilters: [
          { 'acc.id': req.params.accountId },
          { 'scr.id': req.params.screenId },
          { 'cust.username': req.params.username }
        ] }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Subscription, account, or screen not found' });
    }
    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: 'Customer not found on that screen' });
    }
    const updated = await subscriptionsCollection.findOne({ id: req.params.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/subscriptions/:id/accounts/:accountId/screens/:screenId/customers/:username', requireAdmin, async (req, res) => {
  try {
    const result = await subscriptionsCollection.updateOne(
      { id: req.params.id },
      { $pull: { 'accounts.$[acc].screens.$[scr].customers': { username: req.params.username } } },
      { arrayFilters: [{ 'acc.id': req.params.accountId }, { 'scr.id': req.params.screenId }] }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Subscription, account, or screen not found' });
    }
    const updated = await subscriptionsCollection.findOne({ id: req.params.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Users ----
app.post('/api/users/signup', async (req, res) => {
  try {
    const { name, username, password, whatsapp } = req.body;
    if (!name || !username || !password || !whatsapp) {
      return res.status(400).json({ error: 'All fields required' });
    }
    // Mirrors the checklist shown on the sign-up form — enforced here too
    // since a request can always bypass the client-side UI.
    if (/\s/.test(username) || !/^[A-Za-z0-9]+$/.test(username)) {
      return res.status(400).json({ error: 'Username must not contain spaces or special characters' });
    }
    if (!/[A-Za-z]/.test(username)) {
      return res.status(400).json({ error: 'Username must include at least one letter — it can\'t be only numbers' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!/^[A-Z]/.test(password)) {
      return res.status(400).json({ error: 'Password must start with a capital letter' });
    }
    if (!/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least 1 number' });
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least 1 special character' });
    }
    if (password === username) {
      return res.status(400).json({ error: 'Password must be different from username' });
    }
    const existing = await usersCollection.findOne({ username });
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    // One account per WhatsApp number — without this, the same person
    // could keep creating fresh accounts indefinitely.
    const existingWhatsapp = await usersCollection.findOne({ whatsapp });
    if (existingWhatsapp) {
      return res.status(400).json({ error: 'An account with this WhatsApp number already exists' });
    }
    const newUser = {
      name,
      username,
      password: encryptCustomerPassword(password),
      whatsapp,
      purchaseCount: 0,
      credits: 0,
      createdAt: new Date()
    };
    await usersCollection.insertOne(newUser);
    res.json({ success: true, user: sanitizeUser(newUser), token: signToken({ u: newUser.username, r: 'user' }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await usersCollection.findOne({ username });
    if (!user || !verifyCustomerPassword(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // Upgrade a legacy plain-text or scrypt-hashed password to reversible
    // encryption on first successful login — this is the only moment the
    // server ever has the real plaintext in hand to do that with.
    if (!isEncrypted(user.password)) {
      await usersCollection.updateOne({ username }, { $set: { password: encryptCustomerPassword(password) } });
    }
    res.json({ success: true, user: sanitizeUser(user), token: signToken({ u: user.username, r: 'user' }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forgot-password step 1: verify identity by matching the WhatsApp number
// on file for this username. Numbers are compared after stripping spaces,
// dashes and a leading "+" so small formatting differences don't block a
// legitimate match. Never reveals whether the username itself exists.
app.post('/api/users/verify-whatsapp', async (req, res) => {
  try {
    const { username, whatsapp } = req.body;
    if (!username || !whatsapp) {
      return res.status(400).json({ error: 'Username and WhatsApp number are required' });
    }
    const normalize = (n) => String(n || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
    const user = await usersCollection.findOne({ username });
    if (!user || normalize(user.whatsapp) !== normalize(whatsapp)) {
      return res.status(401).json({ success: false, error: 'That WhatsApp number does not match our records for this username.' });
    }
    res.json({ success: true, resetToken: signResetToken(username) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await usersCollection.find({}).toArray();
    const sanitized = users.map(u => {
      const { password, ...rest } = u;
      return rest;
    });
    res.json(sanitized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:username', async (req, res) => {
  try {
    const user = await usersCollection.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const auth = getAuth(req);
    const isOwner = auth && auth.r === 'user' && auth.u === user.username;
    const isAdmin = auth && auth.r === 'admin';
    if (isAdmin || isOwner) {
      // Hand back the real password, decrypted — never the raw stored
      // string. If it can't be decrypted (e.g. this account's password
      // predates reversible encryption and is still an old one-way scrypt
      // hash, which by design can never be turned back into plaintext),
      // say so explicitly instead of leaking the hash itself: it would
      // look like a password to whoever's viewing it, but isn't one.
      const decrypted = decryptCustomerPassword(user.password);
      return res.json({ ...user, password: decrypted, passwordAvailable: decrypted !== null });
    }
    res.json(sanitizeUser(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:username/incrementPurchase', async (req, res) => {
  try {
    const result = await usersCollection.updateOne(
      { username: req.params.username },
      { $inc: { purchaseCount: 1 } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const updated = await usersCollection.findOne({ username: req.params.username });
    res.json(sanitizeUser(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/:username/addCredits', requireAdmin, async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const result = await usersCollection.findOneAndUpdate(
      { username: req.params.username },
      { $inc: { credits: amount } },
      { returnDocument: 'after' }
    );
    const updated = result && result.value !== undefined ? result.value : result;
    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Keep a record of every credit change so the customer (and admin) can
    // see a full history: when credits were added, when they were used,
    // and on what.
    await creditHistoryCollection.insertOne({
      id: crypto.randomUUID(),
      username: req.params.username,
      type: 'credit',
      amount: amount,
      reason: reason || 'Credits added by admin',
      balanceAfter: updated.credits,
      createdAt: new Date()
    });
    res.json(sanitizeUser(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full credit history for a customer: every add and every spend, with the
// date/time and what it was for, newest first.
app.get('/api/users/:username/credit-history', async (req, res) => {
  try {
    const list = await creditHistoryCollection
      .find({ username: req.params.username })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atomic credit deduction. The find-then-update version of this used to
// check `user.credits < amount` and THEN write the decrement as a second,
// separate step — if two purchase requests landed close together (e.g. a
// double-tapped purchase button) they could both read the same starting
// balance, both pass the check, and both deduct, pushing credits negative
// and letting a purchase go through without really being paid for. Doing
// the check and the decrement in a single findOneAndUpdate makes it
// impossible for two concurrent requests to both succeed against the same
// balance.
app.post('/api/users/:username/deductCredits', async (req, res) => {
  try {
    let { amount, purchaseId, reason, subscriptionId, months, screens, dealId } = req.body;

    // For a real purchase, never trust the credit amount the browser sends —
    // always recompute it here from the subscription's (or deal's) actual
    // current price in the database. The client only sends subscriptionId/
    // months/screens (or dealId) to identify WHAT was bought; the server
    // decides WHAT IT COSTS. This closes two problems at once: a customer's
    // browser showing a stale/out-of-date price (e.g. after the admin
    // changes it) can no longer result in under-charging, and nobody can
    // tamper with the request to pay less than the real price.
    // Admin's manual credit adjustments (add/deduct from the Users tab)
    // pass neither subscriptionId nor dealId, so they keep using the raw
    // `amount` exactly as before.
    if (subscriptionId) {
      const sub = await subscriptionsCollection.findOne({ id: subscriptionId });
      if (!sub) return res.status(404).json({ error: 'Subscription not found' });
      const totalMonths = Number(months) || 1;
      if (sub.type === 'netflix' && screens != null) {
        amount = getNetflixPriceServer(sub, screens, totalMonths);
      } else {
        const perMonth = Number(sub.sellingPrice) || 0;
        amount = Math.round(perMonth * totalMonths);
      }
    } else if (dealId) {
      const deal = await dealsCollection.findOne({ id: dealId });
      if (!deal) return res.status(404).json({ error: 'Deal not found' });
      amount = Number(deal.discountPrice) || 0;
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // If this exact purchase already deducted credits (e.g. the request
    // arrived twice), just return the user's current data instead of
    // deducting a second time.
    const key = purchaseId ? `credits:${purchaseId}` : null;
    const claimed = await claimIdempotencyKey(key);
    if (!claimed) {
      const existing = await usersCollection.findOne({ username: req.params.username });
      if (!existing) return res.status(404).json({ error: 'User not found' });
      const { password, ...rest } = existing;
      return res.json(rest);
    }

    const result = await usersCollection.findOneAndUpdate(
      { username: req.params.username, credits: { $gte: amount } },
      { $inc: { credits: -amount } },
      { returnDocument: 'after' }
    );
    const updated = result && result.value !== undefined ? result.value : result;
    if (!updated) {
      const user = await usersCollection.findOne({ username: req.params.username });
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.status(400).json({ error: 'Insufficient credits' });
    }
    await creditHistoryCollection.insertOne({
      id: crypto.randomUUID(),
      username: req.params.username,
      type: 'debit',
      amount: amount,
      reason: reason || 'Credits used for a purchase',
      purchaseId: purchaseId || null,
      balanceAfter: updated.credits,
      createdAt: new Date()
    });
    res.json(sanitizeUser(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a user account (login credentials only — their existing purchased
// subscription entries are left untouched; remove those separately if needed).
app.delete('/api/users/:username', requireAdmin, async (req, res) => {
  try {
    const result = await usersCollection.deleteOne({ username: req.params.username });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a user's username/password/whatsapp/credits. If the username changes,
// every existing purchase record under the old username is atomically renamed
// to the new one so the customer doesn't lose access to their portal.
app.put('/api/users/:username', async (req, res) => {
  try {
    const oldUsername = req.params.username;
    const { username: newUsername, password, whatsapp, credits, resetToken } = req.body;

    const auth = getAuth(req);
    const authorized = (auth && auth.r === 'admin') || verifyResetToken(resetToken, oldUsername);
    if (!authorized) {
      return res.status(401).json({ error: 'Not authorized to modify this account' });
    }

    const existingUser = await usersCollection.findOne({ username: oldUsername });
    if (!existingUser) return res.status(404).json({ error: 'User not found' });

    if (newUsername && newUsername !== oldUsername) {
      const clash = await usersCollection.findOne({ username: newUsername });
      if (clash) return res.status(400).json({ error: 'That username is already taken' });
    }

    const update = {};
    if (newUsername !== undefined && newUsername !== '') update.username = newUsername;
    if (password !== undefined && password !== '') update.password = encryptCustomerPassword(password);
    if (whatsapp !== undefined) update.whatsapp = whatsapp;
    if (credits !== undefined) update.credits = credits;

    if (Object.keys(update).length > 0) {
      await usersCollection.updateOne({ username: oldUsername }, { $set: update });
    }

    if (newUsername && newUsername !== oldUsername) {
      await subscriptionsCollection.updateMany(
        {},
        { $set: { 'accounts.$[].screens.$[].customers.$[cust].username': newUsername } },
        { arrayFilters: [{ 'cust.username': oldUsername }] }
      );
    }

    const finalUsername = (newUsername && newUsername !== oldUsername) ? newUsername : oldUsername;
    const updated = await usersCollection.findOne({ username: finalUsername });
    const { password: pw, ...sanitized } = updated;
    res.json(sanitized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Deals ----
app.get('/api/deals', async (req, res) => {
  try {
    const deals = await dealsCollection.find({}).toArray();
    res.json(deals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/deals/active', async (req, res) => {
  try {
    const deals = await dealsCollection.find({ active: true }).toArray();
    res.json(deals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deals', requireAdmin, async (req, res) => {
  try {
    const { id, subscriptionIds, title, description, actualPrice, discountPrice, active,
      socialPlatformId, socialPlatformName, socialServiceId, socialServiceName, socialQuantity } = req.body;
    const isSocialDeal = !!socialServiceId;
    if (!id || !title || actualPrice == null || discountPrice == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!isSocialDeal && (!subscriptionIds || !subscriptionIds.length)) {
      return res.status(400).json({ error: 'Select at least one subscription, or a social media service' });
    }
    if (isSocialDeal && (!socialQuantity || Number(socialQuantity) <= 0)) {
      return res.status(400).json({ error: 'Enter a quantity for the social media deal' });
    }
    const existing = await dealsCollection.findOne({ id });
    if (existing) {
      return res.status(400).json({ error: 'Deal id already exists' });
    }
    const newDeal = {
      id,
      subscriptionIds: isSocialDeal ? [] : subscriptionIds,
      title,
      description: description || '',
      actualPrice,
      discountPrice,
      active: active !== undefined ? active : true,
      // A social-media deal is a fixed package (e.g. "1000 Instagram
      // Followers") at a flat discount price — unlike the normal
      // per-1000 pricing customers pick a quantity for themselves — so it
      // carries its own quantity here instead of asking the customer.
      socialPlatformId: isSocialDeal ? socialPlatformId : '',
      socialPlatformName: isSocialDeal ? (socialPlatformName || '') : '',
      socialServiceId: isSocialDeal ? socialServiceId : '',
      socialServiceName: isSocialDeal ? (socialServiceName || '') : '',
      socialQuantity: isSocialDeal ? Number(socialQuantity) : 0,
      createdAt: new Date()
    };
    await dealsCollection.insertOne(newDeal);
    res.json(newDeal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/deals/:id', requireAdmin, async (req, res) => {
  try {
    const { subscriptionIds, title, description, actualPrice, discountPrice, active,
      socialPlatformId, socialPlatformName, socialServiceId, socialServiceName, socialQuantity } = req.body;
    const update = {};
    if (subscriptionIds !== undefined) update.subscriptionIds = subscriptionIds;
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (actualPrice !== undefined) update.actualPrice = actualPrice;
    if (discountPrice !== undefined) update.discountPrice = discountPrice;
    if (active !== undefined) update.active = active;
    if (socialPlatformId !== undefined) update.socialPlatformId = socialPlatformId;
    if (socialPlatformName !== undefined) update.socialPlatformName = socialPlatformName;
    if (socialServiceId !== undefined) update.socialServiceId = socialServiceId;
    if (socialServiceName !== undefined) update.socialServiceName = socialServiceName;
    if (socialQuantity !== undefined) update.socialQuantity = Number(socialQuantity) || 0;
    const result = await dealsCollection.updateOne(
      { id: req.params.id },
      { $set: update }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }
    const updated = await dealsCollection.findOne({ id: req.params.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/deals/:id', requireAdmin, async (req, res) => {
  try {
    const result = await dealsCollection.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SOCIAL MEDIA SERVICES ────────────────────────────────────
// A "platform" (Instagram, TikTok, etc) holds a list of "services"
// (Followers, Likes, Comments...) each priced per 1000 units, and each
// declaring which inputs it needs from the customer (account link and/or
// video link — a service can require either, both, or neither).
app.get('/api/social-services', async (req, res) => {
  try {
    const platforms = await socialServicesCollection.find({}).toArray();
    res.json(platforms);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social-services', requireAdmin, async (req, res) => {
  try {
    const { id, name, icon, logo, description } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'Platform name is required' });
    const existing = await socialServicesCollection.findOne({ id });
    if (existing) return res.status(400).json({ error: 'Platform id already exists' });
    const platform = { id, name, icon: icon || '', logo: logo || '', description: description || '', services: [], createdAt: new Date() };
    await socialServicesCollection.insertOne(platform);
    res.json(platform);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/social-services/:id', requireAdmin, async (req, res) => {
  try {
    const { name, icon, logo, description } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (icon !== undefined) update.icon = icon;
    if (logo !== undefined) update.logo = logo;
    if (description !== undefined) update.description = description;
    const result = await socialServicesCollection.updateOne({ id: req.params.id }, { $set: update });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Platform not found' });
    const updated = await socialServicesCollection.findOne({ id: req.params.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/social-services/:id', requireAdmin, async (req, res) => {
  try {
    const result = await socialServicesCollection.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Platform not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A service's requiredFields is a subset of ['accountLink','videoLink'] —
// whatever's listed there is what the customer gets asked for before they
// can send the order.
app.post('/api/social-services/:id/services', requireAdmin, async (req, res) => {
  try {
    const { name, costPrice, sellingPrice, requiredFields, variations } = req.body;
    if (!name) return res.status(400).json({ error: 'Service name is required' });
    const platform = await socialServicesCollection.findOne({ id: req.params.id });
    if (!platform) return res.status(404).json({ error: 'Platform not found' });
    const service = {
      id: Date.now().toString(),
      name,
      costPrice: costPrice || 0,
      sellingPrice: sellingPrice || 0,
      requiredFields: Array.isArray(requiredFields) ? requiredFields.filter(f => ['accountLink', 'videoLink'].includes(f)) : [],
      // Optional sub-types of this service (e.g. Lifetime Warranty, Non-Refill,
      // 6 Months Warranty), each with its own per-1000 price. Empty = the
      // service just uses the base cost/selling price above.
      variations: Array.isArray(variations) ? variations
        .filter(v => v && String(v.name || '').trim())
        .map(v => ({
          id: v.id ? String(v.id) : Date.now().toString() + Math.random().toString(36).slice(2, 7),
          name: String(v.name).trim(),
          costPrice: Number(v.costPrice) || 0,
          sellingPrice: Number(v.sellingPrice) || 0
        })) : [],
      active: true
    };
    await socialServicesCollection.updateOne({ id: req.params.id }, { $push: { services: service } });
    const updated = await socialServicesCollection.findOne({ id: req.params.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/social-services/:id/services/:serviceId', requireAdmin, async (req, res) => {
  try {
    const { name, costPrice, sellingPrice, requiredFields, active, variations } = req.body;
    const platform = await socialServicesCollection.findOne({ id: req.params.id });
    if (!platform) return res.status(404).json({ error: 'Platform not found' });
    const services = (platform.services || []).map(s => {
      if (s.id !== req.params.serviceId) return s;
      return {
        ...s,
        name: name !== undefined ? name : s.name,
        costPrice: costPrice !== undefined ? costPrice : s.costPrice,
        sellingPrice: sellingPrice !== undefined ? sellingPrice : s.sellingPrice,
        requiredFields: requiredFields !== undefined ? requiredFields.filter(f => ['accountLink', 'videoLink'].includes(f)) : s.requiredFields,
        variations: variations !== undefined ? (Array.isArray(variations) ? variations
          .filter(v => v && String(v.name || '').trim())
          .map(v => ({
            id: v.id ? String(v.id) : Date.now().toString() + Math.random().toString(36).slice(2, 7),
            name: String(v.name).trim(),
            costPrice: Number(v.costPrice) || 0,
            sellingPrice: Number(v.sellingPrice) || 0
          })) : []) : (s.variations || []),
        active: active !== undefined ? active : s.active
      };
    });
    await socialServicesCollection.updateOne({ id: req.params.id }, { $set: { services } });
    const updated = await socialServicesCollection.findOne({ id: req.params.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/social-services/:id/services/:serviceId', requireAdmin, async (req, res) => {
  try {
    const platform = await socialServicesCollection.findOne({ id: req.params.id });
    if (!platform) return res.status(404).json({ error: 'Platform not found' });
    const services = (platform.services || []).filter(s => s.id !== req.params.serviceId);
    await socialServicesCollection.updateOne({ id: req.params.id }, { $set: { services } });
    const updated = await socialServicesCollection.findOne({ id: req.params.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SOCIAL MEDIA ORDERS ──────────────────────────────────────
// Customers don't need an account to order — same as the rest of the
// site's WhatsApp-driven flow, this just also keeps a record the admin
// can see and track from the dashboard.
app.get('/api/social-orders', requireAdmin, async (req, res) => {
  try {
    const orders = await socialOrdersCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social-orders', async (req, res) => {
  try {
    const { platformId, platformName, serviceId, serviceName, variationId, variationName, quantity, accountLink, videoLink, name, username, whatsapp, price, dealId } = req.body;
    if (!platformName || !serviceName || !quantity || !whatsapp) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const order = {
      id: Date.now().toString(),
      platformId: platformId || '',
      platformName,
      serviceId: serviceId || '',
      serviceName,
      variationId: variationId || '',
      variationName: variationName || '',
      quantity: Number(quantity) || 0,
      accountLink: accountLink || '',
      videoLink: videoLink || '',
      name: name || '',
      username: username || '',
      whatsapp,
      price: Number(price) || 0,
      dealId: dealId || '',
      status: 'pending',
      createdAt: new Date()
    };
    await socialOrdersCollection.insertOne(order);
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/social-orders/:id', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const update = {};
    if (status !== undefined) update.status = status;
    const result = await socialOrdersCollection.updateOne({ id: req.params.id }, { $set: update });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Order not found' });
    const updated = await socialOrdersCollection.findOne({ id: req.params.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/social-orders/:id', requireAdmin, async (req, res) => {
  try {
    const result = await socialOrdersCollection.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A customer's own order history for their dashboard — scoped to their
// username, and only they (or the admin) may read it, since orders carry
// account/video links and WhatsApp numbers.
app.get('/api/social-orders/user/:username', async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth || (auth.r !== 'admin' && auth.u !== req.params.username)) {
      return res.status(403).json({ error: 'Not authorized to view this account' });
    }
    const orders = await socialOrdersCollection.find({ username: req.params.username }).sort({ createdAt: -1 }).toArray();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Social Media Cart ----
// Orders under the Rs 300 minimum land here instead of going straight
// through — a customer keeps adding services until the cart clears that
// bar, then checks the whole thing out in one go.
app.get('/api/social-cart/:username', async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth || (auth.r !== 'admin' && auth.u !== req.params.username)) {
      return res.status(403).json({ error: 'Not authorized to view this account' });
    }
    const items = await socialCartCollection.find({ username: req.params.username }).sort({ createdAt: 1 }).toArray();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social-cart', async (req, res) => {
  try {
    const {
      username, platformId, platformName, serviceId, serviceName,
      variationId, variationName, quantity, linkType, linkValue, price
    } = req.body;
    if (!username || !platformName || !serviceName || !quantity) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const auth = getAuth(req);
    if (!auth || (auth.r !== 'admin' && auth.u !== username)) {
      return res.status(403).json({ error: 'Not authorized to add to this cart' });
    }
    const item = {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
      username,
      platformId: platformId || '',
      platformName,
      serviceId: serviceId || '',
      serviceName,
      variationId: variationId || '',
      variationName: variationName || '',
      quantity: Number(quantity) || 0,
      linkType: linkType || '',
      linkValue: linkValue || '',
      price: Number(price) || 0,
      createdAt: new Date()
    };
    await socialCartCollection.insertOne(item);
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/social-cart/:id', async (req, res) => {
  try {
    const item = await socialCartCollection.findOne({ id: req.params.id });
    if (!item) return res.status(404).json({ error: 'Cart item not found' });
    const auth = getAuth(req);
    if (!auth || (auth.r !== 'admin' && auth.u !== item.username)) {
      return res.status(403).json({ error: 'Not authorized to remove this item' });
    }
    await socialCartCollection.deleteOne({ id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pays for everything currently in a customer's cart in one shot. The price
// of every line item is recomputed here from the live service/variation
// data (never trusted from the client) so a stale or tampered cart price
// can never be charged.
app.post('/api/social-cart/:username/checkout', async (req, res) => {
  try {
    const username = req.params.username;
    const auth = getAuth(req);
    if (!auth || (auth.r !== 'admin' && auth.u !== username)) {
      return res.status(403).json({ error: 'Not authorized to check out this cart' });
    }
    const { name, whatsapp } = req.body;
    const items = await socialCartCollection.find({ username }).toArray();
    if (items.length === 0) return res.status(400).json({ error: 'Your cart is empty' });

    const platforms = await socialServicesCollection.find({}).toArray();
    let total = 0;
    const priced = items.map(item => {
      const platform = platforms.find(p => p.id === item.platformId);
      const service = platform ? (platform.services || []).find(s => s.id === item.serviceId) : null;
      let unitPrice = item.price;
      if (service) {
        if (item.variationId) {
          const variation = (service.variations || []).find(v => v.id === item.variationId);
          if (variation) unitPrice = Math.round(((variation.sellingPrice || 0) / 1000) * item.quantity);
        } else {
          unitPrice = Math.round(((service.sellingPrice || 0) / 1000) * item.quantity);
        }
      }
      total += unitPrice;
      return { ...item, price: unitPrice };
    });

    if (total < 300) {
      return res.status(400).json({ error: `Minimum purchase amount is Rs 300. Your cart total is Rs ${total} — add more services to reach it.` });
    }

    const purchaseId = 'cart_' + Date.now().toString();
    const claimed = await claimIdempotencyKey(`cartcheckout:${purchaseId}`);
    if (!claimed) return res.status(400).json({ error: 'Checkout already processed' });

    const result = await usersCollection.findOneAndUpdate(
      { username, credits: { $gte: total } },
      { $inc: { credits: -total } },
      { returnDocument: 'after' }
    );
    const updatedUser = result && result.value !== undefined ? result.value : result;
    if (!updatedUser) {
      return res.status(400).json({ error: 'Insufficient credits' });
    }

    await creditHistoryCollection.insertOne({
      id: crypto.randomUUID(),
      username,
      type: 'debit',
      amount: total,
      reason: `Social media cart checkout (${priced.length} item${priced.length !== 1 ? 's' : ''})`,
      purchaseId,
      balanceAfter: updatedUser.credits,
      createdAt: new Date()
    });

    for (const item of priced) {
      const orderId = Date.now().toString() + Math.random().toString(36).slice(2, 7);
      const label = `${item.platformName} - ${item.serviceName}${item.variationName ? ' - ' + item.variationName : ''}`;
      await socialOrdersCollection.insertOne({
        id: orderId,
        platformId: item.platformId,
        platformName: item.platformName,
        serviceId: item.serviceId,
        serviceName: item.serviceName,
        variationId: item.variationId,
        variationName: item.variationName,
        quantity: item.quantity,
        accountLink: item.linkType === 'accountLink' ? item.linkValue : '',
        videoLink: item.linkType === 'videoLink' ? item.linkValue : '',
        name: name || username,
        username,
        whatsapp: whatsapp || '',
        price: item.price,
        dealId: '',
        status: 'pending',
        createdAt: new Date()
      });
      await waitingCollection.insertOne({
        id: orderId + 'w',
        subscriptionId: null,
        subscriptionName: label,
        isCustomRequest: false,
        name: name || username,
        username,
        whatsapp: whatsapp || '',
        months: 1,
        email: '',
        paidWithCredits: true,
        creditsAmount: item.price,
        isSocialOrder: true,
        platformId: item.platformId,
        platformName: item.platformName,
        serviceId: item.serviceId,
        serviceName: item.serviceName,
        quantity: item.quantity,
        linkType: item.linkType || '',
        linkValue: item.linkValue || '',
        price: item.price,
        fulfilled: false,
        purchasedAt: new Date().toISOString(),
        createdAt: new Date()
      });
    }

    await socialCartCollection.deleteMany({ username });

    res.json({ success: true, total, itemCount: priced.length, user: sanitizeUser(updatedUser) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ---- OTP ----
app.post('/api/otp/generate', async (req, res) => {
  try {
    const { userIdentifier, description } = req.body;
    const otp = String(Math.floor(1000 + Math.random() * 9000));
    // Matches the 60-second countdown shown on screen — it used to be
    // 5 minutes here while the UI displayed a 1-minute countdown, so the
    // code kept working long after it visibly said "expired".
    const expiresAt = new Date(Date.now() + 60 * 1000);
    const newOTP = {
      id: Date.now().toString(),
      otp,
      userIdentifier: userIdentifier || 'Unknown',
      description: description || '',
      createdAt: new Date(),
      expiresAt,
      verified: false,
    };
    await otpsCollection.insertOne(newOTP);
    console.log(`✅ OTP generated: ${otp} for ${userIdentifier} - ${description}`);
    res.json({ success: true, otpId: newOTP.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/otp/verify', async (req, res) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ error: 'OTP required' });
    const record = await otpsCollection.findOne({ otp, verified: false });
    if (!record) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }
    if (record.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Time is up! Please request a new OTP.', expired: true });
    }
    await otpsCollection.updateOne(
      { _id: record._id },
      { $set: { verified: true } }
    );
    console.log(`✅ OTP ${otp} verified`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/otp/list', requireAdmin, async (req, res) => {
  try {
    const list = await otpsCollection.find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Promotions ----
app.get('/api/promotions', async (req, res) => {
  try {
    const promos = await promotionsCollection.find({}).toArray();
    res.json(promos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/promotions', requireAdmin, async (req, res) => {
  try {
    const { id, heading, image, active } = req.body;
    if (!id || !heading || !image) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const existing = await promotionsCollection.findOne({ id });
    if (existing) {
      return res.status(400).json({ error: 'Promotion id already exists' });
    }
    const newPromo = {
      id,
      heading,
      image,
      active: active !== undefined ? active : true,
      createdAt: new Date()
    };
    await promotionsCollection.insertOne(newPromo);
    res.json(newPromo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/promotions/:id', requireAdmin, async (req, res) => {
  try {
    const { heading, image, active } = req.body;
    const update = {};
    if (heading !== undefined) update.heading = heading;
    if (image !== undefined) update.image = image;
    if (active !== undefined) update.active = active;
    const result = await promotionsCollection.updateOne(
      { id: req.params.id },
      { $set: update }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Promotion not found' });
    }
    const updated = await promotionsCollection.findOne({ id: req.params.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/promotions/:id', requireAdmin, async (req, res) => {
  try {
    const result = await promotionsCollection.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Promotion not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Waiting Customers ----
// Two ways a customer lands here:
// 1. They paid/verified for a subscription that has no account/slot
//    available yet (out of stock) — subscriptionId is set.
// 2. They submitted a "Custom Subscription Request" for something not
//    listed at all — subscriptionId is null and isCustomRequest is true.
// Either way, nothing is auto-removed: the admin sees it here until they
// manually mark it fulfilled once the account has been created and given
// to the customer.
app.get('/api/waiting', requireAdmin, async (req, res) => {
  try {
    const list = await waitingCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/waiting', async (req, res) => {
  try {
    const {
      subscriptionId, subscriptionName, isCustomRequest,
      name, username, whatsapp, months, email,
      paidWithCredits, creditsAmount, purchasedAt, purchaseId,
      // Social media service order fields — set when a customer confirms a
      // follower/likes/views/comments order paid for with credits, instead
      // of a subscription. subscriptionName is still filled in (as
      // "Platform — Service") so this reuses the same waiting list without
      // needing a separate collection.
      isSocialOrder, platformId, platformName, serviceId, serviceName,
      quantity, linkType, linkValue, price
    } = req.body;
    if (!subscriptionName || !name || !whatsapp) {
      return res.status(400).json({ error: 'subscriptionName, name and whatsapp are required' });
    }

    // Same waiting-request submitted twice? Don't add a duplicate entry.
    const key = purchaseId ? `waiting:${purchaseId}:${subscriptionId || 'custom'}` : null;
    const claimed = await claimIdempotencyKey(key);
    if (!claimed) {
      return res.json({ duplicate: true });
    }

    const entry = {
      id: Date.now().toString(),
      subscriptionId: subscriptionId || null,
      subscriptionName,
      isCustomRequest: !!isCustomRequest,
      name,
      username: username || '',
      whatsapp,
      months: months || 1,
      email: email || '',
      paidWithCredits: !!paidWithCredits,
      creditsAmount: creditsAmount || 0,
      isSocialOrder: !!isSocialOrder,
      platformId: platformId || null,
      platformName: platformName || '',
      serviceId: serviceId || null,
      serviceName: serviceName || '',
      quantity: quantity || 0,
      linkType: linkType || '',
      linkValue: linkValue || '',
      price: price || 0,
      fulfilled: false,
      purchasedAt: purchasedAt || new Date().toISOString(),
      createdAt: new Date()
    };
    await waitingCollection.insertOne(entry);
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/waiting/:id', requireAdmin, async (req, res) => {
  try {
    const result = await waitingCollection.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Waiting entry not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Help / FAQ (admin-added, on top of the built-in ones in the UI) ----
app.get('/api/faqs', async (req, res) => {
  try {
    const list = await faqsCollection.find({}).sort({ createdAt: 1 }).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/faqs', requireAdmin, async (req, res) => {
  try {
    const { question, answer, category } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: 'question and answer are required' });
    }
    const entry = {
      id: Date.now().toString(),
      question,
      answer,
      category: category || 'General',
      createdAt: new Date()
    };
    await faqsCollection.insertOne(entry);
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/faqs/:id', requireAdmin, async (req, res) => {
  try {
    const result = await faqsCollection.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'FAQ not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Notices (customer notes board) ----
// Two kinds of entries can appear on a customer's board:
//  1. Auto-generated security heads-up messages — computed fresh on every
//     request, not stored — about an upcoming PIN change on a screen this
//     customer shares with someone else whose subscription is expiring.
//  2. Admin broadcast messages, sent from the Admin Portal to every
//     customer at once and stored here.
app.get('/api/notices', async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth || auth.r !== 'admin') return res.status(401).json({ error: 'Admin login required' });
    const list = await noticesCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notices', async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth || auth.r !== 'admin') return res.status(401).json({ error: 'Admin login required' });
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });
    const entry = { id: Date.now().toString(), message: message.trim(), createdAt: new Date() };
    await noticesCollection.insertOne(entry);
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notices/:id', async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth || auth.r !== 'admin') return res.status(401).json({ error: 'Admin login required' });
    const result = await noticesCollection.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Notice not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A shared screen's PIN gets regenerated the day AFTER a departing
// customer's expiry (once the admin has had a chance to get their
// access/device back). This works out, for one "someone else on my screen
// is expiring" event, whether today is 2 days before that change, 1 day
// before, the day of, or already handled — and if so, which message (if
// any) belongs on the notes board today.
//
// RECENT_PIN_RESET_SUPPRESSION_DAYS: a PIN reset only counts as "this
// person's departure was already handled" if it happened on/after their
// own expiry AND within this many days — an old reset (from a different,
// unrelated departure on this same screen, or routine PIN rotation) must
// never permanently silence notices for someone else. Tune this if that
// feels too aggressive or too lax.
const RECENT_PIN_RESET_SUPPRESSION_DAYS = 7;
function pinChangeNoteForExpiry(expiryDate, screen) {
  if (!expiryDate) return null;
  const exp = new Date(expiryDate);
  if (isNaN(exp.getTime())) return null;
  exp.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Already handled: the PIN was reset on/after this person's expiry, and
  // that reset was recent — so the admin has already dealt with this
  // specific departure. We require BOTH conditions (not just resetAt >=
  // exp) because otherwise a reset from a totally unrelated, older
  // departure on this same screen (or a one-off manual PIN reset months
  // ago) would permanently silence notices for every future customer
  // whose expiry happens to fall before that old timestamp.
  if (screen.pinResetAt) {
    const resetAt = new Date(screen.pinResetAt);
    resetAt.setHours(0, 0, 0, 0);
    const sinceReset = Math.round((today - resetAt) / (1000 * 60 * 60 * 24));
    if (resetAt >= exp && sinceReset >= 0 && sinceReset <= RECENT_PIN_RESET_SUPPRESSION_DAYS) {
      return null;
    }
  }

  const changeDay = new Date(exp);
  changeDay.setDate(changeDay.getDate() + 1);
  const daysToChange = Math.round((changeDay - today) / (1000 * 60 * 60 * 24));
  if (daysToChange < 0 || daysToChange > 2) return null;

  if (daysToChange === 2) return "For your security, we'll be changing this screen's PIN soon. We'll update it here — stay tuned!";
  if (daysToChange === 1) return "For your security, we'll be changing this screen's PIN tomorrow. We'll update it here — stay tuned!";
  if (daysToChange === 0) return "For your security, we're changing this screen's PIN today. We'll update it here — stay tuned!";
  return null;
}

app.get('/api/my-notes', async (req, res) => {
  try {
    const auth = getAuth(req);
    if (!auth) return res.status(401).json({ error: 'Please log in first' });
    if (auth.r !== 'user') return res.status(400).json({ error: 'This endpoint is for a logged-in customer' });
    const username = auth.u;

    const subs = await subscriptionsCollection.find({}).toArray();
    const securityNotes = [];
    for (const sub of subs) {
      for (const acc of (sub.accounts || [])) {
        for (const screen of (acc.screens || [])) {
          const customers = screen.customers || [];
          if (!customers.some(c => c.username === username)) continue; // not my screen
          for (const other of customers) {
            if (other.username === username) continue; // that's the departing person, not the screen-mate reading this
            const msg = pinChangeNoteForExpiry(other.expiryDate, screen);
            if (msg) {
              securityNotes.push({
                id: `pin-${sub.id}-${acc.id}-${screen.id}-${other.username}`,
                type: 'security',
                message: `${sub.name} — ${screen.name}: ${msg}`,
                date: new Date().toISOString()
              });
            }
          }
        }
      }
    }

    const broadcasts = await noticesCollection.find({}).sort({ createdAt: -1 }).toArray();
    const broadcastNotes = broadcasts.map(n => ({
      id: `broadcast-${n.id}`,
      type: 'broadcast',
      message: n.message,
      date: n.createdAt
    }));

    const combined = [...securityNotes, ...broadcastNotes];
    combined.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(combined);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Custom Grants ----
// A custom grant is a manually-fulfilled subscription that doesn't come
// from the regular accounts/screens catalog — e.g. a customer asked for
// something out of stock or not normally sold, and the admin sourced a
// one-off account for it by hand. It still shows up in the customer's
// portal like a real purchase (name, email, password, expiry), and still
// counts toward income, but the cost/selling price used for that
// calculation are admin-only — never sent back on a customer-scoped fetch.
app.get('/api/custom-grants', async (req, res) => {
  try {
    const { username } = req.query;
    const auth = getAuth(req);
    if (username) {
      // Customer-facing fetch — strip the admin-only cost/pricing fields, and
      // only include the granted account password for the customer themselves
      // (or the admin), so nobody can read someone else's keys by guessing a
      // username.
      const canSeeCreds = !!auth && (auth.r === 'admin' || auth.u === username);
      const list = await customGrantsCollection.find({ username }).sort({ createdAt: -1 }).toArray();
      const sanitized = list.map(({ costPerMonth, sellingPrice, matchedSubscriptionId, password, ...rest }) =>
        canSeeCreds ? { ...rest, password } : rest);
      return res.json(sanitized);
    }
    // No username → the admin's full list (with pricing + keys). Only the
    // admin may load this; everyone else gets nothing.
    if (!auth || auth.r !== 'admin') return res.json([]);
    const list = await customGrantsCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/custom-grants', requireAdmin, async (req, res) => {
  try {
    const {
      username, name, whatsapp, subscriptionName, email, password, notes,
      months, days, matchedSubscriptionId, costPerMonth, sellingPrice
    } = req.body;
    if (!username || !subscriptionName || !subscriptionName.trim()) {
      return res.status(400).json({ error: 'username and subscriptionName are required' });
    }

    // "Already listed" means: trust that catalog subscription's own
    // cost/selling price for the income calculation rather than whatever
    // was typed in — single source of truth, and it's what keeps this
    // consistent with every other cost figure in the Income tab.
    let finalCostPerMonth = Number(costPerMonth) || 0;
    let finalSellingPrice = Number(sellingPrice) || 0;
    if (matchedSubscriptionId) {
      const matched = await subscriptionsCollection.findOne({ id: matchedSubscriptionId });
      if (matched) {
        finalCostPerMonth = matched.costPerMonth || 0;
        finalSellingPrice = matched.sellingPrice || 0;
      }
    } else if (!costPerMonth && !sellingPrice) {
      return res.status(400).json({ error: 'Cost and selling price are required for a subscription not in your catalog' });
    }

    const now = new Date();
    const totalDays = months ? Number(months) * 30 : (Number(days) || 30);
    const expiry = new Date(now);
    expiry.setDate(expiry.getDate() + totalDays);

    const entry = {
      id: crypto.randomUUID(),
      username,
      name: name || '',
      whatsapp: whatsapp || '',
      subscriptionName: subscriptionName.trim(),
      email: email || '',
      password: password || '',
      notes: notes || '',
      months: months ? Number(months) : 0,
      days: totalDays,
      expiryDate: expiry.toISOString().split('T')[0],
      matchedSubscriptionId: matchedSubscriptionId || null,
      costPerMonth: finalCostPerMonth,
      sellingPrice: finalSellingPrice,
      purchasedAt: now.toISOString(),
      createdAt: now
    };
    await customGrantsCollection.insertOne(entry);
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/custom-grants/:id', requireAdmin, async (req, res) => {
  try {
    const result = await customGrantsCollection.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- INCOME CALCULATION ----
// costPerMonth = what YOU pay for the account (your expense/cost).
// sellingPrice = what YOU charge the customer (your revenue).
// profit = revenue - cost. All three are reported separately, plus a
// breakdown by subscription type and an optional custom date range.
app.get('/api/income', requireAdmin, async (req, res) => {
  try {
    const { period, startDate: customStart, endDate: customEnd } = req.query;
    const now = new Date();
    let startDate = new Date(now);
    let endDate = now;

    if (period === 'monthly') {
      startDate.setDate(1);
      startDate.setHours(0, 0, 0, 0);
    } else if (period === '30') {
      startDate.setDate(startDate.getDate() - 30);
    } else if (period === '60') {
      startDate.setDate(startDate.getDate() - 60);
    } else if (period === '90') {
      startDate.setDate(startDate.getDate() - 90);
    } else if (period === 'custom' && customStart) {
      startDate = new Date(customStart);
      startDate.setHours(0, 0, 0, 0);
      endDate = customEnd ? new Date(customEnd) : now;
      endDate.setHours(23, 59, 59, 999);
    } else {
      startDate = new Date(0);
    }

    const subs = await subscriptionsCollection.find({}).toArray();
    let totalRevenue = 0, totalCost = 0;
    let customers = [];
    let revenueByType = {}, costByType = {};
    // Per-subscription-document cost breakdown, so an inflated total is
    // easy to trace back to exactly which subscription has more accounts
    // saved against it than expected (e.g. leftover duplicates).
    let subscriptionBreakdown = [];

    subs.forEach(sub => {
      // No accounts on this subscription at all -> nothing to have cost you
      // money for, so it's skipped entirely and never counted.
      if (!sub.accounts || sub.accounts.length === 0) return;

      const costPerMonth = sub.costPerMonth || 0;
      const sellingPrice = sub.sellingPrice || 0;
      const subType = sub.type;

      // Cost is a flat, recurring amount per ACCOUNT you maintain (what you
      // actually pay the provider for it) — completely independent of how
      // many customers you've put on it or which reporting period is
      // selected. Adding another customer to an existing account must NOT
      // increase this; only adding another account does.
      const accountsCost = sub.accounts.length * costPerMonth;
      totalCost += accountsCost;
      costByType[subType] = (costByType[subType] || 0) + accountsCost;
      subscriptionBreakdown.push({
        subscriptionId: sub.id,
        name: sub.name,
        type: subType,
        accountsCount: sub.accounts.length,
        costPerAccount: costPerMonth,
        totalCost: accountsCost,
        accountEmails: sub.accounts.map(a => a.email).filter(Boolean)
      });

      sub.accounts.forEach(acc => {
        acc.screens.forEach(screen => {
          if (screen.customers && screen.customers.length > 0) {
            screen.customers.forEach(c => {
              const expiryDate = c.expiryDate ? new Date(c.expiryDate) : null;
              const purchaseDate = c.purchasedAt ? new Date(c.purchasedAt) : null;

              if (expiryDate && expiryDate < now) return;

              if (purchaseDate && (purchaseDate < startDate || purchaseDate > endDate)) return;
              if (!purchaseDate) {
                const months = c.months || 1;
                const estPurchase = new Date(expiryDate);
                estPurchase.setMonth(estPurchase.getMonth() - months);
                if (estPurchase < startDate || estPurchase > endDate) return;
              }

              const months = c.months || 1;
              const revenue = sellingPrice * months;

              totalRevenue += revenue;
              revenueByType[subType] = (revenueByType[subType] || 0) + revenue;

              customers.push({
                customerName: c.name || c.username,
                subscriptionType: sub.type,
                subscriptionName: sub.name,
                screenName: screen.name,
                accountEmail: acc.email,
                months: months,
                revenue: revenue,
                expiryDate: c.expiryDate,
                purchasedAt: c.purchasedAt || purchaseDate
              });
            });
          }
        });
      });
    });

    // Custom grants (manually-fulfilled, out-of-catalog subscriptions) count
    // toward income the same way a regular customer purchase does — cost is
    // a flat recurring amount for as long as it's active, revenue is what
    // the customer was actually charged, counted only if the grant was made
    // within the selected period.
    const customGrants = await customGrantsCollection.find({}).toArray();
    customGrants.forEach(g => {
      const expiryDate = g.expiryDate ? new Date(g.expiryDate) : null;
      if (expiryDate && expiryDate < now) return; // expired — no longer an active cost

      const cost = g.costPerMonth || 0;
      totalCost += cost;
      costByType['custom'] = (costByType['custom'] || 0) + cost;

      const purchaseDate = g.purchasedAt ? new Date(g.purchasedAt) : null;
      if (purchaseDate && (purchaseDate < startDate || purchaseDate > endDate)) return;

      const revenue = (g.sellingPrice || 0) * (g.months || 1);
      totalRevenue += revenue;
      revenueByType['custom'] = (revenueByType['custom'] || 0) + revenue;

      customers.push({
        customerName: g.name || g.username,
        subscriptionType: 'custom',
        subscriptionName: g.subscriptionName + ' (custom grant)',
        screenName: 'N/A',
        accountEmail: g.email,
        months: g.months || 1,
        revenue: revenue,
        expiryDate: g.expiryDate,
        purchasedAt: g.purchasedAt || purchaseDate
      });
    });

    const totalProfit = totalRevenue - totalCost;
    const profitByType = {};
    const allTypes = new Set([...Object.keys(revenueByType), ...Object.keys(costByType)]);
    allTypes.forEach(t => {
      profitByType[t] = (revenueByType[t] || 0) - (costByType[t] || 0);
    });

    res.json({
      totalRevenue,
      totalCost,
      totalProfit,
      revenueByType,
      costByType,
      profitByType,
      customers,
      subscriptionBreakdown,
      period: period || 'all',
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }

});

// ---- Health ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', database: db ? 'connected' : 'disconnected' });
});

// ═══════════════════════════════════════════════════════════════
// JARVIS — local admin assistant (no external API of any kind)
// The admin types or speaks a request, this file pattern-matches it
// against a broad list of known intents below, pulls out the details
// (username, amount, price, etc.) with plain text parsing, and calls
// the matching tool in executeJarvisTool() directly — the same real,
// narrow, server-side actions as before. If something required is
// missing, it asks one short follow-up question; answering it lets
// Jarvis pick the request back up without repeating everything.
// ═══════════════════════════════════════════════════════════════

// This portal has one admin — hardcoding their name here (rather than
// wiring up a whole "who's logged in" identity system just for small talk)
// is what lets Jarvis greet them personally and refer to them by name.
const ADMIN_FULL_NAME = 'Mutahhar Ali';
const ADMIN_FIRST_NAME = 'Mutahhar';

// ── Typo tolerance ──────────────────────────────────────────────
// Jarvis runs entirely on pattern-matching (no AI model behind it), so a
// misspelled command word ("creidt", "subscribtion", "watiing") would
// normally just fail to match anything. This fixes that: every command
// word Jarvis actually listens for is a "vocabulary", and before parsing,
// each word in what the admin typed gets checked against it — close
// enough (by edit distance) and clearly not already a real word gets
// silently corrected. Quoted text (titles, FAQ answers) and anything with
// a digit or @ in it (usernames, emails, amounts) is left completely
// alone, so this can't mangle actual data, only the command words around it.
const JARVIS_VOCAB = [
  'add','added','adding','deduct','deducted','subtract','remove','removed','give','grant','granted',
  'credit','credits','user','users','customer','customers','account','accounts','password','passwords',
  'reset','change','changed','update','updated','create','created','new','delete','deleted','find','found',
  'look','search','list','show','showing','subscription','subscriptions','deal','deals','promotion',
  'promotions','promo','banner','banners','platform','platforms','service','services','waiting','faq',
  'faqs','notice','notices','announcement','summary','overview','business','custom','social','media',
  'instagram','tiktok','youtube','facebook','snapchat','followers','likes','views','comments','whatsapp',
  'name','named','called','email','login','price','cost','selling','active','inactive','activate',
  'deactivate','enable','disable','resolve','fulfill','fulfilled','revoke','question','answer','message',
  'months','signup','register','description','hello','thanks','please'
];

function jarvisLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function jarvisClosestVocabWord(word) {
  if (word.length < 4) return null; // too short to safely correct without false positives
  let best = null, bestDist = Infinity;
  for (const v of JARVIS_VOCAB) {
    if (Math.abs(v.length - word.length) > 2) continue; // cheap prune
    const d = jarvisLevenshtein(word, v);
    if (d < bestDist) { bestDist = d; best = v; }
  }
  const threshold = word.length <= 5 ? 1 : 2; // stricter tolerance for short words
  return (best && bestDist > 0 && bestDist <= threshold) ? best : null;
}

function jarvisCorrectTypos(text) {
  const quotedSpans = [];
  const placeholder = text.replace(/["'“”‘’][^"'“”‘’]*["'“”‘’]/g, (m) => {
    quotedSpans.push(m);
    return `__QUOTE${quotedSpans.length - 1}__`;
  });
  const corrected = placeholder.split(/(\s+)/).map(tok => {
    if (/^\s*$/.test(tok) || /^__QUOTE\d+__$/.test(tok)) return tok;
    const m = tok.match(/^([a-zA-Z]+)([.,!?]*)$/); // pure-letters only — skips usernames/emails/numbers
    if (!m) return tok;
    const [, word, punct] = m;
    if (JARVIS_VOCAB.includes(word.toLowerCase())) return tok;
    const fix = jarvisClosestVocabWord(word.toLowerCase());
    return fix ? fix + punct : tok;
  }).join('');
  return corrected.replace(/__QUOTE(\d+)__/g, (_, i) => quotedSpans[Number(i)]);
}

// ── Small talk ───────────────────────────────────────────────────
// Handled completely separately from the task-parsing below — a "hi" or
// "thanks" should never fall through to "I didn't catch that". Returns a
// plain reply string, or null if this isn't small talk at all.
//
// Worth being upfront about (this comment, not what Jarvis says out loud):
// there's no language model behind any of this — it's pattern matching
// against phrases we thought to anticipate. It can hold a decent bit of
// casual conversation and give canned advice on running this business, but
// it will never truly understand an arbitrary sentence the way a real AI
// model would. That's the tradeoff for not calling an external API.
const JARVIS_ADVICE = [
  "If credits are sitting unused for a while, a small 'use them or lose a bonus' nudge in a notice tends to bring people back.",
  "Waiting customers piling up is usually a pricing or stock problem, not a marketing one — worth checking if a popular subscription's out of accounts before running a promo for it.",
  "Deals convert best when the discount is obvious at a glance — RS off and a strikethrough price beats a vague '% off' most of the time.",
  "If the same customer keeps needing a password reset, it's worth just asking them on WhatsApp what's going wrong — usually a small confusion, not a real problem.",
  "For social media services, keeping 2–3 well-priced options per platform beats offering everything — too many choices slows people down.",
  "A short, honest notice ('running a bit behind on orders today') keeps customers calmer than silence when things are slow.",
  "Custom grants are great for one-offs, but if you're granting the same subscription manually a lot, it might be worth adding it to the catalog properly."
];

const JARVIS_JOKES = [
  "Why did the customer's account get suspended? It had too many trust issues with its password.",
  "I'd tell you a joke about credits, but you'd probably want a refund.",
  "Why don't subscriptions ever get lonely? They're always bundled with someone.",
  "I asked a customer for their account link. They sent me their LinkedIn. Close, but no."
];

function jarvisSmallTalk(rawText) {
  const t = rawText.trim().toLowerCase().replace(/[!.?]+$/, '');
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  if (/^(hi+|hello+|hey+|yo|salam|assalamu?\s*alaikum|asalam.*alaikum|aoa)(\s*,?\s*jarvis)?$/.test(t)) {
    return pick([
      `Hey ${ADMIN_FIRST_NAME}! What can I take care of for you?`,
      `Hi ${ADMIN_FIRST_NAME} — good to see you. What do you need?`,
      `Hello! I'm here and ready — what should I do?`
    ]);
  }
  if (/^(jarvis)$/.test(t)) return `Yes ${ADMIN_FIRST_NAME}, I'm listening — go ahead.`;

  if (/how are you|how('?s| is) it going|how('?s| have) you been|what'?s up|whats up|sup\b/.test(t)) {
    return pick([
      `I'm doing great, thanks for asking! Everything's running smoothly on the portal. What can I help with?`,
      `All good on my end — quiet day so far on the portal. How about you, how's it going?`,
      `Can't complain — no fires to put out right now. What's on your mind?`
    ]);
  }
  if (/^i'?m (tired|exhausted|stressed|overwhelmed|busy|struggling)\b/.test(t)) {
    return pick([
      `Sounds like a lot — take a breather if you can. I've got things covered here whenever you're ready.`,
      `That's rough, ${ADMIN_FIRST_NAME}. No rush on anything — let me know if there's something I can take off your plate.`
    ]);
  }
  if (/^i'?m (good|great|happy|excited|doing well|fine)\b/.test(t)) {
    return pick([`Glad to hear it! What can I help with?`, `Nice — let's make it a productive one. What do you need?`]);
  }

  if (/^(thanks|thank you|thankyou|thnx|ty|shukriya)\b/.test(t)) {
    return pick([`Anytime, ${ADMIN_FIRST_NAME}!`, `You're welcome — let me know if there's anything else.`, `Happy to help!`]);
  }
  if (/^(bye|goodbye|see you|see ya|later|good night)\b/.test(t)) {
    return `See you later, ${ADMIN_FIRST_NAME}! I'll be right here whenever you need me.`;
  }
  if (/who are you|what('?s| is) your name|what are you called/.test(t)) {
    return `I'm Jarvis — your assistant for this admin portal. I can handle the day-to-day tasks in here, but I'm also happy to just talk things through, brainstorm, or give you my honest take on something. What's up?`;
  }
  if (/^(ok|okay|alright|cool|nice|great|good)\.?$/.test(t)) {
    return pick([`👍`, `Sounds good.`, `Got it.`]);
  }
  if (/^(sorry|my bad|oops)\b/.test(t)) {
    return `No worries at all — what would you like me to do?`;
  }

  // Advice / opinion-seeking — genuinely useful within the business this
  // portal runs, since that's the one domain Jarvis actually has real,
  // current data about.
  if (/\b(any advice|got advice|advice on|what should i do|any suggestions?|any tips?|what do you (think|suggest|recommend)|your (opinion|take))\b/.test(t)) {
    return pick(JARVIS_ADVICE) + ` (Ask me for another if that's not quite what you needed.)`;
  }
  if (/\btell me a joke\b|\bmake me laugh\b/.test(t)) {
    return pick(JARVIS_JOKES);
  }
  if (/what time is it|current time/.test(t)) {
    return `It's ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} on the server right now.`;
  }
  if (/what'?s the date|today'?s date|what day is it/.test(t)) {
    return `Today's ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
  }
  if (/you'?re (the best|great|awesome|amazing)|good (job|work)\b/.test(t)) {
    return pick([`That means a lot — thank you!`, `Ha, thanks! Just doing my job.`]);
  }
  if (/^i love you\b/.test(t)) {
    return `That's sweet of you to say! I'm just an assistant, but I do genuinely enjoy helping run this place.`;
  }

  return null;
}

// A last-resort, honest reply for something that's clearly a real question
// (starts with what/who/why/how/when/where/is/does/can, or ends with "?")
// but matched nothing above and nothing in the task parser below either.
// Rather than the same capability dump every time, this is upfront about
// the actual limitation and still tries to be useful.
function jarvisHonestUnknown(rawText) {
  const t = rawText.trim();
  const looksLikeQuestion = /\?\s*$/.test(t) || /^(what|who|why|how|when|where|is|does|can|could|should|would)\b/i.test(t);
  if (!looksLikeQuestion) return null;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return pick([
    `Good question — but honestly, that's outside what I can reliably answer. I'm not connected to a general AI model, so I'm best with things about this portal (credits, customers, subscriptions, deals...) or quick chat. What can I actually help with?`,
    `I'd love to answer that properly, but I don't have real general knowledge built in — no AI model behind me, just pattern-matching for portal tasks and casual conversation. Is there something about the business I can help with instead?`
  ]);
}

// Common words that should never be mistaken for a username, name, or
// title when scanning a sentence for "the token that must be the thing
// the admin means".
const JARVIS_STOPWORDS = new Set([
  'a','an','the','to','from','for','of','with','and','or','please','pls','plz',
  'add','adds','added','adding','deduct','deducts','deducted','remove','removes','removed',
  'subtract','minus','give','gives','giving','grant','grants','granting','credit','credits',
  'user','users','username','usernames','customer','customers','account','accounts',
  'password','passwords','reset','resets','change','changes','changed','update','updates','updated',
  'create','creates','creating','new','delete','deletes','deleting','find','finds','finding',
  'look','looks','looking','up','show','shows','showing','list','lists','listing',
  'subscription','subscriptions','sub','deal','deals','promotion','promotions','promo','promos',
  'banner','banners','platform','platforms','service','service','waiting','faq','faqs',
  'notice','notices','announcement','summary','overview','business','how','many','much',
  'is','are','was','were','it','that','this','their','his','her','them','they',
  'set','name','named','called','titled','into','onto','on','at','by','as','my','me',
  'i','want','need','can','you','please','make','set','worth','currently','currently,'
]);

function jarvisExtractNumber(text) {
  const m = text.match(/(\d[\d,]*\.?\d*)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function jarvisExtractAllNumbers(text) {
  const matches = text.match(/\d[\d,]*\.?\d*/g) || [];
  return matches.map(s => parseFloat(s.replace(/,/g, ''))).filter(n => !isNaN(n));
}

function jarvisExtractQuoted(text) {
  const m = text.match(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);
  return m ? m[1].trim() : null;
}

// Finds the token right after any of the given keywords ("to", "user",
// "from"...), skipping an optional filler word ("is"/"to"/"as") in
// between, and stripping trailing punctuation/possessive.
function jarvisExtractAfterKeyword(text, keywords) {
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw}\\b\\s*(?:is|to|as|:|=)?\\s+([a-zA-Z0-9_.@+-]+)`, 'i');
    const m = text.match(re);
    if (m) return m[1].replace(/[.,!?]+$/, '').replace(/['’]s$/, '');
  }
  return null;
}

// Same idea, but grabs everything to the end of the sentence rather than
// one token — for fields that are a whole phrase (a notice's message, an
// FAQ's answer), not a single value.
function jarvisExtractRestAfter(text, keywords) {
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw}\\b\\s*(?:is|to|as|:)?\\s+(.+)$`, 'i');
    const m = text.match(re);
    if (m) return m[1].replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  }
  return null;
}

function jarvisExtractWhatsapp(text) {
  const m = text.match(/(\+?\d[\d\s-]{7,}\d)/);
  return m ? m[1].replace(/[\s-]/g, '') : null;
}

// A username usually shows up either right after a keyword ("to john123",
// "user john123") or as a bare token containing a digit somewhere in the
// sentence ("give john123 100 credits"). Tries the reliable path first.
function jarvisExtractUsername(text) {
  const kw = jarvisExtractAfterKeyword(text, ['username', 'user', 'customer', 'account', 'to', 'from', 'for']);
  if (kw && !JARVIS_STOPWORDS.has(kw.toLowerCase())) return kw;
  const tokens = text.split(/\s+/).map(t => t.replace(/^[.,!?'"]+|[.,!?'"]+$/g, ''));
  const withDigit = tokens.find(t => /\d/.test(t) && /^[a-zA-Z][a-zA-Z0-9_.]*$/.test(t) && !JARVIS_STOPWORDS.has(t.toLowerCase()));
  return withDigit || null;
}

// Best-effort human name: "named John Smith" / "name is John Smith", or
// two consecutive capitalized words that aren't at the very start of the
// sentence (to dodge "Add 100 credits...").
function jarvisExtractPersonName(text) {
  let m = text.match(/\b(?:named|name is|call(?:ed)? them|full name)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/);
  if (m) return m[1].trim();
  m = text.match(/[a-z]\s+([A-Z][a-zA-Z'-]+\s+[A-Z][a-zA-Z'-]+)\b/);
  if (m) return m[1].trim();
  return null;
}

function jarvisExtractPassword(text) {
  if (/\bpassword\b/i.test(text)) {
    const toMatch = text.match(/\bto\b\s+(\S+)\s*$/i);
    if (toMatch && toMatch[1].length >= 4) return toMatch[1];
  }
  const m = text.match(/\b(?:password|pass|pwd)\b\s*(?:is|to|as|:|=)?\s+(\S+)/i);
  if (m && m[1].length >= 4 && !/^(for|to|is|as|of|the|a)$/i.test(m[1])) return m[1];
  const quoted = jarvisExtractQuoted(text);
  if (quoted && /[A-Z]/.test(quoted) && /\d/.test(quoted)) return quoted;
  return null;
}

// Anything the admin wrapped in quotes is almost always the title/name of
// the thing they mean (a subscription, deal, FAQ question, platform...).
// Falls back to whatever's left after stripping known command words.
function jarvisExtractTitle(text, stripWords) {
  const quoted = jarvisExtractQuoted(text);
  if (quoted) return quoted;
  const called = text.match(/\b(?:called|titled|named)\s+(.+)/i);
  if (called) return called[1].replace(/[.!?]+$/, '').trim();
  let cleaned = text;
  stripWords.forEach(w => { cleaned = cleaned.replace(new RegExp(`\\b${w}\\b`, 'ig'), ''); });
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

const JARVIS_CAPABILITIES = [
  'add or deduct a customer\'s credits', 'look up or list customers', 'create, delete, or reset the password on a customer account',
  'list, create, update, or delete subscriptions, and add a new login/account to one',
  'list, create, activate/deactivate, or delete deals', 'list, activate/deactivate, or delete promotion banners',
  'list social-media platforms/services or add a new service under a platform',
  'list waiting customers or resolve one', 'list, grant, or remove a custom subscription grant',
  'list, create, or delete FAQs, and post a customer notice', 'give a quick business summary',
  'remember something for later ("remember that...") and recall it whenever you ask'
];

// Note: the "I didn't understand" reply now lives inline in the /api/jarvis
// route as a small rotating set, so it doesn't sound identical every time.

// Tries to turn one sentence into { tool, input }. Returns null if nothing
// matched at all, or { needsInfo: '...question...' } if the intent was
// clear but a required detail is missing.
// "give him 50 more credits" right after talking about a specific
// customer — rather than asking "whose account?" again, this finds who
// was last mentioned in the conversation and substitutes them in.
const JARVIS_PRONOUN_RE = /\b(him|her|them|that customer|that user|same person|same user|this customer|this user)\b/i;
function jarvisFindLastMentionedUsername(history) {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h || !h.content) continue;
    const u = jarvisExtractUsername(h.content);
    if (u) return u;
  }
  return null;
}

function parseJarvisIntent(rawText) {
  const rawTrimmed = (rawText || '').trim();
  if (!rawTrimmed) return null;

  const smallTalk = jarvisSmallTalk(rawTrimmed);
  if (smallTalk) return { smallTalk };

  const text = jarvisCorrectTypos(rawTrimmed);
  const lower = text.toLowerCase();
  const has = (...words) => words.some(w => lower.includes(w));

  // ── Memory (explicit "remember this" facts, separate from normal
  // conversation context) — a simple persisted note store. Real learning
  // this is not; it's Jarvis keeping exactly what it's told to, verbatim,
  // and giving it back when asked. Checked before typo-correction messes
  // with the word "remember" itself (it's already in the vocab, so it's
  // safe either way, but checked here so it always takes priority).
  if (/\bforget\b/i.test(lower) && (has('everything', 'all', 'clear your memory', 'clear my memory', 'clear memory'))) {
    return { tool: 'forget_all_facts', input: {} };
  }
  if (/\bforget\b/i.test(lower)) {
    const fact = jarvisExtractRestAfter(text, ['forget that', 'forget']);
    if (!fact) return { needsInfo: 'What should I forget?' };
    return { tool: 'forget_fact', input: { fact } };
  }
  if (has('what do you remember', 'what have i told you', 'what did i tell you', 'recall everything', 'list what you remember', "what's in your memory", 'whats in your memory')) {
    return { tool: 'recall_facts', input: {} };
  }
  if (/\bremember\b/i.test(lower) && !has('password', 'my login', 'reset')) {
    const fact = jarvisExtractRestAfter(text, ['remember that', 'remember to', 'remember']);
    if (!fact) return { needsInfo: 'Sure — what should I remember?' };
    return { tool: 'remember_fact', input: { fact } };
  }

  // ── Business summary ──────────────────────────────────────
  if (has('business summary', 'overview', 'how is business', "how's business", 'dashboard stats', 'quick stats', 'business stats')) {
    return { tool: 'get_business_summary', input: {} };
  }

  // ── Credits ────────────────────────────────────────────────
  if (has('credit')) {
    const amount = jarvisExtractNumber(text);
    const username = jarvisExtractUsername(text);
    const isDeduct = has('deduct', 'subtract', 'remove', 'take away', 'minus');
    const tool = isDeduct ? 'deduct_credits' : 'add_credits';
    if (!username) return { needsInfo: `Sure — whose account should I ${isDeduct ? 'deduct' : 'add'} credits ${isDeduct ? 'from' : 'to'}?` };
    if (!amount) return { needsInfo: `How many credits should I ${isDeduct ? 'deduct from' : 'add to'} ${username}?` };
    return { tool, input: { username, amount } };
  }

  // ── Password reset ────────────────────────────────────────
  if (has('password') && (has('reset', 'change', 'update', 'new password', 'forgot') || /\bset\b.*\bpassword\b/.test(lower)) && !has('create', 'new user', 'sign up', 'signup', 'register', 'grant')) {
    const beforePassword = text.split(/\bpassword\b/i)[0];
    const afterPassword = text.split(/\bpassword\b/i)[1] || '';
    const username = jarvisExtractAfterKeyword(text, ['for', 'of']) || jarvisExtractUsername(beforePassword) || jarvisExtractUsername(afterPassword);
    const newPassword = jarvisExtractPassword(text);
    if (!username) return { needsInfo: "Whose password should I reset?" };
    if (!newPassword) return { needsInfo: `What should ${username}'s new password be?` };
    return { tool: 'reset_user_password', input: { username, newPassword } };
  }

  // ── Waiting list ───────────────────────────────────────────
  if (has('waiting')) {
    if (has('resolve', 'fulfill', 'fulfilled', 'clear', 'done with', 'sorted')) {
      const username = jarvisExtractUsername(text);
      if (!username) return { needsInfo: 'Which customer\'s waiting entry should I resolve?' };
      return { tool: 'resolve_waiting', input: { username } };
    }
    return { tool: 'list_waiting', input: {} };
  }

  // ── Add a login to a subscription ───────────────────────────
  // Checked before the generic user/customer branch below since both use
  // the word "account" — this one's the login-with-an-email-and-password
  // flavor, so an email address in the sentence is the tell.
  {
    const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (emailMatch && has('add', 'new') && has('account', 'login')) {
      const idOrName = jarvisExtractQuoted(text) || jarvisExtractAfterKeyword(text, ['to', 'subscription']);
      const password = jarvisExtractPassword(text);
      if (!idOrName) return { needsInfo: 'Which subscription should I add this account to?' };
      if (!password) return { needsInfo: `I need the login password for the new ${idOrName} account.` };
      return { tool: 'add_account', input: { idOrName, email: emailMatch[0], password } };
    }
  }

  // ── Users / customers ─────────────────────────────────────
  if (has('user', 'customer', 'account') && !has('subscription', 'deal', 'promo', 'faq', 'notice', 'social', 'platform', 'waiting')) {
    if (has('list', 'recent', 'show me', 'who signed up')) {
      return { tool: 'list_users', input: { limit: jarvisExtractNumber(text) || 20 } };
    }
    if (has('find', 'look up', 'lookup', 'search', 'who is', 'check')) {
      const username = jarvisExtractUsername(text);
      if (!username) return { needsInfo: 'Which username should I look up?' };
      return { tool: 'find_user', input: { username } };
    }
    if (has('delete', 'remove')) {
      const username = jarvisExtractUsername(text);
      if (!username) return { needsInfo: 'Which username should I delete?' };
      return { tool: 'delete_user', input: { username } };
    }
    if (has('create', 'new', 'register', 'sign up', 'signup')) {
      const username = jarvisExtractUsername(text);
      const name = jarvisExtractPersonName(text) || username;
      const password = jarvisExtractPassword(text);
      const whatsapp = jarvisExtractWhatsapp(text);
      const missing = [];
      if (!username) missing.push('a username');
      if (!password) missing.push('a password');
      if (!whatsapp) missing.push('a WhatsApp number');
      if (missing.length) return { needsInfo: `To create that account I still need ${missing.join(', ')}.` };
      return { tool: 'create_user', input: { name, username, password, whatsapp } };
    }
    // Bare lookup: "john123" mentioned with "user"/"customer" but no clear verb
    const username = jarvisExtractUsername(text);
    if (username) return { tool: 'find_user', input: { username } };
  }

  // ── Custom grants ──────────────────────────────────────────
  if (has('grant')) {
    if (has('list', 'show')) return { tool: 'list_custom_grants', input: {} };
    if (has('delete', 'remove', 'revoke')) {
      const username = jarvisExtractUsername(text);
      const subscriptionName = jarvisExtractTitle(text, ['delete', 'remove', 'revoke', 'grant', 'custom', 'from', username || '']);
      if (!username) return { needsInfo: 'Whose custom grant should I remove, and which subscription?' };
      if (!subscriptionName) return { needsInfo: `Which subscription grant should I remove from ${username}?` };
      return { tool: 'delete_custom_grant', input: { username, subscriptionName } };
    }
    const textNoMonths = text.replace(/\bfor\s+\d+\s*months?\b/i, '');
    const username = jarvisExtractAfterKeyword(text, ['grant']) || jarvisExtractUsername(textNoMonths);
    const subscriptionName = jarvisExtractQuoted(text);
    const email = jarvisExtractAfterKeyword(text, ['email']);
    const password = jarvisExtractPassword(text);
    const monthsMatch = text.match(/(\d+)\s*months?\b/i);
    const months = monthsMatch ? parseInt(monthsMatch[1], 10) : 1;
    const missing = [];
    if (!username) missing.push('who it\'s for');
    if (!subscriptionName) missing.push('the subscription name (in quotes is safest)');
    if (!email) missing.push('the login email');
    if (!password) missing.push('the login password');
    if (missing.length) return { needsInfo: `To grant that I still need: ${missing.join(', ')}.` };
    return { tool: 'grant_subscription', input: { username, subscriptionName, email, password, months: months || 1 } };
  }

  // ── FAQs ────────────────────────────────────────────────────
  if (has('faq')) {
    if (has('delete', 'remove')) {
      const question = jarvisExtractQuoted(text) || jarvisExtractTitle(text, ['delete', 'remove', 'faq']);
      if (!question) return { needsInfo: 'Which FAQ (by its question) should I delete?' };
      return { tool: 'delete_faq', input: { question } };
    }
    if (has('create', 'add', 'new')) {
      const question = jarvisExtractQuoted(text);
      if (!question) return { needsInfo: 'What should the FAQ question say (put it in quotes), and what\'s the answer?' };
      const rest = text.replace(`"${question}"`, '').replace(`'${question}'`, '');
      const answer = jarvisExtractQuoted(rest) || jarvisExtractRestAfter(rest, ['answer']);
      if (!answer) return { needsInfo: `Got the question — what's the answer?` };
      return { tool: 'create_faq', input: { question, answer } };
    }
    return { tool: 'list_faqs', input: {} };
  }

  // ── Notices ─────────────────────────────────────────────────
  if (has('notice', 'announcement', 'broadcast', 'post a message')) {
    const message = jarvisExtractQuoted(text) || jarvisExtractRestAfter(text, ['saying', 'that says', 'that']);
    if (!message) return { needsInfo: 'What should the notice say?' };
    return { tool: 'create_notice', input: { message } };
  }

  // ── Social media services ──────────────────────────────────
  if (has('social', 'instagram', 'tiktok', 'youtube', 'facebook', 'snapchat', 'followers', 'likes')) {
    if (has('add', 'create', 'new') && has('service')) {
      const platformName = jarvisExtractAfterKeyword(text, ['platform', 'to', 'under', 'on']);
      const serviceName = jarvisExtractQuoted(text);
      const numbers = jarvisExtractAllNumbers(text);
      if (!platformName) return { needsInfo: 'Which platform is this service under?' };
      if (!serviceName) return { needsInfo: `What's the service called (e.g. "Followers")?` };
      if (numbers.length < 2) return { needsInfo: `What's the cost price and selling price (per 1000) for ${serviceName}?` };
      return { tool: 'add_social_service', input: { platformName, serviceName, costPrice: numbers[0], sellingPrice: numbers[1] } };
    }
    return { tool: 'list_social_services', input: {} };
  }

  // ── Deals ───────────────────────────────────────────────────
  if (has('deal')) {
    const dealTurnOff = has('deactivate', 'disable', 'turn off');
    const dealTurnOn = !dealTurnOff && has('activate', 'enable', 'turn on');
    if (dealTurnOff || dealTurnOn) {
      const title = jarvisExtractQuoted(text) || jarvisExtractTitle(text, ['activate', 'enable', 'turn', 'on', 'deactivate', 'disable', 'off', 'deal', 'the']);
      const active = dealTurnOn;
      if (!title) return { needsInfo: `Which deal should I ${active ? 'activate' : 'deactivate'}?` };
      return { tool: 'toggle_deal', input: { title, active } };
    }
    if (has('delete', 'remove')) {
      const title = jarvisExtractQuoted(text) || jarvisExtractTitle(text, ['delete', 'remove', 'deal', 'the']);
      if (!title) return { needsInfo: 'Which deal should I delete?' };
      return { tool: 'delete_deal', input: { title } };
    }
    if (has('create', 'new', 'add')) {
      const title = jarvisExtractQuoted(text);
      const numbers = jarvisExtractAllNumbers(text);
      if (!title) return { needsInfo: 'What should the deal be called (put the title in quotes)?' };
      if (numbers.length < 2) return { needsInfo: `What's the original price and the discounted price for "${title}"?` };
      return { needsInfo: `Got "${title}" at RS ${numbers[1]} (was RS ${numbers[0]}) — which subscriptions should it bundle? Name them and I'll set it up.` };
    }
    return { tool: 'list_deals', input: {} };
  }

  // ── Promotions ──────────────────────────────────────────────
  if (has('promotion', 'promo', 'banner')) {
    const promoTurnOff = has('deactivate', 'disable', 'turn off');
    const promoTurnOn = !promoTurnOff && has('activate', 'enable', 'turn on');
    if (promoTurnOff || promoTurnOn) {
      const heading = jarvisExtractQuoted(text) || jarvisExtractTitle(text, ['activate', 'enable', 'turn', 'on', 'deactivate', 'disable', 'off', 'promotion', 'promo', 'banner', 'the']);
      const active = promoTurnOn;
      if (!heading) return { needsInfo: `Which promotion should I ${active ? 'activate' : 'deactivate'}?` };
      return { tool: 'toggle_promotion', input: { heading, active } };
    }
    if (has('delete', 'remove')) {
      const heading = jarvisExtractQuoted(text) || jarvisExtractTitle(text, ['delete', 'remove', 'promotion', 'promo', 'banner', 'the']);
      if (!heading) return { needsInfo: 'Which promotion should I delete?' };
      return { tool: 'delete_promotion', input: { heading } };
    }
    return { tool: 'list_promotions', input: {} };
  }

  // ── Subscriptions / accounts ────────────────────────────────
  if (has('subscription', 'sub ') || lower.startsWith('sub ')) {
    if (has('add') && has('account', 'login')) {
      const idOrName = jarvisExtractQuoted(text) || jarvisExtractAfterKeyword(text, ['to', 'subscription']);
      const email = jarvisExtractAfterKeyword(text, ['email']) || (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0];
      const password = jarvisExtractPassword(text);
      if (!idOrName) return { needsInfo: 'Which subscription should I add this account to?' };
      if (!email || !password) return { needsInfo: `I need both the login email and password for the new ${idOrName} account.` };
      return { tool: 'add_account', input: { idOrName, email, password } };
    }
    if (has('delete', 'remove')) {
      const idOrName = jarvisExtractQuoted(text) || jarvisExtractTitle(text, ['delete', 'remove', 'subscription', 'the']);
      if (!idOrName) return { needsInfo: 'Which subscription should I delete?' };
      return { tool: 'delete_subscription', input: { idOrName } };
    }
    if (has('create', 'new') && !has('deal')) {
      const name = jarvisExtractQuoted(text);
      const numbers = jarvisExtractAllNumbers(text);
      if (!name) return { needsInfo: 'What should the subscription be called (put the name in quotes)?' };
      if (!numbers.length) return { needsInfo: `What's the selling price for "${name}"?` };
      const type = (jarvisExtractAfterKeyword(text, ['type']) || name).toLowerCase().replace(/[^a-z]/g, '') || 'other';
      return { tool: 'create_subscription', input: { name, type, sellingPrice: numbers[numbers.length - 1], costPerMonth: numbers.length > 1 ? numbers[0] : 0 } };
    }
    if (has('update', 'change', 'edit') && has('price', 'cost', 'name', 'description')) {
      const idOrName = jarvisExtractQuoted(text) || jarvisExtractAfterKeyword(text, ['for', 'to', 'of']);
      const numbers = jarvisExtractAllNumbers(text);
      if (!idOrName) return { needsInfo: 'Which subscription should I update?' };
      const update = {};
      if (has('selling price') && numbers.length) update.sellingPrice = numbers[0];
      else if (has('cost') && numbers.length) update.costPerMonth = numbers[0];
      else if (numbers.length) update.sellingPrice = numbers[0];
      if (!Object.keys(update).length) return { needsInfo: `What should change on ${idOrName}, and to what?` };
      return { tool: 'update_subscription', input: { idOrName, ...update } };
    }
    if (has('list', 'show', 'what')) return { tool: 'list_subscriptions', input: {} };
    const idOrName = jarvisExtractQuoted(text) || jarvisExtractAfterKeyword(text, ['about', 'on']);
    if (idOrName) return { tool: 'get_subscription', input: { idOrName } };
    return { tool: 'list_subscriptions', input: {} };
  }

  if (has('help', 'what can you do', 'what do you do')) {
    return { needsInfo: `Happy to explain, ${ADMIN_FIRST_NAME}! I can ` + JARVIS_CAPABILITIES.join('; ') + ". Just tell me plainly, like \"add 100 credits to john123\" or \"deactivate the summer deal\" — typos are fine, I'll figure it out." };
  }

  return null;
}

function formatJarvisReply(tool, input, r) {
  if (r && r.error) return r.error;
  switch (tool) {
    case 'add_credits': return `Done — added ${input.amount} credits to ${r.username}. New balance: ${r.newBalance}.`;
    case 'deduct_credits': return `Done — deducted ${input.amount} credits from ${r.username}. New balance: ${r.newBalance}.`;
    case 'find_user': return `${r.name || r.username} (@${r.username}) — WhatsApp ${r.whatsapp || 'N/A'}, ${r.credits} credits, signed up ${r.signedUpAt ? new Date(r.signedUpAt).toLocaleDateString() : 'N/A'}.`;
    case 'list_users': return r.count === 0 ? 'No users yet.' : `${r.count} most recent user${r.count > 1 ? 's' : ''}: ` + r.users.map(u => `${u.name || u.username} (@${u.username}, ${u.credits} credits)`).join('; ') + '.';
    case 'create_user': return `Created the account for ${r.name} (@${r.username}).`;
    case 'delete_user': return `Deleted the account "${r.deleted}".`;
    case 'reset_user_password': return `Password reset for @${r.username}.`;
    case 'list_subscriptions': return r.count === 0 ? 'No subscriptions yet.' : `${r.count} subscription${r.count > 1 ? 's' : ''}: ` + r.subscriptions.map(s => `${s.name} (RS ${s.sellingPrice}, ${s.accounts} account${s.accounts !== 1 ? 's' : ''})`).join('; ') + '.';
    case 'get_subscription': return `${r.name} (${r.type}) — RS ${r.sellingPrice}/screen, cost RS ${r.costPerMonth}/month. ${(r.accounts || []).length} account(s).`;
    case 'create_subscription': return `Created the subscription "${r.name}".`;
    case 'update_subscription': return `Updated subscription — ${Object.keys(r.updated).join(', ')}.`;
    case 'delete_subscription': return `Deleted the subscription "${r.deleted}".`;
    case 'add_account': return `Added a new account (${r.addedAccount}) to ${r.subscription}.`;
    case 'list_deals': return r.count === 0 ? 'No deals yet.' : `${r.count} deal${r.count > 1 ? 's' : ''}: ` + r.deals.map(d => `${d.title} (RS ${d.discountPrice}, was RS ${d.actualPrice}) — ${d.active ? 'active' : 'inactive'}`).join('; ') + '.';
    case 'toggle_deal': return `"${r.title}" is now ${r.active ? 'active' : 'inactive'}.`;
    case 'delete_deal': return `Deleted the deal "${r.deleted}".`;
    case 'list_promotions': return r.count === 0 ? 'No promotions yet.' : `${r.count} promotion${r.count > 1 ? 's' : ''}: ` + r.promotions.map(p => `${p.heading} — ${p.active ? 'active' : 'inactive'}`).join('; ') + '.';
    case 'toggle_promotion': return `"${r.heading}" is now ${r.active ? 'active' : 'inactive'}.`;
    case 'delete_promotion': return `Deleted the promotion "${r.deleted}".`;
    case 'list_social_services': return (!r.platforms || r.platforms.length === 0) ? 'No social platforms yet.' : r.platforms.map(p => `${p.name}: ` + (p.services.length ? p.services.map(s => `${s.name} (RS ${s.sellingPrice})`).join(', ') : 'no services yet')).join(' | ');
    case 'add_social_service': return `Added "${r.addedService}" under ${r.platform}.`;
    case 'list_waiting': return r.count === 0 ? 'Nobody is waiting right now.' : `${r.count} waiting: ` + r.waiting.map(w => `${w.username} (${w.subscriptionName})`).join('; ') + '.';
    case 'resolve_waiting': return `Marked ${r.resolved}'s waiting entry as resolved.`;
    case 'list_custom_grants': return r.count === 0 ? 'No custom grants yet.' : `${r.count} custom grant${r.count > 1 ? 's' : ''}: ` + r.grants.map(g => `${g.username} → ${g.subscriptionName} (expires ${g.expiryDate})`).join('; ') + '.';
    case 'grant_subscription': return `Granted "${r.subscriptionName}" to ${r.username}, expiring ${r.expiryDate}.`;
    case 'delete_custom_grant': return `Removed "${r.removed}" from ${r.from}.`;
    case 'list_faqs': return r.count === 0 ? 'No FAQs yet.' : `${r.count} FAQ${r.count > 1 ? 's' : ''}: ` + r.faqs.map(f => f.question).join('; ') + '.';
    case 'create_faq': return `Added the FAQ "${r.question}".`;
    case 'delete_faq': return `Deleted the FAQ "${r.deleted}".`;
    case 'create_notice': return `Posted the notice: "${r.posted}".`;
    case 'get_business_summary': return `Right now: ${r.totalUsers} users, ${r.totalSubscriptions} subscriptions, ${r.activeDeals} active deals, ${r.pendingWaiting} people waiting, ${r.activeCustomGrants} active custom grants.`;
    case 'remember_fact': return `Got it — I'll remember that ${r.remembered}`;
    case 'recall_facts': return r.count === 0 ? "I don't have anything saved yet — tell me something to remember, like \"remember that Friday is payout day\"." : `Here's what I remember: ` + r.facts.map((f, i) => `${i + 1}. ${f}`).join('  ');
    case 'forget_fact': return r.forgot ? `Done — I've forgotten that.` : `I couldn't find anything matching that in my memory.`;
    case 'forget_all_facts': return `Cleared everything I had saved — starting fresh.`;
    default: return 'Done.';
  }
}

// Small helper: resolve a subscription by its exact id, or fall back to a
// case-insensitive name match — lets the admin say "netflix family plan"
// instead of needing to know its internal id.
async function findSubscriptionByIdOrName(idOrName) {
  if (!idOrName) return null;
  let sub = await subscriptionsCollection.findOne({ id: idOrName });
  if (sub) return sub;
  const all = await subscriptionsCollection.find({}).toArray();
  const lower = idOrName.trim().toLowerCase();
  return all.find(s => (s.name || '').toLowerCase() === lower)
    || all.find(s => (s.name || '').toLowerCase().includes(lower))
    || null;
}

async function executeJarvisTool(name, input) {
  switch (name) {
    case 'add_credits': {
      const { username, amount, reason } = input;
      if (!username || !amount || amount <= 0) return { error: 'A valid username and positive amount are required.' };
      const result = await usersCollection.findOneAndUpdate({ username }, { $inc: { credits: amount } }, { returnDocument: 'after' });
      const updated = result && result.value !== undefined ? result.value : result;
      if (!updated) return { error: `No user found with username "${username}".` };
      await creditHistoryCollection.insertOne({ id: crypto.randomUUID(), username, type: 'credit', amount, reason: reason || 'Added by Jarvis (AI assistant)', balanceAfter: updated.credits, createdAt: new Date() });
      return { success: true, username, added: amount, newBalance: updated.credits };
    }
    case 'deduct_credits': {
      const { username, amount, reason } = input;
      if (!username || !amount || amount <= 0) return { error: 'A valid username and positive amount are required.' };
      const result = await usersCollection.findOneAndUpdate({ username, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { returnDocument: 'after' });
      const updated = result && result.value !== undefined ? result.value : result;
      if (!updated) {
        const exists = await usersCollection.findOne({ username });
        if (!exists) return { error: `No user found with username "${username}".` };
        return { error: `Insufficient credits — ${username} only has ${exists.credits}.` };
      }
      await creditHistoryCollection.insertOne({ id: crypto.randomUUID(), username, type: 'debit', amount, reason: reason || 'Deducted by Jarvis (AI assistant)', balanceAfter: updated.credits, createdAt: new Date() });
      return { success: true, username, deducted: amount, newBalance: updated.credits };
    }
    case 'find_user': {
      const u = await usersCollection.findOne({ username: input.username });
      if (!u) return { error: `No user found with username "${input.username}".` };
      return { found: true, name: u.name, username: u.username, whatsapp: u.whatsapp, credits: u.credits, signedUpAt: u.createdAt };
    }
    case 'list_users': {
      const limit = Math.min(Number(input.limit) || 20, 50);
      const list = await usersCollection.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
      return { count: list.length, users: list.map(u => ({ name: u.name, username: u.username, credits: u.credits, signedUpAt: u.createdAt })) };
    }
    case 'create_user': {
      const { name, username, password, whatsapp } = input;
      if (!name || !username || !password || !whatsapp) return { error: 'Name, username, password, and whatsapp are all required.' };
      if (/\s/.test(username) || !/^[A-Za-z0-9]+$/.test(username)) return { error: 'Username must not contain spaces or special characters.' };
      if (!/[A-Za-z]/.test(username)) return { error: "Username must include at least one letter." };
      if (password.length < 8) return { error: 'Password must be at least 8 characters.' };
      if (!/^[A-Z]/.test(password)) return { error: 'Password must start with a capital letter.' };
      if (!/[0-9]/.test(password)) return { error: 'Password must contain at least 1 number.' };
      if (!/[^A-Za-z0-9]/.test(password)) return { error: 'Password must contain at least 1 special character.' };
      if (password === username) return { error: 'Password must be different from the username.' };
      if (await usersCollection.findOne({ username })) return { error: `Username "${username}" is already taken.` };
      if (await usersCollection.findOne({ whatsapp })) return { error: 'An account with this WhatsApp number already exists.' };
      await usersCollection.insertOne({ name, username, password: encryptCustomerPassword(password), whatsapp, purchaseCount: 0, credits: 0, createdAt: new Date() });
      return { success: true, username, name };
    }
    case 'delete_user': {
      const result = await usersCollection.deleteOne({ username: input.username });
      if (result.deletedCount === 0) return { error: `No user found with username "${input.username}".` };
      return { success: true, deleted: input.username };
    }
    case 'reset_user_password': {
      const { username, newPassword } = input;
      if (!newPassword || newPassword.length < 8) return { error: 'New password must be at least 8 characters.' };
      const result = await usersCollection.updateOne({ username }, { $set: { password: encryptCustomerPassword(newPassword) } });
      if (result.matchedCount === 0) return { error: `No user found with username "${username}".` };
      return { success: true, username, newPassword };
    }

    case 'list_subscriptions': {
      const subs = await subscriptionsCollection.find({}).toArray();
      return { count: subs.length, subscriptions: subs.map(s => ({ id: s.id, name: s.name, type: s.type, sellingPrice: s.sellingPrice, costPerMonth: s.costPerMonth, accounts: (s.accounts || []).length })) };
    }
    case 'get_subscription': {
      const sub = await findSubscriptionByIdOrName(input.idOrName);
      if (!sub) return { error: `No subscription matching "${input.idOrName}".` };
      return {
        id: sub.id, name: sub.name, type: sub.type, sellingPrice: sub.sellingPrice, costPerMonth: sub.costPerMonth,
        description: sub.description,
        accounts: (sub.accounts || []).map(a => ({ email: a.email, screens: (a.screens || []).length, customers: (a.screens || []).reduce((n, s) => n + (s.customers || []).length, 0) }))
      };
    }
    case 'create_subscription': {
      const { name, type, costPerMonth, sellingPrice, slots, description } = input;
      if (!name || !type || sellingPrice == null) return { error: 'name, type, and sellingPrice are required.' };
      const id = crypto.randomUUID();
      const newSub = { id, name, type, accounts: [], costPerMonth: costPerMonth || 0, sellingPrice, slots: slots || 0, askFor: ['name', 'number'], description: description || '', importantNote: '', logo: '', createdAt: new Date() };
      await subscriptionsCollection.insertOne(newSub);
      return { success: true, id, name };
    }
    case 'update_subscription': {
      const sub = await findSubscriptionByIdOrName(input.idOrName);
      if (!sub) return { error: `No subscription matching "${input.idOrName}".` };
      const update = {};
      ['name', 'costPerMonth', 'sellingPrice', 'description'].forEach(k => { if (input[k] !== undefined) update[k] = input[k]; });
      if (Object.keys(update).length === 0) return { error: 'Nothing to update — specify what should change.' };
      await subscriptionsCollection.updateOne({ id: sub.id }, { $set: update });
      return { success: true, id: sub.id, updated: update };
    }
    case 'delete_subscription': {
      const sub = await findSubscriptionByIdOrName(input.idOrName);
      if (!sub) return { error: `No subscription matching "${input.idOrName}".` };
      await subscriptionsCollection.deleteOne({ id: sub.id });
      return { success: true, deleted: sub.name };
    }
    case 'add_account': {
      const sub = await findSubscriptionByIdOrName(input.idOrName);
      if (!sub) return { error: `No subscription matching "${input.idOrName}".` };
      if (!input.email || !input.password) return { error: 'email and password are required.' };
      const account = { id: crypto.randomUUID(), email: input.email, password: input.password, screens: [{ id: crypto.randomUUID(), name: 'Screen 1', pin: '', customers: [] }], createdAt: new Date() };
      await subscriptionsCollection.updateOne({ id: sub.id }, { $push: { accounts: account } });
      return { success: true, subscription: sub.name, addedAccount: input.email };
    }

    case 'list_deals': {
      const deals = await dealsCollection.find({}).toArray();
      return { count: deals.length, deals: deals.map(d => ({ title: d.title, actualPrice: d.actualPrice, discountPrice: d.discountPrice, active: d.active })) };
    }
    case 'create_deal': {
      const { title, subscriptionNames, actualPrice, discountPrice, description } = input;
      if (!title || !subscriptionNames?.length || actualPrice == null || discountPrice == null) return { error: 'title, subscriptionNames, actualPrice, and discountPrice are required.' };
      const subs = await subscriptionsCollection.find({}).toArray();
      const ids = [];
      for (const nm of subscriptionNames) {
        const match = subs.find(s => s.name.toLowerCase() === nm.toLowerCase()) || subs.find(s => s.name.toLowerCase().includes(nm.toLowerCase()));
        if (!match) return { error: `Couldn't find a subscription named "${nm}".` };
        ids.push(match.id);
      }
      const id = crypto.randomUUID();
      const newDeal = { id, subscriptionIds: ids, title, description: description || '', actualPrice, discountPrice, active: true, socialPlatformId: '', socialPlatformName: '', socialServiceId: '', socialServiceName: '', socialQuantity: 0, createdAt: new Date() };
      await dealsCollection.insertOne(newDeal);
      return { success: true, title, id };
    }
    case 'toggle_deal': {
      const deal = await dealsCollection.findOne({ title: { $regex: `^${input.title}$`, $options: 'i' } }) || await dealsCollection.findOne({ title: { $regex: input.title, $options: 'i' } });
      if (!deal) return { error: `No deal matching "${input.title}".` };
      await dealsCollection.updateOne({ id: deal.id }, { $set: { active: !!input.active } });
      return { success: true, title: deal.title, active: !!input.active };
    }
    case 'delete_deal': {
      const deal = await dealsCollection.findOne({ title: { $regex: input.title, $options: 'i' } });
      if (!deal) return { error: `No deal matching "${input.title}".` };
      await dealsCollection.deleteOne({ id: deal.id });
      return { success: true, deleted: deal.title };
    }

    case 'list_promotions': {
      const promos = await promotionsCollection.find({}).toArray();
      return { count: promos.length, promotions: promos.map(p => ({ heading: p.heading, active: p.active })) };
    }
    case 'toggle_promotion': {
      const promo = await promotionsCollection.findOne({ heading: { $regex: input.heading, $options: 'i' } });
      if (!promo) return { error: `No promotion matching "${input.heading}".` };
      await promotionsCollection.updateOne({ id: promo.id }, { $set: { active: !!input.active } });
      return { success: true, heading: promo.heading, active: !!input.active };
    }
    case 'delete_promotion': {
      const promo = await promotionsCollection.findOne({ heading: { $regex: input.heading, $options: 'i' } });
      if (!promo) return { error: `No promotion matching "${input.heading}".` };
      await promotionsCollection.deleteOne({ id: promo.id });
      return { success: true, deleted: promo.heading };
    }

    case 'list_social_services': {
      const platforms = await socialServicesCollection.find({}).toArray();
      return { platforms: platforms.map(p => ({ name: p.name, services: (p.services || []).map(s => ({ name: s.name, costPrice: s.costPrice, sellingPrice: s.sellingPrice })) })) };
    }
    case 'add_social_service': {
      const { platformName, serviceName, costPrice, sellingPrice } = input;
      const platform = await socialServicesCollection.findOne({ name: { $regex: platformName, $options: 'i' } });
      if (!platform) return { error: `No social-media platform matching "${platformName}". Create the platform in the admin panel first — Jarvis can only add services under an existing platform.` };
      const service = { id: crypto.randomUUID(), name: serviceName, costPrice: Number(costPrice), sellingPrice: Number(sellingPrice), requiredFields: ['accountLink'], variations: [], createdAt: new Date() };
      await socialServicesCollection.updateOne({ id: platform.id }, { $push: { services: service } });
      return { success: true, platform: platform.name, addedService: serviceName };
    }

    case 'list_waiting': {
      const list = await waitingCollection.find({}).sort({ createdAt: -1 }).toArray();
      return { count: list.length, waiting: list.map(w => ({ username: w.username, subscriptionName: w.subscriptionName })) };
    }
    case 'resolve_waiting': {
      const result = await waitingCollection.deleteOne({ username: input.username });
      if (result.deletedCount === 0) return { error: `No waiting-list entry found for "${input.username}".` };
      return { success: true, resolved: input.username };
    }
    case 'list_custom_grants': {
      const list = await customGrantsCollection.find({}).sort({ createdAt: -1 }).toArray();
      return { count: list.length, grants: list.map(g => ({ username: g.username, subscriptionName: g.subscriptionName, expiryDate: g.expiryDate })) };
    }
    case 'grant_subscription': {
      const { username, subscriptionName, email, password, months, notes, costPerMonth, sellingPrice } = input;
      if (!username || !subscriptionName || !email || !password) return { error: 'username, subscriptionName, email, and password are required.' };
      const user = await usersCollection.findOne({ username });
      if (!user) return { error: `No user found with username "${username}".` };
      if (costPerMonth === undefined || sellingPrice === undefined) return { error: "costPerMonth and sellingPrice are both needed for profit tracking — ask the admin for these." };
      const now = new Date();
      const totalDays = (Number(months) || 1) * 30;
      const expiry = new Date(now);
      expiry.setDate(expiry.getDate() + totalDays);
      const entry = { id: crypto.randomUUID(), username, name: user.name || '', whatsapp: user.whatsapp || '', subscriptionName: subscriptionName.trim(), email, password, notes: notes || '', months: Number(months) || 1, days: totalDays, expiryDate: expiry.toISOString().split('T')[0], matchedSubscriptionId: null, costPerMonth: Number(costPerMonth) || 0, sellingPrice: Number(sellingPrice) || 0, purchasedAt: now.toISOString(), createdAt: now };
      await customGrantsCollection.insertOne(entry);
      return { success: true, username, subscriptionName, expiryDate: entry.expiryDate };
    }
    case 'delete_custom_grant': {
      const result = await customGrantsCollection.deleteOne({ username: input.username, subscriptionName: { $regex: input.subscriptionName, $options: 'i' } });
      if (result.deletedCount === 0) return { error: `No custom grant found for "${input.username}" matching "${input.subscriptionName}".` };
      return { success: true, removed: input.subscriptionName, from: input.username };
    }

    case 'list_faqs': {
      const list = await faqsCollection.find({}).toArray();
      return { count: list.length, faqs: list.map(f => ({ question: f.question, category: f.category })) };
    }
    case 'create_faq': {
      const { question, answer, category } = input;
      if (!question || !answer) return { error: 'question and answer are required.' };
      await faqsCollection.insertOne({ id: Date.now().toString(), question, answer, category: category || 'General', createdAt: new Date() });
      return { success: true, question };
    }
    case 'delete_faq': {
      const faq = await faqsCollection.findOne({ question: { $regex: input.question, $options: 'i' } });
      if (!faq) return { error: `No FAQ matching "${input.question}".` };
      await faqsCollection.deleteOne({ id: faq.id });
      return { success: true, deleted: faq.question };
    }
    case 'create_notice': {
      if (!input.message) return { error: 'message is required.' };
      await noticesCollection.insertOne({ id: Date.now().toString(), message: input.message, createdAt: new Date() });
      return { success: true, posted: input.message };
    }

    case 'get_business_summary': {
      const [userCount, subCount, activeDealCount, waitingCount, grantCount] = await Promise.all([
        usersCollection.countDocuments({}),
        subscriptionsCollection.countDocuments({}),
        dealsCollection.countDocuments({ active: true }),
        waitingCollection.countDocuments({}),
        customGrantsCollection.countDocuments({})
      ]);
      return { totalUsers: userCount, totalSubscriptions: subCount, activeDeals: activeDealCount, pendingWaiting: waitingCount, activeCustomGrants: grantCount };
    }

    case 'remember_fact': {
      const entry = { id: crypto.randomUUID(), text: input.fact, createdAt: new Date() };
      await jarvisMemoryCollection.insertOne(entry);
      return { remembered: input.fact };
    }
    case 'recall_facts': {
      const items = await jarvisMemoryCollection.find({}).sort({ createdAt: -1 }).limit(25).toArray();
      return { count: items.length, facts: items.map(i => i.text) };
    }
    case 'forget_fact': {
      const result = await jarvisMemoryCollection.deleteOne({ text: { $regex: input.fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } });
      return { forgot: result.deletedCount > 0, requested: input.fact };
    }
    case 'forget_all_facts': {
      await jarvisMemoryCollection.deleteMany({});
      return { clearedAll: true };
    }

    default:
      return { error: `Unknown tool "${name}".` };
  }
}

app.post('/api/jarvis', requireAdmin, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    // If the previous turn ended in a clarifying question, the admin's
    // reply here is often just the missing piece ("100", or "john123") —
    // re-parsing it combined with their own last message usually resolves
    // the whole request in one go, without needing any real conversation
    // state to be tracked.
    const lastUserFromHistory = Array.isArray(history) ? [...history].reverse().find(h => h.role === 'user') : null;

    let parsed = parseJarvisIntent(message);
    if (parsed && parsed.needsInfo && lastUserFromHistory && lastUserFromHistory.content) {
      const retry = parseJarvisIntent(`${lastUserFromHistory.content} ${message}`);
      if (retry && !retry.needsInfo) parsed = retry;
    }
    // "give him 50 more credits" / "reset her password" after a customer
    // was mentioned earlier in this chat — swap the pronoun for whoever
    // that was and try again, instead of asking who "him" is.
    if (parsed && parsed.needsInfo && JARVIS_PRONOUN_RE.test(message)) {
      const lastUsername = jarvisFindLastMentionedUsername(history);
      if (lastUsername) {
        const substituted = message.replace(JARVIS_PRONOUN_RE, lastUsername);
        const retry2 = parseJarvisIntent(substituted);
        if (retry2 && !retry2.needsInfo && !retry2.smallTalk) parsed = retry2;
      }
    }

    if (parsed && parsed.smallTalk) {
      return res.json({ reply: parsed.smallTalk, actions: [] });
    }
    if (!parsed) {
      const honest = jarvisHonestUnknown(message);
      if (honest) return res.json({ reply: honest, actions: [] });
      const fallbacks = [
        `Hmm, I didn't quite catch what you'd like me to do there — could you say it a bit differently? For example: "add 100 credits to john123" or "list waiting customers".`,
        `Sorry, I'm not sure what you mean by that — mind rephrasing? I can ${JARVIS_CAPABILITIES.join('; ')}.`,
        `I want to get this right — could you tell me again, maybe more directly? Something like "reset john123's password" works well.`
      ];
      return res.json({ reply: fallbacks[Math.floor(Math.random() * fallbacks.length)], actions: [] });
    }
    if (parsed.needsInfo) {
      return res.json({ reply: parsed.needsInfo, actions: [] });
    }

    const result = await executeJarvisTool(parsed.tool, parsed.input);
    const reply = formatJarvisReply(parsed.tool, parsed.input, result);
    res.json({ reply, actions: [{ tool: parsed.tool, input: parsed.input, result }] });
  } catch (err) {
    console.error('Jarvis error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── Start server ──────────────────────────────────────────

// Automatically and permanently remove subscription entries that have expired.
// Uses an atomic $pull across every account/screen at once (no read-modify-write),
// so it can never collide with or erase a purchase that's being saved at the same time.
async function cleanupExpiredCustomers() {
  try {
    const todayStr = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const result = await subscriptionsCollection.updateMany(
      {},
      {
        $pull: {
          'accounts.$[].screens.$[].customers': {
            expiryDate: { $exists: true, $ne: '', $lt: todayStr }
          }
        }
      }
    );
    if (result.modifiedCount > 0) {
      console.log(`🧹 Cleaned up expired customer entries from ${result.modifiedCount} subscription(s)`);
    }
  } catch (err) {
    console.error('❌ Cleanup error:', err);
  }
}



connectDB()
  .then(() => seedData())
  .then(() => cleanupExpiredCustomers())
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 API URL: http://localhost:${PORT}/api`);
    });
    // Re-check for expired subscriptions every hour.
    setInterval(cleanupExpiredCustomers, 60 * 60 * 1000);
  })
  .catch(err => {
    console.error('❌ Failed to connect to MongoDB:', err);
    process.exit(1);
  });