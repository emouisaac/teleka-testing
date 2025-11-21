const express = require('express');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies and capture the raw body for debugging
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    try { req.rawBody = buf.toString(); } catch (e) { req.rawBody = '' + buf; }
  }
}));
// Also accept URL-encoded bodies
app.use(express.urlencoded({ extended: true, verify: (req, res, buf) => { try { req.rawBody = req.rawBody || buf.toString(); } catch(e){ req.rawBody = req.rawBody || '' + buf; } } }));

// Simple request logger to help debug incoming requests
app.use((req, res, next) => {
  try {
    console.log('[req] %s %s', req.method, req.url);
  } catch (e) {}
  next();
});

// Serve static files from the root and ims directory
app.use(express.static(path.join(__dirname)));
app.use('/ims', express.static(path.join(__dirname, 'ims')));

// Fallback to index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Price calculation constants
// Adjusted for target pricing: ~UGX 29000-39000 for ~14.6km trips
const PRICE_PER_KM = 2700; // UGX per kilometer
const MIN_FARE = 10000;     // Minimum fare of 10,000 UGX
const TRAFFIC_MULTIPLIER = {
  LOW: 1.0,
  MEDIUM: 1.15,
  HIGH: 1.3
};

// Calculate price endpoint
app.get('/api/calculate-price', async (req, res) => {
  try {
    const { origin, destination } = req.query;
    
    if (!origin || !destination) {
      return res.status(400).json({ error: 'Both origin and destination are required' });
    }

    // Get route details from Google Maps Distance Matrix API
    const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
      params: {
        origins: origin,
        destinations: destination,
        key: process.env.GOOGLE_MAPS_API_KEY,
        departure_time: 'now',
        traffic_model: 'best_guess'
      }
    });

    if (response.data.status !== 'OK') {
      throw new Error('Failed to calculate distance');
    }

    const result = response.data.rows[0].elements[0];
    if (result.status !== 'OK') {
      throw new Error('No route found');
    }

    // Extract distance in kilometers and duration in minutes
    const distanceKm = result.distance.value / 1000;
    const durationMinutes = result.duration.value / 60;
    const trafficDuration = result.duration_in_traffic?.value / 60;

    // Calculate traffic multiplier
    let trafficMultiplier = TRAFFIC_MULTIPLIER.LOW;
    if (trafficDuration) {
      const trafficRatio = trafficDuration / durationMinutes;
      if (trafficRatio > 1.5) {
        trafficMultiplier = TRAFFIC_MULTIPLIER.HIGH;
      } else if (trafficRatio > 1.2) {
        trafficMultiplier = TRAFFIC_MULTIPLIER.MEDIUM;
      }
    }

    // Calculate base price (per-km rate for typical conditions)
    const raw = distanceKm * PRICE_PER_KM * trafficMultiplier;
    console.log('[price-calc] origin=%s destination=%s distance_m=%d distance_km=%.3f PRICE_PER_KM=%d trafficMultiplier=%.2f raw=%.2f',
      origin, destination, result.distance.value, distanceKm, PRICE_PER_KM, trafficMultiplier, raw);
    
    // Calculate base price (rounded to nearest 1000)
    let basePrice = Math.max(MIN_FARE, Math.round(raw / 1000) * 1000);

    // Add peak hour surcharge (7-9 AM and 5-7 PM on weekdays)
    const now = new Date();
    const hour = now.getHours();
    const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
    const isPeakHour = isWeekday && ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19));
    
    if (isPeakHour) {
      basePrice *= 1.2; // 20% peak hour surcharge
    }

    // Calculate price range: lower (with discount) and upper (standard)
    const lowerPrice = Math.round(basePrice * 0.74); // ~26% discount for lower estimate
    const upperPrice = basePrice; // Full price as upper estimate

    res.json({
      price: Math.round(basePrice),
      priceRange: {
        lower: lowerPrice,
        upper: upperPrice,
        currency: 'UGX'
      },
      distance: result.distance,
      duration: result.duration_in_traffic || result.duration,
      traffic_level: trafficMultiplier === TRAFFIC_MULTIPLIER.HIGH ? 'High' :
                    trafficMultiplier === TRAFFIC_MULTIPLIER.MEDIUM ? 'Medium' : 'Low',
      isPeakHour: isPeakHour
    });
  } catch (error) {
    console.error('Price calculation error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to calculate price' });
  }
});

// Places API proxy endpoint
app.get('/api/places/autocomplete', async (req, res) => {
  try {
    const { input, types, sessiontoken } = req.query;
    
    if (!input) {
      return res.status(400).json({ error: 'Input parameter is required' });
    }

    // First attempt: strict geocode + establishment search
    let response = await axios.get('https://maps.googleapis.com/maps/api/place/autocomplete/json', {
      params: {
        input,
        key: process.env.GOOGLE_MAPS_API_KEY,
        sessiontoken,
        components: 'country:ug', // Restrict to Uganda
        types: 'geocode|establishment',
        language: 'en'
      }
    });

    // If no results, try broader search without type restriction
    if ((!response.data.predictions || response.data.predictions.length === 0) && response.data.status === 'ZERO_RESULTS') {
      console.log(`[places/autocomplete] No results for "${input}" with strict types, retrying without type restriction...`);
      response = await axios.get('https://maps.googleapis.com/maps/api/place/autocomplete/json', {
        params: {
          input,
          key: process.env.GOOGLE_MAPS_API_KEY,
          sessiontoken,
          components: 'country:ug',
          language: 'en'
        }
      });
    }

    res.json(response.data);
  } catch (error) {
    console.error('Places API Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch places suggestions' });
  }
});

// Places details proxy endpoint
app.get('/api/places/details', async (req, res) => {
  try {
    const { place_id, sessiontoken } = req.query;
    
    if (!place_id) {
      return res.status(400).json({ error: 'place_id parameter is required' });
    }

    const response = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: {
        place_id,
        key: process.env.GOOGLE_MAPS_API_KEY,
        sessiontoken,
        fields: 'formatted_address,geometry,name,place_id,types,vicinity,rating'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Places API Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch place details' });
  }
});

// Nearby places endpoint
app.get('/api/places/nearby', async (req, res) => {
  try {
    const { location, types, sessiontoken } = req.query;
    
    if (!location) {
      return res.status(400).json({ error: 'location parameter is required' });
    }

    const [lat, lng] = location.split(',').map(Number);
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Invalid location format. Use "latitude,longitude"' });
    }

    const response = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
      params: {
        location: `${lat},${lng}`,
        radius: 500000, // 500km radius to cover entire Uganda
        type: types ? types.split('|') : undefined,
        key: process.env.GOOGLE_MAPS_API_KEY,
        sessiontoken,
        language: 'en',
        rankby: 'prominence' // Get most popular places first
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Places API Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch nearby places' });
  }
});

// --- Simple auth endpoints (file-backed) ---
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const crypto = require('crypto');

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      try { fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true }); } catch (e) {}
      fs.writeFileSync(USERS_FILE, '[]', 'utf8');
    }
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('[users] readUsers error', err);
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function hashPassword(password, salt=null) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const h = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}

function signToken(payload) {
  // simple token: base64(payload) + '.' + hmac
  const secret = process.env.AUTH_SECRET || 'dev-secret-change-me';
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString('base64');
  const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function sanitizeUser(user) {
  const u = Object.assign({}, user);
  delete u.passwordHash; delete u.salt;
  return u;
}

// --- Admin credential handling (file-backed, salted hash)
const ADMIN_FILE = path.join(__dirname, 'data', 'admin.json');

function readAdmin() {
  try {
    if (!fs.existsSync(ADMIN_FILE)) return null;
    const raw = fs.readFileSync(ADMIN_FILE, 'utf8');
    return JSON.parse(raw || 'null');
  } catch (err) {
    console.error('[admin] readAdmin error', err);
    return null;
  }
}

function writeAdmin(admin) {
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(admin, null, 2), 'utf8');
}

function ensureAdminCredential(){
  // Priority: env ADMIN_PASSWORD > existing file > generate a random password
  try{
    const envPass = process.env.ADMIN_PASSWORD;
    const envEmail = process.env.ADMIN_EMAIL;
    let admin = readAdmin();
    // If admin exists and has credentials, leave as-is
    if(admin && admin.hash && admin.salt && admin.email) return { plain: null, admin };

    // Use environment variables if provided
    if(envPass || envEmail){
      const password = envPass || envPass === '' ? envPass : null;
      const email = envEmail || '';
      if(password){
        const { salt, hash } = hashPassword(password);
        admin = { id: 'admin', email: email || 'admin@local', salt, hash, createdAt: new Date().toISOString() };
        writeAdmin(admin);
        console.log('[admin] ADMIN credentials taken from environment and stored (hashed) in data/admin.json');
        return { plain: null, admin };
      }
    }

    // If no admin file, create one with a default admin from user request
    // Default admin per request: email 'emouisaac1@gmail.com' password 'Ap.23082017.'
    const defaultEmail = 'emouisaac1@gmail.com';
    const defaultPassword = 'Ap.23082017.';
    const { salt, hash } = hashPassword(defaultPassword);
    admin = { id: 'admin', email: defaultEmail, salt, hash, createdAt: new Date().toISOString() };
    try { writeAdmin(admin); } catch(e) { console.error('[admin] failed to write admin file', e); }
    console.log('[admin] Admin credential created with provided default email and password (stored hashed)');
    return { plain: null, admin };
  }catch(err){
    console.error('[admin] ensureAdminCredential error', err);
    return { plain: null, admin: null };
  }
}

function verifyAdminPassword(password){
  try{
    const admin = readAdmin();
    if(!admin || !admin.salt || !admin.hash) return false;
    return verifyPassword(password, admin.salt, admin.hash);
  }catch(e){
    return false;
  }
}

// Ensure admin credential exists on startup
// (will be invoked after `fs` is defined to avoid module initialization order issues)

// Register
app.post('/api/auth/register', (req, res) => {
  try {
    const { name, phone, email, password } = req.body || {};
    if (!name || !phone || !password) return res.status(400).json({ message: 'Name, phone and password are required' });

    const users = readUsers();
    // prevent duplicate phone or email
    if (users.find(u => u.phone === phone)) return res.status(409).json({ message: 'Phone already registered' });
    if (email && users.find(u => u.email && u.email.toLowerCase() === (email||'').toLowerCase())) return res.status(409).json({ message: 'Email already registered' });

    const { salt, hash } = hashPassword(password);
    const now = new Date().toISOString();
    const newUser = {
      id: String(Date.now()),
      name: name.toString(),
      phone: phone.toString(),
      email: email ? email.toString().toLowerCase() : '',
      passwordHash: hash,
      salt,
      createdAt: now,
      updatedAt: now
    };
    users.push(newUser);
    writeUsers(users);

    // Optionally sign a token and return it
    const token = signToken({ sub: newUser.id, iat: Math.floor(Date.now()/1000) });
    return res.status(201).json({ message: 'Account created', token, user: sanitizeUser(newUser) });
  } catch (err) {
    console.error('[auth register] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ message: 'Registration failed' });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) return res.status(400).json({ message: 'Identifier and password are required' });

    // Allow an 'admin' identifier to authenticate against admin credential
    const id = identifier.toString();
    if(id.toLowerCase() === 'admin' || id.toLowerCase() === 'administrator'){
      if(verifyAdminPassword(password)){
        const admin = readAdmin();
        const adminEmail = admin && admin.email ? admin.email : 'admin@local';
        const adminUser = { id: 'admin', name: 'Administrator', email: adminEmail, role: 'admin', createdAt: new Date().toISOString() };
        const token = signToken({ sub: adminUser.id, role: 'admin', iat: Math.floor(Date.now()/1000) });
        return res.json({ token, user: sanitizeUser(adminUser) });
      }
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }

    // Also accept login when identifier matches admin email
    const maybeAdmin = readAdmin();
    if(maybeAdmin && maybeAdmin.email && id.toLowerCase() === (maybeAdmin.email||'').toLowerCase()){
      if(verifyAdminPassword(password)){
        const adminUser = { id: 'admin', name: 'Administrator', email: maybeAdmin.email, role: 'admin', createdAt: new Date().toISOString() };
        const token = signToken({ sub: adminUser.id, role: 'admin', iat: Math.floor(Date.now()/1000) });
        return res.json({ token, user: sanitizeUser(adminUser) });
      }
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }

    const users = readUsers();
    const user = users.find(u => u.phone === id || (u.email && u.email.toLowerCase() === id.toLowerCase()));
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    const ok = verifyPassword(password, user.salt, user.passwordHash);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    const token = signToken({ sub: user.id, iat: Math.floor(Date.now()/1000) });
    return res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('[auth login] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ message: 'Login failed' });
  }
});

// Quick test register via query params (useful from PowerShell/browser)
app.get('/api/auth/register-test', (req, res) => {
  try {
    const name = (req.query.name || '').toString();
    const phone = (req.query.phone || '').toString();
    const email = (req.query.email || '').toString();
    const password = (req.query.password || '').toString();
    if (!name || !phone || !password) return res.status(400).json({ message: 'name, phone and password are required as query params' });

    const users = readUsers();
    if (users.find(u => u.phone === phone)) return res.status(409).json({ message: 'Phone already registered' });
    if (email && users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ message: 'Email already registered' });

    const { salt, hash } = hashPassword(password);
    const now = new Date().toISOString();
    const newUser = { id: String(Date.now()), name, phone, email: email ? email.toLowerCase() : '', passwordHash: hash, salt, createdAt: now, updatedAt: now };
    users.push(newUser);
    writeUsers(users);
    const token = signToken({ sub: newUser.id, iat: Math.floor(Date.now()/1000) });
    return res.status(201).json({ message: 'Account created', token, user: sanitizeUser(newUser) });
  } catch (err) {
    console.error('[auth register-test] error', err);
    return res.status(500).json({ message: 'Registration failed' });
  }
});

// Quick test endpoint: compute price from a given distance (km) and optional traffic level
app.get('/api/price-from-distance', (req, res) => {
  try {
    const km = parseFloat(req.query.km);
    const traffic = (req.query.traffic || 'low').toLowerCase();
    if (isNaN(km) || km <= 0) return res.status(400).json({ error: 'Provide km as a positive number, e.g. ?km=65.4' });

    const trafficMultiplier = traffic === 'high' ? TRAFFIC_MULTIPLIER.HIGH : (traffic === 'medium' ? TRAFFIC_MULTIPLIER.MEDIUM : TRAFFIC_MULTIPLIER.LOW);
    const raw = km * PRICE_PER_KM * trafficMultiplier;
    const price = Math.max(MIN_FARE, Math.round(raw / 1000) * 1000);
    return res.json({ km, traffic, PRICE_PER_KM, trafficMultiplier, raw, price });
  } catch (err) {
    return res.status(500).json({ error: 'Internal' });
  }
});

// --- Bookings storage and SSE (server-sent events) ---
const fs = require('fs');
// Ensure admin credential exists on startup (fs is now available)
try{ ensureAdminCredential(); } catch(e){ console.error('[admin] ensureAdminCredential failed at startup', e); }
const BOOKINGS_FILE = path.join(__dirname, 'data', 'bookings.json');

function readBookings() {
  try {
    if (!fs.existsSync(BOOKINGS_FILE)) {
      // ensure directory exists
      try { fs.mkdirSync(path.dirname(BOOKINGS_FILE), { recursive: true }); } catch (e) {}
      fs.writeFileSync(BOOKINGS_FILE, '[]', 'utf8');
    }
    const raw = fs.readFileSync(BOOKINGS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('[bookings] readBookings error', err);
    return [];
  }
}

function writeBookings(bookings) {
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2), 'utf8');
}

// SSE clients
const sseClients = new Set();

// Get all bookings
app.get('/api/bookings', (req, res) => {
  const bookings = readBookings();
  res.json(bookings);
});

// Stream bookings via SSE for admin real-time notifications
app.get('/api/bookings/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const clientId = Date.now() + Math.random();
  const client = { id: clientId, res };
  sseClients.add(client);

  req.on('close', () => {
    sseClients.delete(client);
  });
});

// Create a new booking
app.post('/api/bookings', (req, res) => {
  try {
    const data = req.body;
    console.log('[bookings] create request body:', data);
    // Basic validation
    if (!data || typeof data !== 'object') {
      console.warn('[bookings] invalid payload');
      return res.status(400).json({ error: 'Invalid booking payload' });
    }
    const name = (data.name || '').toString().trim();
    const pickup = (data.pickup || '').toString().trim();
    const destination = (data.destination || '').toString().trim();
    if (!name || !pickup || !destination) {
      console.warn('[bookings] missing required fields', { name, pickup, destination });
      return res.status(400).json({ error: 'Missing required booking fields: name, pickup and destination are required' });
    }

    const bookings = readBookings();
    const now = new Date().toISOString();
    const newBooking = {
      _id: String(Date.now()),
      name: data.name,
      email: data.email || '',
      pickup: data.pickup,
      destination: data.destination,
      serviceType: data.serviceType || '',
      date: data.date || '',
      time: data.time || '',
      estimatedPrice: data.estimatedPrice || '',
      status: 'pending',
      createdAt: now,
      updatedAt: now
    };

    bookings.unshift(newBooking);
    try {
      writeBookings(bookings);
    } catch (writeErr) {
      console.error('[bookings] failed to persist booking', writeErr);
      return res.status(500).json({ error: 'Failed to persist booking' });
    }

    // Notify SSE clients
    const payload = JSON.stringify(newBooking);
    for (const client of sseClients) {
      try {
        client.res.write(`event: new-booking\ndata: ${payload}\n\n`);
      } catch (err) {
        // ignore write errors
      }
    }

    res.status(201).json(newBooking);
  } catch (err) {
    console.error('[bookings] unhandled error in create booking:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Failed to create booking', detail: err && err.message ? err.message : String(err) });
  }
});

// Debug helper: create booking via query params (bypass JSON body parsing issues)
app.get('/api/bookings/create-test', (req, res) => {
  try {
    const name = (req.query.name || 'Test').toString();
    const pickup = (req.query.pickup || 'X').toString();
    const destination = (req.query.destination || 'Y').toString();
    const bookings = readBookings();
    const now = new Date().toISOString();
    const newBooking = {
      _id: String(Date.now()),
      name, email: req.query.email || '', pickup, destination,
      serviceType: req.query.serviceType || '', date: req.query.date || '', time: req.query.time || '',
      estimatedPrice: req.query.estimatedPrice || '', status: 'pending', createdAt: now, updatedAt: now
    };
    bookings.unshift(newBooking);
    writeBookings(bookings);
    // notify
    const payload = JSON.stringify(newBooking);
    for (const client of sseClients) {
      try { client.res.write(`event: new-booking\ndata: ${payload}\n\n`); } catch (e) {}
    }
    res.json(newBooking);
  } catch (err) {
    console.error('[bookings debug] create-test failed', err);
    res.status(500).json({ error: 'create-test failed', detail: err && err.message });
  }
});

// Delete booking by id
app.delete('/api/bookings/:id', (req, res) => {
  try {
    const id = req.params.id;
    let bookings = readBookings();
    const idx = bookings.findIndex(b => b._id === id);
    if (idx === -1) return res.status(404).json({ error: 'Booking not found' });
    bookings.splice(idx, 1);
    writeBookings(bookings);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

// Clear-all bookings (admin)
app.post('/api/bookings/clear-all', (req, res) => {
  try {
    writeBookings([]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear bookings' });
  }
});

app.listen(PORT, () => {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.warn('\x1b[33m%s\x1b[0m', 'Warning: GOOGLE_MAPS_API_KEY environment variable is not set');
  }
  console.log(`Teleka Taxi server running on http://localhost:${PORT}`);
});

// Body-parser / JSON parse error handler — return JSON with raw body snippet to aid debugging
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    console.warn('[body-parser] JSON parse error. rawBody=', (req && req.rawBody) ? req.rawBody.slice(0,200) : '<empty>');
    return res.status(400).json({ error: 'Invalid JSON payload', raw: req.rawBody ? req.rawBody.slice(0,200) : '' });
  }
  next(err);
});



