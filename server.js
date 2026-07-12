const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// In-memory storage
let otps = [];
let idCounter = 0;

// Generate OTP
app.post('/api/otp/generate', (req, res) => {
  const { userIdentifier } = req.body;
  const otp = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
  const newOTP = {
    id: ++idCounter,
    otp,
    userIdentifier: userIdentifier || 'Unknown',
    createdAt: new Date().toISOString(),
    expiresAt,
    verified: false,
  };
  otps.push(newOTP);
  // Keep last 100 to avoid memory bloat
  if (otps.length > 100) otps.shift();
  console.log(`✅ OTP generated: ${otp} for ${userIdentifier}`);
  res.json({ success: true, otpId: newOTP.id });
});

// Verify OTP
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

// Get all OTPs for admin
app.get('/api/otp/list', (req, res) => {
  const list = otps.map(o => ({
    id: o.id,
    otp: o.otp,
    userIdentifier: o.userIdentifier,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    verified: o.verified,
    expired: o.expiresAt < Date.now(),
  })).reverse(); // newest first
  res.json(list);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));