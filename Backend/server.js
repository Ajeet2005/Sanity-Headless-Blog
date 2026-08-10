const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const dns = require('dns');
const crypto = require('crypto');
let adminApp = null;
let adminAuth = null;
let adminMessaging = null;
try {
  // firebase-admin v14 — modular subpath imports
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const { getMessaging } = require('firebase-admin/messaging');
  adminApp = { initializeApp, cert };
  adminAuth = getAuth;
  adminMessaging = getMessaging;
} catch (err) {
  console.warn('WARNING: firebase-admin is not installed. Push notifications will be disabled.');
}

// Fix for Node.js DNS resolution issues on Windows
dns.setDefaultResultOrder('ipv4first');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.set('trust proxy', 1);
app.use(cors());
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf; // used for Sanity webhook signature verification
    },
  })
);
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
//
    // Read the static post.html template
    const fs = require('fs').promises;
    let html = await fs.readFile(filePath, 'utf8');

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const imageUrl = post.ogImageUrl || post.imageUrl || `${baseUrl}/favicon.png`;
    const title = post.title || 'Blog Post';
    const description = post.excerpt || 'Read the full post on our blog.';

    const canonicalUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    // Dynamically replace empty meta tags in post.html
    html = html
      .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${escapeHtml(title)}" />`)
      .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${escapeHtml(description)}" />`)
      .replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${escapeHtml(imageUrl)}" />`)
      .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`)
      .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${escapeHtml(description)}" />`)
      .replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`)
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)} | Anubhav</title>`);

    return res.send(html);
  } catch (error) {
    console.error('Error serving dynamic meta tags for post:', error);
    return res.sendFile(filePath);
  }
});

// ── SEO: dynamically generated sitemap.xml ──
// robots.txt is a static file at Frontend/robots.txt (served by express.static)
// and points here. The sitemap is generated from Sanity so every published post
// (blog, premium, journal) is always included automatically. Private posts are
// excluded since crawlers cannot access them. Cached for 1 hour to keep Sanity
// API usage low.
app.get('/sitemap.xml', async (req, res) => {
  try {
    const PROJECT_ID = 'xsd8o1za';
    const DATASET = 'production';
    const QUERY = encodeURIComponent(`*[_type == "post" && defined(slug.current) && (!defined(isPrivate) || isPrivate != true)]{
      "slug": slug.current,
      "lastmod": coalesce(publishedAt, _updatedAt)
    }`);
    const sanityUrl = `https://${PROJECT_ID}.api.sanity.io/v2024-01-01/data/query/${DATASET}?query=${QUERY}`;

    const sanityRes = await fetch(sanityUrl);
    const sanityData = await sanityRes.json();

    if (!sanityRes.ok || sanityData.error) {
      throw new Error(sanityData.error?.description || `Sanity query failed (${sanityRes.status})`);
    }

    const posts = sanityData.result || [];
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    // Safely format lastmod to YYYY-MM-DD; skip it entirely for unparseable dates.
    const toLastmod = (d) => {
      if (!d) return '';
      const parsed = new Date(d);
      return isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
    };

    const urls = [
      { loc: `${baseUrl}/`, lastmod: '' },
      { loc: `${baseUrl}/journal.html`, lastmod: '' },
      ...posts.map((p) => ({
        loc: `${baseUrl}/post.html?slug=${encodeURIComponent(p.slug)}`,
        lastmod: toLastmod(p.lastmod),
      })),
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>\n    <loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}\n  </url>`
  )
  .join('\n')}
</urlset>`;

    res.type('application/xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (error) {
    console.error('Error generating sitemap:', error);
    res.status(500).type('text/plain').send('Error generating sitemap.');
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
  // Optional author/person reply shown inside the review card
  reply: { type: String, default: '' },
  repliedBy: { type: String, default: '' },
  repliedAt: { type: Date, default: null },
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

// ── Push Notification (FCM) Model ──
const PushRegistrationSchema = new mongoose.Schema({
  userId: { type: String, default: '', index: true }, // '' = anonymous device subscription (no login)
  email: { type: String, default: '' },
  token: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  userAgent: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
const PushRegistration = mongoose.model('PushRegistration', PushRegistrationSchema);

// ── Firebase Admin SDK (server-side only — the private key never leaves this server) ──
let fcmReady = false;

function initFirebaseAdmin() {
  if (!adminApp || fcmReady) return fcmReady;
  try {
    let serviceAccount = null;

    // Option A: full service-account JSON string in one env var
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      // Real Firebase service-account JSON uses snake_case keys ("project_id").
      // Normalize to camelCase so the readiness check below accepts it.
      if (serviceAccount && serviceAccount.project_id && !serviceAccount.projectId) {
        serviceAccount.projectId = serviceAccount.project_id;
      }
    }
    // Option B: individual fields
    else if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // dotenv converts "\n" inside double-quoted values to real newlines; safety net below
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\n/g, '\n'),
      };
    }

    if (!serviceAccount || !serviceAccount.projectId) {
      console.warn('WARNING: Firebase service-account credentials missing. Push notifications are disabled.');
      return false;
    }

    adminApp.initializeApp({ credential: adminApp.cert(serviceAccount) });
    fcmReady = true;
    console.log('Firebase Admin SDK initialized.');
    return true;
  } catch (err) {
    console.error('Error initializing Firebase Admin SDK:', err.message);
    return false;
  }
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Verifies the Firebase ID token sent by the frontend and returns the UID.
// The UID always comes from the verified token — we never trust a client-sent userId.
async function verifyFirebaseIdToken(req) {
  if (!initFirebaseAdmin()) return { error: 'not_configured' };
  const token = getBearerToken(req);
  if (!token) return { error: 'no_token' };
  try {
    const decoded = await adminAuth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email || '' };
  } catch (err) {
    return { error: 'invalid_token' };
  }
}

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

// POST /api/reviews/reply — add or update a reply on a review
// If repliedBy is 'Author' (or omitted), the frontend labels it "Replied by Author".
app.post('/api/reviews/reply', async (req, res) => {
  try {
    const { reviewId, reply, repliedBy } = req.body;

    if (!reviewId) {
      return res.status(400).json({ error: 'Review ID is required.' });
    }
    if (!reply || !String(reply).trim()) {
      return res.status(400).json({ error: 'Reply text is required.' });
    }

    const review = await Review.findById(reviewId);
    if (!review) {
      return res.status(404).json({ error: 'Review not found.' });
    }

    review.reply = String(reply).trim();
    review.repliedBy = (repliedBy || '').trim() || 'Author';
    review.repliedAt = new Date();
    await review.save();

    return res.json({ success: true, review });
  } catch (error) {
    console.error('Error saving review reply:', error);
    return res.status(500).json({ error: 'Server error saving review reply.' });
  }
});

// DELETE /api/reviews/reply — remove the reply from a review (reviewId in body)
app.delete('/api/reviews/reply', async (req, res) => {
  try {
    const { reviewId } = req.body || {};

    if (!reviewId) {
      return res.status(400).json({ error: 'Review ID is required.' });
    }

    const review = await Review.findById(reviewId);
    if (!review) {
      return res.status(404).json({ error: 'Review not found.' });
    }

    review.reply = '';
    review.repliedBy = '';
    review.repliedAt = null;
    await review.save();

    return res.json({ success: true, review });
  } catch (error) {
    console.error('Error deleting review reply:', error);
    return res.status(500).json({ error: 'Server error deleting review reply.' });
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

// DELETE /api/reviews — delete an existing review (identified by name + slug)
// Also removes the archived version history for that review.
app.delete('/api/reviews', async (req, res) => {
  try {
    const { name, slug } = req.body || {};
    const reviewerName = (name || '').trim() || 'Anonymous';

    if (!slug) {
      return res.status(400).json({ error: 'Post slug is required.' });
    }

    // Match the most recent review with this name on this post — with anonymous
    // reviewers (all named "Anonymous"), the freshest one is the safest pick.
    const existingReview = await Review.findOne({ name: reviewerName, slug }).sort({ createdAt: -1 });
    if (!existingReview) {
      return res.status(404).json({ error: 'Review not found. Please submit a new review.' });
    }

    // Remove related version history before deleting the review
    await ReviewHistory.deleteMany({ originalReviewId: existingReview._id });
    await Review.deleteOne({ _id: existingReview._id });

    console.log(`Review deleted for slug: ${slug}, name: ${reviewerName}`);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting review:', error);
    return res.status(500).json({ error: 'Server error deleting review.' });
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

// ── Push Notification (FCM) Endpoints ──

// Public, non-secret Firebase config used by the browser to set up FCM messaging.
// Includes diagnostics (no secrets): which credential mode the server sees and
// whether the Admin SDK actually initialized — lets you tell apart "env vars
// missing" from "env vars malformed" straight from the browser console.
// Public, non-secret diagnostics about the most recent Sanity webhook attempt.
// Lets you verify webhook delivery (and its exact outcome) without Render log
// access — handy because the signature error is the same for every failure mode.
let lastWebhookAttempt = null;

app.get('/api/notifications/config', (req, res) => {
  const hasServiceAccountJson = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT);
  const hasIndividualCreds = Boolean(
    process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
  );
  res.json({
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
    vapidKey: process.env.VAPID_PUBLIC_KEY || '',
    configured: Boolean(
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_MESSAGING_SENDER_ID &&
      process.env.FIREBASE_APP_ID &&
      process.env.VAPID_PUBLIC_KEY
    ),
    adminSdkReady: fcmReady,
    credentialMode: hasServiceAccountJson
      ? 'service_account_json'
      : hasIndividualCreds
      ? 'individual_fields'
      : 'missing',
    // Last Sanity webhook verification result (null if none received yet).
    webhookLastAttempt: lastWebhookAttempt,
  });
});

// POST /api/notifications/subscribe  { token }  → saves this browser's FCM registration.
// No login required: anonymous visitors can enable push notifications on their device.
// If a valid Firebase ID token is supplied, the device is additionally linked to that user.
app.post('/api/notifications/subscribe', async (req, res) => {
  try {
    if (!initFirebaseAdmin()) {
      return res.status(503).json({ error: 'Push notifications are not configured on the server yet.' });
    }

    const { token } = req.body || {};
    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ error: 'A valid FCM registration token is required.' });
    }

    const cleanToken = token.trim();

    // Optional: link the device to a signed-in user if a valid ID token is provided.
    let userId = '';
    let email = '';
    const auth = await verifyFirebaseIdToken(req);
    if (!auth.error) {
      userId = auth.uid;
      email = auth.email || '';
    }

    await PushRegistration.findOneAndUpdate(
      { token: cleanToken },
      {
        userId,
        email,
        status: 'active',
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    console.log(`FCM registration saved${userId ? ` for user ${userId}` : ' (anonymous device)'}`);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error subscribing to notifications:', error);
    return res.status(500).json({ error: 'Server error enabling notifications.' });
  }
});

// POST /api/notifications/unsubscribe  { token }  → removes this device's registration (no login required)
app.post('/api/notifications/unsubscribe', async (req, res) => {
  try {
    if (!initFirebaseAdmin()) {
      return res.status(503).json({ error: 'Push notifications are not configured on the server yet.' });
    }

    const { token } = req.body || {};
    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ error: 'A valid FCM registration token is required.' });
    }

    const result = await PushRegistration.deleteMany({ token: token.trim() });
    console.log(`FCM registration removed (${result.deletedCount} deleted)`);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error unsubscribing from notifications:', error);
    return res.status(500).json({ error: 'Server error disabling notifications.' });
  }
});

// GET /api/notifications/status?token=<fcmToken> → whether THIS device is subscribed (no login required).
// Signed-in users may omit the device token to check all registrations for their account.
app.get('/api/notifications/status', async (req, res) => {
  try {
    if (!initFirebaseAdmin()) {
      return res.status(503).json({ error: 'Push notifications are not configured on the server yet.' });
    }

    const deviceToken = String(req.query.token || '').trim();
    if (deviceToken) {
      const reg = await PushRegistration.findOne({ token: deviceToken, status: 'active' }).lean();
      return res.json({ enabled: Boolean(reg) });
    }

    // Fallback: signed-in users can check by account.
    const auth = await verifyFirebaseIdToken(req);
    if (auth.error) {
      return res.status(401).json({ error: 'A device token is required to check notification status.' });
    }
    const registrations = await PushRegistration.find({ userId: auth.uid, status: 'active' })
      .select('token -_id')
      .lean();
    return res.json({ enabled: registrations.length > 0, tokens: registrations.map((r) => r.token) });
  } catch (error) {
    console.error('Error fetching notification status:', error);
    return res.status(500).json({ error: 'Server error fetching notification status.' });
  }
});

// Verifies a request is a genuine Sanity webhook (HMAC-SHA256 over the raw body).
// Sanity signs every request with `sanity-webhook-signature: t=<ts>,v1=<hmac>`,
// where hmac = HMAC-SHA256(secret, `${timestamp}.${rawBody}`).
// Returns { valid: true } or { valid: false, reason } so failures can be logged
// with the exact cause instead of a generic "bad signature".
function verifySanityWebhook(req) {
  const secret = process.env.SANITY_WEBHOOK_SECRET;
  if (!secret) {
    return { valid: false, reason: 'SANITY_WEBHOOK_SECRET is not set on the server' };
  }

  const signatureHeader = req.headers['sanity-webhook-signature'];
  if (!signatureHeader) {
    return { valid: false, reason: 'missing sanity-webhook-signature header' };
  }
  if (!req.rawBody || req.rawBody.length === 0) {
    return { valid: false, reason: 'missing raw request body' };
  }

  try {
    const parts = {};
    signatureHeader.split(',').forEach((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return;
      parts[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    });

    const timestamp = parts['t'];
    const signature = parts['v1'];
    if (!timestamp || !signature) {
      return { valid: false, reason: 'signature header missing t= or v1= part' };
    }

    // Replay protection: Sanity signs with an epoch-millisecond timestamp.
    // Reject stale signatures (clock-skew tolerant, 5 minute window).
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
      return { valid: false, reason: 'stale signature timestamp (possible replay)' };
    }

    const signedPayload = `${timestamp}.${req.rawBody.toString('utf8')}`;
    const expectedBuf = crypto.createHmac('sha256', secret).update(signedPayload).digest(); // 32 raw bytes

    // Sanity encodes the HMAC digest as base64url WITHOUT padding (see
    // @sanity/webhook: btoa(...).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')).
    // Decoding it as hex (the common mistake) yields a different length → reject.
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(signature)) {
      return { valid: false, reason: 'signature is not valid base64url' };
    }
    const receivedBuf = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (expectedBuf.length !== receivedBuf.length) {
      return {
        valid: false,
        reason: `signature length mismatch (expected ${expectedBuf.length} bytes, got ${receivedBuf.length})`,
      };
    }
    if (!crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
      return { valid: false, reason: 'signature mismatch (secret differs from the Sanity webhook secret?)' };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `error verifying signature: ${err.message}` };
  }
}

// Builds a public Sanity CDN image URL from an image asset reference
// (e.g. "image-abc123-800x600-jpg" → https://cdn.sanity.io/images/xsd8o1za/production/abc123-800x600.jpg)
function sanityImageUrl(ref) {
  if (!ref || typeof ref !== 'string') return '';
  const m = ref.match(/^image-([A-Za-z0-9]+)-(\d+)x(\d+)-([a-z]+)$/);
  if (!m) return '';
  return `https://cdn.sanity.io/images/xsd8o1za/production/${m[1]}-${m[2]}x${m[3]}.${m[4]}`;
}

// POST /api/notifications/send → called by the Sanity webhook when a new post is published.
app.post('/api/notifications/send', async (req, res) => {
  const webhookCheck = verifySanityWebhook(req);
  if (!webhookCheck.valid) {
    // Record every attempt (no secrets) so /api/notifications/config shows the
    // last webhook outcome — useful for verifying Sanity → server delivery.
    lastWebhookAttempt = {
      at: new Date().toISOString(),
      outcome: 'rejected',
      reason: webhookCheck.reason,
    };
    console.warn(`Webhook rejected: ${webhookCheck.reason}`);
    return res.status(401).json({ error: 'Invalid webhook signature.' });
  }

  const body = req.body || {};

  // Sanity fires webhooks when a draft is saved too (document.create). Drafts have
  // _id like "drafts.<id>", and version docs use "versions.<id>". Only notify for
  // actually-published posts so writing a draft doesn't spam subscribers, and
  // publishing fires exactly one notification.
  // Checked before the Firebase check so drafts are ignored even if FCM is down.
  const docId = body._id ? String(body._id) : '';
  if (docId.startsWith('drafts.') || docId.startsWith('versions.')) {
    lastWebhookAttempt = { at: new Date().toISOString(), outcome: 'draft-skipped' };
    console.log(`Webhook ignored: draft document ${docId} (no notification sent).`);
    return res.json({ success: true, skipped: 'draft' });
  }

  if (!initFirebaseAdmin()) {
    return res.status(503).json({ error: 'Push notifications are not configured on the server yet.' });
  }

  try {
    // Notify for ALL published posts — blog, premium, journal, private — every category.
    const title = body.title || 'New Blog Published';
    const slug = (body.slug && body.slug.current) || body.slug || '';
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const postUrl = slug ? `${baseUrl}/post.html?slug=${encodeURIComponent(slug)}` : `${baseUrl}/`;

    // Rich notification: post title, excerpt as the body, and the cover image.
    const ogRef = body.ogImage && body.ogImage.asset && body.ogImage.asset._ref;
    const mainRef = body.mainImage && body.mainImage.asset && body.mainImage.asset._ref;
    const imageUrl = sanityImageUrl(ogRef || mainRef);
    const notifBody = (body.excerpt && String(body.excerpt).trim()) || 'New blog post published';

    const tokens = await PushRegistration.find({ status: 'active' }).distinct('token');

    let sent = 0;
    let failed = 0;
    const invalidTokens = [];

    for (const token of tokens) {
      // Web-only tokens: put everything in webpush.notification (a top-level
      // `notification` alongside it would conflict in FCM's validator).
      const message = {
        token,
        data: { url: postUrl, slug: String(slug) },
        webpush: {
          headers: { TTL: '604800' },
          fcmOptions: { link: postUrl },
          notification: {
            title,
            body: notifBody,
            icon: imageUrl || `${baseUrl}/favicon.png`,
            image: imageUrl || `${baseUrl}/favicon.png`,
            badge: `${baseUrl}/favicon.png`,
          },
        },
      };
      try {
        await adminMessaging().send(message);
        sent += 1;
      } catch (err) {
        failed += 1;
        const code = err.code || '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          invalidTokens.push(token);
        }
      }
    }

    if (invalidTokens.length > 0) {
      await PushRegistration.deleteMany({ token: { $in: invalidTokens } });
    }

    console.log(
      `Notification broadcast: ${sent} sent, ${failed} failed, ${invalidTokens.length} stale token(s) removed.`
    );
    lastWebhookAttempt = {
      at: new Date().toISOString(),
      outcome: 'broadcast',
      sent,
      failed,
      removed: invalidTokens.length,
    };
    return res.json({ success: true, sent, failed, removed: invalidTokens.length });
  } catch (error) {
    lastWebhookAttempt = {
      at: new Date().toISOString(),
      outcome: 'error',
      reason: String(error.message || error),
    };
    console.error('Error sending notifications:', error);
    return res.status(500).json({ error: 'Server error sending notifications.' });
  }
});
// Try to initialize Firebase Admin at boot so the startup log shows the real
// status right away (instead of only logging the first time a notification
// endpoint is hit).
const fcmBootReady = initFirebaseAdmin();
console.log(
  `Push notifications: ${fcmBootReady ? 'Firebase Admin SDK ready' : 'NOT configured (see warning/error above)'}`
);

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
});
