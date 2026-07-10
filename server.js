// functions/index.js
const functions = require('firebase-functions');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── In‑memory storage (will reset on every function cold start) ──
let otps = [];
let idCounter = 0;
let subscriptions = [
  // ... your initial data here (the same as in your server.js)
  // Make sure to copy everything from your original server.js
];

// ─── Copy ALL your routes exactly as they are ──────────────────
app.post('/api/otp/generate', (req, res) => { /* ... */ });
app.post('/api/otp/verify', (req, res) => { /* ... */ });
app.get('/api/otp/list', (req, res) => { /* ... */ });
app.get('/api/subscriptions', (req, res) => { /* ... */ });
app.get('/api/subscriptions/:id', (req, res) => { /* ... */ });
app.post('/api/subscriptions', (req, res) => { /* ... */ });
app.put('/api/subscriptions/:id', (req, res) => { /* ... */ });
app.delete('/api/subscriptions/:id', (req, res) => { /* ... */ });
app.get('/api/health', (req, res) => { /* ... */ });

// ─── EXPORT the app as a Cloud Function ────────────────────────
exports.api = functions.https.onRequest(app);