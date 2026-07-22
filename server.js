const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();

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
  await ensureAuthSecret(); // load or create the server-only token-signing secret
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
    const VALID_THEMES = ['classic', 'spiderman'];
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
    const { username, password, whatsapp } = req.body;
    if (!username || !password || !whatsapp) {
      return res.status(400).json({ error: 'All fields required' });
    }
    // Mirrors the checklist shown on the sign-up form — enforced here too
    // since a request can always bypass the client-side UI.
    if (/\s/.test(username) || !/^[A-Za-z0-9]+$/.test(username)) {
      return res.status(400).json({ error: 'Username must not contain spaces or special characters' });
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
    const newUser = {
      username,
      password: hashPassword(password),
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
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // Upgrade a legacy plain-text password to a hash on first successful login.
    if (!isHashed(user.password)) {
      await usersCollection.updateOne({ username }, { $set: { password: hashPassword(password) } });
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
    res.json((isAdmin || isOwner) ? user : sanitizeUser(user));
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
    const { amount, purchaseId, reason } = req.body;
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
    if (password !== undefined && password !== '') update.password = hashPassword(password);
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
    const { id, subscriptionIds, title, description, actualPrice, discountPrice, active } = req.body;
    if (!id || !subscriptionIds || !subscriptionIds.length || !title || actualPrice == null || discountPrice == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const existing = await dealsCollection.findOne({ id });
    if (existing) {
      return res.status(400).json({ error: 'Deal id already exists' });
    }
    const newDeal = {
      id,
      subscriptionIds,
      title,
      description: description || '',
      actualPrice,
      discountPrice,
      active: active !== undefined ? active : true,
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
    const { subscriptionIds, title, description, actualPrice, discountPrice, active } = req.body;
    const update = {};
    if (subscriptionIds !== undefined) update.subscriptionIds = subscriptionIds;
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (actualPrice !== undefined) update.actualPrice = actualPrice;
    if (discountPrice !== undefined) update.discountPrice = discountPrice;
    if (active !== undefined) update.active = active;
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
      paidWithCredits, creditsAmount, purchasedAt, purchaseId
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

const PORT = process.env.PORT || 5000;

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