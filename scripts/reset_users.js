// One-off maintenance script: clear non-admin users and bookings, ensure admin user exists
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/teleka';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || (process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',')[0] : 'admin@teleka.local');
const ADMIN_PHONE = process.env.ADMIN_PHONE || '0000000000';
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD || 'admin7763';

async function run() {
  console.log('[RESET] Connecting to DB:', MONGODB_URI);
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  console.log('[RESET] Connected');

  const userSchema = new mongoose.Schema({
    name: String,
    phone: String,
    email: String,
    password: String,
    role: String
  }, { collection: 'users' });

  const bookingSchema = new mongoose.Schema({}, { strict: false, collection: 'bookings' });

  const User = mongoose.model('ResetUser', userSchema);
  const Booking = mongoose.model('ResetBooking', bookingSchema);

  try {
    const usersBefore = await User.countDocuments();
    const bookingsBefore = await Booking.countDocuments();
    console.log(`[RESET] Counts before: users=${usersBefore}, bookings=${bookingsBefore}`);

    // Delete non-admin users
    const delUsers = await User.deleteMany({ role: { $ne: 'admin' } });
    console.log(`[RESET] Deleted non-admin users: ${delUsers.deletedCount}`);

    // Delete bookings
    const delBookings = await Booking.deleteMany({});
    console.log(`[RESET] Deleted bookings: ${delBookings.deletedCount}`);

    // Ensure admin exists
    let admin = await User.findOne({ role: 'admin' });
    const hashed = await bcrypt.hash(ADMIN_PASS, 10);
    if (admin) {
      admin.email = ADMIN_EMAIL;
      admin.phone = ADMIN_PHONE;
      admin.password = hashed;
      admin.name = admin.name || 'Administrator';
      await admin.save();
      console.log('[RESET] Updated existing admin credentials:', ADMIN_EMAIL, ADMIN_PHONE);
    } else {
      admin = new User({ name: 'Administrator', email: ADMIN_EMAIL, phone: ADMIN_PHONE, password: hashed, role: 'admin' });
      await admin.save();
      console.log('[RESET] Created new admin user:', ADMIN_EMAIL, ADMIN_PHONE);
    }

    const usersAfter = await User.countDocuments();
    const bookingsAfter = await Booking.countDocuments();
    console.log(`[RESET] Counts after: users=${usersAfter}, bookings=${bookingsAfter}`);
  } catch (err) {
    console.error('[RESET] Error:', err);
    process.exitCode = 2;
  } finally {
    await mongoose.disconnect();
    console.log('[RESET] Done. Disconnected.');
  }
}

run();
