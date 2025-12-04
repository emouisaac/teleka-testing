const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

console.log(`[STARTUP] PORT: ${PORT}`);
console.log(`[STARTUP] Google Maps API Key: ${GOOGLE_MAPS_API_KEY ? 'LOADED' : 'MISSING'}`);

// Middleware
app.use(express.json());

// In-memory bookings storage (in production, use a database)
const bookings = [];
let bookingIdCounter = 1000;

// Mock locations database for autocomplete
const mockLocations = [
  { description: 'Entebbe International Airport', place_id: 'entebbe_airport', lat: -0.1022, lng: 32.4428 },
  { description: 'Kampala City Centre', place_id: 'kampala_center', lat: -0.3155, lng: 32.5832 },
  { description: 'Makerere University', place_id: 'makerere_uni', lat: -0.3389, lng: 32.5733 },
  { description: 'Mulago Hospital', place_id: 'mulago_hospital', lat: -0.3256, lng: 32.5763 },
  { description: 'Kampala Road', place_id: 'kampala_road', lat: -0.3201, lng: 32.5861 },
  { description: 'Nairobi Road', place_id: 'nairobi_road', lat: -0.3156, lng: 32.5831 },
  { description: 'Jinja Road', place_id: 'jinja_road', lat: -0.3145, lng: 32.6201 },
  { description: 'Old Kampala', place_id: 'old_kampala', lat: -0.3174, lng: 32.5891 },
  { description: 'Garden City Mall', place_id: 'garden_city', lat: -0.2976, lng: 32.6007 },
  { description: 'Bugoloobi', place_id: 'bugoloobi', lat: -0.3323, lng: 32.6131 },
];

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

// API endpoint: calculate price (mock)
app.get('/api/calculate-price', (req, res) => {
  const origin = req.query.origin || '0,0';
  const destination = req.query.destination || '0,0';

  const [originLat, originLng] = origin.split(',').map(Number);
  const [destLat, destLng] = destination.split(',').map(Number);

  // Simple distance calculation (Haversine formula approximation)
  const dlat = destLat - originLat;
  const dlng = destLng - originLng;
  const distanceKm = Math.sqrt(dlat * dlat + dlng * dlng) * 111; // rough approximation

  // Mock pricing: base 5000 + 1000 per km
  const baseFare = 5000;
  const perKmRate = 1000;
  const lowPrice = Math.round(baseFare + distanceKm * perKmRate * 0.9);
  const highPrice = Math.round(baseFare + distanceKm * perKmRate * 1.1);

  res.json({
    distance: { value: distanceKm * 1000 }, // in meters
    duration: { value: Math.max(600, distanceKm * 60) }, // rough estimate in seconds
    priceRange: {
      lower: lowPrice,
      upper: highPrice
    },
    isPeakHour: false
  });
});

// API endpoint: create booking
app.post('/api/bookings', (req, res) => {
  const { pickup, destination, pickupLat, pickupLng, destLat, destLng, priceRange, clientName, clientPhone, notes, serviceType, date, time, estimatedPrice } = req.body;
  
  console.log(`[BOOKING] New booking from ${clientName} (${clientPhone})`);

  if (!pickup || !destination || !pickupLat || !pickupLng || !destLat || !destLng) {
    return res.status(400).json({ error: 'Missing required booking fields' });
  }

  const booking = {
    _id: `booking_${bookingIdCounter}`,
    id: bookingIdCounter++,
    name: clientName || 'Anonymous',
    phone: clientPhone || 'N/A',
    email: clientPhone || 'N/A',
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    status: 'pending', // pending, accepted, in-progress, completed, cancelled
    pickup: pickup,
    destination: destination,
    serviceType: serviceType || '',
    date: date || '',
    time: time || '',
    estimatedPrice: estimatedPrice || '',
    notes: notes || '',
    pickupLat: parseFloat(pickupLat),
    pickupLng: parseFloat(pickupLng),
    destLat: parseFloat(destLat),
    destLng: parseFloat(destLng),
    priceRange: priceRange || { lower: 0, upper: 0 },
    driver: null // will be assigned when driver accepts
  };

  bookings.push(booking);
  console.log(`[BOOKING] Booking ${booking.id} created. Total bookings: ${bookings.length}`);

  res.json({
    success: true,
    bookingId: booking.id,
    message: 'Booking created successfully'
  });
});

// API endpoint: get all bookings (for admin dashboard)
app.get('/api/bookings', (req, res) => {
  console.log(`[ADMIN] Fetching ${bookings.length} bookings`);
  // Return bookings array expected by the admin dashboard
  const response = bookings.map(b => ({
    _id: b._id,
    id: b.id,
    name: b.name,
    phone: b.phone,
    pickup: b.pickup,
    destination: b.destination,
    date: b.date,
    time: b.time,
    serviceType: b.serviceType,
    status: b.status,
    estimatedPrice: b.estimatedPrice,
    createdAt: b.createdAt || b.timestamp || new Date().toISOString(),
    priceRange: b.priceRange || { lower: 0, upper: 0 }
  }));

  res.json(response);
});

// API endpoint: get single booking
app.get('/api/bookings/:id', (req, res) => {
  const booking = bookings.find(b => b.id === parseInt(req.params.id));
  
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  res.json(booking);
});

// API endpoint: update booking status (for admin/driver)
app.patch('/api/bookings/:id', (req, res) => {
  const booking = bookings.find(b => b.id === parseInt(req.params.id));
  
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const { status, driver } = req.body;

  if (status) {
    booking.status = status;
    console.log(`[BOOKING] Booking ${booking.id} status updated to: ${status}`);
  }

  if (driver) {
    booking.driver = driver;
    console.log(`[BOOKING] Booking ${booking.id} assigned to driver: ${driver.name}`);
  }

  res.json({ success: true, booking });
});

// Serve static files AFTER API routes so they don't interfere
app.use(express.static(path.join(__dirname)));

// Ensure the client index is the main page for the root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

// Fallback: when a route isn't found, try to serve client index (useful for client-side routing)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'client', 'index.html'));
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Client: http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin/`);
  console.log(`Driver: http://localhost:${PORT}/driver/`);
});
