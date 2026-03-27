// Drive folder poller — scans for new client folders on a timer
// Detects when ClientSpring AI has generated new docs and queues them for onboarding

const { google } = require('googleapis');
const fs = require('fs');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function getAuth() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || './google-service-account.json';
  if (!fs.existsSync(keyPath)) return null;
  return new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

// List all subfolders in the watch folder created after a given timestamp
async function listNewFolders(watchFolderId, sinceTime) {
  const auth = getAuth();
  if (!auth) throw new Error('No service account key');

  const drive = google.drive({ version: 'v3', auth });
  const since = sinceTime.toISOString();

  const res = await drive.files.list({
    q: `'${watchFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and createdTime > '${since}' and trashed = false`,
    fields: 'files(id, name, createdTime, webViewLink)',
    orderBy: 'createdTime desc',
    pageSize: 50,
  });

  return res.data.files || [];
}

// List Google Docs inside a specific folder
async function listDocsInFolder(folderId) {
  const auth = getAuth();
  if (!auth) return [];

  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.document' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 50,
  });
  return res.data.files || [];
}

// Determine what type of folder this is based on its name and contents
function classifyFolder(folderName, docNames) {
  const name = folderName.toLowerCase();
  const docs = docNames.map(d => d.toLowerCase());

  if (name.includes('clientspring ai') || docs.some(d => d.includes('sales page copy'))) {
    return 'offer';
  }
  if (name.includes('backend engine') || docs.some(d => d.includes('upsell'))) {
    return 'backend';
  }
  if (name.includes('silent sale')) {
    return 'silentSale';
  }
  return 'unknown';
}

// Extract a client identifier from the folder name (e.g. date or client name)
function extractClientKey(folderName) {
  // "ClientSpring AI - 2026-03-25" → "2026-03-25"
  // "Backend Engine - 2026-03-25" → "2026-03-25"
  // "John Smith - ClientSpring AI" → "john-smith"
  const dateMatch = folderName.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return dateMatch[1];

  // Fall back to sanitized folder name
  return folderName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// Start polling — calls onNewClient(clientKey, folderMap) when new folders appear
// folderMap: { offer: url, backend: url, silentSale: url }
function startPoller(watchFolderId, onNewClient) {
  if (!watchFolderId) {
    console.log('⚠ WATCH_FOLDER_ID not set — Drive polling disabled');
    return;
  }

  // Track what we've seen: clientKey → { offer, backend, silentSale }
  const seen = new Map();
  let lastChecked = new Date(Date.now() - POLL_INTERVAL_MS); // look back 1 interval on startup

  async function poll() {
    try {
      const newFolders = await listNewFolders(watchFolderId, lastChecked);
      lastChecked = new Date();

      for (const folder of newFolders) {
        const docs = await listDocsInFolder(folder.id);
        const docNames = docs.map(d => d.name);
        const type = classifyFolder(folder.name, docNames);
        const clientKey = extractClientKey(folder.name);
        const folderUrl = `https://drive.google.com/drive/folders/${folder.id}`;

        if (!seen.has(clientKey)) seen.set(clientKey, {});
        const entry = seen.get(clientKey);
        entry[type] = folderUrl;
        entry.detectedAt = entry.detectedAt || new Date().toISOString();
        entry.clientKey = clientKey;

        console.log(`📁 New Drive folder detected: "${folder.name}" (${type}) → client: ${clientKey}`);

        // If we have at least an offer folder, notify
        if (entry.offer && !entry.notified) {
          entry.notified = true;
          console.log(`✅ Client "${clientKey}" has offer docs — queuing for onboarding`);
          onNewClient(clientKey, { ...entry });
        }
      }
    } catch (err) {
      console.error('Drive poll error:', err.message);
    }
  }

  // Run immediately, then on interval
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
  console.log(`📡 Drive poller started — watching folder ${watchFolderId} every ${POLL_INTERVAL_MS / 60000} min`);
}

module.exports = { startPoller };
