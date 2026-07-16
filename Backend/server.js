const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const dns = require('dns');

// Fix for Node.js DNS resolution issues on Windows
dns.setDefaultResultOrder('ipv4first');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../Frontend')));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;
if (MONGODB_URI) {
  mongoose
    .connect(MONGODB_URI)
    .then(() => console.log('Successfully connected to MongoDB.'))
    .catch((err) => console.error('MongoDB connection error:', err));
} else {
  console.warn('WARNING: MONGODB_URI environment variable is not defined. Database features will fail.');
}

// Schemas & Models
const SubscriptionSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  status: { type: String, required: true, enum: ['active', 'inactive'], default: 'active' },
  updatedAt: { type: Date, default: Date.now },
});

const PaymentSchema = new mongoose.Schema({
  pidx: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  amount: { type: Number, required: true }, // in Paisa
  status: { type: String, required: true, default: 'pending' },
  purchaseOrderId: { type: String, required: true },
  returnUrl: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const Subscription = mongoose.model('Subscription', SubscriptionSchema);
const Payment = mongoose.model('Payment', PaymentSchema);

// API Endpoints

// 1. Check Subscription Status
app.get('/api/subscription/status', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const subscription = await Subscription.findOne({ email: email.toLowerCase(), status: 'active' });
    if (subscription) {
      return res.json({ subscribed: true });
    } else {
      return res.json({ subscribed: false });
    }
  } catch (error) {
    console.error('Error checking subscription:', error);
    return res.status(500).json({ error: 'Server error checking subscription status.' });
  }
});

// 2. Initiate Payment with Khalti
app.post('/api/payment/initiate', async (req, res) => {
  try {
    const { email, amount, returnUrl } = req.body;

    if (!email || !amount || !returnUrl) {
      return res.status(400).json({ error: 'Missing required parameters (email, amount, returnUrl).' });
    }

    // Check if user is already subscribed
    const existingSub = await Subscription.findOne({ email: email.toLowerCase(), status: 'active' });
    if (existingSub) {
      return res.status(400).json({ error: 'This email already has an active subscription.' });
    }

    const purchaseOrderId = `sub_order_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
    const khaltiSecretKey = process.env.KHALTI_SECRET_KEY;
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;

    // Callback URL that Khalti redirects to
    const callbackUrl = `${baseUrl}/api/payment/callback`;

    const khaltiPayload = {
      return_url: callbackUrl,
      website_url: baseUrl,
      amount: parseInt(amount, 10), // in Paisa (e.g., 1000 paisa = 10 NPR)
      purchase_order_id: purchaseOrderId,
      purchase_order_name: 'Premium Blog Subscription',
      customer_info: {
        name: 'Subscriber',
        email: email.toLowerCase(),
      },
    };

    console.log('Initiating Khalti payment payload:', khaltiPayload);

    const khaltiResponse = await fetch('https://dev.khalti.com/api/v2/epayment/initiate/', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${khaltiSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(khaltiPayload),
    });

    const khaltiData = await khaltiResponse.json();

    if (!khaltiResponse.ok) {
      console.error('Khalti initiate API error:', khaltiData);
      return res.status(khaltiResponse.status).json({
        error: 'Khalti payment initiation failed.',
        details: khaltiData,
      });
    }

    // Save pending payment record to MongoDB
    const payment = new Payment({
      pidx: khaltiData.pidx,
      email: email.toLowerCase(),
      amount: parseInt(amount, 10),
      status: 'pending',
      purchaseOrderId,
      returnUrl,
    });
    await payment.save();

    console.log('Payment initiated successfully. pidx:', khaltiData.pidx);
    return res.json({
      pidx: khaltiData.pidx,
      payment_url: khaltiData.payment_url,
    });
  } catch (error) {
    console.error('Error initiating payment:', error);
    return res.status(500).json({ error: 'Server error initiating payment.' });
  }
});

// 3. Khalti Payment Callback
app.get('/api/payment/callback', async (req, res) => {
  try {
    const { pidx, status, purchase_order_id } = req.query;

    if (!pidx) {
      return res.status(400).send('Invalid callback request. Missing pidx.');
    }

    // Find the matching payment in our database
    const payment = await Payment.findOne({ pidx });
    if (!payment) {
      return res.status(404).send('Payment transaction not found in database.');
    }

    const returnUrlObj = new URL(payment.returnUrl);

    // Call Khalti's lookup endpoint to verify payment status
    const khaltiSecretKey = process.env.KHALTI_SECRET_KEY;
    const lookupResponse = await fetch('https://dev.khalti.com/api/v2/epayment/lookup/', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${khaltiSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pidx }),
    });

    const lookupData = await lookupResponse.json();

    if (lookupResponse.ok && lookupData.status === 'Completed') {
      // Payment verification successful
      payment.status = 'success';
      await payment.save();

      // Create or update subscription to active
      await Subscription.findOneAndUpdate(
        { email: payment.email },
        { status: 'active', updatedAt: Date.now() },
        { upsert: true, new: true }
      );

      console.log(`Payment verify success. Email ${payment.email} is now subscribed.`);

      // Redirect back to frontend page with success status
      returnUrlObj.searchParams.set('payment', 'success');
      returnUrlObj.searchParams.set('email', payment.email);
      return res.redirect(returnUrlObj.toString());
    } else {
      // Payment verification failed
      payment.status = 'failed';
      await payment.save();

      console.log(`Payment verify failed for pidx ${pidx}. Khalti status: ${lookupData.status || status}`);

      // Redirect back to frontend page with failed status
      returnUrlObj.searchParams.set('payment', 'failed');
      return res.redirect(returnUrlObj.toString());
    }
  } catch (error) {
    console.error('Error handling payment callback:', error);
    return res.status(500).send('Server error handling payment callback.');
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
});
