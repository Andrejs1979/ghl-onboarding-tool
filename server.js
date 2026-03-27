// Web server — GHL webhook receiver + Drive poller + admin UI
require('dotenv').config();

const express = require('express');
const path = require('path');
const { onboardClient, completeSetup } = require('./onboard');
const { startPoller } = require('./poller');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory stores ───────────────────────────────────────────
const jobs    = new Map(); // jobId → job
const pending = new Map(); // clientKey → pending item

// ── Drive poller ───────────────────────────────────────────────
// Every 5 min, scans WATCH_FOLDER_ID for new client folders from ClientSpring AI
startPoller(process.env.WATCH_FOLDER_ID, (clientKey, folderMap) => {
  if (!pending.has(clientKey)) {
    pending.set(clientKey, {
      clientKey,
      detectedAt:          folderMap.detectedAt,
      offerFolderUrl:      folderMap.offer       || null,
      backendFolderUrl:    folderMap.backend      || null,
      silentSaleFolderUrl: folderMap.silentSale   || null,
      status: 'pending',
      source: 'poller',
    });
    console.log(`📥 Queued pending onboarding for: ${clientKey}`);
  }
});

// ── Admin UI ───────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── API: List pending ──────────────────────────────────────────
app.get('/api/pending', (req, res) => {
  res.json(Array.from(pending.values()));
});

// ── API: Approve + run a pending item ─────────────────────────
app.post('/api/approve/:clientKey', async (req, res) => {
  const item = pending.get(req.params.clientKey);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const clientData = { ...item, ...req.body };
  const jobId = `${req.params.clientKey}-${Date.now()}`;
  const logs = [];

  jobs.set(jobId, { status: 'running', logs, startedAt: new Date(), clientKey: req.params.clientKey });
  item.status = 'running';

  res.json({ jobId, statusUrl: `/api/status/${jobId}` });

  const logger = (msg) => { console.log(msg); logs.push({ time: new Date().toISOString(), msg }); };
  const result = await onboardClient(clientData, logger);
  // Save clientData and salesData so /api/complete can re-run steps 4-6
  jobs.set(jobId, { ...jobs.get(jobId), status: result.status, result, clientData, salesData: result.salesData, completedAt: new Date() });
  item.status = result.status;
  if (result.locationUrl) item.locationUrl = result.locationUrl;
});

// ── API: Manual onboard from web form ─────────────────────────
app.post('/api/onboard', async (req, res) => {
  const jobId = Date.now().toString();
  const logs = [];
  jobs.set(jobId, { status: 'running', logs, startedAt: new Date() });
  res.json({ jobId, statusUrl: `/api/status/${jobId}` });

  const logger = (msg) => { console.log(msg); logs.push({ time: new Date().toISOString(), msg }); };
  const result = await onboardClient(req.body, logger);
  jobs.set(jobId, { ...jobs.get(jobId), status: result.status, result, clientData: req.body, salesData: result.salesData, completedAt: new Date() });
});

// ── API: Complete setup with sub-account token ────────────────
// Called from the dashboard when Steve pastes a sub-account PIT
app.post('/api/complete/:jobId', async (req, res) => {
  const { locationToken } = req.body;
  if (!locationToken) return res.status(400).json({ error: 'locationToken required' });

  // Find the original job to get locationId, salesData, clientData
  const originalJob = jobs.get(req.params.jobId);
  if (!originalJob) return res.status(404).json({ error: 'Job not found' });

  const locationId = originalJob.result?.locationId;
  if (!locationId) return res.status(400).json({ error: 'No locationId in original job' });

  const completeJobId = `complete-${req.params.jobId}-${Date.now()}`;
  const logs = [];
  jobs.set(completeJobId, { status: 'running', logs, startedAt: new Date(), parentJobId: req.params.jobId });
  res.json({ jobId: completeJobId, statusUrl: `/api/status/${completeJobId}` });

  const logger = (msg) => { console.log(msg); logs.push({ time: new Date().toISOString(), msg }); };
  const result = await completeSetup(locationToken, locationId, {
    salesData: originalJob.salesData || originalJob.result?.salesData || {},
    clientData: originalJob.clientData || {},
  }, logger);

  jobs.set(completeJobId, { ...jobs.get(completeJobId), status: result.status, result, completedAt: new Date() });

  // Update the original job status if complete succeeded
  if (result.status === 'complete') {
    originalJob.status = 'complete';
    originalJob.result.needsLocationToken = false;
    originalJob.result.steps = [...(originalJob.result.steps || []), ...result.steps];
  }
});

// ── WEBHOOK: GHL form submission ───────────────────────────────
// GHL fires this when a client submits Steve's intake form
// Adds to pending queue — Steve reviews in /admin before running
app.post('/webhook/ghl-form', (req, res) => {
  const f = req.body;
  console.log('GHL webhook received:', JSON.stringify(f, null, 2));

  const firstName = f['First Name'] || f.first_name || '';
  const lastName  = f['Last Name']  || f.last_name  || '';
  const clientKey = f['Company Name'] || f.company_name || Date.now().toString();

  pending.set(clientKey, {
    clientKey,
    businessName:        f['Company Name']    || f.company_name,
    clientEmail:         f['Email']           || f.email,
    clientPhone:         f['Phone']           || f.phone,
    website:             f['Website']         || f.website,
    address:             f['Company Address'] || f.company_address,
    fromName:            `${firstName} ${lastName}`.trim(),
    fromEmail:           f['Email']           || f.email,
    offerFolderUrl:      f['Offer & Product Google Drive Link'] || f.offer_product_google_drive_link,
    backendFolderUrl:    f['Backend Engine Google Drive Folder'] || f.backend_engine_google_drive_folder,
    silentSaleFolderUrl: f['Silent Sale Machine Drive Folder']  || f.silent_sale_machine_drive_folder,
    domain:              f['Domain Name'] || f.domain_name,
    price:               f['Price']       || f.price,
    vslLink:             f['VSL Link']    || f.vsl_link,
    detectedAt:          new Date().toISOString(),
    status:              'pending',
    source:              'webhook',
  });

  res.json({ received: true, clientKey, reviewUrl: '/admin' });
});

// ── API: Job status ────────────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── API: List jobs ─────────────────────────────────────────────
app.get('/api/jobs', (req, res) => {
  const list = Array.from(jobs.entries()).map(([id, job]) => ({
    id, status: job.status, clientKey: job.clientKey,
    startedAt: job.startedAt, completedAt: job.completedAt,
    locationUrl: job.result?.locationUrl,
  }));
  res.json(list.reverse());
});

app.listen(PORT, () => {
  console.log(`\nGHL Onboarding Tool running at http://localhost:${PORT}`);
  console.log(`Admin panel:  http://localhost:${PORT}/admin`);
  console.log(`Webhook URL:  POST http://YOUR_DOMAIN:${PORT}/webhook/ghl-form\n`);
});
