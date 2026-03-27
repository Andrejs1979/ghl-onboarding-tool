// Google Docs & Drive parser
// Reads Drive folders submitted from Steve's GHL intake form,
// identifies docs by name, and extracts funnel copy for GHL custom values.

const { google } = require('googleapis');
const fs = require('fs');

// ─────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────

function getAuth() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || './google-service-account.json';
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Google Service Account key not found at ${keyPath}. Provide the key file or use manual input.`);
  }
  return new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: [
      'https://www.googleapis.com/auth/documents.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
}

function getDriveClient() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

function getDocsClient() {
  return google.docs({ version: 'v1', auth: getAuth() });
}

// ─────────────────────────────────────────────────────────────────────
// DRIVE FOLDER HELPERS
// ─────────────────────────────────────────────────────────────────────

// Extract folder ID from a Google Drive folder URL
function extractFolderId(url) {
  const match = url.match(/\/folders\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error(`Invalid Google Drive folder URL: ${url}`);
  return match[1];
}

// Extract doc ID from a Google Docs URL
function extractDocId(url) {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error(`Invalid Google Docs URL: ${url}`);
  return match[1];
}

// List all Google Docs in a Drive folder
async function listDocsInFolder(folderUrl) {
  const folderId = extractFolderId(folderUrl);
  const drive = getDriveClient();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.document' and trashed = false`,
    fields: 'files(id, name, mimeType)',
    pageSize: 50,
  });
  return res.data.files || [];
}

// Read all text from a Google Doc (plain text, preserving paragraph structure)
async function readDocText(docId) {
  const docs = getDocsClient();
  const res = await docs.documents.get({ documentId: docId });
  const content = res.data.body.content;
  const lines = [];
  for (const element of content) {
    if (!element.paragraph) continue;
    const text = element.paragraph.elements
      .map(e => e.textRun?.content || '')
      .join('')
      .trim();
    if (text) lines.push(text);
  }
  return lines.join('\n');
}

// Read a Google Doc with heading-level info (for section-format docs)
async function readDocStructured(docId) {
  const docs = getDocsClient();
  const res = await docs.documents.get({ documentId: docId });
  const content = res.data.body.content;
  const paragraphs = [];
  for (const element of content) {
    if (!element.paragraph) continue;
    const text = element.paragraph.elements
      .map(e => e.textRun?.content || '')
      .join('')
      .trim();
    if (!text) continue;
    const style = element.paragraph.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
    paragraphs.push({ text, style });
  }
  return paragraphs;
}

// ─────────────────────────────────────────────────────────────────────
// FOLDER PARSERS
// ─────────────────────────────────────────────────────────────────────

// Identify a doc's role by its filename
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

// Parse a Sales Page Copy doc (ClientSpring section format)
// Returns: { salesHeadline, salesSubheadline, mainProductName, mainProductPrice, mainProductDescription }
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

  // Extract from header section
  const headerLines = sections['header'] || [];
  const attentionLine = headerLines.find(l => l.toUpperCase().startsWith('ATTENTION'));
  const introLine = headerLines.find(l => l.toUpperCase().startsWith('INTRODUCING'));
  const headlineLines = headerLines.filter(l =>
    !l.toUpperCase().startsWith('ATTENTION') &&
    !l.toUpperCase().startsWith('INTRODUCING')
  );

  if (attentionLine) data.salesSubheadline = attentionLine;
  if (headlineLines.length > 0) {
    data.salesHeadline = headlineLines.reduce((a, b) => (a.length >= b.length ? a : b));
  }
  if (introLine) {
    const match = introLine.match(/Introducing\s+(.+?)(?:\s*[:—]|$)/i);
    if (match) data.mainProductName = match[1].trim();
  }

  // Extract price
  const priceLines = sections['price'] || [];
  for (const line of priceLines) {
    const match = line.match(/\$\s*(\d+(?:\.\d{2})?)/);
    if (match) { data.mainProductPrice = match[1]; break; }
  }

  // Extract description from solution section
  const solLines = sections['solution'] || [];
  if (solLines.length > 0) {
    data.mainProductDescription = solLines.slice(0, 3).join(' ');
  }

  return data;
}

// Parse an upsell Sales Page doc — same structure as main sales page
// Returns: { name, headline, price, description }
function parseUpsellSalesPageDoc(paragraphs) {
  const base = parseSalesPageDoc(paragraphs);
  return {
    name: base.mainProductName || '',
    headline: base.salesHeadline || '',
    price: base.mainProductPrice || '',
    description: base.mainProductDescription || '',
  };
}

// Parse a Thank You Email doc — extract subject line and body
function parseThankYouEmailDoc(paragraphs) {
  const lines = paragraphs.map(p => p.text);
  let subject = '';
  let bodyLines = [];
  let inBody = false;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('SUBJECT:') || upper.startsWith('EMAIL SUBJECT:')) {
      subject = line.replace(/^.*?:\s*/i, '').trim();
    } else if (upper.includes('BODY') || upper.includes('EMAIL BODY') || inBody) {
      inBody = true;
      if (!upper.includes('BODY')) bodyLines.push(line);
    }
  }

  // Fallback: first non-empty line is subject, rest is body
  if (!subject && lines.length > 0) {
    subject = lines[0];
    bodyLines = lines.slice(1);
  }

  return {
    subject,
    body: bodyLines.join('\n').trim(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// MAIN FOLDER PARSER — called from onboard.js
// ─────────────────────────────────────────────────────────────────────

// Parse the "Offer & Product" Drive folder (ClientSpring AI folder)
// Returns structured sales data for the main offer
async function parseOfferFolder(folderUrl) {
  const files = await listDocsInFolder(folderUrl);
  const data = {};

  for (const file of files) {
    const role = identifyDoc(file.name);
    if (!role) continue;

    const paragraphs = await readDocStructured(file.id);

    if (role === 'salesPage') {
      const parsed = parseSalesPageDoc(paragraphs);
      Object.assign(data, parsed);
      // Store the doc URL as a reference
      data.salesPageDocUrl = `https://docs.google.com/document/d/${file.id}/edit`;
    }

    if (role === 'thankYouEmail') {
      const parsed = parseThankYouEmailDoc(paragraphs);
      data.thankYouEmailSubject = parsed.subject;
      data.thankYouEmailBody = parsed.body;
      // Brief: "Puts the URL link to the Google Doc in the download URL link in the emails"
      data.downloadUrl = `https://docs.google.com/document/d/${file.id}/edit`;
    }
  }

  return data;
}

// Parse the "Backend Engine" Drive folder (upsell pages, scripts)
// Returns upsell data (upsell1*, upsell2*)
async function parseBackendFolder(folderUrl) {
  const files = await listDocsInFolder(folderUrl);
  const data = {};

  for (const file of files) {
    const role = identifyDoc(file.name);
    if (!role) continue;

    const paragraphs = await readDocStructured(file.id);

    if (role === 'upsell1SalesPage') {
      const parsed = parseUpsellSalesPageDoc(paragraphs);
      data.upsell1Name = parsed.name || data.upsell1Name;
      data.upsell1Price = parsed.price || data.upsell1Price;
      data.upsell1Description = parsed.description || data.upsell1Description;
    }

    if (role === 'upsell1ThankYou') {
      const parsed = parseThankYouEmailDoc(paragraphs);
      data.upsell1ThankYouSubject = parsed.subject;
      data.upsell1ThankYouBody = parsed.body;
      data.upsell1DownloadUrl = `https://docs.google.com/document/d/${file.id}/edit`;
    }

    if (role === 'upsell1Product') {
      const text = paragraphs.map(p => p.text).join('\n');
      // Extract product name and URL from product doc (only if not already set from thank-you doc)
      const urlMatch = text.match(/https?:\/\/[^\s]+/);
      if (urlMatch && !data.upsell1DownloadUrl) data.upsell1DownloadUrl = urlMatch[0];
      if (!data.upsell1Name) {
        const nameMatch = text.match(/(?:product|offer|name)[:\s]+(.+)/i);
        if (nameMatch) data.upsell1Name = nameMatch[1].trim();
      }
    }

    if (role === 'upsell2SalesPage') {
      const parsed = parseUpsellSalesPageDoc(paragraphs);
      data.upsell2Name = parsed.name || data.upsell2Name;
      data.upsell2Price = parsed.price || data.upsell2Price;
      data.upsell2Description = parsed.description || data.upsell2Description;
    }

    if (role === 'upsell2ThankYou') {
      const parsed = parseThankYouEmailDoc(paragraphs);
      data.upsell2ThankYouSubject = parsed.subject;
      data.upsell2ThankYouBody = parsed.body;
      data.upsell2DownloadUrl = `https://docs.google.com/document/d/${file.id}/edit`;
    }

    if (role === 'upsell2Delivery') {
      const text = paragraphs.map(p => p.text).join('\n');
      const urlMatch = text.match(/https?:\/\/[^\s]+/);
      if (urlMatch && !data.upsell2DownloadUrl) data.upsell2DownloadUrl = urlMatch[0];
    }
  }

  return data;
}

// ─────────────────────────────────────────────────────────────────────
// LEGACY: single-doc label format (kept for backward compat)
// ─────────────────────────────────────────────────────────────────────

function parseSalesCopyDoc(text) {
  const data = {};
  const labelMap = {
    'HEADLINE': 'salesHeadline',
    'SUBHEADLINE': 'salesSubheadline',
    'PRICE': 'mainProductPrice',
    'PRODUCT NAME': 'mainProductName',
    'PRODUCT DESCRIPTION': 'mainProductDescription',
    'UPSELL 1 NAME': 'upsell1Name',
    'UPSELL 1 PRICE': 'upsell1Price',
    'UPSELL 1 DESCRIPTION': 'upsell1Description',
    'UPSELL 2 NAME': 'upsell2Name',
    'UPSELL 2 PRICE': 'upsell2Price',
    'UPSELL 2 DESCRIPTION': 'upsell2Description',
    'THANK YOU SUBJECT': 'thankYouEmailSubject',
    'THANK YOU BODY': 'thankYouEmailBody',
    'DOWNLOAD URL': 'downloadUrl',
    'FROM EMAIL': 'fromEmail',
    'FROM NAME': 'fromName',
  };
  for (const line of text.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const label = line.substring(0, colonIdx).trim().toUpperCase();
    const value = line.substring(colonIdx + 1).trim();
    if (labelMap[label]) data[labelMap[label]] = value;
  }
  return data;
}

async function readDoc(docUrl) {
  const docId = extractDocId(docUrl);
  const paragraphs = await readDocStructured(docId);
  return paragraphs.map(p => p.text).join('\n');
}

async function parseSalesCopyFromDoc(docUrl) {
  const docId = extractDocId(docUrl);
  const paragraphs = await readDocStructured(docId);
  return parseSalesPageDoc(paragraphs);
}

module.exports = {
  parseOfferFolder,
  parseBackendFolder,
  listDocsInFolder,
  readDoc,
  parseSalesCopyDoc,
  parseSalesCopyFromDoc,
  extractDocId,
  extractFolderId,
};
