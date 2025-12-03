# Deployment Guide for Email Notifications on Domain

## Problem
- ✅ Email notifications work on **localhost:3000**
- ❌ Email notifications DO NOT work on **www.telekataxi.com**

## Root Cause
The domain server is running **old code** without the email sending functionality. You need to:

1. Deploy the latest code to the domain server
2. Ensure `.env` file exists on the domain server
3. Restart Node.js

---

## Step 1: Deploy Latest Code to Domain Server

### Option A: Using Git (Recommended)

SSH into your domain server:
```bash
ssh user@www.telekataxi.com
# or
ssh user@your-server-ip
```

Navigate to your teleka project:
```bash
cd /path/to/teleka
# Example: cd /home/teleka or cd /var/www/teleka
```

Pull the latest code:
```bash
git pull origin main
```

### Option B: Manual Upload (If Git not available)

1. Copy all files from your local `c:\Users\ISAAC E\Desktop\teleka\` to the domain server
2. Ensure these key files are uploaded:
   - `server.js` (with email functions)
   - `package.json`
   - `.env` (IMPORTANT! Copy this file!)
   - `node_modules/` folder

---

## Step 2: Verify `.env` File on Domain Server

**This is critical!** The `.env` file MUST exist on the domain server with SMTP credentials.

Check if `.env` exists:
```bash
cat /path/to/teleka/.env
```

Expected output should include:
```
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_SECURE=false
MAIL_USER=emouisaac1@gmail.com
MAIL_PASS=jngrfsnadexlroqs
MAIL_FROM="Teleka <no-reply@telekataxi.com>"
ADMIN_EMAILS=emouisaac1@gmail.com
```

If `.env` is missing or incomplete:
1. Copy `.env` from your local machine to the domain server
2. Or manually create it with the content above

---

## Step 3: Install Dependencies (if needed)

```bash
cd /path/to/teleka
npm install
```

---

## Step 4: Restart Node.js

Choose one based on how you're running Node.js:

### If using PM2:
```bash
pm2 restart server
# or if the process has a different name:
pm2 restart all
# Check logs:
pm2 logs
```

### If using systemd/systemctl:
```bash
sudo systemctl restart teleka
# Check status:
sudo systemctl status teleka
# Check logs:
sudo journalctl -u teleka -f
```

### If running Node.js directly:
```bash
# Kill the old process
pkill -f "node server.js"

# Start it again
cd /path/to/teleka
nohup node server.js > teleka.log 2>&1 &

# Check logs:
tail -f teleka.log
```

---

## Step 5: Verify It's Working

Test the diagnostic endpoint (will show if SMTP is configured):
```bash
curl https://www.telekataxi.com/api/diagnostics/mail
```

Expected response:
```json
{
  "status": "ok",
  "config": {
    "MAIL_HOST": "smtp.gmail.com",
    "MAIL_PORT": "587",
    "MAIL_USER": "***l.com",
    ...
  }
}
```

If you see `"MAIL_HOST": "(not set)"`, then `.env` is not loaded — check Step 2.

---

## Step 6: Test Email Sending

Send a test email:
```bash
curl https://www.telekataxi.com/api/test/send-email
```

Expected response:
```json
{
  "success": true,
  "message": "Test email sent to emouisaac1@gmail.com",
  "sentTo": "emouisaac1@gmail.com"
}
```

Check your email inbox for the test email.

---

## Step 7: Test Full Booking Flow

1. Open browser: `https://www.telekataxi.com`
2. Create a booking with a real email address
3. Admin should receive email notification
4. Go to admin panel and confirm the booking
5. Client should receive confirmation email

---

## Common Issues & Fixes

### Issue: MAIL_HOST is "(not set)"
**Solution:** `.env` file is missing or not in the right location. Copy it to project root.

### Issue: Email send fails with auth error
**Solution:** Gmail App Password may be wrong. Regenerate it:
1. Go to https://myaccount.google.com/apppasswords
2. Select "Mail" and "Windows Computer"
3. Copy the 16-character password (without spaces)
4. Update in `.env`: `MAIL_PASS=<new-password-without-spaces>`
5. Restart Node.js

### Issue: Email send fails with timeout/connection error
**Solution:** Firewall may be blocking port 587. Check:
```bash
# Test connection to Gmail SMTP
nc -zv smtp.gmail.com 587
# or
telnet smtp.gmail.com 587
```

If blocked, contact your hosting provider to open port 587.

### Issue: Old code still running
**Solution:** 
- Make sure you ran `git pull origin main` on the domain
- Restart Node.js completely (kill + start, not just reload)
- Check that `/api/test/send-email` endpoint exists (proves new code is running)

---

## Checklist Before Testing

- [ ] Latest code deployed to domain (`git pull` or manual upload)
- [ ] `.env` file exists on domain server
- [ ] SMTP credentials are correct (especially Gmail App Password without spaces)
- [ ] Node.js process restarted
- [ ] Can access `/api/diagnostics/mail` and see SMTP config
- [ ] Can access `/api/test/send-email` and receive test email
- [ ] Firewall allows outbound on port 587

---

## Questions?

If emails still don't work on domain:

1. Check server logs for `[mail]` errors:
   ```bash
   pm2 logs | grep mail
   # or
   tail -f teleka.log | grep mail
   ```

2. Send the output of `/api/diagnostics/mail` response

3. Send the full error from server logs

