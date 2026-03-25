// Web server — provides a UI form + GHL webhook receiver + status dashboard
require('dotenv').config();

const express = require('express');
const path = require('path');
const { onboardClient } = require('./onboard');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory job log (replace with DB for production)
const jobs = new Map();

// ── UI: Main form ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── API: Start onboarding from web form ───────────────────────
app.post('/api/onboard', async (req, res) => {
  const jobId = Date.now().toString();
  const clientData = req.body;
  const logs = [];

  jobs.set(jobId, { status: 'running', logs, startedAt: new Date() });

  // Kick off async — respond immediately with jobId
  res.json({ jobId, message: 'Onboarding started', statusUrl: `/api/status/${jobId}` });

  const logger = (msg) => {
    console.log(msg);
    logs.push({ time: new Date().toISOString(), msg });
  };

  const result = await onboardClient(clientData, logger);
  jobs.set(jobId, { ...jobs.get(jobId), status: result.status, result, completedAt: new Date() });
});

// ── WEBHOOK: Receive GHL form submission ──────────────────────
// Point your GHL form's webhook to: POST /webhook/ghl-form
app.post('/webhook/ghl-form', async (req, res) => {
  const formData = req.body;
  console.log('GHL Form webhook received:', JSON.stringify(formData, null, 2));

  // Map GHL form field names to our client data structure
  // Adjust field names to match your actual GHL form fields
  const clientData = {
    businessName: formData['Business Name'] || formData.business_name || formData.businessName,
    clientEmail: formData['Email'] || formData.email || formData.clientEmail,
    clientPhone: formData['Phone'] || formData.phone || formData.clientPhone,
    website: formData['Website'] || formData.website,
    domain: formData['Domain'] || formData.domain,
    timezone: formData['Timezone'] || formData.timezone || 'America/New_York',
    salesCopyDocUrl: formData['Sales Copy Doc'] || formData.sales_copy_doc,
    productName: formData['Product Name'] || formData.product_name,
    productPrice: formData['Product Price'] || formData.product_price,
    productDescription: formData['Product Description'] || formData.product_description,
    downloadUrl: formData['Download URL'] || formData.download_url,
    upsell1Name: formData['Upsell 1 Name'] || formData.upsell1_name,
    upsell1Price: formData['Upsell 1 Price'] || formData.upsell1_price,
    upsell1DownloadUrl: formData['Upsell 1 Download URL'] || formData.upsell1_download_url,
    upsell2Name: formData['Upsell 2 Name'] || formData.upsell2_name,
    upsell2Price: formData['Upsell 2 Price'] || formData.upsell2_price,
    upsell2DownloadUrl: formData['Upsell 2 Download URL'] || formData.upsell2_download_url,
    fromName: formData['From Name'] || formData.from_name,
    fromEmail: formData['From Email'] || formData.from_email,
    address: formData['Address'] || formData.address,
    city: formData['City'] || formData.city,
    state: formData['State'] || formData.state,
    postalCode: formData['Postal Code'] || formData.postal_code,
  };

  const jobId = Date.now().toString();
  const logs = [];
  jobs.set(jobId, { status: 'running', logs, startedAt: new Date(), source: 'webhook', rawData: formData });

  res.json({ received: true, jobId });

  const result = await onboardClient(clientData, (msg) => logs.push({ time: new Date().toISOString(), msg }));
  jobs.set(jobId, { ...jobs.get(jobId), status: result.status, result, completedAt: new Date() });
});

// ── API: Check job status ─────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── API: List all jobs ────────────────────────────────────────
app.get('/api/jobs', (req, res) => {
  const list = Array.from(jobs.entries()).map(([id, job]) => ({
    id,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    businessName: job.result?.steps?.[0]?.data?.name || 'Unknown',
    locationUrl: job.result?.locationUrl,
  }));
  res.json(list.reverse());
});

app.listen(PORT, () => {
  console.log(`\nGHL Onboarding Tool running at http://localhost:${PORT}`);
  console.log(`Webhook URL: http://YOUR_DOMAIN:${PORT}/webhook/ghl-form\n`);
});
