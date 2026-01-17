const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // ensures Express finds your EJS files

// -------------------- FIREBASE --------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT environment variable is missing!');
  process.exit(1);
}

let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (raw.startsWith('"') && raw.endsWith('"')) {
  raw = raw.slice(1, -1).replace(/\\"/g, '"');
}
const serviceAccount = JSON.parse(raw);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'memoryretrieve.appspot.com'
});
const bucket = admin.storage().bucket();

// -------------------- MONGODB --------------------
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'memoryretrieve';
let db;

async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      tls: true
    });
    await client.connect();
    db = client.db(DB_NAME);
    console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
  }
}

// -------------------- ROUTES --------------------

// Home - show detections grouped by video
app.get('/', async (req, res) => {
  try {
    const detections = await db.collection('detections')
      .find()
      .sort({ timestamp: -1 })
      .toArray();

    const videoMap = {};
    detections.forEach(det => {
      if (!videoMap[det.videoId]) {
        videoMap[det.videoId] = { videoId: det.videoId, cameraId: det.cameraId, detections: [] };
      }
      videoMap[det.videoId].detections.push(det);
    });

    const videos = Object.values(videoMap);
    // Use 'index.ejs' instead of 'dashboard.ejs'
    res.render('index', { videos, message: req.query.message, error: req.query.error });
  } catch (err) {
    console.error('Error loading home page:', err);
    res.render('index', { videos: [], message: null, error: 'Failed to load data' });
  }
});

// Search
app.get('/search', async (req, res) => {
  try {
    const { item } = req.query;
    if (!item) return res.redirect('/');
    const detections = await db.collection('detections')
      .find({ item: new RegExp(item, 'i') })
      .sort({ timestamp: -1 })
      .toArray();
    res.render('index', { videos: detections, message: null, error: null, searchTerm: item });
  } catch (err) {
    console.error('Search error:', err);
    res.render('index', { videos: [], message: null, error: 'Search failed', searchTerm: req.query.item });
  }
});

// API - last seen
app.get('/api/last-seen/:item', async (req, res) => {
  try {
    const detection = await db.collection('detections')
      .find({ item: new RegExp(req.params.item, 'i') })
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray();
    if (detection.length === 0) return res.json({ found: false, message: 'Item never detected' });
    res.json({ found: true, detection: detection[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to search' });
  }
});

// API - log detection
app.post('/api/detection', async (req, res) => {
  try {
    const { cameraId, videoId, item, confidence, timestamp, timestampSec } = req.body;
    if (!cameraId || !videoId || !item || !confidence || !timestamp || timestampSec === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    await db.collection('detections').insertOne({
      cameraId,
      videoId,
      item,
      confidence: parseFloat(confidence),
      timestamp: new Date(timestamp),
      timestampSec: parseInt(timestampSec),
      createdAt: new Date()
    });
    res.json({ success: true, message: 'Detection logged' });
  } catch (err) {
    console.error('Error logging detection:', err);
    res.status(500).json({ error: 'Failed to log detection' });
  }
});

// API - list items
app.get('/api/items', async (req, res) => {
  try {
    const items = await db.collection('detections').distinct('item');
    res.json({ items: items.sort() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get items' });
  }
});

// Delete detection
app.post('/delete/:id', async (req, res) => {
  try {
    await db.collection('detections').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: 'Failed to delete' });
  }
});

// -------------------- START SERVER --------------------
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Smart Camera Dashboard running on http://localhost:${PORT}`);
  });
});
