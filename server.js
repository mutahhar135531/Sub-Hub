const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── In‑memory storage ──────────────────────────────────────
let otps = [];
let idCounter = 0;
let subscriptions = [
  {
    id: '1',
    name: 'Netflix',
    type: 'netflix',
    accounts: [
      {
        id: 'a1',
        email: 'netflix1@example.com',
        password: 'pass1',
        screens: [
          { id: 's1', name: 'Screen 1', pin: '1111', customers: [] },
          { id: 's2', name: 'Screen 2', pin: '2222', customers: [] },
          { id: 's3', name: 'Screen 3', pin: '3333', customers: [] },
          { id: 's4', name: 'Screen 4', pin: '4444', customers: [] },
          { id: 's5', name: 'Screen 5', pin: '5555', customers: [] },
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
          { id: 's10', name: 'Screen 5', pin: '1010', customers: [] },
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

// ─── OTP endpoints ──────────────────────────────────────────
app.post('/api/otp/generate', (req, res) => {
  const { userIdentifier } = req.body;
  const otp = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const newOTP = {
    id: ++idCounter,
    otp,
    userIdentifier: userIdentifier || 'Unknown',
    createdAt: new Date().toISOString(),
    expiresAt,
    verified: false,
  };
  otps.push(newOTP);
  if (otps.length > 100) otps.shift();
  console.log(`✅ OTP generated: ${otp} for ${userIdentifier}`);
  res.json({ success: true, otpId: newOTP.id });
});

app.post('/api/otp/verify', (req, res) => {
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ error: 'OTP required' });
  const record = otps.find(o => o.otp === otp && !o.verified && o.expiresAt > Date.now());
  if (!record) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  record.verified = true;
  console.log(`✅ OTP ${otp} verified`);
  res.json({ success: true });
});

app.get('/api/otp/list', (req, res) => {
  const list = otps.map(o => ({
    id: o.id,
    otp: o.otp,
    userIdentifier: o.userIdentifier,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    verified: o.verified,
    expired: o.expiresAt < Date.now(),
  })).reverse();
  res.json(list);
});

// ─── Subscription endpoints ──────────────────────────────────
app.get('/api/subscriptions', (req, res) => {
  console.log('✅ /api/subscriptions called');
  res.json(subscriptions);
});

app.get('/api/subscriptions/:id', (req, res) => {
  const sub = subscriptions.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json(sub);
});

app.post('/api/subscriptions', (req, res) => {
  const { id, name, type, accounts } = req.body;
  if (subscriptions.find(s => s.id === id)) {
    return res.status(400).json({ error: 'Subscription id already exists' });
  }
  const newSub = { id, name, type, accounts: accounts || [] };
  subscriptions.push(newSub);
  res.json(newSub);
});

app.put('/api/subscriptions/:id', (req, res) => {
  const index = subscriptions.findIndex(s => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  const { name, type, accounts } = req.body;
  if (name) subscriptions[index].name = name;
  if (type) subscriptions[index].type = type;
  if (accounts) subscriptions[index].accounts = accounts;
  res.json(subscriptions[index]);
});

app.delete('/api/subscriptions/:id', (req, res) => {
  const index = subscriptions.findIndex(s => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  subscriptions.splice(index, 1);
  res.json({ success: true });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ─── START THE SERVER ──────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});