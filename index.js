const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

// -------------------- FIREBASE --------------------
// Safety check for Firebase env variable
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT environment variable is missing!');
  process.exit(1);
}

// Parse Firebase JSON from environment variable
let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (raw.startsWith('"') && raw.endsWith('"')) {
  raw = raw.slice(1, -1).replace(/\\"/g, '"');
}
const serviceAccount = JSON.parse(raw);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'memoryretrieve.appspot.com' // <-- your bucket
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
      tls: true, // ensures secure connection
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

// Dashboard - Show all videos and detections
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
    res.render('dashboard', { videos, message: req.query.message, error: req.query.error });
  } catch (error) {
    console.error('Error loading dashboard:', error);
    res.render('dashboard', { videos: [], message: null, error: 'Failed to load data' });
  }
});

// Search for specific item
app.get('/search', async (req, res) => {
  try {
    const { item } = req.query;
    if (!item) return res.redirect('/');
    const detections = await db.collection('detections')
      .find({ item: new RegExp(item, 'i') })
      .sort({ timestamp: -1 })
      .toArray();
    res.render('search', { detections, searchTerm: item });
  } catch (error) {
    console.error('Error searching:', error);
    res.render('search', { detections: [], searchTerm: req.query.item, error: 'Search failed' });
  }
});

// View specific video with all detections
app.get('/video/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const detections = await db.collection('detections')
      .find({ videoId })
      .sort({ timestampSec: 1 })
      .toArray();

    if (detections.length === 0) return res.redirect('/?error=Video not found');

    const fileName = `videos/${videoId}.mp4`;
    const file = bucket.file(fileName);
    const [exists] = await file.exists();

    let videoUrl = '';
    if (exists) {
      await file.makePublic();
      videoUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    }

    res.render('video', { videoId, videoUrl, detections, cameraId: detections[0].cameraId });
  } catch (error) {
    console.error('Error loading video:', error);
    res.redirect('/?error=Failed to load video');
  }
});

// API - last seen
app.get('/api/last-seen/:item', async (req, res) => {
  try {
    const { item } = req.params;
    const detection = await db.collection('detections')
      .find({ item: new RegExp(item, 'i') })
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray();

    if (detection.length === 0) return res.json({ found: false, message: 'Item never detected' });
    res.json({ found: true, detection: detection[0] });
  } catch (error) {
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
  } catch (error) {
    console.error('Error logging detection:', error);
    res.status(500).json({ error: 'Failed to log detection' });
  }
});

// API - list items
app.get('/api/items', async (req, res) => {
  try {
    const items = await db.collection('detections').distinct('item');
    res.json({ items: items.sort() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get items' });
  }
});

// Delete detection entry
app.post('/delete/:id', async (req, res) => {
  try {
    await db.collection('detections').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: 'Failed to delete' });
  }
});

// -------------------- START SERVER --------------------
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Smart Camera Dashboard running on http://localhost:${PORT}`);
  });
});
