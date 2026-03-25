// GHL API Client — wraps all GoHighLevel v2 API calls
const axios = require('axios');

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

function client(apiKey) {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Version': API_VERSION,
      'Content-Type': 'application/json',
    },
  });
}

// Create a new sub-account (location) under the agency
async function createLocation(apiKey, data) {
  const api = client(apiKey);
  const payload = {
    name: data.businessName,
    email: data.clientEmail,
    phone: data.clientPhone || '',
    address: data.address || '',
    city: data.city || '',
    state: data.state || '',
    country: data.country || 'US',
    postalCode: data.postalCode || '',
    website: data.website || '',
    timezone: data.timezone || 'America/New_York',
    companyId: process.env.GHL_COMPANY_ID,
  };
  const res = await api.post('/locations/', payload);
  return res.data.location;
}

// Push Master Snapshot to a location — builds all funnels/pipelines/templates
async function loadSnapshot(apiKey, locationId, snapshotId) {
  const api = client(apiKey);
  const res = await api.post(`/locations/${locationId}/snapshot`, {
    snapshotId,
    override: false,  // set true to overwrite existing elements
  });
  return res.data;
}

// Get all custom values for a location
async function getCustomValues(apiKey, locationId) {
  const api = client(apiKey);
  const res = await api.get(`/locations/${locationId}/customValues/`);
  return res.data.customValues || [];
}

// Create or update a custom value (template variable used in funnel pages)
async function upsertCustomValue(apiKey, locationId, name, value) {
  const api = client(apiKey);
  // First check if it already exists
  const existing = await getCustomValues(apiKey, locationId);
  const found = existing.find(cv => cv.name.toLowerCase() === name.toLowerCase());

  if (found) {
    const res = await api.put(`/locations/${locationId}/customValues/${found.id}`, { name, value });
    return res.data;
  } else {
    const res = await api.post(`/locations/${locationId}/customValues/`, { name, value });
    return res.data;
  }
}

// Set multiple custom values at once
async function setCustomValues(apiKey, locationId, valuesMap) {
  const results = [];
  for (const [name, value] of Object.entries(valuesMap)) {
    if (value) {
      const result = await upsertCustomValue(apiKey, locationId, name, value);
      results.push({ name, value, result });
      console.log(`  ✓ Set custom value: ${name}`);
    }
  }
  return results;
}

// Create a product in the location
async function createProduct(apiKey, locationId, productData) {
  const api = client(apiKey);
  const payload = {
    name: productData.name,
    description: productData.description || '',
    productType: 'SERVICE',
    image: productData.image || '',
    currency: productData.currency || 'USD',
    priceType: productData.priceType || 'one_time',
    amount: productData.price * 100, // GHL uses cents
    locationId,
  };
  const res = await api.post(`/products/`, payload);
  return res.data.product;
}

// Create a post-purchase thank you email automation
async function createThankYouEmail(apiKey, locationId, emailData) {
  const api = client(apiKey);
  // This creates a simple email template
  const payload = {
    name: emailData.name,
    fromName: emailData.fromName || 'CS Ltd',
    fromEmail: emailData.fromEmail,
    subject: emailData.subject,
    body: emailData.body,
    locationId,
  };
  // Note: Email automations in GHL are typically set up via workflows
  // This creates the email template; webhook/trigger configuration is separate
  const res = await api.post(`/email-templates/`, payload);
  return res.data;
}

// Update location settings (e.g. domain)
async function updateLocationSettings(apiKey, locationId, settings) {
  const api = client(apiKey);
  const res = await api.put(`/locations/${locationId}`, settings);
  return res.data.location;
}

// Get location details
async function getLocation(apiKey, locationId) {
  const api = client(apiKey);
  const res = await api.get(`/locations/${locationId}`);
  return res.data.location;
}

module.exports = {
  createLocation,
  loadSnapshot,
  getCustomValues,
  setCustomValues,
  upsertCustomValue,
  createProduct,
  createThankYouEmail,
  updateLocationSettings,
  getLocation,
};
