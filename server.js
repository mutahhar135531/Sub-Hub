const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

// ─── STRICT CACHE CONTROL ──────────────────────────────────────
app.use((req, res, next) => {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.header('Pragma', 'no-cache');
  res.header('Expires', '0');
  next();
});

// ─── MongoDB connection ──────────────────────────────────────
const MONGODB_URI = 'mongodb+srv://elitecinezo_db_user:g485P3ELoeP8REkD@cluster0.tsw1i0i.mongodb.net/subscription_hub?retryWrites=true&w=majority';
const DB_NAME = 'subscription_hub';

let db;
let subscriptionsCollection;
let otpsCollection;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  subscriptionsCollection = db.collection('subscriptions');
  otpsCollection = db.collection('otps');
  console.log('✅ Connected to MongoDB');
}

// ─── Initial seed data ──────────────────────────────────────
async function seedData() {
  const count = await subscriptionsCollection.countDocuments();
  if (count === 0) {
    const initialSubscriptions = [
      {
        id: '1',
        name: 'Netflix',
        type: 'netflix',
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
        accounts: [
          {
            id: 'a3',
            email: 'amazon1@example.com',
            password: 'pass3',
            screens: Array.from({ length: 30 }, (_, i) => ({
              id: `s_${i}`,
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
        accounts: []
      },
      {
        id: '4',
        name: 'Spotify Premium',
        type: 'spotify',
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
        name: 'ChatGPT',
        type: 'chatgpt',
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
      }
    ];
    await subscriptionsCollection.insertMany(initialSubscriptions);
    console.log('✅ Initial subscriptions seeded');
  }
}

// ─── Routes ──────────────────────────────────────────────────

app.get('/api/subscriptions', async (req, res) => {
  try {
    const subs = await subscriptionsCollection.find({}).toArray();
    res.json(subs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subscriptions/:id', async (req, res) => {
  try {
    const sub = await subscriptionsCollection.findOne({ id: req.params.id });
    if (!sub) return res.status(404).json({ error: 'Not found' });
    res.json(sub);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/subscriptions', async (req, res) => {
  try {
    const { id, name, type, accounts } = req.body;
    const existing = await subscriptionsCollection.findOne({ id });
    if (existing) {
      return res.status(400).json({ error: 'Subscription id already exists' });
    }
    const newSub = { id, name, type, accounts: accounts || [] };
    await subscriptionsCollection.insertOne(newSub);
    res.json(newSub);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/subscriptions/:id', async (req, res) => {
  try {
    const { name, type, accounts } = req.body;
    const update = {};
    if (name) update.name = name;
    if (type) update.type = type;
    if (accounts) update.accounts = accounts;
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

app.delete('/api/subscriptions/:id', async (req, res) => {
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

// ─── OTP endpoints ──────────────────────────────────────────

app.post('/api/otp/generate', async (req, res) => {
  try {
    const { userIdentifier } = req.body;
    const otp = String(Math.floor(1000 + Math.random() * 9000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const newOTP = {
      id: Date.now().toString(),
      otp,
      userIdentifier: userIdentifier || 'Unknown',
      createdAt: new Date(),
      expiresAt,
      verified: false,
    };
    await otpsCollection.insertOne(newOTP);
    console.log(`✅ OTP generated: ${otp} for ${userIdentifier}`);
    res.json({ success: true, otpId: newOTP.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/otp/verify', async (req, res) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ error: 'OTP required' });
    const record = await otpsCollection.findOne({
      otp,
      verified: false,
      expiresAt: { $gt: new Date() }
    });
    if (!record) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
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

app.get('/api/otp/list', async (req, res) => {
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

// ─── Authentication check (for expiry) ──────────────────────
app.post('/api/auth/check', async (req, res) => {
  try {
    const { username, password } = req.body;
    const subs = await subscriptionsCollection.find({}).toArray();
    let user = null;
    let subscriptionName = '';
    for (let sub of subs) {
      for (let acc of sub.accounts) {
        for (let screen of acc.screens) {
          if (screen.customers) {
            const found = screen.customers.find(
              c => c.username === username && c.password === password
            );
            if (found) {
              user = found;
              subscriptionName = sub.name;
              break;
            }
          }
        }
        if (user) break;
      }
      if (user) break;
    }
    if (!user) {
      return res.json({ valid: false, error: 'User not found' });
    }
    // Check expiry
    if (user.expiryDate) {
      const expiry = new Date(user.expiryDate);
      const now = new Date();
      if (expiry < now) {
        return res.json({ valid: false, error: 'Subscription expired' });
      }
    }
    res.json({ valid: true, user, subscriptionName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', database: db ? 'connected' : 'disconnected' });
});

// ─── Start server ──────────────────────────────────────────

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => seedData())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Failed to connect to MongoDB:', err);
    process.exit(1);
  });