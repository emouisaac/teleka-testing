# Teleka Taxi - Production-Ready Deployment Guide

## Overview
Teleka Taxi is a full-stack web application for airport/city ride booking with a real-time admin dashboard. The app now uses **MongoDB for persistent data storage** and **Server-Sent Events (SSE)** for real-time updates.

## Architecture
- **Frontend**: HTML5, CSS3, Vanilla JavaScript (responsive design with dark mode)
- **Backend**: Node.js + Express.js
- **Database**: MongoDB (Mongoose ODM)
- **Real-time**: Server-Sent Events (SSE)
- **Authentication**: Basic token-based (localStorage)

## Features
✅ **Persistent Data Storage** - All bookings, users, and transactions stored in MongoDB  
✅ **Real-time Dashboard** - Admin sees booking updates instantly via SSE  
✅ **Client Ride Status** - Clients see their booking status update in real-time  
✅ **User Authentication** - Registration, login, and role-based access (client/driver/admin)  
✅ **Google Maps Integration** - Place autocomplete and distance/price calculation  
✅ **Responsive Design** - Works on desktop, tablet, and mobile  
✅ **Dark Mode** - Theme toggle with persistence  

## System Requirements
- **Node.js** v14+ (tested on v18+)
- **MongoDB** v4.4+ (local or cloud)
- **Google Maps API Key** (for autocomplete & directions)
- **RAM**: 512MB minimum (1GB recommended)
- **Disk**: 1GB minimum for MongoDB data

## Installation & Setup

### 1. Prerequisites
```bash
# Install Node.js from https://nodejs.org/
# Install MongoDB from https://www.mongodb.com/try/download/community

# Verify installations
node --version
npm --version
mongod --version
```

### 2. Clone & Install Dependencies
```bash
cd "C:\Users\ISAAC E\Desktop\teleka testing app"
npm install
```

### 3. Configure Environment Variables
Edit `.env` file:
```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/teleka
GOOGLE_MAPS_API_KEY=your_actual_key_here
NODE_ENV=production
```

**For MongoDB Atlas (Cloud):**
```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/teleka?retryWrites=true&w=majority
```

### 4. Start MongoDB
```bash
# Windows (if installed locally)
mongod

# Or use MongoDB Atlas - no local setup needed
```

### 5. Run the Server
```bash
npm start
# or
node server.js
```

Server will be available at:
- Client: http://localhost:3000
- Admin: http://localhost:3000/admin/
- Driver: http://localhost:3000/driver/

## Database Schema

### Booking
```javascript
{
  _id: ObjectId,
  name: String,
  phone: String,
  email: String,
  pickup: String (required),
  destination: String (required),
  pickupLat: Number,
  pickupLng: Number,
  destLat: Number,
  destLng: Number,
  serviceType: String,
  date: String,
  time: String,
  estimatedPrice: String,
  notes: String,
  status: String (enum: pending|confirmed|completed|cancelled),
  driver: ObjectId (ref: User),
  priceRange: { lower: Number, upper: Number },
  createdAt: Date (default: now),
  updatedAt: Date (default: now)
}
```

### User
```javascript
{
  _id: ObjectId,
  name: String,
  phone: String (unique),
  email: String (unique, sparse),
  password: String (hashed with bcryptjs),
  role: String (enum: client|driver|admin, default: client),
  createdAt: Date (default: now)
}
```

## API Endpoints

### Bookings
- `POST /api/bookings` - Create booking
- `GET /api/bookings` - Get all bookings (admin)
- `GET /api/bookings/:id` - Get single booking
- `PATCH /api/bookings/:id` - Update booking status/driver
- `POST /api/bookings/:id/confirm` - Confirm booking (admin)
- `DELETE /api/bookings/:id` - Delete booking
- `POST /api/bookings/clear-all` - Clear all bookings (demo only)

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user

### Places (Google Maps)
- `GET /api/places/autocomplete?input=query` - Get place suggestions
- `GET /api/places/details?place_id=id` - Get place details (lat/lng)
- `GET /api/calculate-price?origin=lat,lng&destination=lat,lng` - Calculate ride price

### Real-time (SSE)
- `GET /sse/bookings` - Subscribe to booking events
  - Event: `booking_created` - New booking submitted
  - Event: `booking_confirmed` - Admin confirmed booking
  - Event: `booking_updated` - Booking status changed

## Production Deployment

### Option 1: Heroku
```bash
# Install Heroku CLI and login
heroku login
heroku create your-app-name
heroku addons:create mongolab:sandbox  # or use MongoDB Atlas
heroku config:set GOOGLE_MAPS_API_KEY=your_key
git push heroku main
```

### Option 2: Railway/Render/Replit
1. Connect GitHub repo
2. Set environment variables in dashboard
3. Deploy with one click

### Option 3: Self-hosted (Linux/Ubuntu)
```bash
# Install Node.js & MongoDB
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs mongodb-org

# Clone app
git clone your-repo && cd your-repo
npm install
npm start

# Use PM2 for process management
npm install -g pm2
pm2 start server.js
pm2 startup
pm2 save
```

### Option 4: Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

## Security Best Practices

⚠️ **Before Production Deployment:**

1. **Replace JWT Token Mechanism**
   - Current: Simple base64 encoding (NOT secure)
   - Recommended: Use `jsonwebtoken` package with HS256 signing
   ```bash
   npm install jsonwebtoken
   ```

2. **Add Password Reset Endpoint**
   - Implement secure email-based password reset

3. **Rate Limiting**
   ```bash
   npm install express-rate-limit
   ```

4. **CORS Configuration**
   ```javascript
   const cors = require('cors');
   app.use(cors({ origin: process.env.ALLOWED_ORIGINS }));
   ```

5. **Input Validation**
   - Add validation library: `npm install joi` or `zod`

6. **Helmet.js for Headers**
   ```bash
   npm install helmet
   app.use(helmet());
   ```

7. **Environment Variables**
   - Never commit `.env` to git
   - Use `.env.example` for documentation
   - Rotate API keys periodically

8. **SSL/TLS**
   - Use HTTPS in production (Heroku provides free SSL)
   - Force HTTPS redirect

9. **Database**
   - Enable MongoDB authentication
   - Set up automated backups
   - Use MongoDB Atlas IP whitelist

10. **API Keys**
    - Restrict Google Maps API to specific domains
    - Enable billing alerts

## Monitoring & Maintenance

### Logs
```bash
# View real-time logs
pm2 logs

# Check database
mongosh
show databases
use teleka
db.bookings.count()
```

### Performance Tips
- Index MongoDB fields: `db.bookings.createIndex({ status: 1 })`
- Enable gzip compression in Express
- Use CDN for static assets
- Cache API responses where appropriate

## Troubleshooting

### MongoDB Connection Error
```
Error: connect ECONNREFUSED 127.0.0.1:27017
```
- Ensure MongoDB is running: `mongod`
- Check `MONGODB_URI` in `.env`
- For cloud: Check IP whitelist and connection string

### SSE Not Working
- Check browser supports EventSource (all modern browsers)
- Verify proxy doesn't block streaming (nginx: `proxy_buffering off`)
- Check firewall isn't blocking connections

### Bookings Not Persisting
- Verify MongoDB connection in logs
- Check database storage space: `mongosh` → `db.stats()`

## Backup & Recovery

```bash
# Backup MongoDB
mongodump --uri="mongodb://localhost:27017/teleka" --out=./backups

# Restore MongoDB
mongorestore --uri="mongodb://localhost:27017/teleka" ./backups/teleka
```

## Version History
- **v2.0.0** - Production-ready with MongoDB persistence
- **v1.0.0** - Initial release with in-memory storage

## Support & Contribution
For bugs or features, open an issue on GitHub.

---

**Deployed by**: Teleka Taxi Team  
**Last Updated**: December 2025  
**Status**: Production Ready ✅
