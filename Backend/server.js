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
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Intercept crawler requests for post.html to dynamically inject meta tags
app.get('/post.html', async (req, res) => {
  const { slug } = req.query;
  const filePath = path.join(__dirname, '../Frontend/post.html');

  if (!slug) {
    return res.sendFile(filePath);
  }

  try {
    const PROJECT_ID = "xsd8o1za";
    const DATASET = "production";
    const QUERY = encodeURIComponent(`*[_type == "post" && slug.current == "${slug}"][0]{
      title,
      excerpt,
      "imageUrl": mainImage.asset->url,
      "ogImageUrl": ogImage.asset->url
    }`);
    const sanityUrl = `https://${PROJECT_ID}.api.sanity.io/v2024-01-01/data/query/${DATASET}?query=${QUERY}`;

    const sanityRes = await fetch(sanityUrl);
    const sanityData = await sanityRes.json();
    const post = sanityData.result;

    if (!post) {
      return res.sendFile(filePath);
    }

    // Read the static post.html template
    const fs = require('fs').promises;
    let html = await fs.readFile(filePath, 'utf8');

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const imageUrl = post.ogImageUrl || post.imageUrl || `${baseUrl}/favicon.png`;
    const title = post.title || 'Blog Post';
    const description = post.excerpt || 'Read the full post on our blog.';

    // Dynamically replace empty meta tags in post.html
    html = html
      .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${escapeHtml(title)}" />`)
      .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${escapeHtml(description)}" />`)
      .replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${escapeHtml(imageUrl)}" />`)
      .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${escapeHtml(req.protocol + '://' + req.get('host') + req.originalUrl)}" />`);

    return res.send(html);
  } catch (error) {
    console.error('Error serving dynamic meta tags for post:', error);
    return res.sendFile(filePath);
  }
});

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

// ── Review Schema & Model ──
const ReviewSchema = new mongoose.Schema({
  name: { type: String, default: 'Anonymous' },
  rating: { type: Number, required: true, min: 1, max: 5 },
  feedback: { type: String, default: '' },
  slug: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
});

const ReviewHistorySchema = new mongoose.Schema({
  originalReviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'Review', required: true },
  name: { type: String, default: 'Anonymous' },
  rating: { type: Number, required: true },
  feedback: { type: String, default: '' },
  slug: { type: String, required: true, index: true },
  version: { type: Number, required: true },
  archivedAt: { type: Date, default: Date.now },
});

const Review = mongoose.model('Review', ReviewSchema);
const ReviewHistory = mongoose.model('ReviewHistory', ReviewHistorySchema);

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

// ── Review API Endpoints ──

// POST /api/reviews — submit a review
app.post('/api/reviews', async (req, res) => {
  try {
    const { name, rating, feedback, slug } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    }
    if (!slug) {
      return res.status(400).json({ error: 'Post slug is required.' });
    }

    const review = new Review({
      name: (name || '').trim() || 'Anonymous',
      rating: parseInt(rating, 10),
      feedback: (feedback || '').trim(),
      slug,
    });

    await review.save();
    console.log(`Review saved for slug: ${slug}`);

    return res.status(201).json({ success: true, review });
  } catch (error) {
    console.error('Error saving review:', error);
    return res.status(500).json({ error: 'Server error saving review.' });
  }
});

// GET /api/reviews?slug=xxx — fetch reviews for a post
app.get('/api/reviews', async (req, res) => {
  try {
    const { slug } = req.query;
    if (!slug) {
      return res.status(400).json({ error: 'Post slug is required.' });
    }

    const reviews = await Review.find({ slug }).sort({ createdAt: -1 });
    return res.json({ reviews });
  } catch (error) {
    console.error('Error fetching reviews:', error);
    return res.status(500).json({ error: 'Server error fetching reviews.' });
  }
});

// PUT /api/reviews — update an existing review (identified by name + slug)
// Preserves the old version in ReviewHistory before updating
app.put('/api/reviews', async (req, res) => {
  try {
    const { name, rating, feedback, slug } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    }
    if (!slug) {
      return res.status(400).json({ error: 'Post slug is required.' });
    }

    const reviewerName = (name || '').trim() || 'Anonymous';

    // Find the existing review first
    const existingReview = await Review.findOne({ name: reviewerName, slug });

    if (!existingReview) {
      return res.status(404).json({ error: 'Review not found. Please submit a new review.' });
    }

    // Count existing history entries to determine version number
    const historyCount = await ReviewHistory.countDocuments({ originalReviewId: existingReview._id });
    const version = historyCount + 1;

    // Archive the old version into history
    const oldVersion = new ReviewHistory({
      originalReviewId: existingReview._id,
      name: existingReview.name,
      rating: existingReview.rating,
      feedback: existingReview.feedback,
      slug: existingReview.slug,
      version,
    });
    await oldVersion.save();

    // Now update the review
    existingReview.rating = parseInt(rating, 10);
    existingReview.feedback = (feedback || '').trim();
    existingReview.createdAt = new Date();
    await existingReview.save();

    console.log(`Review updated for slug: ${slug}, name: ${reviewerName} (version ${version} archived)`);
    return res.json({ success: true, review: existingReview });
  } catch (error) {
    console.error('Error updating review:', error);
    return res.status(500).json({ error: 'Server error updating review.' });
  }
});

// GET /api/reviews/history?reviewId=xxx — fetch version history for a specific review
app.get('/api/reviews/history', async (req, res) => {
  try {
    const { reviewId } = req.query;
    if (!reviewId) {
      return res.status(400).json({ error: 'Review ID is required.' });
    }

    const history = await ReviewHistory.find({ originalReviewId: reviewId })
      .sort({ version: -1 });

    return res.json({ history });
  } catch (error) {
    console.error('Error fetching review history:', error);
    return res.status(500).json({ error: 'Server error fetching review history.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
});
