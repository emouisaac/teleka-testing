# Push Notification Setup & Mobile Device Guide

## Issue Found & Fixed ✅

**Root Cause**: The `web-push` package was listed in `package.json` but was **NOT imported/required** in `server.js`. This meant the server had no way to send Web Push notifications to subscribed devices.

**Fix Applied**:
- Added `const webpush = require('web-push');` at the top of `server.js` (line 5)
- Removed duplicate declaration at line 494
- Server now properly initializes VAPID details for Web Push

---

## How Push Notifications Work

### 1. **Service Worker Registration** (Automatic on page load)
   - Browser registers `/sw.js` as the service worker
   - Service worker listens for push events

### 2. **Push Subscription** (First user interaction)
   - When user clicks anywhere on the page or submits a booking
   - Browser requests notification permission (if not already granted)
   - Device generates a unique subscription endpoint
   - Subscription is sent to server and stored in `data/push_subscriptions.json`

### 3. **Booking Trigger**
   - When a new booking is created → server sends Web Push to all admin subscriptions
   - When booking is confirmed → server can send email + push notifications

### 4. **Notification Display**
   - Push arrives at device via FCM (Firebase Cloud Messaging) or browser's push service
   - Service worker receives push event and displays notification
   - Notification shows icon, title, body, and vibrate pattern

---

## Mobile Device Setup (Required for notifications)

### For **Android** Devices:

1. **Open Browser** (Chrome, Firefox, Edge, or any PWA-capable browser)
   
2. **Navigate to**: `http://<YOUR_IP>:3000`
   - Replace `<YOUR_IP>` with your server's IP address
   - Example: `http://192.168.1.100:3000`
   
3. **Wait for Permission Prompt**
   - Browser will ask: "Allow notifications?"
   - **TAP "Allow"** to enable notifications
   
4. **Keep Browser/App in Foreground**
   - First time subscription requires user interaction
   - Tap anywhere on the page if needed
   - Complete a booking to trigger subscription
   
5. **Subscribe Automatically Happens When**:
   - Page loads (if already granted permission)
   - User clicks/taps on the page
   - User submits a booking
   - Check browser console (F12 → Console tab) for `[push:user] subscribed` message

### For **iOS** Devices:

⚠️ **Important**: iOS has limited Web Push support
- Add app to home screen for better push support
- Use Safari browser
- Enable notifications when prompted
- Keep app in foreground initially

---

## Testing Push Notifications

### **Option 1: Create a Booking (Recommended)**

1. Open mobile browser to: `http://<YOUR_IP>:3000`
2. Fill booking form:
   - Name: `Test User`
   - Pickup: `Entebbe Airport`
   - Destination: `Kampala City`
3. Submit booking
4. Open **Admin Dashboard** (different device/tab)
5. Admin clicks "Confirm" button on the booking
6. **Check Mobile Device** → Should see notification with:
   - Title: "New Booking Received"
   - Body: "Test User — Entebbe Airport → Kampala City"
   - Sound effect (if enabled)
   - Vibration pattern

### **Option 2: Direct Test via Curl**

From server terminal, send test notification:

```bash
curl -X POST http://localhost:3000/api/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "pickup": "Airport",
    "destination": "City",
    "date": "2025-11-26",
    "time": "10:00 AM"
  }'
```

Then confirm it in admin panel to trigger Web Push.

---

## Troubleshooting

### **Notifications Not Arriving**

1. **Check Server Logs**:
   ```
   [push] sending to <endpoint>
   [push] send ok to <endpoint>
   ```
   Look for these messages when booking is confirmed

2. **Verify Subscription Was Saved**:
   - Check `data/push_subscriptions.json` file
   - Should contain objects with `endpoint`, `subscription`, `email`, `role`
   - If empty, service worker didn't register

3. **Check Browser Console** (F12 → Console):
   - Look for `[push:user] subscribed` message
   - If you see `[push:user] subscribe failed` → Permission denied or service worker issue

4. **Verify Permission Granted**:
   - Browser Settings → Notifications
   - Ensure `http://localhost:3000` (or your IP) is "Allowed"
   - If "Blocked", clear cache and reload

5. **Service Worker Issues**:
   - F12 → Application → Service Workers
   - Should show `/sw.js` as "Active and running"
   - If error, check browser console for SW registration errors

6. **VAPID Keys Valid**:
   - Server logs should show no `[webpush]` errors on startup
   - Check `.env` file has `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`

---

## Architecture Overview

```
Mobile Device
    ↓ (Registers service worker)
Browser (registers /sw.js)
    ↓ (User clicks → requests notification permission)
Browser (shows permission prompt)
    ↓ (User taps "Allow")
Device Push Service (FCM/APN)
    ↓ (Browser sends subscription endpoint to server)
Server (stores in push_subscriptions.json)
    ↓ (Booking created)
Admin Dashboard (clicks "Confirm")
    ↓ (Server triggers sendPushToRole/sendPushToUserByEmail)
web-push library (signs payload with VAPID keys)
    ↓ (Sends to device push service)
Device Push Service
    ↓ (Delivers to device)
Service Worker (sw.js receives push event)
    ↓ (Shows notification via self.registration.showNotification)
Mobile Device (displays notification)
    ↓ (User taps notification)
Service Worker (handles notificationclick event)
    ↓ (Opens app or focuses window)
User sees booking details
```

---

## Files Modified

- **server.js**: Added `const webpush = require('web-push');` import
- **sw.js**: Service Worker handles push events (already working)
- **.env**: Contains valid VAPID keys for push signing
- **package.json**: Contains `"web-push": "^3.5.0"` dependency

---

## Next Steps

1. **On Mobile Device**:
   - Navigate to your server URL
   - Grant notification permission when prompted
   - Test by creating a booking and confirming it from admin

2. **Monitor Server Logs**:
   - Watch for `[push] sending to` messages
   - Check for any `[push]` errors

3. **Check Subscriptions**:
   - Verify `data/push_subscriptions.json` has your device's endpoint

---

## Support

If notifications still don't arrive:
1. Check server logs for VAPID/push errors
2. Verify service worker is active in browser dev tools
3. Check device notification settings
4. Ensure you tapped "Allow" when prompted for notification permission
5. Try on desktop first to verify system is working
