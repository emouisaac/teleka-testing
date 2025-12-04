const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

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
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: dbStatus,
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

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Identifier and password are required' });
  }

  try {
    // Find user by phone, email, or name (admin id)
    const user = await User.findOne({ 
      $or: [
        { phone: identifier }, 
        { email: identifier },
        { name: identifier }
      ] 
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Compare password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create JWT token
    const token = jwt.sign(
      { id: user._id.toString(), phone: user.phone, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    console.log(`[AUTH] User logged in: ${user.phone} (${user.role})`);

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
    console.error('[AUTH] Login error:', error.message);
    res.status(500).json({ error: error.message });
  }
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
    const adminPhone = process.env.ADMIN_PHONE || '0000000000';

    let admin = await User.findOne({ role: 'admin' });
    if (!admin) {
      admin = new User({ name: 'admin', phone: adminPhone, email: adminEmail, password: adminPass, role: 'admin' });
      await admin.save();
      console.log('[MAINT] Created new admin user:', adminEmail, adminPhone);
    } else {
      // update admin password (will be hashed by pre-save)
      admin.password = adminPass;
      admin.email = admin.email || adminEmail;
      admin.phone = admin.phone || adminPhone;
      await admin.save();
      console.log('[MAINT] Updated existing admin credentials.');
    }

    return res.json({
      success: true,
      deletedUsers: delUsers.deletedCount != null ? delUsers.deletedCount : delUsers.n || 0,
      deletedBookings: delBookings.deletedCount != null ? delBookings.deletedCount : delBookings.n || 0,
      admin: { email: admin.email, phone: admin.phone }
    });
  } catch (err) {
    console.error('[MAINT] Cleanup error:', err.stack || err.message || err);
    return res.status(500).json({ error: (err && err.message) || 'Cleanup failed' });
  }
});

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
