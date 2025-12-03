# Quick Deploy Checklist for www.telekataxi.com

## ✅ Pre-Deployment (on your local machine - Already Done)
- [x] Email functions added to server.js
- [x] sendBookingNotificationToAdmin() - sends email when client books
- [x] sendBookingConfirmationToClient() - sends email when admin confirms
- [x] nodemailer added to package.json
- [x] Old/duplicate code removed
- [x] .env has Gmail SMTP configured

## 📋 Deployment Steps (on domain server)

```bash
# 1. SSH into domain
ssh user@www.telekataxi.com

# 2. Navigate to project
cd /path/to/teleka

# 3. Update code
git pull origin main

# 4. Verify .env exists
cat .env
# Should show: MAIL_HOST=smtp.gmail.com, MAIL_USER, MAIL_PASS, etc.
# If missing, copy from local machine or create it manually

# 5. Install dependencies
npm install

# 6. Restart Node.js
pm2 restart server
# OR
sudo systemctl restart teleka
# OR
pkill -f "node server.js" && nohup node server.js > teleka.log 2>&1 &

# 7. Verify it's running
curl https://www.telekataxi.com/api/diagnostics/mail
```

## 🧪 Test Email Sending

```bash
# Send test email to admin
curl https://www.telekataxi.com/api/test/send-email

# Should respond with:
# {"success": true, "message": "Test email sent to emouisaac1@gmail.com", ...}

# Check email inbox for receipt
```

## 🔍 Debug If Not Working

```bash
# Check logs
pm2 logs server | grep mail
tail -f /var/log/teleka.log | grep mail

# Test SMTP connection
nc -zv smtp.gmail.com 587

# Verify environment variables are loaded
curl https://www.telekataxi.com/api/diagnostics/mail
```

## 📧 Expected Behavior After Deployment

### User books on web/mobile:
1. System creates booking
2. Admin email (emouisaac1@gmail.com) receives notification:
   - Subject: "New Teleka Booking — [Client Name] ([Booking ID])"
   - Body: Shows pickup, destination, booking details
   - Link to admin panel

### Admin confirms booking:
1. System marks booking as confirmed
2. Client email receives confirmation:
   - Subject: "Your Teleka booking [ID] is confirmed"
   - Body: Shows booking details
   - "Thank you, Teleka"

---

## ❌ Common Issues & Fixes

| Issue | Fix |
|-------|-----|
| `/api/diagnostics/mail` returns 404 | Old code still running. Run `git pull` and restart |
| MAIL_HOST shows "(not set)" | `.env` file missing on domain. Copy from local |
| Email send fails with "auth error" | Gmail password incorrect. Regenerate from myaccount.google.com/apppasswords |
| SMTP connection timeout | Firewall blocking port 587. Contact hosting provider |
| Emails sent to wrong address | Check ADMIN_EMAILS in .env matches the email that should receive bookings |

---

## 🎯 Success Criteria

- ✅ Server starts without errors
- ✅ `/api/diagnostics/mail` shows SMTP config (not "not set")
- ✅ `/api/test/send-email` returns success
- ✅ Email received at admin address
- ✅ Create booking → admin gets email
- ✅ Confirm booking → client gets email

