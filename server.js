const express = require('express');
const path = require('path');
const axios = require('axios');
const webpush = require('web-push');
require('dotenv').config();
const nodemailer = require('nodemailer');

// In-memory last mail attempt record (useful for diagnostics)
let lastMailAttempt = null;
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
// NOTE: This should come AFTER API routes to avoid interfering with POST/PUT/DELETE
// app.use(express.static(path.join(__dirname)));
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

function writeAtomicJson(filePath, obj) {
  try {
    try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch (e) {}
    const tmp = filePath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    const dataStr = JSON.stringify(obj, null, 2);
    fs.writeFileSync(tmp, dataStr, 'utf8');
    fs.renameSync(tmp, filePath);
    // Console-log the write for easier debugging (who/when wrote what)
    try {
      const bytes = Buffer.byteLength(dataStr, 'utf8');
      console.log('[writeAtomicJson] WROTE', path.relative(__dirname, filePath), 'bytes=', bytes, 'ts=', new Date().toISOString());
      const logLine = JSON.stringify({ ts: new Date().toISOString(), file: path.relative(__dirname, filePath), bytes });
      const logFile = path.join(__dirname, 'data', 'write_log.log');
      try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (e) {}
      fs.appendFileSync(logFile, logLine + '\n', 'utf8');
    } catch (e) { console.warn('[writeAtomicJson] logging failed', e); }
  } catch (err) {
    console.error('[writeAtomicJson] failed for', filePath, err);
    throw err;
  }
}

function writeUsers(users) {
  writeAtomicJson(USERS_FILE, users);
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

// Verify token produced by signToken(). Returns payload or null.
function verifyToken(token) {
  try {
    if (!token) return null;
    const parts = String(token).split('.');
    if (parts.length !== 2) return null;
    const b64 = parts[0];
    const sig = parts[1];
    const secret = process.env.AUTH_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
    // timingSafeEqual expects Buffers of same length
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

// Middleware to require admin token (Bearer token from /api/auth/login)
function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || req.headers.Authorization || req.headers['x-access-token'] || req.headers['x-auth-token'];
    let token = null;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    if (String(auth).startsWith('Bearer ')) token = String(auth).slice(7).trim(); else token = String(auth).trim();
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    if (payload.sub !== 'admin' && payload.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    // attach payload for downstream handlers if needed
    req.auth = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
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
  writeAtomicJson(ADMIN_FILE, admin);
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
const PUSH_FILE = path.join(__dirname, 'data', 'push_subscriptions.json');

// VAPID keys: prefer env, otherwise generate temporarily for this run and log them
let VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
if(!VAPID_PUBLIC || !VAPID_PRIVATE){
  try{
    const keys = webpush.generateVAPIDKeys();
    VAPID_PUBLIC = keys.publicKey;
    VAPID_PRIVATE = keys.privateKey;
    console.log('[webpush] Generated ephemeral VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env for persistence.');
    console.log('[webpush] VAPID_PUBLIC_KEY=' + VAPID_PUBLIC);
  }catch(e){ console.warn('[webpush] generateVAPIDKeys failed', e); }
}
try{ webpush.setVapidDetails('mailto:admin@teleka.local', VAPID_PUBLIC, VAPID_PRIVATE); }catch(e){ console.warn('[webpush] setVapidDetails failed', e); }

// Log VAPID keys at startup (helpful for setting permanent keys in .env)
if(!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY){
  console.log('[webpush] ⚠️  Ephemeral VAPID keys generated. To persist across restarts, add to .env:');
  console.log('[webpush] VAPID_PUBLIC_KEY=' + VAPID_PUBLIC);
  console.log('[webpush] VAPID_PRIVATE_KEY=' + VAPID_PRIVATE);
}

// --- Email (nodemailer) setup ---
// Email notification setup using nodemailer.
// Environment options (set in .env):
// SMTP_HOST, SMTP_PORT, SMTP_SECURE (true/false), SMTP_USER, SMTP_PASS, FROM_EMAIL, ADMIN_EMAIL, APP_BASE_URL

// Lazy-initialized transporter. If no SMTP settings are provided, an Ethereal test account
// will be created for local development and preview links will be logged.
async function _ensureTransporter() {
  if (_ensureTransporter.transporter) return _ensureTransporter.transporter;
  try {
    // Support both SMTP_* and MAIL_* env variable names
    const host = process.env.SMTP_HOST || process.env.MAIL_HOST;
    const port = process.env.SMTP_PORT || process.env.MAIL_PORT || '587';
    const secure = process.env.SMTP_SECURE || process.env.MAIL_SECURE || 'false';
    let user = process.env.SMTP_USER || process.env.MAIL_USER;
    let pass = process.env.SMTP_PASS || process.env.MAIL_PASS;
    
    // Remove spaces from Gmail App Password (Google provides them with spaces for readability)
    if (pass) pass = pass.replace(/\s+/g, '');
    
    if (host) {
      const options = {
        host: host,
        port: parseInt(port, 10),
        secure: (String(secure) === 'true'),
        // Enable nodemailer internal logger and debug output to surface SMTP issues in logs
        logger: true,
        debug: true,
        // Disable SSL verification as workaround for some network issues (can be stricter in production)
        tls: { rejectUnauthorized: false },
        // Add connection timeout to prevent hanging on network issues
        connectionTimeout: 5000,
        socketTimeout: 5000
      };
      if (user && pass) {
        options.auth = { user: user, pass: pass };
      }
      _ensureTransporter.transporter = nodemailer.createTransport(options);
      console.log('[mail] ✓ Using SMTP transport:', host + ':' + port, 'user:', user);
    } else {
      // create ethereal test account for local/dev if no SMTP configured
      const testAccount = await nodemailer.createTestAccount();
      _ensureTransporter.testAccount = testAccount;
      _ensureTransporter.transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        logger: true,
        debug: true,
        auth: { user: testAccount.user, pass: testAccount.pass }
      });
      console.log('[mail] ✓ No SMTP configured — using Ethereal test account. Preview URLs will be logged.');
    }
  } catch (e) {
    console.error('[mail] ✗ failed to create transporter:', e && e.message ? e.message : e);
    throw e;
  }
  return _ensureTransporter.transporter;
}

async function sendEmail(to, subject, text, html) {
  try {
    if (!to) {
      console.warn('[mail] sendEmail: no recipient email provided');
      return;
    }
    const transporter = await _ensureTransporter();
    const fromAddr = process.env.FROM_EMAIL || process.env.MAIL_FROM || process.env.SMTP_FROM || ('Teleka <no-reply@teleka.local>');
    
    // Verify SMTP connection is working (first time only)
    if (!_ensureTransporter.verified) {
      try {
        console.log('[mail] verifying SMTP connection...');
        await transporter.verify();
        _ensureTransporter.verified = true;
        console.log('[mail] ✓ SMTP connection verified');
      } catch (verifyErr) {
        console.error('[mail] ✗ SMTP connection verification failed:', verifyErr && verifyErr.message ? verifyErr.message : verifyErr);
        throw verifyErr;
      }
    }
    
    // Record attempt start
    const attemptStart = new Date().toISOString();
    lastMailAttempt = { time: attemptStart, to, subject, from: fromAddr, success: false, info: null, error: null };
    console.log('[mail] attempting to send:', { from: fromAddr, to, subject });
    const info = await transporter.sendMail({ from: fromAddr, to, subject, text, html });
    console.log('[mail] ✓ sent successfully', { to, subject, messageId: info.messageId });
    lastMailAttempt.success = true;
    lastMailAttempt.info = { messageId: info.messageId, response: info.response || null };
    if (_ensureTransporter.testAccount) {
      const url = nodemailer.getTestMessageUrl(info);
      if (url) console.log('[mail] preview URL:', url);
    }
    return info;
  } catch (e) {
    console.error('[mail] ✗ sendEmail FAILED:', e && e.message ? e.message : e, 'to:', to);
    try { lastMailAttempt = Object.assign(lastMailAttempt || {}, { success: false, error: (e && e.message) ? e.message : String(e) }); } catch (ex) {}
    throw e;
  }
}

function _buildBookingSummary(booking){
  return `Booking ID: ${booking._id}\nName: ${booking.name}\nPhone: ${booking.phone || 'N/A'}\nEmail: ${booking.email || 'N/A'}\nPickup: ${booking.pickup}\nDestination: ${booking.destination}\nEstimated Price: ${booking.estimatedPrice || 'N/A'}\nDate: ${booking.date || 'N/A'}\nTime: ${booking.time || 'N/A'}`;
}

async function sendBookingNotificationToAdmin(booking){
  try{
    const admin = readAdmin();
    const adminEmail = (process.env.ADMIN_EMAIL || process.env.ADMIN_EMAILS || (admin && admin.email) || 'admin@teleka.local');
    console.log('[mail:admin] admin notification triggered for booking', booking._id, 'adminEmail:', adminEmail);
    if(!adminEmail) { console.warn('[mail:admin] no admin email configured'); return; }
    const host = (booking && booking._meta && booking._meta.host) ? booking._meta.host : (process.env.APP_BASE_URL || `localhost:${PORT}`);
    const url = `http://${host}/admin`;
    const subject = `New Teleka Booking — ${booking.name} (${booking._id})`;
    const text = `A new booking was received:\n\n${_buildBookingSummary(booking)}\n\nOpen admin: ${url}`;
    const html = `<p>A new booking was received:</p><pre>${_buildBookingSummary(booking)}</pre><p><a href="${url}">Open admin</a></p>`;
    await sendEmail(adminEmail, subject, text, html);
    console.log('[mail:admin] ✓ admin notified successfully');
  }catch(e){ console.error('[mail:admin] ✗ FAILED to send admin notification:', e && e.message ? e.message : e); }
}

async function sendBookingConfirmationToClient(booking){
  try{
    if(!booking || !booking.email) { console.warn('[mail:client] no client email in booking'); return; }
    console.log('[mail:client] client notification triggered for booking', booking._id, 'clientEmail:', booking.email);
    const subject = `Your Teleka booking ${booking._id} is confirmed`;
    const text = `Hello ${booking.name || ''},\n\nYour Teleka booking (ID: ${booking._id}) from ${booking.pickup} to ${booking.destination} has been confirmed.\n\n${_buildBookingSummary(booking)}\n\nThank you,\nTeleka`;
    const html = `<p>Hello ${booking.name || ''},</p><p>Your Teleka booking (ID: ${booking._id}) has been confirmed.</p><pre>${_buildBookingSummary(booking)}</pre><p>Thank you,<br/>Teleka</p>`;
    await sendEmail(booking.email, subject, text, html);
    console.log('[mail:client] ✓ client notified successfully');
  }catch(e){ console.error('[mail:client] ✗ FAILED to send client confirmation:', e && e.message ? e.message : e); }
}

// SMS sending function
async function sendSMS(phoneNumber, message){
  try{
    if(!phoneNumber || !message) return;
    
    const provider = process.env.SMS_PROVIDER || 'africastalking';
    
    if(provider === 'africastalking'){
      return sendSMS_AfricasTalking(phoneNumber, message);
    } else if(provider === 'nexmo'){
      return sendSMS_Nexmo(phoneNumber, message);
    } else {
      console.log('[sms] (dry-run) would send SMS to', phoneNumber, 'message=', message);
      return;
    }
  }catch(e){ console.warn('[sms] sendSMS failed', e && e.message ? e.message : e); }
}

// Africa's Talking SMS implementation
async function sendSMS_AfricasTalking(phoneNumber, message){
  try{
    const apiKey = process.env.SMS_API_KEY;
    const username = process.env.SMS_USERNAME;
    const from = process.env.SMS_FROM || 'Teleka';
    
    if(!apiKey || !username){
      console.log('[sms:at] (dry-run) would send SMS to', phoneNumber, 'via Africa\'s Talking');
      return;
    }

    const response = await axios.post('https://api.africastalking.com/version1/messaging', 
      new URLSearchParams({
        username: username,
        message: message,
        recipients: phoneNumber
      }),
      {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'apiKey': apiKey
        }
      }
    );
    
    console.log('[sms:at] sent to', phoneNumber, 'response=', response.data);
    return response.data;
  }catch(e){ console.warn('[sms:at] sendSMS_AfricasTalking failed', e && e.message ? e.message : e); }
}

// Nexmo/Vonage SMS implementation
async function sendSMS_Nexmo(phoneNumber, message){
  try{
    const apiKey = process.env.SMS_API_KEY;
    const apiSecret = process.env.SMS_API_SECRET;
    const from = process.env.SMS_FROM || 'Teleka';
    
    if(!apiKey || !apiSecret){
      console.log('[sms:nexmo] (dry-run) would send SMS to', phoneNumber, 'via Nexmo');
      return;
    }

    const response = await axios.post('https://rest.nexmo.com/sms/json',
      {
        api_key: apiKey,
        api_secret: apiSecret,
        from: from,
        to: phoneNumber,
        text: message
      }
    );
    
    console.log('[sms:nexmo] sent to', phoneNumber, 'response=', response.data);
    return response.data;
  }catch(e){ console.warn('[sms:nexmo] sendSMS_Nexmo failed', e && e.message ? e.message : e); }
}

function readPushSubs(){
  try{
    if(!fs.existsSync(PUSH_FILE)){ try{ fs.mkdirSync(path.dirname(PUSH_FILE), { recursive: true }); }catch(e){}; fs.writeFileSync(PUSH_FILE, '[]', 'utf8'); }
    const raw = fs.readFileSync(PUSH_FILE, 'utf8'); return JSON.parse(raw || '[]');
  }catch(err){ console.error('[push] readPushSubs error', err); return []; }
}

function writePushSubs(list){
  try{ writeAtomicJson(PUSH_FILE, list); }catch(e){ console.error('[push] writePushSubs failed', e); }
}

// send push to subscriptions matching provided filter (matcher fn)
async function sendPushTo(filterFn, payload){
  const subs = readPushSubs();
  const toRemove = [];
  for(const s of subs){
    try{
      if(!filterFn(s)) continue;
      // log send attempt to help debug delivery issues
      try{ console.log('[push] sending to', s && s.subscription && s.subscription.endpoint ? s.subscription.endpoint : '(unknown endpoint)'); }catch(e){}
      // Ensure payload contains sensible notification options for visibility and vibration
      const defaultOptions = { vibrate: [200, 100, 200], tag: 'teleka-notify', requireInteraction: true };
      const sendPayload = Object.assign({}, payload || {});
      sendPayload.options = Object.assign({}, defaultOptions, (payload && payload.options) || {});
      // Use a short TTL for more immediate delivery behavior (adjust as needed).
      await webpush.sendNotification(s.subscription, JSON.stringify(sendPayload), { TTL: 60 });
      try{ console.log('[push] send ok to', s && s.subscription && s.subscription.endpoint ? s.subscription.endpoint : '(unknown)'); }catch(e){}
    }catch(err){
      // remove unsubscribed/expired
      const status = err && err.statusCode ? err.statusCode : null;
      if(status === 410 || status === 404) toRemove.push(s);
      console.warn('[push] send failed', err && err.message ? err.message : err, 'statusCode=', status);
    }
  }
  if(toRemove.length){
    const remaining = subs.filter(x => !toRemove.includes(x)); writePushSubs(remaining);
  }
}

function sendPushToUserByEmail(email, payload){
  if(!email) return Promise.resolve();
  return sendPushTo(s => (s.email && s.email.toLowerCase() === (email||'').toLowerCase()), payload);
}

function sendPushToRole(role, payload){
  if(!role) return Promise.resolve();
  return sendPushTo(s => (s.role === role), payload);
}

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
  writeAtomicJson(BOOKINGS_FILE, bookings);
}

// --- Server-Sent Events (SSE) support ---
// Track clients with metadata so we can target notifications to specific users or roles
const sseClients = new Map(); // res -> { role, email, bookingId }

function sendSseEvent(clientRes, event, data) {
  try {
    clientRes.write(`event: ${event}\n`);
    clientRes.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    console.warn('[sse] failed to write to client', e);
  }
}

function broadcastSse(event, data) {
  for (const res of Array.from(sseClients.keys())) {
    sendSseEvent(res, event, data);
  }
}

function sendSseTo(filterFn, event, data) {
  for (const [res, meta] of Array.from(sseClients.entries())) {
    try {
      if (filterFn(meta)) sendSseEvent(res, event, data);
    } catch (e) { /* ignore per-client errors */ }
  }
}

app.get('/api/notifications/stream', (req, res) => {
  // Allow CORS for EventSource if needed
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders && res.flushHeaders();

  // send initial comment to establish the stream
  res.write(': connected\n\n');

  // parse identifying query params if present
  const role = (req.query.role || '').toString();
  const email = (req.query.email || '').toString();
  const bookingId = (req.query.bookingId || '').toString();
  const meta = { role: role || '', email: email || '', bookingId: bookingId || '' };

  sseClients.set(res, meta);
  console.log('[sse] client connected, total=', sseClients.size, 'meta=', meta);

  // ping to keep connection alive
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) {}
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    try { res.end(); } catch (e) {}
    console.log('[sse] client disconnected, total=', sseClients.size);
  });
});

// Get all bookings
app.get('/api/bookings', (req, res) => {
  const bookings = readBookings();
  res.json(bookings);
});

// Expose VAPID public key for clients to use when subscribing
app.get('/api/push/vapidPublicKey', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC || '' });
});

// Accept push subscription from clients
app.post('/api/push/subscribe', (req, res) => {
  try{
    const sub = req.body && req.body.subscription;
    const email = req.body && req.body.email;
    const role = req.body && req.body.role; // optional: 'admin' or 'user'
    if(!sub) return res.status(400).json({ error: 'Missing subscription' });
    const list = readPushSubs();
    // prevent duplicates by endpoint
    const exists = list.find(s => s.subscription && s.subscription.endpoint === sub.endpoint);
    if(!exists){ list.push({ subscription: sub, email: email || '', role: role || '' , createdAt: new Date().toISOString() }); writePushSubs(list); }
    res.json({ success: true });
  }catch(e){ console.error('[push] subscribe failed', e); res.status(500).json({ error: 'subscribe failed' }); }
});

// Create a new booking
app.post('/api/bookings', (req, res) => {
  console.log('[bookings:post] starting handler');
  try {
    const data = req.body;
    // Log request metadata to help identify which interface handled the request
    try{ console.log('[bookings] request meta: ip=%s x-forwarded-for=%s host=%s origin=%s', req.ip, req.headers['x-forwarded-for'] || '-', req.get('host') || '-', req.headers.origin || '-'); }catch(e){}
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
      phone: data.phone || '',
      pickup: data.pickup,
      destination: data.destination,
      serviceType: data.serviceType || '',
      date: data.date || '',
      time: data.time || '',
      estimatedPrice: data.estimatedPrice || '',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      // meta: capture request context so we can trace where bookings originate
      _meta: {
        ip: req.ip || '',
        xForwardedFor: req.headers['x-forwarded-for'] || '',
        host: req.get('host') || '',
        origin: req.headers.origin || '',
        userAgent: req.headers['user-agent'] || ''
      }
    };

    bookings.unshift(newBooking);
    try {
      writeBookings(bookings);
      try{ console.log('[bookings] persisted booking count=', bookings.length, 'latestId=', newBooking._id); }catch(e){}
    } catch (writeErr) {
      console.error('[bookings] failed to persist booking', writeErr);
      return res.status(500).json({ error: 'Failed to persist booking' });
    }

    // Broadcast SSE event for new booking so connected admin/user clients can react
    try {
      broadcastSse('booking-created', { booking: newBooking });
    } catch (e) { console.warn('[sse] booking-created broadcast failed', e); }

    // Also send Web Push to admin role subscriptions
    try{
      const payload = { title: 'New Booking Received', body: `${newBooking.name} — ${newBooking.pickup} → ${newBooking.destination}`, data: { booking: newBooking, url: '/admin' } };
      sendPushToRole('admin', payload).catch(e => console.warn('[push] admin notify failed', e));
    }catch(e){ console.warn('[push] notify admin failed', e); }

    // Email: notify admin of new booking (runs async, failures are non-blocking)
    (async () => {
      try {
        await sendBookingNotificationToAdmin(newBooking);
      } catch(e) {
        console.error('[mail] admin notify flow failed:', e && e.message ? e.message : e);
      }
    })().catch(err => console.error('[mail] async admin notification error:', err));

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
      name, email: req.query.email || '', phone: req.query.phone || '', pickup, destination,
      serviceType: req.query.serviceType || '', date: req.query.date || '', time: req.query.time || '',
      estimatedPrice: req.query.estimatedPrice || '', status: 'pending', createdAt: now, updatedAt: now
    };
    bookings.unshift(newBooking);
    writeBookings(bookings);
    try{ broadcastSse('booking-created', { booking: newBooking }); } catch(e){ console.warn('[sse] create-test broadcast failed', e); }
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

// Confirm booking by id (mark status as 'confirmed')
app.post('/api/bookings/:id/confirm', (req, res) => {
  try {
    const id = req.params.id;
    const bookings = readBookings();
    const idx = bookings.findIndex(b => b._id === id);
    if (idx === -1) return res.status(404).json({ error: 'Booking not found' });
    bookings[idx].status = 'confirmed';
    bookings[idx].updatedAt = new Date().toISOString();
    writeBookings(bookings);

    // Broadcast SSE event to connected clients so users can be notified in real-time
    try {
      const payload = { booking: bookings[idx] };
      // send to all admins and to any client that identified itself with matching email or bookingId
      try { sendSseTo(m => (m && (m.role === 'admin' || (m.email && bookings[idx].email && m.email.toLowerCase() === bookings[idx].email.toLowerCase()) || (m.bookingId && m.bookingId === String(bookings[idx]._id)))), 'booking-confirmed', payload); } catch (e) { console.warn('[sse] targeted send failed', e); }
      // also broadcast to everyone as a fallback
      try { broadcastSse('booking-confirmed', payload); } catch (e) { console.warn('[sse] broadcast failed', e); }
    } catch (e) { console.warn('[sse] broadcast failed', e); }

    // send web-push to the booking owner (by email) if subscription exists
    try{
      const booking = bookings[idx];
      const payload = { title: 'Booking Confirmed', body: `${booking.name || 'Your booking'} has been confirmed`, data: { booking } };
      if(booking.email) sendPushToUserByEmail(booking.email, payload).catch(e => console.warn('[push] notify user failed', e));
    }catch(e){ console.warn('[push] notify user failed', e); }

    // Email: notify client that booking was confirmed (runs async, non-blocking)
    (async () => {
      try{
        const booking = bookings[idx];
        await sendBookingConfirmationToClient(booking);

        // Still attempt SMS and push notifications as configured
        if(booking.phone){
          const smsMsg = `Hello ${booking.name || ''},\n\nYour Teleka booking (ID: ${booking._id}) from ${booking.pickup} to ${booking.destination} has been confirmed.\n\nEstimated Price: ${booking.estimatedPrice || 'N/A'}\nDate: ${booking.date || 'N/A'}\nTime: ${booking.time || 'N/A'}\n\nThank you,\nTeleka`;
          try{ await sendSMS(booking.phone, smsMsg); console.log('[sms] confirmation SMS sent to user:', booking.phone); }catch(e){ console.error('[sms] user notify failed:', e && e.message ? e.message : e); }
        }
      }catch(e){
        console.error('[mail] notify flow failed:', e);
      }
    })().catch(err => console.error('[mail] async email handler error:', err));

    res.json(bookings[idx]);
  } catch (err) {
    console.error('[bookings] confirm error', err);
    res.status(500).json({ error: 'Failed to confirm booking' });
  }
});

// Clear-all bookings (admin) - protected: requires admin Bearer token
app.post('/api/bookings/clear-all', requireAdmin, (req, res) => {
  try {
    try{ console.log('[bookings:clear-all] requested by ip=%s host=%s x-forwarded-for=%s auth=%s', req.ip, req.get('host')||'-', req.headers['x-forwarded-for']||'-', (req.headers.authorization||'(none)').toString().slice(0,40)); }catch(e){}
    writeBookings([]);
    console.log('[bookings:clear-all] bookings cleared at', new Date().toISOString());
    res.json({ success: true });
  } catch (err) {
    console.error('[bookings:clear-all] failed to clear bookings', err);
    res.status(500).json({ error: 'Failed to clear bookings' });
  }
});

// DIAGNOSTIC endpoint - shows SMTP/mail config (helps debug domain vs localhost issues)
app.get('/api/diagnostics/mail', (req, res) => {
  try {
    const mailConfig = {
      MAIL_HOST: process.env.MAIL_HOST || '(not set)',
      MAIL_PORT: process.env.MAIL_PORT || '(not set)',
      MAIL_SECURE: process.env.MAIL_SECURE || '(not set)',
      MAIL_USER: process.env.MAIL_USER ? '***' + process.env.MAIL_USER.slice(-10) : '(not set)',
      MAIL_PASS: process.env.MAIL_PASS ? '***' : '(not set)',
      MAIL_FROM: process.env.MAIL_FROM || '(not set)',
      ADMIN_EMAILS: process.env.ADMIN_EMAILS || '(not set)',
      NODE_ENV: process.env.NODE_ENV || '(not set)',
      PORT: process.env.PORT || '(not set)',
      dotenvLoaded: !!process.env.GOOGLE_MAPS_API_KEY
    };
    console.log('[diagnostics] mail config request from', req.ip);
    res.json({ 
      status: 'ok',
      timestamp: new Date().toISOString(),
      config: mailConfig,
      message: 'If MAIL_HOST is "(not set)", the .env file is not loaded. Check that .env exists in the project root.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get diagnostics', detail: err.message });
  }
});

// Expose last mail attempt details (masked) for diagnostics
app.get('/api/diagnostics/mail-last', (req, res) => {
  try {
    if (!lastMailAttempt) return res.json({ status: 'ok', message: 'no attempts recorded yet', last: null });
    // Mask sensitive bits before returning
    const masked = Object.assign({}, lastMailAttempt);
    if (masked.from) masked.from = String(masked.from).replace(/([^<@\s>]+@)?(.+)/, '***@$2');
    if (masked.to) masked.to = String(masked.to).replace(/([^<@\s>]+@)?(.+)/, '***@$2');
    if (masked.info && masked.info.response) masked.info.response = String(masked.info.response).slice(0, 200);
    res.json({ status: 'ok', last: masked });
  } catch (err) {
    res.status(500).json({ status: 'error', error: String(err && err.message ? err.message : err) });
  }
});

// Clear all push subscriptions (useful when VAPID keys change)
app.delete('/api/push/subscriptions-clear', (req, res) => {
  try {
    writePushSubs([]);
    console.log('[push] cleared all subscriptions');
    res.json({ success: true, message: 'All push subscriptions cleared. Clients must re-subscribe.' });
  } catch (err) {
    console.error('[push] clear-subscriptions failed', err);
    res.status(500).json({ error: 'Failed to clear subscriptions' });
  }
});

// Quick test: send a test email to admin
app.get('/api/test/send-email', async (req, res) => {
  try {
    console.log('[test:email] sending test email...');
    const admin = readAdmin();
    const adminEmail = (process.env.ADMIN_EMAIL || process.env.ADMIN_EMAILS || (admin && admin.email) || 'admin@teleka.local');
    console.log('[test:email] admin email:', adminEmail);
    
    await sendEmail(adminEmail, 'Test Email from Teleka', 'This is a test email to verify SMTP is working.', '<p>This is a test email to verify SMTP is working.</p>');
    res.json({ success: true, message: 'Test email sent to ' + adminEmail, sentTo: adminEmail });
  } catch (err) {
    console.error('[test:email] failed:', err && err.message ? err.message : err);
    res.status(500).json({ success: false, error: 'Failed to send test email', detail: err && err.message ? err.message : String(err) });
  }
});

// Serve public static files from root AFTER all API routes
app.use(express.static(path.join(__dirname)));

app.listen(PORT, '0.0.0.0', () => {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.warn('\x1b[33m%s\x1b[0m', 'Warning: GOOGLE_MAPS_API_KEY environment variable is not set');
  }
  // Startup diagnostic: show email configuration status
  const emailConfigStatus = {
    MAIL_HOST: process.env.MAIL_HOST || '(not set)',
    MAIL_USER: process.env.MAIL_USER ? '***' + process.env.MAIL_USER.slice(-10) : '(not set)',
    MAIL_PASS: process.env.MAIL_PASS ? '***[' + process.env.MAIL_PASS.length + ' chars]' : '(not set)',
    ADMIN_EMAILS: process.env.ADMIN_EMAILS || '(not set)'
  };
  console.log('[startup] Email configuration:', emailConfigStatus);
  // Log VAPID key status
  console.log('[startup] Web Push VAPID:', process.env.VAPID_PUBLIC_KEY ? '✓ configured (persistent)' : '⚠️  ephemeral (generated fresh, will break existing subscriptions on restart)');
  console.log(`Teleka Taxi server running on http://0.0.0.0:${PORT} (accessible from all network interfaces)`);
  console.log(`  - Local: http://localhost:${PORT}`);
  console.log(`  - Network: http://<your-domain-or-ip>:${PORT}`);
});

// Body-parser / JSON parse error handler — return JSON with raw body snippet to aid debugging
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    console.warn('[body-parser] JSON parse error. rawBody=', (req && req.rawBody) ? req.rawBody.slice(0,200) : '<empty>');
    return res.status(400).json({ error: 'Invalid JSON payload', raw: req.rawBody ? req.rawBody.slice(0,200) : '' });
  }
  next(err);
});



