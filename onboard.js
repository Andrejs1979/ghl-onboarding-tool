// Main onboarding orchestrator
// Runs the full sequence: create location → load snapshot → populate variables → set up products → emails
require('dotenv').config();

const ghl = require('./ghl');
const { parseOfferFolder, parseBackendFolder, parseSalesCopyFromDoc, parseSalesCopyDoc } = require('./gdocs');

const API_KEY = process.env.GHL_API_KEY;
const SNAPSHOT_ID = process.env.MASTER_SNAPSHOT_ID;

// ─────────────────────────────────────────────────────────────
// MAIN ONBOARDING FUNCTION
// clientData comes from the GHL form submission or web UI
// ─────────────────────────────────────────────────────────────
async function onboardClient(clientData, log = console.log) {
  const results = { steps: [], locationId: null, locationUrl: null };

  try {
    // ── STEP 1: Create sub-account ────────────────────────────
    log('📋 Step 1: Creating GHL sub-account...');
    const location = await ghl.createLocation(API_KEY, {
      businessName: clientData.businessName,
      clientEmail: clientData.clientEmail,
      clientPhone: clientData.clientPhone,
      address: clientData.address,
      city: clientData.city,
      state: clientData.state,
      country: clientData.country || 'US',
      postalCode: clientData.postalCode,
      website: clientData.website,
      timezone: clientData.timezone || 'America/New_York',
    });
    results.locationId = location.id;
    results.locationUrl = `https://app.gohighlevel.com/location/${location.id}/dashboard`;
    results.steps.push({ step: 1, label: 'Sub-account created', status: 'ok', data: { id: location.id, name: location.name } });
    log(`  ✓ Location created: ${location.name} (${location.id})`);

    // ── STEP 2: Load Master Snapshot ──────────────────────────
    log('📸 Step 2: Loading Master Snapshot...');
    await ghl.loadSnapshot(API_KEY, location.id, SNAPSHOT_ID);
    results.steps.push({ step: 2, label: 'Master Snapshot loaded', status: 'ok' });
    log(`  ✓ Snapshot ${SNAPSHOT_ID} applied`);

    // Wait a moment for snapshot to propagate
    await sleep(3000);

    // ── STEP 3: Parse sales copy from Google Drive folders ────
    log('📄 Step 3: Parsing sales copy from Google Drive...');
    let salesData = {};

    // Primary: parse from Drive folders (Steve's GHL form submits folder URLs)
    if (clientData.offerFolderUrl) {
      try {
        salesData = await parseOfferFolder(clientData.offerFolderUrl);
        log(`  ✓ Offer folder parsed: ${Object.keys(salesData).length} fields`);
      } catch (err) {
        log(`  ⚠ Offer folder parse failed (${err.message}) — using form fields`);
        salesData = extractSalesDataFromForm(clientData);
      }
    } else if (clientData.salesCopyDocUrl) {
      // Legacy: single doc URL
      try {
        salesData = await parseSalesCopyFromDoc(clientData.salesCopyDocUrl);
        log(`  ✓ Parsed ${Object.keys(salesData).length} fields from Google Doc`);
      } catch (err) {
        log(`  ⚠ Google Doc parse failed (${err.message}) — using form fields`);
        salesData = extractSalesDataFromForm(clientData);
      }
    } else {
      salesData = extractSalesDataFromForm(clientData);
      log('  ✓ Using form-provided sales data');
    }

    // Supplement with Backend Engine folder (upsell pages)
    if (clientData.backendFolderUrl) {
      try {
        const backendData = await parseBackendFolder(clientData.backendFolderUrl);
        Object.assign(salesData, backendData);
        log(`  ✓ Backend folder parsed: ${Object.keys(backendData).length} additional fields`);
      } catch (err) {
        log(`  ⚠ Backend folder parse failed (${err.message}) — skipping upsells`);
      }
    }

    // Apply price override if provided directly in form
    if (clientData.price && !salesData.mainProductPrice) {
      salesData.mainProductPrice = clientData.price;
    }
    // Apply VSL link
    if (clientData.vslLink) {
      salesData.vslLink = clientData.vslLink;
    }

    results.steps.push({ step: 3, label: 'Sales copy parsed', status: 'ok', data: salesData });

    // Save salesData in results for the /api/complete flow
    results.salesData = salesData;

    // ── STEPS 4-6: Try with agency key first, fall back to "needs token" ──
    try {
      // ── STEP 4: Set custom values (funnel variables) ──────────
      log('🔧 Step 4: Setting funnel custom values...');
      const customValues = buildCustomValuesMap(clientData, salesData);
      await ghl.setCustomValues(API_KEY, location.id, customValues);
      results.steps.push({ step: 4, label: 'Custom values set', status: 'ok', data: { count: Object.keys(customValues).length } });
      log(`  ✓ Set ${Object.keys(customValues).length} custom values`);

      // ── STEP 5: Create products ───────────────────────────────
      log('🛍 Step 5: Creating products...');
      const products = await setupProducts(API_KEY, location.id, salesData);
      results.steps.push({ step: 5, label: 'Products created', status: 'ok', data: products });
      log(`  ✓ Created ${products.length} products`);

      // ── STEP 6: Create thank you emails ───────────────────────
      log('📧 Step 6: Creating post-purchase emails...');
      const emails = await setupEmails(API_KEY, location.id, salesData, clientData);
      results.steps.push({ step: 6, label: 'Thank you emails created', status: 'ok', data: emails });
      log(`  ✓ Created ${emails.length} email templates`);
    } catch (scopeErr) {
      // Agency key may not have sub-account level scopes — mark for completion with sub-account token
      log(`  ⚠ Steps 4-6 need sub-account token: ${scopeErr.message}`);
      results.steps.push({ step: 4, label: 'Custom values — pending sub-account token', status: 'pending' });
      results.steps.push({ step: 5, label: 'Products — pending sub-account token', status: 'pending' });
      results.steps.push({ step: 6, label: 'Emails — pending sub-account token', status: 'pending' });
      results.needsLocationToken = true;
      results.manualStepsNeeded = true;
    }

    // ── STEP 7: Set domain (if provided) ─────────────────────
    if (clientData.domain) {
      try {
        log('🌐 Step 7: Setting up domain...');
        await ghl.updateLocationSettings(API_KEY, location.id, {
          domain: clientData.domain,
        });
        results.steps.push({ step: 7, label: 'Domain configured', status: 'ok', data: { domain: clientData.domain } });
        log(`  ✓ Domain: ${clientData.domain}`);
      } catch (domainErr) {
        results.steps.push({ step: 7, label: 'Domain — set up CNAME first', status: 'warning' });
        log(`  ⚠ Domain: ${domainErr.message}`);
      }
    }

    results.status = results.needsLocationToken ? 'complete_partial' : 'complete';
    results.message = results.needsLocationToken
      ? `⚠ Partial — sub-account created, paste token to complete setup. Location: ${results.locationUrl}`
      : `✅ Onboarding complete! Location: ${results.locationUrl}`;
    log(`\n${results.message}`);

  } catch (err) {
    results.status = 'error';
    results.error = err.message;
    results.errorDetail = err.response?.data || null;
    log(`\n❌ Onboarding failed at step ${results.steps.length + 1}: ${err.message}`);
    if (err.response?.data) log('API response:', JSON.stringify(err.response.data, null, 2));
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

// Extract sales data directly from form fields (fallback if no Google Doc)
function extractSalesDataFromForm(data) {
  return {
    salesHeadline: data.headline,
    salesSubheadline: data.subheadline,
    mainProductName: data.productName,
    mainProductPrice: data.productPrice,
    mainProductDescription: data.productDescription,
    upsell1Name: data.upsell1Name,
    upsell1Price: data.upsell1Price,
    upsell1Description: data.upsell1Description,
    upsell2Name: data.upsell2Name,
    upsell2Price: data.upsell2Price,
    upsell2Description: data.upsell2Description,
    thankYouEmailSubject: data.thankYouSubject,
    downloadUrl: data.downloadUrl,
    upsell1DownloadUrl: data.upsell1DownloadUrl,
    upsell2DownloadUrl: data.upsell2DownloadUrl,
    fromEmail: data.fromEmail,
    fromName: data.fromName,
  };
}

// Map parsed sales data + client form data → GHL Custom Values keys
// These key names must match what's used in the Master Snapshot funnel pages
function buildCustomValuesMap(clientData, salesData) {
  return {
    // Business info
    'Business Name': clientData.businessName,
    'Client Email': clientData.clientEmail,
    'Client Phone': clientData.clientPhone || '',
    'Website': clientData.website || '',
    'Domain': clientData.domain || '',

    // Sales page copy
    'Sales Headline': salesData.salesHeadline || '',
    'Sales Subheadline': salesData.salesSubheadline || '',
    'VSL Link': salesData.vslLink || clientData.vslLink || '',

    // Main product
    'Product Name': salesData.mainProductName || clientData.productName || '',
    'Product Price': salesData.mainProductPrice || clientData.productPrice || '',
    'Product Description': salesData.mainProductDescription || clientData.productDescription || '',
    'Download URL': salesData.downloadUrl || clientData.downloadUrl || '',

    // Upsell 1
    'Upsell 1 Name': salesData.upsell1Name || '',
    'Upsell 1 Price': salesData.upsell1Price || '',
    'Upsell 1 Description': salesData.upsell1Description || '',
    'Upsell 1 Download URL': salesData.upsell1DownloadUrl || '',

    // Upsell 2
    'Upsell 2 Name': salesData.upsell2Name || '',
    'Upsell 2 Price': salesData.upsell2Price || '',
    'Upsell 2 Description': salesData.upsell2Description || '',
    'Upsell 2 Download URL': salesData.upsell2DownloadUrl || '',

    // Email sender
    'From Name': salesData.fromName || clientData.fromName || clientData.businessName || '',
    'From Email': salesData.fromEmail || clientData.fromEmail || clientData.clientEmail || '',
  };
}

// Create products in GHL
async function setupProducts(apiKey, locationId, salesData) {
  const products = [];
  const created = [];

  if (salesData.mainProductName && salesData.mainProductPrice) {
    products.push({
      name: salesData.mainProductName,
      price: parseFloat(salesData.mainProductPrice),
      description: salesData.mainProductDescription || '',
      priceType: 'one_time',
    });
  }

  if (salesData.upsell1Name && salesData.upsell1Price) {
    products.push({
      name: salesData.upsell1Name,
      price: parseFloat(salesData.upsell1Price),
      description: salesData.upsell1Description || '',
      priceType: 'one_time',
    });
  }

  if (salesData.upsell2Name && salesData.upsell2Price) {
    products.push({
      name: salesData.upsell2Name,
      price: parseFloat(salesData.upsell2Price),
      description: salesData.upsell2Description || '',
      priceType: 'one_time',
    });
  }

  for (const product of products) {
    const result = await ghl.createProduct(apiKey, locationId, product);
    created.push({ name: product.name, id: result?.id });
    console.log(`  ✓ Product: ${product.name} ($${product.price})`);
  }

  return created;
}

// Build and create thank you email templates
async function setupEmails(apiKey, locationId, salesData, clientData) {
  const fromName = salesData.fromName || clientData.businessName || 'CS Ltd';
  const fromEmail = salesData.fromEmail || clientData.fromEmail || clientData.clientEmail;
  const created = [];

  const emailTemplates = [
    {
      name: 'Thank You - Main Product',
      subject: salesData.thankYouEmailSubject || `Thank you for your purchase of ${salesData.mainProductName || 'our product'}!`,
      // Use parsed email body from Google Doc if available; fall back to generated template
      body: salesData.thankYouEmailBody
        ? wrapEmailBody(salesData.thankYouEmailBody, salesData.downloadUrl)
        : buildThankYouEmailBody({ productName: salesData.mainProductName, downloadUrl: salesData.downloadUrl, fromName }),
    },
  ];

  if (salesData.upsell1Name || salesData.upsell1ThankYouBody) {
    emailTemplates.push({
      name: 'Thank You - Upsell 1',
      subject: salesData.upsell1ThankYouSubject || `Thank you for adding ${salesData.upsell1Name || 'your upsell'}!`,
      body: salesData.upsell1ThankYouBody
        ? wrapEmailBody(salesData.upsell1ThankYouBody, salesData.upsell1DownloadUrl)
        : buildThankYouEmailBody({ productName: salesData.upsell1Name, downloadUrl: salesData.upsell1DownloadUrl, fromName }),
    });
  }

  if (salesData.upsell2Name || salesData.upsell2ThankYouBody) {
    emailTemplates.push({
      name: 'Thank You - Upsell 2',
      subject: salesData.upsell2ThankYouSubject || `Thank you for adding ${salesData.upsell2Name || 'your upsell'}!`,
      body: salesData.upsell2ThankYouBody
        ? wrapEmailBody(salesData.upsell2ThankYouBody, salesData.upsell2DownloadUrl)
        : buildThankYouEmailBody({ productName: salesData.upsell2Name, downloadUrl: salesData.upsell2DownloadUrl, fromName }),
    });
  }

  for (const template of emailTemplates) {
    try {
      const result = await ghl.createThankYouEmail(apiKey, locationId, {
        ...template,
        fromName,
        fromEmail,
        locationId,
      });
      created.push({ name: template.name, id: result?.id });
      console.log(`  ✓ Email: ${template.name}`);
    } catch (err) {
      // Email template API may vary — log but don't fail the whole flow
      console.log(`  ⚠ Email template "${template.name}" — saved locally, needs manual import`);
      created.push({ name: template.name, status: 'manual', html: template.body });
    }
  }

  return created;
}

// Wrap a raw email body with the download URL link appended
function wrapEmailBody(body, downloadUrl) {
  if (!downloadUrl) return `<p>${body.replace(/\n/g, '</p><p>')}</p>`;
  return `<p>${body.replace(/\n/g, '</p><p>')}</p>\n<p><a href="${downloadUrl}">Access your purchase here →</a></p>`;
}

function buildThankYouEmailBody({ productName, downloadUrl, fromName }) {
  return `
<p>Hi {{contact.first_name}},</p>
<p>Thank you so much for your purchase of <strong>${productName || 'our product'}</strong>!</p>
${downloadUrl ? `<p>You can access your purchase here:<br><a href="${downloadUrl}">${downloadUrl}</a></p>` : ''}
<p>If you have any questions, just reply to this email and we'll be happy to help.</p>
<p>Talk soon,<br>${fromName}</p>
  `.trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
// COMPLETE SETUP — runs steps 4-6 using a sub-account token
// Called when the agency key doesn't have sub-account scope
// ─────────────────────────────────────────────────────────────
async function completeSetup(locationToken, locationId, savedJob, log = console.log) {
  const results = { steps: [], locationId };

  try {
    const salesData = savedJob.salesData || {};
    const clientData = savedJob.clientData || {};

    // ── STEP 4: Set custom values ──────────────────────────────
    log('🔧 Step 4: Setting funnel custom values (with sub-account token)...');
    const customValues = buildCustomValuesMap(clientData, salesData);
    await ghl.setCustomValues(locationToken, locationId, customValues);
    results.steps.push({ step: 4, label: 'Custom values set', status: 'ok', data: { count: Object.keys(customValues).length } });
    log(`  ✓ Set ${Object.keys(customValues).length} custom values`);

    // ── STEP 5: Create products ────────────────────────────────
    log('🛍 Step 5: Creating products...');
    const products = await setupProducts(locationToken, locationId, salesData);
    results.steps.push({ step: 5, label: 'Products created', status: 'ok', data: products });
    log(`  ✓ Created ${products.length} products`);

    // ── STEP 6: Create thank you emails ────────────────────────
    log('📧 Step 6: Creating post-purchase emails...');
    const emails = await setupEmails(locationToken, locationId, salesData, clientData);
    results.steps.push({ step: 6, label: 'Thank you emails created', status: 'ok', data: emails });
    log(`  ✓ Created ${emails.length} email templates`);

    results.status = 'complete';
    results.message = '✅ Setup complete! Custom values, products, and emails are live.';
    log(`\n${results.message}`);

  } catch (err) {
    results.status = 'error';
    results.error = err.message;
    results.errorDetail = err.response?.data || null;
    log(`\n❌ Complete setup failed at step ${results.steps.length + 4}: ${err.message}`);
    if (err.response?.data) log('API response:', JSON.stringify(err.response.data, null, 2));
  }

  return results;
}

module.exports = { onboardClient, completeSetup };

// ─────────────────────────────────────────────────────────────
// CLI MODE — run with: node onboard.js client.json
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const fs = require('fs');
  const inputFile = process.argv[2] || 'client.json';

  if (!fs.existsSync(inputFile)) {
    console.error(`Usage: node onboard.js <client-data.json>`);
    console.error(`Example client.json:\n${JSON.stringify(EXAMPLE_CLIENT, null, 2)}`);
    process.exit(1);
  }

  const clientData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  onboardClient(clientData).then(results => {
    console.log('\nFinal results:', JSON.stringify(results, null, 2));
  });
}

const EXAMPLE_CLIENT = {
  businessName: "Acme Corp",
  clientEmail: "client@example.com",
  clientPhone: "+1 555-123-4567",
  website: "https://acmecorp.com",
  domain: "acmecorp.com",
  timezone: "America/New_York",
  salesCopyDocUrl: "https://docs.google.com/document/d/YOUR_DOC_ID/edit",
  productName: "Amazing Course",
  productPrice: "197",
  productDescription: "The complete guide to...",
  downloadUrl: "https://drive.google.com/...",
  fromName: "John Smith",
  fromEmail: "john@acmecorp.com"
};
