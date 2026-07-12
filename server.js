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

app.use(express.json());

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

// ─── SUBSCRIPTION COSTS (Monthly) ──────────────────────────
const SUBSCRIPTION_COSTS = {
  netflix: 1250,      // per account per month
  amazon: 250,        // per account per month
  youtube: 150,       // per member per month (900/6)
  spotify: 0,         // custom pricing
  chatgpt: 1000,      // per invite per month
  canva: 250,         // per year (pro-rated)
  capcut: 200,        // per month
  hbomax: 300,        // per month
  crunchyroll: 200,   // per month
  chaupal: 150,       // per month
  custom: 0           // variable
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
  console.log('✅ Connected to MongoDB');
}

// ─── Initial seed data ──────────────────────────────────────
async function seedData() {
  try {
    const subCount = await subscriptionsCollection.countDocuments();
    if (subCount === 0) {
      const initialSubscriptions = [
        {
          id: '1',
          name: 'Netflix',
          type: 'netflix',
          costPerMonth: 1250,
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
          accounts: []
        },
        {
          id: '4',
          name: 'Spotify Premium',
          type: 'spotify',
          costPerMonth: 0,
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
          costPerMonth: 1000,
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
          costPerMonth: 20.83, // 250/year
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
          accounts: []
        },
        {
          id: '8',
          name: 'HBO Max',
          type: 'hbomax',
          costPerMonth: 300,
          accounts: []
        },
        {
          id: '9',
          name: 'Crunchyroll',
          type: 'crunchyroll',
          costPerMonth: 200,
          accounts: []
        },
        {
          id: '10',
          name: 'Chaupal',
          type: 'chaupal',
          costPerMonth: 150,
          accounts: []
        }
      ];
      await subscriptionsCollection.insertMany(initialSubscriptions);
      console.log('✅ Initial subscriptions seeded');
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
    const { id, name, type, accounts, costPerMonth } = req.body;
    const existing = await subscriptionsCollection.findOne({ id });
    if (existing) {
      return res.status(400).json({ error: 'Subscription id already exists' });
    }
    const newSub = { 
      id, 
      name, 
      type, 
      accounts: accounts || [],
      costPerMonth: costPerMonth || SUBSCRIPTION_COSTS[type] || 0
    };
    await subscriptionsCollection.insertOne(newSub);
    res.json(newSub);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/subscriptions/:id', async (req, res) => {
  try {
    const { name, type, accounts, costPerMonth } = req.body;
    const update = {};
    if (name) update.name = name;
    if (type) update.type = type;
    if (accounts) update.accounts = accounts;
    if (costPerMonth !== undefined) update.costPerMonth = costPerMonth;
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

// ---- Users ----
app.post('/api/users/signup', async (req, res) => {
  try {
    const { username, password, whatsapp } = req.body;
    if (!username || !password || !whatsapp) {
      return res.status(400).json({ error: 'All fields required' });
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
      credits: 50,
      createdAt: new Date()
    };
    await usersCollection.insertOne(newUser);
    res.json({ success: true, user: newUser });
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
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', async (req, res) => {
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
    res.json(user);
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

app.post('/api/users/:username/addCredits', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const result = await usersCollection.updateOne(
      { username: req.params.username },
      { $inc: { credits: amount } }
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

app.post('/api/users/:username/deductCredits', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const user = await usersCollection.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.credits < amount) {
      return res.status(400).json({ error: 'Insufficient credits' });
    }
    const result = await usersCollection.updateOne(
      { username: req.params.username },
      { $inc: { credits: -amount } }
    );
    const updated = await usersCollection.findOne({ username: req.params.username });
    res.json(updated);
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

app.post('/api/deals', async (req, res) => {
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

app.put('/api/deals/:id', async (req, res) => {
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

app.delete('/api/deals/:id', async (req, res) => {
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
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
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

// ---- INCOME CALCULATION ----
app.get('/api/income', async (req, res) => {
  try {
    const { period } = req.query; // '30', '60', '90', 'monthly'
    const now = new Date();
    let startDate = new Date(now);
    
    if (period === 'monthly') {
      startDate.setDate(1);
      startDate.setHours(0, 0, 0, 0);
    } else if (period === '30') {
      startDate.setDate(startDate.getDate() - 30);
    } else if (period === '60') {
      startDate.setDate(startDate.getDate() - 60);
    } else if (period === '90') {
      startDate.setDate(startDate.getDate() - 90);
    } else {
      startDate = new Date(0); // all time
    }

    // Get all subscriptions with customer data
    const subs = await subscriptionsCollection.find({}).toArray();
    let totalIncome = 0;
    let customers = [];
    let incomeByType = {};

    subs.forEach(sub => {
      const costPerMonth = sub.costPerMonth || 0;
      sub.accounts.forEach(acc => {
        acc.screens.forEach(screen => {
          if (screen.customers && screen.customers.length > 0) {
            screen.customers.forEach(c => {
              // Check if customer is active and within the period
              const expiryDate = c.expiryDate ? new Date(c.expiryDate) : null;
              const purchaseDate = c.purchasedAt ? new Date(c.purchasedAt) : null;
              
              // Skip if not active
              if (expiryDate && expiryDate < now) return;
              
              // Skip if purchased after the period
              if (purchaseDate && purchaseDate < startDate) return;
              if (!purchaseDate) {
                // If no purchase date, use expiry - duration
                const months = c.months || 1;
                const estPurchase = new Date(expiryDate);
                estPurchase.setMonth(estPurchase.getMonth() - months);
                if (estPurchase < startDate) return;
              }

              const months = c.months || 1;
              const income = costPerMonth * months;
              totalIncome += income;

              const subType = sub.type;
              if (!incomeByType[subType]) incomeByType[subType] = 0;
              incomeByType[subType] += income;

              customers.push({
                customerName: c.name || c.username,
                subscriptionType: sub.type,
                subscriptionName: sub.name,
                screenName: screen.name,
                accountEmail: acc.email,
                months: months,
                income: income,
                expiryDate: c.expiryDate,
                purchasedAt: c.purchasedAt || purchaseDate
              });
            });
          }
        });
      });
    });

    res.json({
      totalIncome,
      incomeByType,
      customers,
      period: period || 'all',
      startDate: startDate.toISOString(),
      endDate: now.toISOString()
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

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => seedData())
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 API URL: http://localhost:${PORT}/api`);
    });
  })
  .catch(err => {
    console.error('❌ Failed to connect to MongoDB:', err);
    process.exit(1);
  });