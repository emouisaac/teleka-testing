const express = require('express');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

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



