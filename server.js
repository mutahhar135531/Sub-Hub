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
// SECURITY: the connection string (including the DB password) used to be
// hardcoded here, which means it was exposed to anyone who saw this file.
// It now comes from an environment variable instead. The old hardcoded
// value is kept ONLY as a fallback so the app doesn't break before you've
// set MONGODB_URI on your host — set it, then delete the fallback line
// below, and rotate the database user's password in MongoDB Atlas (Database
// Access → edit user → Edit Password) since the old one must be treated as
// compromised.
if (!process.env.MONGODB_URI) {
  console.warn('⚠️  MONGODB_URI env var not set — using a hardcoded fallback. Set MONGODB_URI in your host\'s environment variables and rotate the DB password in MongoDB Atlas.');
}
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://elitecinezo_db_user:g485P3ELoeP8REkD@cluster0.tsw1i0i.mongodb.net/subscription_hub?retryWrites=true&w=majority';
const DB_NAME = 'subscription_hub';

// ─── Auth: sessions & tokens ──────────────────────────────────
// Lightweight bearer-token auth. Tokens are random (unguessable), issued
// on successful login, and checked on every request to a protected route.
// Stored in memory: simple, and fine for a single server instance — they
// reset on restart/redeploy (admin/users just log in again). If you ever
// run more than one server instance, move these Maps to Mongo or Redis so
// all instances share the same session state.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const adminSessions = new Map();  // token -> expiry timestamp
const userSessions = new Map();   // token -> { username, expiry }
const resetTokens = new Map();    // token -> { username, expiry } (single-use, forgot-password)

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
function getBearerToken(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer (.+)$/i);
  return match ? match[1] : null;
}
// Figures out who's calling: an authenticated admin, a logged-in user
// (and which one), or an anonymous visitor. Routes that return different
// levels of detail depending on the caller use this instead of a hard
// require-or-reject check.
function identify(req) {
  const token = getBearerToken(req);
  if (!token) return { role: 'anon' };
  const adminExp = adminSessions.get(token);
  if (adminExp && adminExp > Date.now()) return { role: 'admin' };
  const userSess = userSessions.get(token);
  if (userSess && userSess.expiry > Date.now()) return { role: 'user', username: userSess.username };
  return { role: 'anon' };
}
// Hard gate for admin-only routes.
function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  const exp = token && adminSessions.get(token);
  if (!exp || exp < Date.now()) {
    return res.status(401).json({ error: 'Admin login required' });
  }
  adminSessions.set(token, Date.now() + SESSION_TTL_MS); // sliding expiry
  next();
}
// Gate for routes any signed-in caller (a logged-in user OR an admin) may
// use, e.g. completing a purchase. Attaches req.auth for the route to use.
function requireAuth(req, res, next) {
  const auth = identify(req);
  if (auth.role === 'anon') return res.status(401).json({ error: 'Please log in first' });
  req.auth = auth;
  next();
}
// True if the caller is an admin, or is the specific user the route is
// acting on.
function isAdminOrSelf(auth, username) {
  return auth.role === 'admin' || (auth.role === 'user' && auth.username === username);
}

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

// Log in as admin: verified entirely server-side. On success this issues a
// random session token — the actual password is never sent back to the
// browser, here or anywhere else.
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });
    let settings = await adminSettingsCollection.findOne({ _id: ADMIN_SETTINGS_ID });
    if (!settings) {
      settings = { _id: ADMIN_SETTINGS_ID, password: 'admin123', recoveryNumber: '359609' };
      await adminSettingsCollection.insertOne(settings);
    }
    if (String(password) !== String(settings.password)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const token = newToken();
    adminSessions.set(token, Date.now() + SESSION_TTL_MS);
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/logout', (req, res) => {
  const token = getBearerToken(req);
  if (token) adminSessions.delete(token);
  res.json({ success: true });
});

// Everything below this point in the admin-settings section requires a
// valid admin session — including reading the recovery number, which used
// to be sent to every visitor on every page load.
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    let settings = await adminSettingsCollection.findOne({ _id: ADMIN_SETTINGS_ID });
    if (!settings) {
      settings = { _id: ADMIN_SETTINGS_ID, password: 'admin123', recoveryNumber: '359609' };
      await adminSettingsCollection.insertOne(settings);
    }
    res.json({ recoveryNumber: settings.recoveryNumber || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { password, recoveryNumber } = req.body;
    const update = {};
    if (password !== undefined && password !== '') update.password = password;
    if (recoveryNumber !== undefined) update.recoveryNumber = recoveryNumber;
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    await adminSettingsCollection.updateOne({ _id: ADMIN_SETTINGS_ID }, { $set: update }, { upsert: true });
    // Changing the password invalidates every OTHER existing admin session
    // so a stolen old token stops working immediately, without logging the
    // admin who just made the change out of their own session.
    if (update.password !== undefined) {
      const currentToken = getBearerToken(req);
      for (const t of adminSessions.keys()) {
        if (t !== currentToken) adminSessions.delete(t);
      }
    }
    const settings = await adminSettingsCollection.findOne({ _id: ADMIN_SETTINGS_ID });
    res.json({ recoveryNumber: settings.recoveryNumber || null, success: true });
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
    await adminSettingsCollection.updateOne({ _id: ADMIN_SETTINGS_ID }, { $set: { password: newPassword } });
    adminSessions.clear(); // force everyone (including a potential attacker) to log in again
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

// Strips account credentials (email/password) and other customers' PII
// (username/password/whatsapp/email) out of a subscription document,
// keeping only what's needed to browse/buy: catalog info, screen names,
// and whether a screen is occupied. If `ownUsername` is given, that one
// customer's own entries (and the account credentials for the screen(s)
// they're actually on) are left intact — they need to see the login they
// paid for.
function sanitizeSubscriptionForCaller(sub, ownUsername) {
  const accounts = (sub.accounts || []).map(acc => {
    const screens = (acc.screens || []).map(scr => {
      const isOwnScreen = ownUsername && (scr.customers || []).some(c => c.username === ownUsername);
      const customers = (scr.customers || []).map(c => {
        if (ownUsername && c.username === ownUsername) return c;
        return { username: c.username, screens: c.screens }; // just enough to show "occupied"
      });
      return { ...scr, pin: isOwnScreen ? scr.pin : undefined, customers };
    });
    const hasOwnCustomer = ownUsername && screens.some(s => (s.customers || []).some(c => c.username === ownUsername));
    return {
      ...acc,
      email: hasOwnCustomer ? acc.email : undefined,
      password: hasOwnCustomer ? acc.password : undefined,
      screens
    };
  });
  return { ...sub, accounts, costPerMonth: undefined };
}

app.get('/api/subscriptions', async (req, res) => {
  try {
    const subs = await subscriptionsCollection.find({}).toArray();
    const auth = identify(req);
    if (auth.role === 'admin') return res.json(subs);
    res.json(subs.map(s => sanitizeSubscriptionForCaller(s, auth.role === 'user' ? auth.username : null)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subscriptions/:id', async (req, res) => {
  try {
    const sub = await subscriptionsCollection.findOne({ id: req.params.id });
    if (!sub) return res.status(404).json({ error: 'Not found' });
    const auth = identify(req);
    if (auth.role === 'admin') return res.json(sub);
    res.json(sanitizeSubscriptionForCaller(sub, auth.role === 'user' ? auth.username : null));
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

app.post('/api/subscriptions/:id/allocate', requireAuth, async (req, res) => {
  try {
    const { accountId, screenId, customer, purchaseId } = req.body;
    if (!accountId || !screenId || !customer || !customer.username) {
      return res.status(400).json({ error: 'accountId, screenId and customer are required' });
    }

    // Same purchase step submitted twice? Don't add the customer a second
    // time — just return the subscription as it already stands.
    const key = purchaseId ? `allocate:${purchaseId}:${accountId}:${screenId}` : null;
    const claimed = await claimIdempotencyKey(key);
    if (!claimed) {
      const existing = await subscriptionsCollection.findOne({ id: req.params.id });
      return res.json(existing);
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
    res.json(updated);
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
      password,
      whatsapp,
      purchaseCount: 0,
      credits: 0,
      createdAt: new Date()
    };
    await usersCollection.insertOne(newUser);
    const token = newToken();
    userSessions.set(token, { username: newUser.username, expiry: Date.now() + SESSION_TTL_MS });
    const { password: _pw, ...safeUser } = newUser;
    res.json({ success: true, user: safeUser, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await usersCollection.findOne({ username });
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = newToken();
    userSessions.set(token, { username: user.username, expiry: Date.now() + SESSION_TTL_MS });
    const { password: _pw, ...safeUser } = user;
    res.json({ success: true, user: safeUser, token });
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
    // This token — not just knowing the username — is what proves the
    // WhatsApp check actually happened, and is required by the password
    // reset below. Single-use and expires quickly.
    const resetToken = newToken();
    resetTokens.set(resetToken, { username: user.username, expiry: Date.now() + RESET_TOKEN_TTL_MS });
    res.json({ success: true, resetToken });
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

app.get('/api/users/:username', requireAuth, async (req, res) => {
  try {
    if (!isAdminOrSelf(req.auth, req.params.username)) {
      return res.status(403).json({ error: 'Not authorized to view this account' });
    }
    const user = await usersCollection.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password, ...safe } = user;
    res.json(safe);
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
    res.json(updated);
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
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full credit history for a customer: every add and every spend, with the
// date/time and what it was for, newest first.
app.get('/api/users/:username/credit-history', requireAuth, async (req, res) => {
  try {
    if (!isAdminOrSelf(req.auth, req.params.username)) {
      return res.status(403).json({ error: 'Not authorized to view this account' });
    }
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
app.post('/api/users/:username/deductCredits', requireAuth, async (req, res) => {
  try {
    if (!isAdminOrSelf(req.auth, req.params.username)) {
      return res.status(403).json({ error: 'Not authorized to modify this account' });
    }
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
    res.json(updated);
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

    // Either an admin is making this change, or the caller just proved
    // ownership via the WhatsApp verification step (verify-whatsapp) and is
    // presenting the single-use token that step issued.
    const auth = identify(req);
    let authorized = auth.role === 'admin';
    if (!authorized && resetToken) {
      const rt = resetTokens.get(resetToken);
      if (rt && rt.expiry > Date.now() && rt.username === oldUsername) {
        resetTokens.delete(resetToken); // single-use
        authorized = true;
      }
    }
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
    if (password !== undefined && password !== '') update.password = password;
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
    const auth = identify(req);
    if (username) {
      if (!isAdminOrSelf(auth, username)) {
        return res.status(403).json({ error: 'Not authorized to view these grants' });
      }
    } else if (auth.role !== 'admin') {
      return res.status(401).json({ error: 'Admin login required' });
    }
    const filter = username ? { username } : {};
    const list = await customGrantsCollection.find(filter).sort({ createdAt: -1 }).toArray();
    if (username) {
      // Customer-facing fetch — strip the admin-only cost/pricing fields.
      const sanitized = list.map(({ costPerMonth, sellingPrice, matchedSubscriptionId, ...rest }) => rest);
      return res.json(sanitized);
    }
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