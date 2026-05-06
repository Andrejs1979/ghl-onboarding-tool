/**
 * ClientSpring GHL Onboarding Tool — Cloudflare Worker
 *
 * Routes:
 *   GET  /admin              → Ops Dashboard
 *   GET  /                   → Manual onboard form (redirect to /admin)
 *   POST /api/onboard        → Start manual onboard
 *   POST /api/approve/:key   → Approve + run a pending client
 *   POST /api/complete/:id   → Complete setup with sub-account token
 *   GET  /api/status/:id     → Job status + logs
 *   GET  /api/jobs           → List all jobs
 *   GET  /api/pending        → List pending clients
 *   POST /webhook/ghl-form   → GHL form webhook
 *   GET  /api/oauth-status   → OAuth configuration status
 *   GET  /oauth/install      → Start OAuth flow
 *   GET  /oauth/callback     → OAuth callback
 *
 * Env bindings:
 *   GHL_API_KEY, GHL_COMPANY_ID, MASTER_SNAPSHOT_ID,
 *   GHL_CLIENT_ID, GHL_CLIENT_SECRET, GOOGLE_SA_KEY,
 *   CLIENT_ID, KV
 */

// ── GHL API ─────────────────────────────────────────────────────

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

async function ghlFetch(method, path, apiKey, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Version': GHL_VERSION,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${GHL_BASE}${path}`, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GHL ${method} ${path}: ${res.status} — ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function createLocation(apiKey, data, env) {
  const res = await ghlFetch('POST', '/locations/', apiKey, {
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
    companyId: env.GHL_COMPANY_ID,
  });
  return res.location;
}

async function loadSnapshot(apiKey, locationId, snapshotId) {
  return ghlFetch('POST', `/locations/${locationId}/snapshot`, apiKey, {
    snapshotId,
    override: false,
  });
}

async function getCustomValues(apiKey, locationId) {
  const res = await ghlFetch('GET', `/locations/${locationId}/customValues/`, apiKey);
  return res.customValues || [];
}

async function upsertCustomValue(apiKey, locationId, name, value) {
  const existing = await getCustomValues(apiKey, locationId);
  const found = existing.find(cv => cv.name.toLowerCase() === name.toLowerCase());
  if (found) {
    return ghlFetch('PUT', `/locations/${locationId}/customValues/${found.id}`, apiKey, { name, value });
  } else {
    return ghlFetch('POST', `/locations/${locationId}/customValues/`, apiKey, { name, value });
  }
}

async function setCustomValues(apiKey, locationId, valuesMap, log) {
  for (const [name, value] of Object.entries(valuesMap)) {
    if (value) {
      await upsertCustomValue(apiKey, locationId, name, value);
      if (log) log(`  ✓ Set custom value: ${name}`);
    }
  }
}

async function createProduct(apiKey, locationId, productData) {
  const res = await ghlFetch('POST', '/products/', apiKey, {
    name: productData.name,
    description: productData.description || '',
    productType: 'SERVICE',
    currency: 'USD',
    priceType: productData.priceType || 'one_time',
    amount: productData.price * 100,
    locationId,
  });
  return res.product;
}

async function createThankYouEmail(apiKey, locationId, emailData) {
  return ghlFetch('POST', '/emails/builder', apiKey, {
    name: emailData.name,
    fromName: emailData.fromName || 'CS Ltd',
    fromEmail: emailData.fromEmail,
    subject: emailData.subject,
    body: emailData.body,
    locationId,
  });
}

async function updateLocationSettings(apiKey, locationId, settings) {
  return ghlFetch('PUT', `/locations/${locationId}`, apiKey, settings);
}

// ── Google Drive/Docs API (direct fetch, no googleapis library) ─

async function getGoogleAccessToken(saKeyJson) {
  const key = typeof saKeyJson === 'string' ? JSON.parse(saKeyJson) : saKeyJson;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsigned = enc(header) + '.' + enc(payload);

  // Import the private key and sign
  const pemBody = key.private_key.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\s/g, '');
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = unsigned + '.' + sigB64;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Google auth failed: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function listDocsInFolder(folderUrl, accessToken) {
  const match = folderUrl.match(/\/folders\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error(`Invalid Drive folder URL: ${folderUrl}`);
  const folderId = match[1];

  const q = encodeURIComponent(`'${folderId}' in parents and mimeType = 'application/vnd.google-apps.document' and trashed = false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=50`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Drive list error: ${await res.text()}`);
  const data = await res.json();
  return data.files || [];
}

async function readDocStructured(docId, accessToken) {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Docs read error: ${await res.text()}`);
  const doc = await res.json();
  const paragraphs = [];
  for (const element of (doc.body?.content || [])) {
    if (!element.paragraph) continue;
    const text = element.paragraph.elements.map(e => e.textRun?.content || '').join('').trim();
    if (!text) continue;
    const style = element.paragraph.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
    paragraphs.push({ text, style });
  }
  return paragraphs;
}

// ── Sales Copy Parsers (matching gdocs.js logic) ────────────────

function identifyDoc(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes('sales page copy') || name.includes('sales page'))     return 'salesPage';
  if (name.includes('thank you email') && !name.includes('upsell'))        return 'thankYouEmail';
  if (name.includes('upsell 1') && name.includes('sales page'))            return 'upsell1SalesPage';
  if (name.includes('upsell 1') && name.includes('thank you'))             return 'upsell1ThankYou';
  if (name.includes('upsell 1') && name.includes('product'))               return 'upsell1Product';
  if (name.includes('upsell 2') && name.includes('sales page'))            return 'upsell2SalesPage';
  if (name.includes('upsell 2') && name.includes('thank you'))             return 'upsell2ThankYou';
  if (name.includes('upsell 2') && name.includes('delivery'))              return 'upsell2Delivery';
  if (name.includes('upsell 1'))                                           return 'upsell1Product';
  if (name.includes('upsell 2'))                                           return 'upsell2Product';
  return null;
}

function parseSalesPageDoc(paragraphs) {
  const data = {};
  const sections = {};
  let currentSection = null;

  for (const para of paragraphs) {
    const isHeading = para.style.startsWith('HEADING');
    const upper = para.text.toUpperCase();
    if (isHeading) {
      if (upper.includes('HEADER') || upper.includes('HEADLINE'))      currentSection = 'header';
      else if (upper.includes('PRICE') || upper.includes('OFFER'))     currentSection = 'price';
      else if (upper.includes('SOLUTION') || upper.includes('PRODUCT'))currentSection = 'solution';
      else                                                               currentSection = upper;
      sections[currentSection] = sections[currentSection] || [];
    } else if (currentSection) {
      sections[currentSection].push(para.text);
    }
  }

  const headerLines = sections['header'] || [];
  const attentionLine = headerLines.find(l => l.toUpperCase().startsWith('ATTENTION'));
  const introLine = headerLines.find(l => l.toUpperCase().startsWith('INTRODUCING'));
  const headlineLines = headerLines.filter(l => !l.toUpperCase().startsWith('ATTENTION') && !l.toUpperCase().startsWith('INTRODUCING'));

  if (attentionLine) data.salesSubheadline = attentionLine;
  if (headlineLines.length > 0) data.salesHeadline = headlineLines.reduce((a, b) => (a.length >= b.length ? a : b));
  if (introLine) {
    const match = introLine.match(/Introducing\s+(.+?)(?:\s*[:—]|$)/i);
    if (match) data.mainProductName = match[1].trim();
  }

  // Fallback: "The X Method/Toolkit/..." pattern
  if (!data.mainProductName) {
    for (const para of paragraphs) {
      const m = para.text.match(/\b(The\s+[\w\s]+(?:Method|System|Guide|Course|Toolkit|Roadmap|Checklist|Blueprint|Program|Audit|Framework|Playbook|Masterclass|Workshop|Academy))\b/i);
      if (m) { data.mainProductName = m[1].trim(); break; }
    }
  }
  // Further fallback: first non-label heading
  if (!data.mainProductName) {
    const sectionLabels = /^(header|headline|price|offer|solution|product|section|body|footer|cta|call to action|benefits|features|guarantee|testimonial|faq|bonus)/i;
    for (const para of paragraphs) {
      if (para.style.startsWith('HEADING') && !sectionLabels.test(para.text.trim()) && para.text.trim().length > 3 && para.text.trim().length < 80) {
        data.mainProductName = para.text.trim(); break;
      }
    }
  }

  const priceLines = sections['price'] || [];
  for (const line of priceLines) {
    const m = line.match(/\$\s*(\d+(?:\.\d{2})?)/);
    if (m) { data.mainProductPrice = m[1]; break; }
  }
  if (!data.mainProductPrice) {
    for (const para of paragraphs) {
      const m = para.text.match(/\$\s*(\d+(?:\.\d{2})?)/);
      if (m) { data.mainProductPrice = m[1]; break; }
    }
  }

  const solLines = sections['solution'] || [];
  if (solLines.length > 0) data.mainProductDescription = solLines.slice(0, 3).join(' ');

  return data;
}

function parseThankYouEmailDoc(paragraphs) {
  const lines = paragraphs.map(p => p.text);
  let subject = '';
  let bodyLines = [];
  let inBody = false;
  const subjectOptions = [];

  for (const line of lines) {
    const upper = line.toUpperCase().trim();
    if (/^[─━\-=]{5,}$/.test(line.trim())) continue;
    if (upper === 'SUBJECT LINES' || upper === 'SUBJECT LINE' || upper === 'PREVIEW TEXT' || upper === 'EMAIL BODY') continue;

    if (upper.startsWith('SUBJECT:') || upper.startsWith('EMAIL SUBJECT:')) {
      subject = line.replace(/^.*?:\s*/i, '').trim();
    } else if (upper.startsWith('OPTION') && upper.includes(':') && !inBody) {
      subjectOptions.push(line.replace(/^Option\s*\d+:\s*/i, '').trim());
    } else if (upper.includes('EMAIL BODY') || (inBody && upper !== 'BODY')) {
      if (upper.includes('EMAIL BODY') || upper === 'BODY') { inBody = true; continue; }
      inBody = true;
      bodyLines.push(line);
    } else if (inBody) {
      bodyLines.push(line);
    }
  }

  if (!subject && subjectOptions.length > 0) subject = subjectOptions[0];
  if (!subject && lines.length > 0) {
    const content = lines.filter(l => !/^[─━\-=]{5,}$/.test(l.trim()) && l.trim());
    subject = content[0] || lines[0];
    bodyLines = content.slice(1);
  }

  const cleanedBody = bodyLines
    .filter(l => !/^[─━\-=]{5,}$/.test(l.trim()))
    .filter(l => { const u = l.trim().toUpperCase(); return u !== 'SUBJECT LINES' && u !== 'PREVIEW TEXT' && u !== 'EMAIL BODY'; })
    .join('\n')
    .replace(/\[DOWNLOAD[^\]]*(?:LINK|HERE)\]/gi, '{{download_link}}')
    .replace(/\[BOOK[^\]]*(?:LINK|HERE|CALL|SESSION)\]/gi, '{{booking_link}}')
    .replace(/\[CALENDLY\s+LINK\]/gi, '{{booking_link}}')
    .trim();

  return { subject, body: cleanedBody };
}

async function parseOfferFolder(folderUrl, accessToken) {
  const files = await listDocsInFolder(folderUrl, accessToken);
  const data = {};

  for (const file of files) {
    const role = identifyDoc(file.name);
    if (!role) continue;
    const paragraphs = await readDocStructured(file.id, accessToken);

    if (role === 'salesPage') {
      Object.assign(data, parseSalesPageDoc(paragraphs));
      data.salesPageDocUrl = `https://docs.google.com/document/d/${file.id}/edit`;
    }
    if (role === 'thankYouEmail') {
      const parsed = parseThankYouEmailDoc(paragraphs);
      data.thankYouEmailSubject = parsed.subject;
      data.thankYouEmailBody = parsed.body;
      const docText = paragraphs.map(p => p.text).join('\n');
      const extUrl = docText.match(/https?:\/\/(?!docs\.google\.com\/document)[^\s\])<]+/);
      data.downloadUrl = extUrl ? extUrl[0] : `https://docs.google.com/document/d/${file.id}/edit`;
    }
  }
  return data;
}

async function parseBackendFolder(folderUrl, accessToken) {
  const files = await listDocsInFolder(folderUrl, accessToken);
  const data = {};

  for (const file of files) {
    const role = identifyDoc(file.name);
    if (!role) continue;
    const paragraphs = await readDocStructured(file.id, accessToken);

    if (role === 'upsell1SalesPage') {
      const base = parseSalesPageDoc(paragraphs);
      data.upsell1Name = base.mainProductName || data.upsell1Name;
      data.upsell1Price = base.mainProductPrice || data.upsell1Price;
      data.upsell1Description = base.mainProductDescription || data.upsell1Description;
    }
    if (role === 'upsell1ThankYou') {
      const parsed = parseThankYouEmailDoc(paragraphs);
      data.upsell1ThankYouSubject = parsed.subject;
      data.upsell1ThankYouBody = parsed.body;
      data.upsell1DownloadUrl = `https://docs.google.com/document/d/${file.id}/edit`;
    }
    if (role === 'upsell2SalesPage') {
      const base = parseSalesPageDoc(paragraphs);
      data.upsell2Name = base.mainProductName || data.upsell2Name;
      data.upsell2Price = base.mainProductPrice || data.upsell2Price;
      data.upsell2Description = base.mainProductDescription || data.upsell2Description;
    }
    if (role === 'upsell2ThankYou') {
      const parsed = parseThankYouEmailDoc(paragraphs);
      data.upsell2ThankYouSubject = parsed.subject;
      data.upsell2ThankYouBody = parsed.body;
      data.upsell2DownloadUrl = `https://docs.google.com/document/d/${file.id}/edit`;
    }
  }
  return data;
}

// ── Onboarding Logic ────────────────────────────────────────────

function buildCustomValuesMap(clientData, salesData) {
  return {
    'Business Name': clientData.businessName, 'Client Email': clientData.clientEmail,
    'Client Phone': clientData.clientPhone || '', 'Website': clientData.website || '',
    'Domain': clientData.domain || '', 'Sales Headline': salesData.salesHeadline || '',
    'Sales Subheadline': salesData.salesSubheadline || '', 'VSL Link': salesData.vslLink || clientData.vslLink || '',
    'Product Name': salesData.mainProductName || clientData.productName || '',
    'Product Price': salesData.mainProductPrice || clientData.productPrice || '',
    'Product Description': salesData.mainProductDescription || clientData.productDescription || '',
    'Download URL': salesData.downloadUrl || clientData.downloadUrl || '',
    'Upsell 1 Name': salesData.upsell1Name || '', 'Upsell 1 Price': salesData.upsell1Price || '',
    'Upsell 1 Description': salesData.upsell1Description || '',
    'Upsell 1 Download URL': salesData.upsell1DownloadUrl || '',
    'Upsell 2 Name': salesData.upsell2Name || '', 'Upsell 2 Price': salesData.upsell2Price || '',
    'Upsell 2 Description': salesData.upsell2Description || '',
    'Upsell 2 Download URL': salesData.upsell2DownloadUrl || '',
    'From Name': salesData.fromName || clientData.fromName || clientData.businessName || '',
    'From Email': salesData.fromEmail || clientData.fromEmail || clientData.clientEmail || '',
  };
}

function extractSalesDataFromForm(data) {
  return {
    salesHeadline: data.headline, salesSubheadline: data.subheadline,
    mainProductName: data.productName, mainProductPrice: data.productPrice || data.price,
    mainProductDescription: data.productDescription,
    downloadUrl: data.downloadUrl, fromEmail: data.fromEmail, fromName: data.fromName,
  };
}

async function onboardClient(clientData, env, log) {
  const results = { steps: [], locationId: null, locationUrl: null };
  const apiKey = env.GHL_API_KEY;

  try {
    // Step 1: Create sub-account + load snapshot
    log('📋 Step 1: Creating GHL sub-account with Master Snapshot...');
    const location = await createLocation(apiKey, clientData, env);
    results.locationId = location.id;
    results.locationUrl = `https://app.gohighlevel.com/location/${location.id}/dashboard`;
    results.steps.push({ step: 1, label: 'Sub-account created', status: 'ok', data: { id: location.id } });
    log(`  ✓ Location: ${location.name} (${location.id})`);

    try { await loadSnapshot(apiKey, location.id, env.MASTER_SNAPSHOT_ID); } catch (e) { log(`  ⚠ Snapshot: ${e.message}`); }
    await new Promise(r => setTimeout(r, 3000));

    // Step 2: Parse sales copy
    log('📄 Step 2: Parsing Drive folders...');
    let salesData = {};
    let googleToken = null;

    if (clientData.offerFolderUrl && env.GOOGLE_SA_KEY) {
      try {
        const saKey = env.GOOGLE_SA_KEY.startsWith('{') ? env.GOOGLE_SA_KEY : atob(env.GOOGLE_SA_KEY);
        googleToken = await getGoogleAccessToken(saKey);
        salesData = await parseOfferFolder(clientData.offerFolderUrl, googleToken);
        log(`  ✓ Offer folder parsed: ${Object.keys(salesData).length} fields`);
      } catch (err) {
        log(`  ⚠ Offer folder parse failed (${err.message}) — using form fields`);
        salesData = extractSalesDataFromForm(clientData);
      }
    } else {
      salesData = extractSalesDataFromForm(clientData);
      log(`  ✓ No Drive folder provided — using form-submitted data`);
    }

    if (clientData.backendFolderUrl && googleToken) {
      try {
        const backendData = await parseBackendFolder(clientData.backendFolderUrl, googleToken);
        Object.assign(salesData, backendData);
        log(`  ✓ Backend folder parsed: ${Object.keys(backendData).length} additional fields`);
      } catch (err) {
        log(`  ⚠ WARNING: Backend folder parse failed — ${err.message}`);
        log('  ⚠ Continuing without upsell data. Upsells must be set up manually in GHL.');
      }
    }

    if (clientData.price && !salesData.mainProductPrice) salesData.mainProductPrice = clientData.price;
    if (clientData.vslLink) salesData.vslLink = clientData.vslLink;

    results.steps.push({ step: 2, label: 'Sales copy parsed', status: 'ok' });
    results.salesData = salesData;
    results.clientData = clientData;

    // Try to get a location token via OAuth for steps 3-5
    let locationToken = null;
    if (env.GHL_CLIENT_ID && env.GHL_CLIENT_SECRET) {
      try {
        log('  🔑 Getting location token via OAuth...');
        const tokenRes = await fetch(`${GHL_BASE}/oauth/locationToken`, {
          method: 'POST',
          headers: { 'Version': GHL_VERSION, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `companyId=${env.GHL_COMPANY_ID}&locationId=${location.id}&client_id=${env.GHL_CLIENT_ID}&client_secret=${env.GHL_CLIENT_SECRET}`,
        });
        const tokenText = await tokenRes.text();
        if (tokenRes.ok) {
          const tokenData = JSON.parse(tokenText);
          locationToken = tokenData.access_token;
          log('  ✓ Location token obtained');
        } else {
          log(`  ⚠ OAuth location token failed: ${tokenText.slice(0, 120)}`);
        }
      } catch (e) { log(`  ⚠ OAuth error: ${e.message}`); }
    }

    const stepKey = locationToken || apiKey;

    // Step 3: Custom values (try individually)
    const customValues = buildCustomValuesMap(clientData, salesData);
    results.customValues = customValues;

    try {
      log('🔧 Step 3: Setting custom values...');
      await setCustomValues(stepKey, location.id, customValues, log);
      results.steps.push({ step: 3, label: 'Custom values set', status: 'ok', data: { count: Object.keys(customValues).length } });
    } catch (cvErr) {
      results.steps.push({ step: 3, label: 'Custom values — needs manual setup', status: 'warn' });
      results.manualStepsNeeded = true;
      log(`  ⚠ Custom values failed (${cvErr.message}) — set manually in GHL`);
    }

    // Step 4: Products
    try {
      log('🛍 Step 4: Creating products...');
      const products = [];
      if (salesData.mainProductName && salesData.mainProductPrice) {
        const p = await createProduct(stepKey, location.id, { name: salesData.mainProductName, price: parseFloat(salesData.mainProductPrice), description: salesData.mainProductDescription || '' });
        products.push({ name: salesData.mainProductName, id: p?.id });
      }
      if (salesData.upsell1Name && salesData.upsell1Price) {
        const p = await createProduct(stepKey, location.id, { name: salesData.upsell1Name, price: parseFloat(salesData.upsell1Price), description: salesData.upsell1Description || '' });
        products.push({ name: salesData.upsell1Name, id: p?.id });
      }

      if (products.length === 0) {
        results.steps.push({ step: 4, label: 'No products created — check salesData parsing', status: 'warn', data: [] });
        log(`  ⚠ No products created (mainProductName: ${salesData.mainProductName || 'MISSING'})`);
      } else {
        results.steps.push({ step: 4, label: 'Products created', status: 'ok', data: products });
        log(`  ✓ Created ${products.length} products`);
      }
    } catch (prodErr) {
      results.steps.push({ step: 4, label: 'Products — needs manual setup', status: 'warn' });
      results.manualStepsNeeded = true;
      log(`  ⚠ Products failed (${prodErr.message})`);
    }

    // Step 5: Emails
    try {
      log('📧 Step 5: Creating thank you emails...');
      const fromName = salesData.fromName || clientData.businessName || 'CS Ltd';
      const fromEmail = salesData.fromEmail || clientData.fromEmail || clientData.clientEmail;
      const mainSubject = salesData.thankYouEmailSubject || `Thank you for purchasing ${salesData.mainProductName || 'our product'}!`;
      await createThankYouEmail(stepKey, location.id, { name: 'Thank You - Main Product', subject: mainSubject, body: salesData.thankYouEmailBody || '', fromName, fromEmail });
      results.steps.push({ step: 5, label: 'Thank you emails created', status: 'ok' });
      log('  ✓ Email templates created');
    } catch (emailErr) {
      results.steps.push({ step: 5, label: 'Emails — needs manual setup', status: 'warn' });
      results.manualStepsNeeded = true;
      log(`  ⚠ Emails failed (${emailErr.message}) — create manually in GHL`);
    }

    // Step 6: Domain
    if (clientData.domain) {
      try {
        log('🌐 Step 6: Setting domain...');
        await updateLocationSettings(apiKey, location.id, { domain: clientData.domain });
        results.steps.push({ step: 6, label: 'Domain configured', status: 'ok' });
        log(`  ✓ Domain: ${clientData.domain}`);
      } catch (domErr) {
        results.steps.push({ step: 6, label: 'Domain — set up CNAME first', status: 'warn' });
        log(`  ⚠ Domain skipped — ${domErr.message.slice(0, 100)}`);
      }
    }

    results.needsLocationToken = results.steps.some(s => s.status === 'pending');
    const hasWarnings = results.steps.some(s => s.status === 'warn');
    results.status = results.needsLocationToken ? 'complete_partial' : (hasWarnings ? 'complete_partial' : 'complete');
    results.message = results.status === 'complete'
      ? `✅ Onboarding complete! ${results.locationUrl}`
      : `⚠ Some steps still need manual setup in GHL. ${results.locationUrl}`;
    log(`\n${results.message}`);

  } catch (err) {
    results.status = 'error';
    results.error = err.message;
    log(`\n❌ Onboarding failed: ${err.message}`);
  }

  return results;
}

async function completeSetup(locationToken, locationId, savedJob, env, log) {
  const results = { steps: [], locationId };
  const salesData = savedJob.salesData || {};
  const clientData = savedJob.clientData || {};

  try {
    log('🔄 Resuming with sub-account token...');

    // Step 3: Custom values
    try {
      log('🔧 Step 3: Setting custom values...');
      const cv = buildCustomValuesMap(clientData, salesData);
      await setCustomValues(locationToken, locationId, cv, log);
      results.steps.push({ step: 3, label: 'Custom values set', status: 'ok', data: { count: Object.keys(cv).length } });
    } catch (e) {
      results.steps.push({ step: 3, label: 'Custom values — needs manual setup', status: 'warn' });
      log(`  ⚠ Custom values failed (${e.message}) — set manually in GHL`);
    }

    // Step 4: Products
    try {
      log('🛍 Step 4: Creating products...');
      const products = [];
      if (salesData.mainProductName && salesData.mainProductPrice) {
        const p = await createProduct(locationToken, locationId, { name: salesData.mainProductName, price: parseFloat(salesData.mainProductPrice), description: salesData.mainProductDescription || '' });
        products.push({ name: salesData.mainProductName, id: p?.id });
      }
      results.steps.push({ step: 4, label: 'Products created', status: 'ok', data: products });
      log(`  ✓ Created ${products.length} products`);
    } catch (e) {
      results.steps.push({ step: 4, label: 'Products — needs manual setup', status: 'warn' });
      log(`  ⚠ Products failed (${e.message})`);
    }

    // Step 5: Emails
    try {
      log('📧 Step 5: Creating thank you emails...');
      const fromName = salesData.fromName || clientData.businessName || 'CS Ltd';
      const fromEmail = salesData.fromEmail || clientData.fromEmail || clientData.clientEmail;
      await createThankYouEmail(locationToken, locationId, { name: 'Thank You - Main', subject: salesData.thankYouEmailSubject || 'Thank you!', body: salesData.thankYouEmailBody || '', fromName, fromEmail });
      results.steps.push({ step: 5, label: 'Emails created', status: 'ok' });
      log('  ✓ Email templates created');
    } catch (e) {
      results.steps.push({ step: 5, label: 'Emails — needs manual setup', status: 'warn' });
      log(`  ⚠ Emails failed (${e.message}) — create manually in GHL`);
    }

    const hasWarns = results.steps.some(s => s.status === 'warn');
    results.status = hasWarns ? 'complete_partial' : 'complete';
    results.message = hasWarns
      ? `⚠ Some steps still need manual setup in GHL. https://app.gohighlevel.com/location/${locationId}/dashboard`
      : '✅ Setup complete!';
    log(`\n${results.message}`);

  } catch (err) {
    results.status = 'error';
    results.error = err.message;
    log(`\n❌ Complete setup failed: ${err.message}`);
  }

  return results;
}

// ── KV Helpers ──────────────────────────────────────────────────

async function kvGet(kv, key) {
  const val = await kv.get(key);
  return val ? JSON.parse(val) : null;
}

async function kvPut(kv, key, val) {
  await kv.put(key, JSON.stringify(val));
}

async function kvGetJobs(kv, clientId) {
  return (await kvGet(kv, `${clientId}:jobs`)) || [];
}

async function kvSaveJob(kv, clientId, job) {
  const jobs = await kvGetJobs(kv, clientId);
  const idx = jobs.findIndex(j => j.id === job.id);
  if (idx >= 0) jobs[idx] = job; else jobs.unshift(job);
  await kvPut(kv, `${clientId}:jobs`, jobs.slice(0, 50));
}

async function kvGetPending(kv, clientId) {
  return (await kvGet(kv, `${clientId}:pending`)) || [];
}

async function kvSavePending(kv, clientId, pending) {
  await kvPut(kv, `${clientId}:pending`, pending);
}

// ── HTML Pages ──────────────────────────────────────────────────

function adminPage() {
  // Inline the admin.html from public/admin.html — adapted for worker
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClientSpring — Ops Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f5f5f7;color:#1d1d1f}
header{background:#fff;border-bottom:1px solid #e5e5e5;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
h1{font-size:18px}header .right{display:flex;gap:12px;align-items:center;font-size:13px;color:#666}
.badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600}
.badge-complete{background:#d1fae5;color:#065f46}.badge-complete_partial{background:#fef9c3;color:#854d0e}
.badge-error{background:#fee2e2;color:#991b1b}.badge-running{background:#dbeafe;color:#1e40af}
main{max-width:900px;margin:24px auto;padding:0 16px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.stat{background:#fff;border-radius:8px;padding:16px;text-align:center}
.stat-label{font-size:11px;color:#888;text-transform:uppercase}.stat-value{font-size:28px;font-weight:700;margin:4px 0}
.card{background:#fff;border-radius:8px;padding:16px;margin-bottom:12px;border:1px solid #e5e5e5}
.steps{font-size:13px;line-height:2}
.step-ok::before{content:"● ";color:#22c55e}.step-pending::before{content:"◌ ";color:#eab308}
.step-warn::before{content:"● ";color:#f59e0b}.step-error::before{content:"● ";color:#ef4444}
.card-meta{font-size:12px;color:#888;margin-bottom:8px}
a.ghl-link{color:#2563eb;font-size:12px;text-decoration:none}
.auth-btn{display:inline-block;background:#2563eb;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;border:none;cursor:pointer}
.auth-btn:hover{background:#1d4ed8}.auth-btn:disabled{background:#93c5fd;cursor:not-allowed}
section{margin-bottom:32px}section h2{font-size:14px;color:#666;margin-bottom:12px}
.empty{text-align:center;color:#999;padding:40px;font-size:14px}
input[type=text],input[type=email],input[type=url],input[type=number]{width:100%;border:1px solid #d0d0d0;border-radius:6px;padding:7px 10px;font-size:13px}
label{font-size:12px;color:#666;display:block;margin-bottom:3px}
.log{font-family:monospace;font-size:12px;background:#f8f8f8;border-radius:6px;padding:12px;max-height:200px;overflow-y:auto;white-space:pre-wrap}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:100;display:none;align-items:center;justify-content:center}
.modal-box{background:#fff;border-radius:12px;padding:28px;max-width:560px;width:90%;max-height:90vh;overflow-y:auto}
</style></head><body>
<header><h1>ClientSpring Ops</h1>
<div class="right"><span id="updated"></span><span id="oauth-badge"></span>
<a href="#" id="manual-btn" class="auth-btn">+ Manual Onboard</a></div></header>
<main>
<div id="manual-modal" class="modal-bg">
<div class="modal-box">
<div style="display:flex;justify-content:space-between;margin-bottom:16px"><h2 style="font-size:16px">Manual Onboard</h2><button id="modal-close" style="background:none;border:none;font-size:20px;cursor:pointer">&times;</button></div>
<form id="manual-form">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
<div><label>Business Name *</label><input type="text" name="businessName" required></div>
<div><label>Client Email *</label><input type="email" name="clientEmail" required></div>
<div><label>Phone</label><input type="text" name="clientPhone"></div>
<div><label>Website</label><input type="url" name="website"></div>
<div><label>From Name</label><input type="text" name="fromName"></div>
<div><label>From Email</label><input type="email" name="fromEmail"></div>
<div style="grid-column:1/-1"><label>Offer Drive Folder</label><input type="url" name="offerFolderUrl"></div>
<div style="grid-column:1/-1"><label>Backend Drive Folder</label><input type="url" name="backendFolderUrl"></div>
<div><label>Domain</label><input type="text" name="domain"></div>
<div><label>Price</label><input type="number" name="price"></div>
<div style="grid-column:1/-1"><label>VSL Link</label><input type="url" name="vslLink"></div>
</div><button type="submit" class="auth-btn" style="width:100%">▶ Start Onboarding</button></form>
<div id="manual-log" class="log" style="display:none;margin-top:12px"></div></div></div>
<div class="stats"><div class="stat"><div class="stat-label">Total</div><div class="stat-value" id="s-total">—</div></div>
<div class="stat"><div class="stat-label">Success</div><div class="stat-value" id="s-ok">—</div><div class="stat-label" id="s-rate">—</div></div>
<div class="stat"><div class="stat-label">Failed</div><div class="stat-value" id="s-err">—</div></div>
<div class="stat"><div class="stat-label">Pending</div><div class="stat-value" id="s-pend">—</div></div></div>
<section><h2>Pending</h2><div id="pending-list"></div></section>
<section><h2>Job History <span id="job-count">0</span></h2><div id="jobs"></div></section>
</main>
<script>
var BASE=location.pathname.replace(/\\/[^/]*$/,"");
refresh();setInterval(refresh,30000);
document.getElementById("manual-btn").onclick=function(e){e.preventDefault();document.getElementById("manual-modal").style.display="flex"};
document.getElementById("modal-close").onclick=function(){document.getElementById("manual-modal").style.display="none"};
document.getElementById("manual-modal").onclick=function(e){if(e.target===this)this.style.display="none"};
document.getElementById("manual-form").onsubmit=async function(e){
  e.preventDefault();var d=Object.fromEntries(new FormData(this));
  var b=this.querySelector(".auth-btn");b.textContent="Running...";b.disabled=true;
  var lg=document.getElementById("manual-log");lg.style.display="block";lg.textContent="";
  var r=await fetch(BASE+"/api/onboard",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});
  var j=await r.json();poll(j.jobId,lg,function(){b.textContent="▶ Start Onboarding";b.disabled=false;refresh()});
};
function poll(id,lg,done){
  fetch(BASE+"/api/status/"+encodeURIComponent(id)).then(function(r){return r.json()}).then(function(j){
    lg.textContent=(j.logs||[]).map(function(l){return l.msg}).join("\\n");
    if(j.status==="running")setTimeout(function(){poll(id,lg,done)},1500);else if(done)done();
  });
}
async function refresh(){
  try{
    var [jr,pr,or]=await Promise.all([
      fetch(BASE+"/api/jobs").then(function(r){return r.json()}),
      fetch(BASE+"/api/pending").then(function(r){return r.json()}),
      fetch(BASE+"/api/oauth-status").then(function(r){return r.json()})
    ]);
    document.getElementById("updated").textContent="Updated "+new Date().toLocaleTimeString();
    document.getElementById("oauth-badge").textContent=or.configured?"✅ GHL Connected":"";
    document.getElementById("s-pend").textContent=pr.length;
    var t=jr.length,ok=jr.filter(function(j){return j.status==="complete"}).length;
    document.getElementById("s-total").textContent=t;
    document.getElementById("s-ok").textContent=ok;
    document.getElementById("s-rate").textContent=t?Math.round(ok/t*100)+"% success":"—";
    document.getElementById("s-err").textContent=jr.filter(function(j){return j.status==="error"}).length;
    document.getElementById("job-count").textContent=t;
    var el=document.getElementById("jobs");el.textContent="";
    if(!t){el.textContent="No jobs yet.";return}
    jr.forEach(function(j){
      var c=document.createElement("div");c.className="card";
      var r=j.result||{};
      var h=document.createElement("div");
      h.appendChild(document.createTextNode((j.clientKey||"manual")+" "));
      var b=document.createElement("span");b.className="badge badge-"+j.status;b.textContent=j.status;h.appendChild(b);c.appendChild(h);
      if(j.startedAt){var m=document.createElement("div");m.className="card-meta";m.textContent=new Date(j.startedAt).toLocaleString();c.appendChild(m);}
      var st=document.createElement("div");st.className="steps";
      (r.steps||[]).forEach(function(s){var d=document.createElement("div");d.className="step-"+(s.status==="ok"?"ok":s.status==="pending"?"pending":"warn");d.textContent=s.label;st.appendChild(d)});
      c.appendChild(st);
      if(r.locationUrl){var a=document.createElement("a");a.className="ghl-link";a.href=r.locationUrl;a.target="_blank";a.textContent="Open in GHL →";c.appendChild(a)}
      if(j.status==="complete_partial"||j.manualStepsNeeded){
        var cs=document.createElement("div");cs.style.cssText="margin-top:12px;border-top:1px solid #e5e5e5;padding-top:12px";
        cs.appendChild(Object.assign(document.createElement("div"),{textContent:"🔑 Complete Setup",style:"font-size:12px;font-weight:600;color:#2563eb;margin-bottom:6px"}));
        var pr2=document.createElement("div");pr2.style.cssText="display:flex;gap:8px;margin-bottom:8px";
        var pi=document.createElement("input");pi.type="text";pi.placeholder="pit-xxxxxxxx...";pi.style.cssText="flex:1;font-size:12px";
        var pb=document.createElement("button");pb.className="auth-btn";pb.style.cssText="padding:6px 12px;font-size:12px";pb.textContent="▶ Complete";
        pr2.appendChild(pi);pr2.appendChild(pb);cs.appendChild(pr2);
        var pl=document.createElement("div");pl.className="log";pl.style.display="none";cs.appendChild(pl);
        (function(jid,inp,btn,lg){
          btn.onclick=async function(){
            var tk=inp.value.trim();if(!tk)return;btn.textContent="Running...";btn.disabled=true;lg.style.display="block";
            var r2=await fetch(BASE+"/api/complete/"+encodeURIComponent(jid),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({locationToken:tk})});
            var d2=await r2.json();poll(d2.jobId,lg,function(){btn.textContent="▶ Complete";btn.disabled=false;refresh()});
          };
        })(j.id,pi,pb,pl);
        var cb=document.createElement("button");cb.className="auth-btn";cb.style.cssText="padding:4px 10px;font-size:11px;background:#6b7280;margin-top:4px";cb.textContent="📋 Copy Values";
        (function(jid,btn){
          btn.onclick=async function(){
            var sr=await fetch(BASE+"/api/status/"+encodeURIComponent(jid)).then(function(r){return r.json()});
            var cv=sr.result&&sr.result.customValues||{};
            var txt=Object.keys(cv).filter(function(k){return cv[k]}).map(function(k){return k+": "+cv[k]}).join("\\n");
            navigator.clipboard.writeText(txt).then(function(){btn.textContent="✅ Copied!";setTimeout(function(){btn.textContent="📋 Copy Values"},2000)});
          };
        })(j.id,cb);
        cs.appendChild(cb);c.appendChild(cs);
      }
      el.appendChild(c);
    });
    var pe=document.getElementById("pending-list");pe.textContent="";
    if(!pr.length){pe.textContent="No pending clients.";return}
    pr.forEach(function(p){
      var c=document.createElement("div");c.className="card";
      c.appendChild(Object.assign(document.createElement("strong"),{textContent:p.clientKey||"(unknown)"}));
      var m=document.createElement("div");m.className="card-meta";m.textContent="Detected: "+(p.detectedAt?new Date(p.detectedAt).toLocaleString():"—")+" · "+p.source;c.appendChild(m);
      if(p.status==="pending"){
        var f=document.createElement("form");
        var fs=document.createElement("div");fs.style.cssText="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0";
        var ni=document.createElement("input");ni.type="text";ni.name="businessName";ni.placeholder="Business Name";ni.value=p.businessName||p.clientKey||"";ni.required=true;
        var ei=document.createElement("input");ei.type="email";ei.name="clientEmail";ei.placeholder="Email";ei.value=p.clientEmail||"";ei.required=true;
        fs.appendChild(ni);fs.appendChild(ei);f.appendChild(fs);
        var ab=document.createElement("button");ab.className="auth-btn";ab.type="submit";ab.textContent="▶ Run Onboarding";f.appendChild(ab);
        var al=document.createElement("div");al.className="log";al.style.display="none";f.appendChild(al);
        (function(ck,btn,lg,frm){
          frm.onsubmit=async function(e){
            e.preventDefault();var d=Object.fromEntries(new FormData(frm));btn.textContent="Running...";btn.disabled=true;lg.style.display="block";
            var r=await fetch(BASE+"/api/approve/"+encodeURIComponent(ck),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});
            var j=await r.json();poll(j.jobId,lg,function(){btn.textContent="▶ Run";btn.disabled=false;refresh()});
          };
        })(p.clientKey,ab,al,f);
        c.appendChild(f);
      }
      pe.appendChild(c);
    });
  }catch(e){console.error(e)}
}
</script></body></html>`;
}

// ── Request Router ──────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const clientId = env.CLIENT_ID || 'steve-ghl';
    // Strip the /steve-ghl/ prefix if behind the clients proxy
    let path = url.pathname;
    const prefix = `/${clientId}`;
    if (path.startsWith(prefix)) path = path.slice(prefix.length) || '/';

    const method = request.method;
    const kv = env.KV;

    // ── Static pages ──
    if (method === 'GET' && (path === '/admin' || path === '/admin/')) {
      return new Response(adminPage(), { headers: { 'Content-Type': 'text/html' } });
    }
    if (method === 'GET' && (path === '/' || path === '')) {
      return Response.redirect(url.origin + `/${clientId}/admin`, 302);
    }

    // ── API: OAuth status ──
    if (method === 'GET' && path === '/api/oauth-status') {
      return json({ configured: !!env.GHL_CLIENT_ID, hasClientId: !!env.GHL_CLIENT_ID });
    }

    // ── API: List jobs ──
    if (method === 'GET' && path === '/api/jobs') {
      const jobs = await kvGetJobs(kv, clientId);
      return json(jobs.map(j => ({
        id: j.id, clientKey: j.clientKey, status: j.status,
        startedAt: j.startedAt, completedAt: j.completedAt,
        result: j.result, manualStepsNeeded: j.result?.manualStepsNeeded,
        locationUrl: j.result?.locationUrl,
      })));
    }

    // ── API: Job status ──
    if (method === 'GET' && path.startsWith('/api/status/')) {
      const jobId = decodeURIComponent(path.slice('/api/status/'.length));
      const jobs = await kvGetJobs(kv, clientId);
      const job = jobs.find(j => j.id === jobId);
      if (!job) return json({ error: 'Job not found' }, 404);
      return json(job);
    }

    // ── API: List pending ──
    if (method === 'GET' && path === '/api/pending') {
      return json(await kvGetPending(kv, clientId));
    }

    // ── Webhook: GHL form ──
    if (method === 'POST' && path === '/webhook/ghl-form') {
      const f = await request.json();
      const firstName = f['First Name'] || f.first_name || '';
      const lastName = f['Last Name'] || f.last_name || '';
      const clientKey = f['Company Name'] || f.company_name || Date.now().toString();

      const pending = await kvGetPending(kv, clientId);
      const existing = pending.find(p => p.clientKey === clientKey);
      if (!existing) {
        pending.push({
          clientKey,
          businessName: f['Company Name'] || f.company_name,
          clientEmail: f['Email'] || f.email,
          clientPhone: f['Phone'] || f.phone,
          website: f['Website'] || f.website,
          address: f['Company Address'] || f.company_address,
          fromName: `${firstName} ${lastName}`.trim(),
          fromEmail: f['Email'] || f.email,
          offerFolderUrl: f['Offer & Product Google Drive Link'] || f.offer_product_google_drive_link,
          backendFolderUrl: f['Backend Engine Google Drive Folder'] || f.backend_engine_google_drive_folder,
          silentSaleFolderUrl: f['Silent Sale Machine Drive Folder'] || f.silent_sale_machine_drive_folder,
          domain: f['Domain Name'] || f.domain_name,
          price: f['Price'] || f.price,
          vslLink: f['VSL Link'] || f.vsl_link,
          detectedAt: new Date().toISOString(),
          status: 'pending',
          source: 'webhook',
        });
        await kvSavePending(kv, clientId, pending);
      }

      return json({ received: true, clientKey, reviewUrl: '/admin' });
    }

    // ── API: Manual onboard ──
    if (method === 'POST' && path === '/api/onboard') {
      const body = await request.json();
      const clientData = {
        businessName: body.businessName || body['Company Name'],
        clientEmail: body.clientEmail || body['Email'],
        clientPhone: body.clientPhone || body['Phone'] || '',
        website: body.website || body['Website'] || '',
        address: body.address || body['Company Address'] || '',
        domain: body.domain || body['Domain Name'] || '',
        fromName: body.fromName || [body['First Name'], body['Last Name']].filter(Boolean).join(' ') || '',
        fromEmail: body.fromEmail || body['Email'] || body.clientEmail || '',
        offerFolderUrl: body.offerFolderUrl || body['Offer & Product Google Drive Link'] || '',
        backendFolderUrl: body.backendFolderUrl || body['Backend Engine Google Drive Folder'] || '',
        price: body.price || body['Price'] || '',
        vslLink: body.vslLink || body['VSL Link'] || '',
      };

      if (!clientData.businessName || !clientData.clientEmail) {
        return json({ status: 'error', error: 'Missing required client fields: businessName, clientEmail' }, 400);
      }

      const jobId = `${clientId}:manual:${Date.now()}`;
      const logs = [];
      const log = (msg) => logs.push({ time: new Date().toISOString(), msg });

      // Save initial job state
      const job = { id: jobId, clientId, clientKey: clientData.businessName, status: 'running', logs, startedAt: new Date().toISOString() };
      await kvSaveJob(kv, clientId, job);

      // Run onboarding (this blocks — OK for Workers with 30s CPU limit)
      const result = await onboardClient(clientData, env, log);
      Object.assign(job, { status: result.status, result, logs, completedAt: new Date().toISOString() });
      await kvSaveJob(kv, clientId, job);

      return json({ jobId, statusUrl: `/api/status/${encodeURIComponent(jobId)}` });
    }

    // ── API: Approve pending ──
    if (method === 'POST' && path.startsWith('/api/approve/')) {
      const clientKey = decodeURIComponent(path.slice('/api/approve/'.length));
      const pending = await kvGetPending(kv, clientId);
      const item = pending.find(p => p.clientKey === clientKey);
      if (!item) return json({ error: 'Not found' }, 404);

      const extra = await request.json();
      const clientData = { ...item, ...extra };
      const jobId = `${clientId}:${clientKey}:${Date.now()}`;
      const logs = [];
      const log = (msg) => logs.push({ time: new Date().toISOString(), msg });

      item.status = 'running';
      await kvSavePending(kv, clientId, pending);

      const job = { id: jobId, clientId, clientKey, status: 'running', logs, startedAt: new Date().toISOString() };
      await kvSaveJob(kv, clientId, job);

      const result = await onboardClient(clientData, env, log);
      Object.assign(job, { status: result.status, result, logs, completedAt: new Date().toISOString() });
      await kvSaveJob(kv, clientId, job);

      item.status = result.status;
      if (result.locationUrl) item.locationUrl = result.locationUrl;
      await kvSavePending(kv, clientId, pending);

      return json({ jobId, statusUrl: `/api/status/${encodeURIComponent(jobId)}` });
    }

    // ── API: Complete with sub-account token ──
    if (method === 'POST' && path.startsWith('/api/complete/')) {
      const parentJobId = decodeURIComponent(path.slice('/api/complete/'.length));
      const body = await request.json();
      const locationToken = body.locationToken;
      if (!locationToken) return json({ error: 'locationToken required' }, 400);

      const jobs = await kvGetJobs(kv, clientId);
      const parentJob = jobs.find(j => j.id === parentJobId);
      if (!parentJob) return json({ error: 'Job not found' }, 404);

      const locationId = parentJob.result?.locationId;
      if (!locationId) return json({ error: 'No locationId in original job' }, 400);

      const jobId = `${parentJobId}:resume:${Date.now()}`;
      const logs = [];
      const log = (msg) => logs.push({ time: new Date().toISOString(), msg });

      const job = { id: jobId, clientId, clientKey: parentJob.clientKey, status: 'running', logs, startedAt: new Date().toISOString(), parentJobId };
      await kvSaveJob(kv, clientId, job);

      const result = await completeSetup(locationToken, locationId, parentJob.result || {}, env, log);
      Object.assign(job, { status: result.status, result, logs, completedAt: new Date().toISOString() });
      await kvSaveJob(kv, clientId, job);

      if (result.status === 'complete') {
        parentJob.status = 'complete';
        if (parentJob.result) parentJob.result.needsLocationToken = false;
        await kvSaveJob(kv, clientId, parentJob);
      }

      return json({ jobId, statusUrl: `/api/status/${encodeURIComponent(jobId)}` });
    }

    // ── OAuth install redirect ──
    if (method === 'GET' && path === '/oauth/install') {
      if (!env.GHL_CLIENT_ID) return json({ error: 'OAuth not configured' }, 500);
      const redirectUri = `${url.origin}/${clientId}/oauth/callback`;
      const scopes = 'oauth.write oauth.readonly locations/customValues.write locations/customValues.readonly products.write products/prices.write emails/builder.write';
      const oauthUrl = `https://marketplace.gohighlevel.com/oauth/chooselocation?response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${env.GHL_CLIENT_ID}&scope=${encodeURIComponent(scopes)}`;
      return Response.redirect(oauthUrl, 302);
    }

    // ── OAuth callback ──
    if (method === 'GET' && path === '/oauth/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing code', { status: 400 });

      try {
        const redirectUri = `${url.origin}/${clientId}/oauth/callback`;
        const tokenRes = await fetch('https://services.leadconnectorhq.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `client_id=${env.GHL_CLIENT_ID}&client_secret=${env.GHL_CLIENT_SECRET}&grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}`,
        });
        const tokenData = await tokenRes.json();

        if (tokenData.access_token) {
          // Store the OAuth token for this location
          await kvPut(kv, `${clientId}:oauth:${tokenData.locationId || 'default'}`, tokenData);
        }

        return Response.redirect(`${url.origin}/${clientId}/admin`, 302);
      } catch (e) {
        return new Response('OAuth error: ' + e.message, { status: 500 });
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
