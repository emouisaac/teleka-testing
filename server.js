const express = require('express');
const path = require('path');
const axios = require('axios');
const webpush = require('web-push');
const nodemailer = require('nodemailer');
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
    let admin = readAdmin();
    // If admin exists and has credentials, leave as-is
    if(admin && admin.hash && admin.salt) return { plain: null, admin };

    // Use environment variables if provided
    if(envPass){
      const password = envPass || envPass === '' ? envPass : null;
      if(password){
        const { salt, hash } = hashPassword(password);
        admin = { id: 'admin', salt, hash, createdAt: new Date().toISOString() };
        writeAdmin(admin);
        console.log('[admin] ADMIN credentials taken from environment and stored (hashed) in data/admin.json');
        return { plain: null, admin };
      }
    }

    // If no admin file, create one with a default admin from user request
    // Default password: 'Ap.23082017.'
    const defaultPassword = 'Ap.23082017.';
    const { salt, hash } = hashPassword(defaultPassword);
    admin = { id: 'admin', salt, hash, createdAt: new Date().toISOString() };
    try { writeAdmin(admin); } catch(e) { console.error('[admin] failed to write admin file', e); }
    console.log('[admin] Admin credential created with provided default password (stored hashed)');
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
    const { name, phone, password } = req.body || {};
    if (!name || !phone || !password) return res.status(400).json({ message: 'Name, phone and password are required' });

    const users = readUsers();
    // prevent duplicate phone
    if (users.find(u => u.phone === phone)) return res.status(409).json({ message: 'Phone already registered' });

    const { salt, hash } = hashPassword(password);
    const now = new Date().toISOString();
    const newUser = {
      id: String(Date.now()),
      name: name.toString(),
      phone: phone.toString(),
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
        const adminUser = { id: 'admin', name: 'Administrator', role: 'admin', createdAt: new Date().toISOString() };
        const token = signToken({ sub: adminUser.id, role: 'admin', iat: Math.floor(Date.now()/1000) });
        return res.json({ token, user: sanitizeUser(adminUser) });
      }
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }

    const users = readUsers();
    const user = users.find(u => u.phone === id);
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
    const password = (req.query.password || '').toString();
    if (!name || !phone || !password) return res.status(400).json({ message: 'name, phone and password are required as query params' });

    const users = readUsers();
    if (users.find(u => u.phone === phone)) return res.status(409).json({ message: 'Phone already registered' });

    const { salt, hash } = hashPassword(password);
    const now = new Date().toISOString();
    const newUser = { id: String(Date.now()), name, phone, passwordHash: hash, salt, createdAt: now, updatedAt: now };
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
try{ webpush.setVapidDetails('https://teleka.local', VAPID_PUBLIC, VAPID_PRIVATE); }catch(e){ console.warn('[webpush] setVapidDetails failed', e); }

// Log VAPID keys at startup (helpful for setting permanent keys in .env)
if(!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY){
  console.log('[webpush] ⚠️  Ephemeral VAPID keys generated. To persist across restarts, add to .env:');
  console.log('[webpush] VAPID_PUBLIC_KEY=' + VAPID_PUBLIC);
  console.log('[webpush] VAPID_PRIVATE_KEY=' + VAPID_PRIVATE);
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

// --- Email sending (SMTP via nodemailer) ---
let _mailTransporter = null;
let _mailTestDone = false;

function getMailTransporter() {
  if (_mailTransporter) return _mailTransporter;
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = process.env.SMTP_SECURE === 'true' || (port === 465);

  if (!host || !user || !pass) {
    console.log('[email] SMTP not configured; running in dry-run mode. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env');
    return null;
  }

  try {
    _mailTransporter = nodemailer.createTransport({
      host,
      port: port || 587,
      secure: !!secure,
      auth: { user, pass },
      connectionUrl: `smtp${secure ? 's' : ''}://${user}:***@${host}:${port || 587}`
    });
    
    // Verify connection at first use (async, non-blocking)
    if (!_mailTestDone) {
      _mailTestDone = true;
      _mailTransporter.verify((err, success) => {
        if (err) {
          console.warn('[email] SMTP verify failed (will retry on send):', err && err.message ? err.message : err);
        } else {
          console.log('[email] ✓ SMTP connection verified');
        }
      });
    }
    
    return _mailTransporter;
  } catch (e) {
    console.error('[email] Failed to create mail transporter:', e && e.message ? e.message : e);
    return null;
  }
}

async function sendEmail(to, subject, text, html) {
  try {
    if (!to || !subject) {
      console.warn('[email] skipping: missing to or subject');
      return null;
    }
    const transporter = getMailTransporter();
    const from = process.env.EMAIL_FROM || process.env.SMTP_USER || `no-reply@${process.env.DOMAIN || 'telekataxi.com'}`;
    if (!transporter) {
      console.log('[email] (dry-run) would send email to', to, 'subject:', subject.slice(0, 50));
      return null;
    }
    console.log('[email] sending to', to, '...');
    const info = await transporter.sendMail({ from, to, subject, text, html });
    console.log('[email] ✓ SUCCESS messageId:', info && info.messageId ? info.messageId : 'unknown');
    return info;
  } catch (e) {
    console.error('[email] ✗ FAILED to send:', e && e.message ? e.message : String(e));
    if (e && e.code) console.error('[email] Error code:', e.code);
    if (e && e.response) console.error('[email] SMTP response:', e.response);
    return null; // Return null instead of throwing to prevent crash
  }
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
const sseClients = new Map(); // res -> { role, bookingId }

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
  const bookingId = (req.query.bookingId || '').toString();
  const meta = { role: role || '', bookingId: bookingId || '' };

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
    const role = req.body && req.body.role; // optional: 'admin' or 'user'
    if(!sub) return res.status(400).json({ error: 'Missing subscription' });
    const list = readPushSubs();
    // prevent duplicates by endpoint
    const exists = list.find(s => s.subscription && s.subscription.endpoint === sub.endpoint);
    if(!exists){ list.push({ subscription: sub, role: role || '' , createdAt: new Date().toISOString() }); writePushSubs(list); }
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

    // Send an email notification to admin(s)
    (async () => {
      try {
        const adminEmailsEnv = process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '';
        if (!adminEmailsEnv) {
          console.log('[email] no ADMIN_EMAIL(S) configured; skipping admin email');
          return;
        }
        const adminEmails = adminEmailsEnv.split(',').map(s => s.trim()).filter(Boolean);
        if (adminEmails.length === 0) {
          console.log('[email] ADMIN_EMAIL(S) env empty after parsing; skipping');
          return;
        }

        const subject = `New Teleka Booking: ${newBooking.name} — ${newBooking.pickup} → ${newBooking.destination}`;
        const text = `New booking received\n\nID: ${newBooking._id}\nName: ${newBooking.name}\nPhone: ${newBooking.phone || 'N/A'}\nPickup: ${newBooking.pickup}\nDestination: ${newBooking.destination}\nService: ${newBooking.serviceType || 'N/A'}\nDate: ${newBooking.date || 'N/A'}\nTime: ${newBooking.time || 'N/A'}\nEstimated Price: ${newBooking.estimatedPrice || 'N/A'}\n\nView in admin console: ${process.env.DOMAIN ? (process.env.DOMAIN.replace(/\/$/, '') + '/admin') : 'https://www.telekataxi.com/admin'}`;
        const html = `<p>New booking received</p><ul><li><strong>ID:</strong> ${newBooking._id}</li><li><strong>Name:</strong> ${newBooking.name}</li><li><strong>Phone:</strong> ${newBooking.phone || 'N/A'}</li><li><strong>Pickup:</strong> ${newBooking.pickup}</li><li><strong>Destination:</strong> ${newBooking.destination}</li><li><strong>Service:</strong> ${newBooking.serviceType || 'N/A'}</li><li><strong>Date:</strong> ${newBooking.date || 'N/A'}</li><li><strong>Time:</strong> ${newBooking.time || 'N/A'}</li><li><strong>Estimated Price:</strong> ${newBooking.estimatedPrice || 'N/A'}</li></ul><p><a href="${process.env.DOMAIN ? (process.env.DOMAIN.replace(/\/$/, '') + '/admin') : 'https://www.telekataxi.com/admin'}">Open admin console</a></p>`;

        for (const to of adminEmails) {
          try { await sendEmail(to, subject, text, html); } catch (e) { console.error('[email] failed sending to', to, e); }
        }
      } catch (e) {
        console.error('[email] admin notify flow failed', e);
      }
    })().catch(e => console.error('[email] async handler failed', e));

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
      name, phone: req.query.phone || '', pickup, destination,
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
      // send to all admins and to any client that identified itself with matching bookingId
      try { sendSseTo(m => (m && (m.role === 'admin' || (m.bookingId && m.bookingId === String(bookings[idx]._id)))), 'booking-confirmed', payload); } catch (e) { console.warn('[sse] targeted send failed', e); }
      // also broadcast to everyone as a fallback
      try { broadcastSse('booking-confirmed', payload); } catch (e) { console.warn('[sse] broadcast failed', e); }
    } catch (e) { console.warn('[sse] broadcast failed', e); }

    // SMS notifications if phone available
    (async () => {
      try{
        const booking = bookings[idx];
        if(booking.phone){
          const smsMsg = `Hello ${booking.name || ''},\n\nYour Teleka booking (ID: ${booking._id}) from ${booking.pickup} to ${booking.destination} has been confirmed.\n\nEstimated Price: ${booking.estimatedPrice || 'N/A'}\nDate: ${booking.date || 'N/A'}\nTime: ${booking.time || 'N/A'}\n\nThank you,\nTeleka`;
          try{ await sendSMS(booking.phone, smsMsg); console.log('[sms] confirmation SMS sent to user:', booking.phone); }catch(e){ console.error('[sms] user notify failed:', e && e.message ? e.message : e); }
        }
      }catch(e){
        console.error('[notify] notify flow failed:', e);
      }
    })().catch(err => console.error('[notify] async handler error:', err));

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

// Serve public static files from root AFTER all API routes
app.use(express.static(path.join(__dirname)));

app.listen(PORT, '0.0.0.0', () => {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.warn('\x1b[33m%s\x1b[0m', 'Warning: GOOGLE_MAPS_API_KEY environment variable is not set');
  }
  // Log VAPID key status
  console.log('[startup] Web Push VAPID:', process.env.VAPID_PUBLIC_KEY ? '✓ configured (persistent)' : '⚠️  ephemeral (generated fresh, will break existing subscriptions on restart)');
  // Log SMTP configuration for debugging
  console.log('[startup] SMTP:', process.env.SMTP_HOST ? `✓ ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || '587'}` : '❌ not configured');
  console.log('[startup] Admin emails:', process.env.ADMIN_EMAILS ? `✓ ${process.env.ADMIN_EMAILS}` : '❌ not configured');
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



