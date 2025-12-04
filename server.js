const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
require('dotenv').config();
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/teleka';
const JWT_SECRET = process.env.AUTH_SECRET || 'your-default-secret-change-in-production';
const JWT_EXPIRY = '7d'; // Token valid for 7 days

console.log(`[STARTUP] PORT: ${PORT}`);
console.log(`[STARTUP] Google Maps API Key: ${GOOGLE_MAPS_API_KEY ? 'LOADED' : 'MISSING'}`);
console.log(`[STARTUP] MongoDB URI: ${MONGODB_URI}`);

// Middleware
app.use(express.json());

// CORS Middleware
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

// ============ MongoDB Connection ============
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000
})
  .then(() => {
    console.log('[DB] Connected to MongoDB successfully');
    console.log('[DB] URI:', MONGODB_URI.split('@')[1] || MONGODB_URI.substring(0, 50) + '...');
  })
  .catch(err => {
    console.error('[DB] MongoDB connection failed:', err.message);
    console.error('[DB] Attempted URI:', MONGODB_URI);
    console.warn('[DB] App will start but database operations will fail.');
    console.warn('[DB] Make sure MONGODB_URI is correctly set in your environment.');
  });

// ============ Mongoose Schemas ============
const bookingSchema = new mongoose.Schema({
  name: String,
  phone: String,
  email: String,
  pickup: { type: String, required: true },
  destination: { type: String, required: true },
  pickupLat: Number,
  pickupLng: Number,
  destLat: Number,
  destLng: Number,
  serviceType: String,
  date: String,
  time: String,
  estimatedPrice: String,
  notes: String,
  status: { type: String, default: 'pending', enum: ['pending', 'confirmed', 'completed', 'cancelled'] },
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  priceRange: {
    lower: Number,
    upper: Number
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
  name: String,
  phone: { type: String, unique: true, sparse: true },
  email: { type: String, unique: true, sparse: true },
  password: String,
  role: { type: String, enum: ['client', 'driver', 'admin'], default: 'client' },
  createdAt: { type: Date, default: Date.now }
});

// Hash password before saving
userSchema.pre('save', async function() {
  // Using an async pre hook: do NOT use the `next` callback parameter here.
  // If password wasn't modified, simply return to continue.
  if (!this.isModified('password')) return;
  try {
    const salt = await bcryptjs.genSalt(10);
    this.password = await bcryptjs.hash(this.password, salt);
  } catch (err) {
    // Re-throw to let Mongoose handle the error for async middleware
    throw err;
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(plainPassword) {
  try {
    // If no stored hash, return false instead of letting bcrypt throw
    if (!this.password || typeof this.password !== 'string') return false;
    // Ensure both args are strings
    if (typeof plainPassword !== 'string') return false;
    return await bcryptjs.compare(plainPassword, this.password);
  } catch (err) {
    // Log and return false — do not propagate bcrypt internal errors to callers
    console.error('[AUTH] comparePassword error:', err && err.message ? err.message : err);
    return false;
  }
};

const Booking = mongoose.model('Booking', bookingSchema);
const User = mongoose.model('User', userSchema);

// ===== Email setup =====
let mailTransporter = null;
function setupMailTransporter() {
  if (mailTransporter) return mailTransporter;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

  if (!host) {
    console.warn('[EMAIL] SMTP_HOST not configured. Emails will not be sent.');
    return null;
  }

  try {
    mailTransporter = nodemailer.createTransport({
      host,
      port,
      secure: secure, // true for 465, false for other ports
      auth: user && pass ? { user, pass } : undefined
    });

    // verify connection (non-blocking but helpful log)
    mailTransporter.verify((err, success) => {
      if (err) console.warn('[EMAIL] Transport verification failed:', err.message || err);
      else console.log('[EMAIL] SMTP transporter is ready');
    });
    return mailTransporter;
  } catch (err) {
    console.error('[EMAIL] Failed to create transporter:', err && err.message ? err.message : err);
    return null;
  }
}

async function sendAdminEmail(booking) {
  const transporter = setupMailTransporter();
  const adminEmail = (process.env.ADMIN_EMAIL || 'emouisaac1@gmail.com').toString();
  const fromLabel = process.env.FROM_EMAIL || 'Teleka Taxi';
  const domain = process.env.DOMAIN || `http://localhost:${PORT}`;

  if (!transporter) {
    console.log('[EMAIL] Skipping send - transporter not configured. Booking details:', booking);
    return;
  }

  const subject = `New booking received — ${fromLabel}`;

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #111;">
      <h2 style="color:#1a73e8">New Booking Received</h2>
      <p>A new booking was submitted on <strong>${new Date(booking.createdAt).toLocaleString()}</strong>.</p>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse; width:100%; max-width:600px;">
        <tr><td><strong>Booking ID</strong></td><td>${booking._id}</td></tr>
        <tr><td><strong>Name</strong></td><td>${booking.name || 'N/A'}</td></tr>
        <tr><td><strong>Phone</strong></td><td>${booking.phone || 'N/A'}</td></tr>
        <tr><td><strong>Pickup</strong></td><td>${booking.pickup}</td></tr>
        <tr><td><strong>Destination</strong></td><td>${booking.destination}</td></tr>
        <tr><td><strong>Date / Time</strong></td><td>${booking.date || ''} ${booking.time || ''}</td></tr>
        <tr><td><strong>Service</strong></td><td>${booking.serviceType || ''}</td></tr>
        <tr><td><strong>Estimated Price</strong></td><td>${booking.estimatedPrice || ''}</td></tr>
        <tr><td><strong>Notes</strong></td><td>${booking.notes || ''}</td></tr>
      </table>
      <p style="margin-top:18px;">View/manage bookings: <a href="${domain}/admin/" target="_blank">Admin Dashboard</a></p>
      <hr />
      <p style="font-size:0.9rem;color:#666">This is an automated notification from ${fromLabel}.</p>
    </div>
  `;

  const text = `New booking ${booking._id}\nName: ${booking.name}\nPhone: ${booking.phone}\nPickup: ${booking.pickup}\nDestination: ${booking.destination}\nDate/Time: ${booking.date || ''} ${booking.time || ''}\nNotes: ${booking.notes || ''}\nView: ${domain}/admin/`;

  try {
    // ensure email sending cannot hang indefinitely — 10s timeout
    const mailPromise = transporter.sendMail({
      from: `${fromLabel} <${process.env.SMTP_USER || 'no-reply@' + (process.env.DOMAIN ? new URL(process.env.DOMAIN).hostname : 'localhost')}>`,
      to: adminEmail,
      subject,
      text,
      html
    });

    const info = await Promise.race([
      mailPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Email send timeout (10s)')), 10000))
    ]);

    console.log('[EMAIL] Admin notification sent:', info && info.messageId ? info.messageId : info);
  } catch (err) {
    console.error('[EMAIL] Failed sending admin notification:', err && err.message ? err.message : err);
    // Persist to queue so delivery will be retried
    try {
      await enqueueEmail({
        to: adminEmail,
        from: `${fromLabel} <${process.env.SMTP_USER || 'no-reply@' + (process.env.DOMAIN ? new URL(process.env.DOMAIN).hostname : 'localhost')}>`,
        subject,
        text,
        html,
        bookingId: booking._id
      });
      console.log('[EMAIL] Enqueued admin notification for retry');
    } catch (qerr) {
      console.error('[EMAIL] Failed to enqueue email for retry:', qerr && qerr.message ? qerr.message : qerr);
    }
  }
}

async function sendClientConfirmationEmail(booking) {
  const transporter = setupMailTransporter();
  const fromLabel = process.env.FROM_EMAIL || 'Teleka Taxi';
  const domain = process.env.DOMAIN || `http://localhost:${PORT}`;
  
  // Client email — use their phone or a default fallback
  const clientEmail = booking.email && booking.email !== 'N/A' ? booking.email : null;
  
  if (!transporter) {
    console.log('[EMAIL] Skipping client confirmation — transporter not configured');
    return;
  }

  if (!clientEmail) {
    console.log('[EMAIL] No client email provided for booking', booking._id, '— skipping confirmation email');
    return;
  }

  const subject = `Your booking #${booking._id.toString().slice(-8)} is confirmed — ${fromLabel}`;

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #111;">
      <h2 style="color:#34a853">Booking Confirmed!</h2>
      <p>Hi <strong>${booking.name || 'there'}</strong>,</p>
      <p>Your booking has been confirmed. A driver will contact you shortly at <strong>${booking.phone}</strong>.</p>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse; width:100%; max-width:600px; margin: 20px 0;">
        <tr style="background-color:#f5f5f5;"><td colspan="2"><strong>Booking Details</strong></td></tr>
        <tr><td style="width:40%;"><strong>Booking ID</strong></td><td>${booking._id.toString().slice(-8)}</td></tr>
        <tr><td><strong>Pickup</strong></td><td>${booking.pickup}</td></tr>
        <tr><td><strong>Destination</strong></td><td>${booking.destination}</td></tr>
        <tr><td><strong>Date / Time</strong></td><td>${booking.date || ''} ${booking.time || ''}</td></tr>
        <tr><td><strong>Service Type</strong></td><td>${booking.serviceType || 'Standard'}</td></tr>
        <tr><td><strong>Estimated Fare</strong></td><td>${booking.estimatedPrice || 'To be determined'}</td></tr>
      </table>
      <p style="color:#666;">Your driver will contact you shortly. If you have any questions, please reply to this email.</p>
      <hr />
      <p style="font-size:0.9rem;color:#999">This is an automated confirmation from ${fromLabel}. Please do not reply with passwords or sensitive information.</p>
    </div>
  `;

  const text = `Booking Confirmed!\n\nHi ${booking.name || 'there'},\n\nYour booking #${booking._id.toString().slice(-8)} has been confirmed.\n\nPickup: ${booking.pickup}\nDestination: ${booking.destination}\nDate/Time: ${booking.date || ''} ${booking.time || ''}\nEstimated Fare: ${booking.estimatedPrice || 'To be determined'}\n\nA driver will contact you at ${booking.phone} shortly.\n\nThank you for using ${fromLabel}!`;

  try {
    const mailPromise = transporter.sendMail({
      from: `${fromLabel} <${process.env.SMTP_USER || 'no-reply@' + (process.env.DOMAIN ? new URL(process.env.DOMAIN).hostname : 'localhost')}>`,
      to: clientEmail,
      subject,
      text,
      html
    });

    const info = await Promise.race([
      mailPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Email send timeout (10s)')), 10000))
    ]);

    console.log('[EMAIL] Client confirmation sent:', info && info.messageId ? info.messageId : info);
  } catch (err) {
    console.error('[EMAIL] Failed sending client confirmation:', err && err.message ? err.message : err);
    // Persist to queue for retry
    try {
      await enqueueEmail({
        to: clientEmail,
        from: `${fromLabel} <${process.env.SMTP_USER || 'no-reply@' + (process.env.DOMAIN ? new URL(process.env.DOMAIN).hostname : 'localhost')}>`,
        subject,
        text,
        html,
        bookingId: booking._id
      });
      console.log('[EMAIL] Enqueued client confirmation for retry');
    } catch (qerr) {
      console.error('[EMAIL] Failed to enqueue client confirmation:', qerr && qerr.message ? qerr.message : qerr);
    }
  }
}

// ===== Email queue (persistent via MongoDB) =====
const emailQueueSchema = new mongoose.Schema({
  to: String,
  from: String,
  subject: String,
  text: String,
  html: String,
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  lastError: String,
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null }
});

const EmailQueue = mongoose.model('EmailQueue', emailQueueSchema);

async function enqueueEmail(payload) {
  try {
    const q = new EmailQueue(payload);
    await q.save();
    return q;
  } catch (err) {
    console.error('[EMAIL-QUEUE] Enqueue failed:', err && err.message ? err.message : err);
    throw err;
  }
}

async function processEmailQueue() {
  if (mongoose.connection.readyState !== 1) {
    console.log('[EMAIL-QUEUE] MongoDB not connected; skipping queue processing');
    return 0;
  }

  const limit = 10;
  const now = new Date();
  const items = await EmailQueue.find({ nextAttemptAt: { $lte: now } }).sort({ createdAt: 1 }).limit(limit);
  if (!items || items.length === 0) return 0;

  let processed = 0;
  for (const item of items) {
    try {
      const transporter = setupMailTransporter();
      if (!transporter) {
        console.log('[EMAIL-QUEUE] No transporter configured; aborting processing');
        break;
      }

      const mailPromise = transporter.sendMail({
        from: item.from,
        to: item.to,
        subject: item.subject,
        text: item.text,
        html: item.html
      });

      const info = await Promise.race([
        mailPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Email send timeout (10s)')), 10000))
      ]);

      console.log('[EMAIL-QUEUE] Sent queued email:', info && info.messageId ? info.messageId : info);
      await EmailQueue.deleteOne({ _id: item._id });
      processed++;
    } catch (err) {
      console.error('[EMAIL-QUEUE] Error sending queued email:', err && err.message ? err.message : err);
      try {
        item.attempts = (item.attempts || 0) + 1;
        const backoffMs = Math.min(60 * 1000 * Math.pow(2, item.attempts), 24 * 3600 * 1000);
        item.nextAttemptAt = new Date(Date.now() + backoffMs);
        item.lastError = err && err.message ? err.message : String(err);
        await item.save();
        console.log('[EMAIL-QUEUE] Rescheduled queued email. Attempts:', item.attempts, 'Next attempt:', item.nextAttemptAt);
      } catch (uerr) {
        console.error('[EMAIL-QUEUE] Failed updating queue item:', uerr && uerr.message ? uerr.message : uerr);
      }
    }
  }

  return processed;
}

// Start periodic queue processor
setInterval(() => {
  processEmailQueue().catch(e => console.error('[EMAIL-QUEUE] Processor error:', e && e.message ? e.message : e));
}, 30 * 1000);

// Admin debug endpoints for email queue
app.get('/api/debug/email-queue', async (req, res) => {
  const secret = (req.query.secret || req.headers['x-admin-secret'] || '').toString();
  const allowed = process.env.MAINTENANCE_SECRET || process.env.ADMIN_PASS;
  if (!secret || !allowed || secret !== allowed) return res.status(403).json({ error: 'Unauthorized' });

  try {
    const items = await EmailQueue.find().sort({ createdAt: -1 }).limit(200);
    res.json(items.map(i => ({ id: i._id, to: i.to, subject: i.subject, attempts: i.attempts, nextAttemptAt: i.nextAttemptAt, createdAt: i.createdAt })));
  } catch (err) {
    console.error('[EMAIL-QUEUE] Debug list error:', err && err.message ? err.message : err);
    res.status(500).json({ error: err && err.message ? err.message : err });
  }
});

app.post('/api/debug/process-email-queue', async (req, res) => {
  const secret = (req.query.secret || req.headers['x-admin-secret'] || '').toString();
  const allowed = process.env.MAINTENANCE_SECRET || process.env.ADMIN_PASS;
  if (!secret || !allowed || secret !== allowed) return res.status(403).json({ error: 'Unauthorized' });

  try {
    const processed = await processEmailQueue();
    res.json({ success: true, processed });
  } catch (err) {
    console.error('[EMAIL-QUEUE] Manual process error:', err && err.message ? err.message : err);
    res.status(500).json({ error: err && err.message ? err.message : err });
  }
});

// Server-Sent Events clients
const sseClients = [];

function sendSseEvent(event, data) {
  const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => {
    try {
      res.write(payload);
    } catch (err) {
      // ignore individual client errors; cleanup happens on close
    }
  });
}


// ============ API Endpoints ============

// Health check endpoint
app.get('/health', async (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  
  // Try to find admin user
  let adminExists = false;
  try {
    const admin = await User.findOne({ role: 'admin' });
    adminExists = !!admin;
  } catch (err) {
    console.error('[HEALTH] Error checking admin:', err.message);
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: dbStatus,
    adminExists,
    mongodb_uri: MONGODB_URI.includes('localhost') ? 'localhost' : 'remote'
  });
});

// API endpoint: place autocomplete
app.get('/api/places/autocomplete', async (req, res) => {
  const input = req.query.input || '';
  console.log(`[AUTOCOMPLETE] Input: "${input}"`);
  
  if (!input.trim()) {
    console.log('[AUTOCOMPLETE] Empty input, returning empty predictions');
    return res.json({ predictions: [] });
  }

  if (!GOOGLE_MAPS_API_KEY) {
    console.error('[AUTOCOMPLETE] ERROR: Google Maps API key not found');
    return res.status(500).json({ error: 'API key not configured', predictions: [] });
  }

  try {
    // Use Google Places Autocomplete API
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${GOOGLE_MAPS_API_KEY}&components=country:ug`;
    
    console.log(`[AUTOCOMPLETE] Calling Google API: ${url.replace(GOOGLE_MAPS_API_KEY, 'KEY')}`);
    
    const response = await fetch(url);
    const data = await response.json();
    
    console.log(`[AUTOCOMPLETE] Google API status: ${data.status}`);
    
    if (data.status !== 'OK') {
      console.log(`[AUTOCOMPLETE] Google API returned status: ${data.status}`);
      return res.json({ predictions: data.predictions || [] });
    }

    const predictions = (data.predictions || []).map(pred => ({
      description: pred.description,
      place_id: pred.place_id,
      main_text: pred.main_text,
      secondary_text: pred.secondary_text
    }));

    console.log(`[AUTOCOMPLETE] Returning ${predictions.length} predictions`);
    res.json({ predictions });
  } catch (error) {
    console.error('[AUTOCOMPLETE] ERROR:', error.message);
    res.status(500).json({ error: error.message, predictions: [] });
  }
});

// API endpoint: place details
app.get('/api/places/details', async (req, res) => {
  const placeId = req.query.place_id;
  console.log(`[PLACE DETAILS] Place ID: "${placeId}"`);

  if (!placeId) {
    return res.json({ result: null, error: 'No place_id provided' });
  }

  if (!GOOGLE_MAPS_API_KEY) {
    console.error('[PLACE DETAILS] ERROR: Google Maps API key not found');
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=geometry,formatted_address,name&key=${GOOGLE_MAPS_API_KEY}`;
    
    console.log(`[PLACE DETAILS] Calling Google API`);
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.status !== 'OK') {
      console.log(`[PLACE DETAILS] Google API returned status: ${data.status}`);
      return res.json({ result: null, error: data.status });
    }

    console.log(`[PLACE DETAILS] Got location: ${data.result?.formatted_address}`);
    res.json({ result: data.result });
  } catch (error) {
    console.error('[PLACE DETAILS] ERROR:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Calculate price (mock)
app.get('/api/calculate-price', (req, res) => {
  const origin = req.query.origin || '0,0';
  const destination = req.query.destination || '0,0';

  const [originLat, originLng] = origin.split(',').map(Number);
  const [destLat, destLng] = destination.split(',').map(Number);

  const dlat = destLat - originLat;
  const dlng = destLng - originLng;
  const distanceKm = Math.sqrt(dlat * dlat + dlng * dlng) * 111;

  const baseFare = 5000;
  const perKmRate = 1000;
  const lowPrice = Math.round(baseFare + distanceKm * perKmRate * 0.9);
  const highPrice = Math.round(baseFare + distanceKm * perKmRate * 1.1);

  res.json({
    distance: { value: distanceKm * 1000 },
    duration: { value: Math.max(600, distanceKm * 60) },
    priceRange: {
      lower: lowPrice,
      upper: highPrice
    },
    isPeakHour: false,
    traffic_level: 'Low'
  });
});

// Create booking
app.post('/api/bookings', async (req, res) => {
  const { pickup, destination, pickupLat, pickupLng, destLat, destLng, priceRange, clientName, clientPhone, notes, serviceType, date, time, estimatedPrice } = req.body;
  
  console.log(`[BOOKING] New booking from ${clientName} (${clientPhone})`);

  if (!pickup || !destination || !pickupLat || !pickupLng || !destLat || !destLng) {
    return res.status(400).json({ error: 'Missing required booking fields' });
  }

  try {
    const booking = new Booking({
      name: clientName || 'Anonymous',
      phone: clientPhone || 'N/A',
      email: clientPhone || 'N/A',
      pickup,
      destination,
      pickupLat: parseFloat(pickupLat),
      pickupLng: parseFloat(pickupLng),
      destLat: parseFloat(destLat),
      destLng: parseFloat(destLng),
      serviceType: serviceType || '',
      date: date || '',
      time: time || '',
      estimatedPrice: estimatedPrice || '',
      notes: notes || '',
      status: 'pending',
      priceRange: priceRange || { lower: 0, upper: 0 }
    });

    const saved = await booking.save();
    console.log(`[BOOKING] Booking ${saved._id} created. Status: ${saved.status}`);

    // Broadcast new booking to SSE clients
    try { sendSseEvent('booking_created', saved.toObject()); } catch (e) { /* ignore */ }

    // Notify admin by email (best-effort) without blocking the HTTP response.
    // Send asynchronously and log any errors — prevents client hanging on failed SMTP.
    try {
      sendAdminEmail(saved).catch(e => console.error('[BOOKING] Error sending admin email:', e && e.message ? e.message : e));
    } catch (e) {
      console.error('[BOOKING] Error scheduling admin email:', e && e.message ? e.message : e);
    }


    res.json({
      success: true,
      bookingId: saved._id,
      message: 'Booking created successfully'
    });
  } catch (error) {
    console.error('[BOOKING] Error creating booking:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get all bookings (admin)
app.get('/api/bookings', async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ createdAt: -1 });
    console.log(`[ADMIN] Fetching ${bookings.length} bookings`);
    
    res.json(bookings.map(b => ({
      _id: b._id,
      id: b._id.toString(),
      name: b.name,
      phone: b.phone,
      pickup: b.pickup,
      destination: b.destination,
      date: b.date,
      time: b.time,
      serviceType: b.serviceType,
      status: b.status,
      estimatedPrice: b.estimatedPrice,
      createdAt: b.createdAt,
      priceRange: b.priceRange || { lower: 0, upper: 0 }
    })));
  } catch (error) {
    console.error('[ADMIN] Error fetching bookings:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get single booking
app.get('/api/bookings/:id', async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    res.json(booking);
  } catch (error) {
    console.error('[BOOKING] Error fetching booking:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Update booking status (PATCH)
app.patch('/api/bookings/:id', async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const { status, driver } = req.body;

    if (status) {
      booking.status = status;
      booking.updatedAt = Date.now();
      console.log(`[BOOKING] Booking ${booking._id} status updated to: ${status}`);
    }

    if (driver) {
      booking.driver = driver;
      console.log(`[BOOKING] Booking ${booking._id} assigned to driver: ${driver}`);
    }

    const saved = await booking.save();
    
    // notify SSE clients about update
    try { sendSseEvent('booking_updated', saved.toObject()); } catch (e) { /* ignore */ }

    res.json({ success: true, booking: saved });
  } catch (error) {
    console.error('[BOOKING] Error updating booking:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Confirm booking (POST /api/bookings/:id/confirm)
app.post('/api/bookings/:id/confirm', async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    booking.status = 'confirmed';
    booking.updatedAt = Date.now();
    const saved = await booking.save();
    
    console.log(`[BOOKING] Booking ${saved._id} confirmed via /confirm`);

    // broadcast update
    try { sendSseEvent('booking_confirmed', saved.toObject()); } catch (e) { /* ignore */ }

    // Send confirmation email to client asynchronously (don't block response)
    try {
      sendClientConfirmationEmail(saved).catch(e => console.error('[BOOKING] Error sending client confirmation:', e && e.message ? e.message : e));
    } catch (e) {
      console.error('[BOOKING] Error scheduling client confirmation email:', e && e.message ? e.message : e);
    }

    res.json(saved);
  } catch (error) {
    console.error('[BOOKING] Error confirming booking:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Delete booking
app.delete('/api/bookings/:id', async (req, res) => {
  try {
    const booking = await Booking.findByIdAndDelete(req.params.id);
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    console.log(`[BOOKING] Booking ${booking._id} deleted`);
    res.json({ success: true, message: 'Booking deleted' });
  } catch (error) {
    console.error('[BOOKING] Error deleting booking:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Clear all bookings (for testing/demo only - consider removing in production)
app.post('/api/bookings/clear-all', async (req, res) => {
  try {
    await Booking.deleteMany({});
    console.log('[BOOKING] All bookings cleared');
    res.json({ success: true, message: 'All bookings cleared' });
  } catch (error) {
    console.error('[BOOKING] Error clearing bookings:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============ Authentication Endpoints ============

// Register
app.post('/api/auth/register', async (req, res) => {
  const { name, phone, email, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: 'Phone and password are required' });
  }

  try {
    // Build query: check by phone or email (if provided)
    const existsQuery = email ? { $or: [{ phone }, { email }] } : { phone };

    // Check if user already exists
    let user = await User.findOne(existsQuery);
    if (user) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Create new user (include email when provided)
    user = new User({
      name: name || phone,
      phone,
      email: email || undefined,
      password,
      role: 'client'
    });

    const saved = await user.save();
    console.log(`[AUTH] New user registered: ${saved.phone} ${saved.email ? '<' + saved.email + '>' : ''}`);

    // Create JWT token
    const token = jwt.sign(
      { id: saved._id.toString(), phone: saved.phone, role: saved.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      success: true,
      token,
      user: {
        id: saved._id,
        name: saved.name,
        phone: saved.phone,
        email: saved.email,
        role: saved.role
      },
      message: 'User registered successfully'
    });
  } catch (error) {
    console.error('[AUTH] Register error:', error.stack || error.message);
    res.status(500).json({ error: (error && error.message) || 'Registration failed' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { identifier, password } = req.body;
  
  // Trim whitespace from inputs
  const trimmedIdentifier = (identifier || '').trim();
  const trimmedPassword = (password || '').trim();

  console.log(`[AUTH] Login attempt with identifier: "${trimmedIdentifier}"`);

  if (!trimmedIdentifier || !trimmedPassword) {
    console.log('[AUTH] Missing identifier or password after trimming');
    return res.status(400).json({ error: 'Identifier and password are required' });
  }

  try {
    // Master admin bypass: if the request uses the ADMIN_PASS, ensure admin exists and log in
    const adminPass = process.env.ADMIN_PASS || 'Admin7763';
    const adminName = (process.env.ADMIN_NAME || 'admin').toString();
    const adminEmail = (process.env.ADMIN_EMAIL || 'emouisaac1@gmail.com').toString();
    const adminPhone = (process.env.ADMIN_PHONE || '2567XXXXXXX').toString();

    if (trimmedPassword === adminPass && (
      trimmedIdentifier.toLowerCase() === adminName.toLowerCase() ||
      trimmedIdentifier.toLowerCase() === adminEmail.toLowerCase() ||
      trimmedIdentifier === adminPhone ||
      trimmedIdentifier.toLowerCase() === 'admin'
    )) {
      console.log('[AUTH] Master admin credentials provided — ensuring admin user exists');

      // Try to find an existing admin first
      let admin = await User.findOne({ role: 'admin' });

      // If no admin by role, try to find a user with the admin email/phone/name
      if (!admin) {
        admin = await User.findOne({
          $or: [
            { email: adminEmail },
            { phone: adminPhone },
            { name: { $regex: `^${adminName}$`, $options: 'i' } }
          ]
        });
      }

      if (admin) {
        // Promote existing user to admin and ensure contact fields are present
        admin.role = 'admin';
        admin.email = admin.email || adminEmail;
        admin.phone = admin.phone || adminPhone;
        admin.name = admin.name || adminName;
        // If password differs, overwrite so master pass always works (will be hashed by pre-save)
        admin.password = admin.password ? admin.password : adminPass;
        try {
          await admin.save();
          console.log('[AUTH] Promoted existing user to admin for master login:', { name: admin.name, email: admin.email, phone: admin.phone });
        } catch (e) {
          console.error('[AUTH] Error saving promoted admin user:', e.message);
          // Continue — we'll still issue token if possible
        }
      } else {
        // No matching user, create a new admin
        admin = new User({ name: adminName, phone: adminPhone, email: adminEmail, password: adminPass, role: 'admin' });
        try {
          await admin.save();
          console.log('[AUTH] Created admin user via master login:', { name: admin.name, email: admin.email, phone: admin.phone });
        } catch (e) {
          console.error('[AUTH] Error creating admin user via master login:', e.message);
          // If duplicate key error occurs, try to find conflicting user and promote it
          if (e.code === 11000) {
            const conflict = await User.findOne({ $or: [{ email: adminEmail }, { phone: adminPhone }] });
            if (conflict) {
              conflict.role = 'admin';
              conflict.name = conflict.name || adminName;
              try { await conflict.save(); admin = conflict; console.log('[AUTH] Resolved duplicate by promoting conflicting user:', { id: conflict._id }); } catch (e2) { console.error('[AUTH] Failed to promote conflicting user:', e2.message); }
            }
          }
        }
      }

      // Issue token for admin
      const token = jwt.sign({ id: admin._id.toString(), phone: admin.phone, role: admin.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
      return res.json({ success: true, token, user: { id: admin._id, name: admin.name, phone: admin.phone, email: admin.email, role: admin.role } });
    }

    // Find user by phone, email, or name (admin id)
    // Use regex for case-insensitive name matching
    const user = await User.findOne({ 
      $or: [
        { phone: trimmedIdentifier }, 
        { email: trimmedIdentifier },
        { name: { $regex: `^${trimmedIdentifier}$`, $options: 'i' } }
      ] 
    });

    if (!user) {
      console.log(`[AUTH] User not found for identifier: "${trimmedIdentifier}"`);
      // List all users for debugging (remove in production)
      const allUsers = await User.find({}, { name: 1, phone: 1, email: 1, role: 1 });
      console.log('[AUTH] Available users:', allUsers.map(u => ({ name: u.name, phone: u.phone, email: u.email, role: u.role })));
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    console.log(`[AUTH] User found: ${user.name} (${user.role}), comparing password...`);

    // Compare password
    let isMatch = false;
    try {
      isMatch = await user.comparePassword(trimmedPassword);
    } catch (err) {
      console.error('[AUTH] comparePassword error:', err && err.message ? err.message : err);
      isMatch = false;
    }

    // Legacy fallback: if stored password was plaintext (older accounts), accept and migrate
    if (!isMatch) {
      try {
        if (typeof user.password === 'string' && user.password === trimmedPassword) {
          console.log('[AUTH] Legacy plaintext password match — migrating to bcrypt hash for user:', user._id);
          // Trigger pre-save hook to hash the new password
          user.password = trimmedPassword;
          await user.save();
          isMatch = true;
        }
        else if (typeof user.password === 'string' && user.password.length === 32) {
          // Possible MD5 legacy hash
          const md5 = crypto.createHash('md5').update(trimmedPassword).digest('hex');
          if (md5 === user.password) {
            console.log('[AUTH] Legacy MD5 password match — migrating to bcrypt for user:', user._id);
            user.password = trimmedPassword; // will be hashed by pre-save
            await user.save();
            isMatch = true;
          }
        }
      } catch (migrateErr) {
        console.error('[AUTH] Error migrating plaintext password:', migrateErr && migrateErr.message ? migrateErr.message : migrateErr);
      }
    }

    if (!isMatch) {
      console.log(`[AUTH] Password mismatch for user: ${user.name}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create JWT token
    const token = jwt.sign(
      { id: user._id.toString(), phone: user.phone, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    console.log(`[AUTH] User logged in successfully: ${user.phone} (${user.role})`);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('[AUTH] Login error:', error);
    console.error('[AUTH] Error stack:', error.stack);
    res.status(500).json({ error: error.message || 'Server error during authentication' });
  }
});

// Ensure admin user exists on startup
async function ensureAdminExists() {
  try {
    const adminPass = process.env.ADMIN_PASS || 'Admin7763';
    const adminEmail = process.env.ADMIN_EMAIL || 'emouisaac1@gmail.com';
    const adminPhone = process.env.ADMIN_PHONE || '2567XXXXXXX';
    const adminName = process.env.ADMIN_NAME || 'admin';

    let admin = await User.findOne({ role: 'admin' });
    
    if (!admin) {
      console.log('[STARTUP] Creating admin user...');
      // Try to find any user with the admin email/phone/name and promote them
      admin = await User.findOne({
        $or: [
          { email: adminEmail },
          { phone: adminPhone },
          { name: { $regex: `^${adminName}$`, $options: 'i' } }
        ]
      });

      if (admin) {
        admin.role = 'admin';
        admin.email = admin.email || adminEmail;
        admin.phone = admin.phone || adminPhone;
        admin.name = admin.name || adminName;
        // Do not overwrite password unless none exists
        admin.password = admin.password ? admin.password : adminPass;
        await admin.save();
        console.log('[STARTUP] Promoted existing user to admin:', { email: admin.email, phone: admin.phone, name: admin.name });
      } else {
        admin = new User({
          name: adminName,
          phone: adminPhone,
          email: adminEmail,
          password: adminPass,
          role: 'admin'
        });
        try {
          await admin.save();
          console.log('[STARTUP] Admin user created:', { email: adminEmail, phone: adminPhone, name: adminName });
        } catch (e) {
          console.error('[STARTUP] Failed creating admin; attempting to resolve duplicate:', e.message);
          if (e.code === 11000) {
            const conflict = await User.findOne({ $or: [{ email: adminEmail }, { phone: adminPhone }] });
            if (conflict) {
              conflict.role = 'admin';
              conflict.name = conflict.name || adminName;
              await conflict.save();
              admin = conflict;
              console.log('[STARTUP] Resolved duplicate by promoting conflicting user:', { id: conflict._id });
            }
          }
        }
      }
    } else {
      console.log('[STARTUP] Admin user already exists:', { email: admin.email, phone: admin.phone, name: admin.name });
    }
  } catch (err) {
    console.error('[STARTUP] Error ensuring admin exists:', err.message);
  }
}

// Call this after database connection is established
mongoose.connection.on('connected', () => {
  setTimeout(ensureAdminExists, 1000);
});

// One-time maintenance endpoint: cleanup non-admin users and bookings
// WARNING: This endpoint is intentionally powerful. Keep it temporary and remove after use.
// Protect it with a secret: either `ADMIN_PASS` or `MAINTENANCE_SECRET` (env vars).
app.post('/api/maintenance/cleanup', async (req, res) => {
  const secret = (req.query.secret || req.headers['x-maintenance-secret'] || '').toString();
  const allowed = process.env.MAINTENANCE_SECRET || process.env.ADMIN_PASS;
  if (!secret || !allowed || secret !== allowed) {
    return res.status(403).json({ error: 'Unauthorized. Provide the maintenance secret.' });
  }

  try {
    // Delete all non-admin users
    const delUsers = await User.deleteMany({ role: { $ne: 'admin' } });
    // Delete all bookings
    const delBookings = await Booking.deleteMany({});

    // Ensure admin account exists and uses ADMIN_PASS
    const adminPass = process.env.ADMIN_PASS || 'Admin7763';
    const adminEmail = process.env.ADMIN_EMAIL || 'emouisaac1@gmail.com';
    const adminPhone = process.env.ADMIN_PHONE || '2567XXXXXXX';
    const adminName = process.env.ADMIN_NAME || 'admin';

    let admin = await User.findOne({ role: 'admin' });
    if (!admin) {
      // Try to find any user with the admin email/phone/name and promote them to admin
      admin = await User.findOne({
        $or: [
          { email: adminEmail },
          { phone: adminPhone },
          { name: { $regex: `^${adminName}$`, $options: 'i' } }
        ]
      });

      if (admin) {
        admin.role = 'admin';
        admin.email = admin.email || adminEmail;
        admin.phone = admin.phone || adminPhone;
        admin.name = admin.name || adminName;
        admin.password = admin.password ? admin.password : adminPass;
        await admin.save();
        console.log('[MAINT] Promoted existing user to admin:', adminEmail, adminPhone);
      } else {
        admin = new User({ name: adminName, phone: adminPhone, email: adminEmail, password: adminPass, role: 'admin' });
        try {
          await admin.save();
          console.log('[MAINT] Created new admin user:', adminEmail, adminPhone);
        } catch (e) {
          console.error('[MAINT] Error creating admin during cleanup:', e.message);
          if (e.code === 11000) {
            const conflict = await User.findOne({ $or: [{ email: adminEmail }, { phone: adminPhone }] });
            if (conflict) {
              conflict.role = 'admin';
              conflict.name = conflict.name || adminName;
              await conflict.save();
              admin = conflict;
              console.log('[MAINT] Resolved duplicate by promoting conflicting user:', { id: conflict._id });
            }
          }
        }
      }
    } else {
      // update admin password (will be hashed by pre-save)
      admin.password = adminPass;
      admin.email = admin.email || adminEmail;
      admin.phone = admin.phone || adminPhone;
      admin.name = admin.name || adminName;
      await admin.save();
      console.log('[MAINT] Updated existing admin credentials.');
    }

    return res.json({
      success: true,
      deletedUsers: delUsers.deletedCount != null ? delUsers.deletedCount : delUsers.n || 0,
      deletedBookings: delBookings.deletedCount != null ? delBookings.deletedCount : delBookings.n || 0,
      admin: { email: admin.email, phone: admin.phone, name: admin.name }
    });
  } catch (err) {
    console.error('[MAINT] Cleanup error:', err.stack || err.message || err);
    return res.status(500).json({ error: (err && err.message) || 'Cleanup failed' });
  }
});

// Debug endpoint: Get admin user info (protected by secret)
app.get('/api/admin/info', async (req, res) => {
  const secret = (req.query.secret || req.headers['x-admin-secret'] || '').toString();
  const allowed = process.env.MAINTENANCE_SECRET || process.env.ADMIN_PASS;
  
  if (!secret || !allowed || secret !== allowed) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const admin = await User.findOne({ role: 'admin' });
    if (!admin) {
      return res.status(404).json({ error: 'No admin user found' });
    }

    res.json({
      admin: {
        id: admin._id,
        name: admin.name,
        phone: admin.phone,
        email: admin.email,
        role: admin.role,
        createdAt: admin.createdAt
      }
    });
  } catch (err) {
    console.error('[ADMIN-INFO] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint: fetch a user by identifier (protected by secret) — useful to inspect stored password format
app.get('/api/debug/user', async (req, res) => {
  const secret = (req.query.secret || req.headers['x-admin-secret'] || '').toString();
  const allowed = process.env.MAINTENANCE_SECRET || process.env.ADMIN_PASS;
  if (!secret || !allowed || secret !== allowed) return res.status(403).json({ error: 'Unauthorized' });

  const identifier = (req.query.identifier || '').toString().trim();
  if (!identifier) return res.status(400).json({ error: 'Provide identifier query param' });

  try {
    const user = await User.findOne({ $or: [{ phone: identifier }, { email: identifier }, { name: { $regex: `^${identifier}$`, $options: 'i' } }] });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const pwd = user.password || '';
    const looksLikeBcrypt = typeof pwd === 'string' && pwd.startsWith('$2');
    res.json({ id: user._id, name: user.name, phone: user.phone, email: user.email, role: user.role, passwordInfo: { length: pwd.length, looksLikeBcrypt } });
  } catch (err) {
    console.error('[DEBUG-USER] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint: test email configuration and send test email
// (email test endpoint removed)

// (notifications endpoint removed)

// ============ SSE Endpoint ============

app.get('/sse/bookings', (req, res) => {
  // set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  // send a comment to keep connection alive initially
  res.write(': connected\n\n');

  sseClients.push(res);
  console.log('[SSE] Client connected. Total SSE clients:', sseClients.length);

  // on client disconnect, remove from list
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
    console.log('[SSE] Client disconnected. Remaining:', sseClients.length);
  });
});

// ============ Static Files & Routing ============

// Serve static files
app.use(express.static(path.join(__dirname)));

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

// Fallback: serve client index for client-side routing
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'client', 'index.html'));
  }
  // Guard: ensure next is a function before calling
  if (typeof next === 'function') return next();
  return res.end();
});

// ============ Server Start ============

app.listen(PORT, () => {
  console.log(`\n[SERVER] Listening on http://localhost:${PORT}`);
  console.log(`[SERVER] Client:  http://localhost:${PORT}`);
  console.log(`[SERVER] Admin:   http://localhost:${PORT}/admin/`);
  console.log(`[SERVER] Driver:  http://localhost:${PORT}/driver/\n`);
});
