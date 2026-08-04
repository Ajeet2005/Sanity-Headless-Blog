/* Temporary cleanup — removes duplicate & test push registrations.
   Keeps: newest Chrome/Windows, newest iPhone, the Android.
   Deletes: all other active registrations (older PCs, older iPhones, HeadlessChrome test browsers). */
require('dotenv').config();
const mongoose = require('mongoose');

function classify(ua) {
  const u = String(ua || '');
  if (/HeadlessChrome/i.test(u)) return 'test-browser';
  if (/iPhone|iPad|iPod/i.test(u)) return 'iphone';
  if (/Android/i.test(u)) return 'android';
  if (/Chrome/i.test(u)) return 'chrome-pc';
  if (/Edg\//i.test(u)) return 'edge-pc';
  return 'other';
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const col = mongoose.connection.db.collection('pushregistrations');

  const regs = await col.find({ status: 'active' }).toArray();

  // Choose keepers: newest per chosen class
  const keepClasses = { 'chrome-pc': 1, iphone: 1, android: 1 };
  const keepTokens = new Set();

  const newest = {};
  for (const r of regs) {
    const cls = classify(r.userAgent);
    if (keepClasses[cls]) {
      const t = String(r.updatedAt.getTime());
      if (!newest[cls] || t > newest[cls].t) {
        newest[cls] = { t, token: r.token };
      }
    }
  }
  for (const cls of Object.keys(newest)) keepTokens.add(newest[cls].token);

  const toDelete = regs.filter((r) => !keepTokens.has(r.token));
  const kept = regs.filter((r) => keepTokens.has(r.token));

  console.log('=== KEEPING ===');
  for (const r of kept) {
    console.log(`  ${classify(r.userAgent).padEnd(10)} | ${String(r.token).slice(0, 12)}...${String(r.token).slice(-5)} | ${String(r.userAgent).replace(/\s+/g, ' ').slice(0, 90)}`);
  }

  console.log(`\n=== DELETING (${toDelete.length}) ===`);
  for (const r of toDelete) {
    console.log(`  ${classify(r.userAgent).padEnd(12)} | ${String(r.token).slice(0, 12)}...${String(r.token).slice(-5)} | ${String(r.userAgent).replace(/\s+/g, ' ').slice(0, 90)}`);
  }

  if (toDelete.length > 0) {
    const ids = toDelete.map((r) => r._id);
    const res = await col.deleteMany({ _id: { $in: ids } });
    console.log(`\nDeleted ${res.deletedCount} registrations.`);
  } else {
    console.log('\nNothing to delete.');
  }

  const remaining = await col.countDocuments({ status: 'active' });
  console.log(`Active registrations remaining: ${remaining}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
//