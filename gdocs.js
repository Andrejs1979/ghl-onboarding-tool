// Google Docs parser — reads a client's sales copy or product doc
// and returns structured data for use in funnel variables

const { google } = require('googleapis');
const fs = require('fs');

// Extract doc ID from a Google Docs URL
function extractDocId(url) {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error(`Invalid Google Docs URL: ${url}`);
  return match[1];
}

// Initialize Google Docs client
// Uses a Service Account key (JSON file) for server-to-server auth
// The doc must be shared with the service account email
function getDocsClient() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || './google-service-account.json';

  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Google Service Account key not found at ${keyPath}.\n` +
      `Either provide the key file, or use manual input mode.`
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/documents.readonly'],
  });

  return google.docs({ version: 'v1', auth });
}

// Read all text from a Google Doc
async function readDoc(docUrl) {
  const docId = extractDocId(docUrl);
  const docs = getDocsClient();
  const res = await docs.documents.get({ documentId: docId });

  // Flatten all paragraph text into plain string
  const content = res.data.body.content;
  const lines = [];

  for (const element of content) {
    if (element.paragraph) {
      const text = element.paragraph.elements
        .map(e => e.textRun?.content || '')
        .join('')
        .trim();
      if (text) lines.push(text);
    }
  }

  return lines.join('\n');
}

// Parse a sales copy doc into structured variables for GHL custom values
// The doc should follow a simple structure with labeled sections
// e.g.: "HEADLINE: Your Amazing Product"
//       "SUBHEADLINE: Transform your life..."
//       "PRICE: 197"
function parseSalesCopyDoc(text) {
  const data = {};
  const lines = text.split('\n');

  // Label-based extraction (e.g. "HEADLINE: text here")
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
    'UPSELL 1 DOWNLOAD URL': 'upsell1DownloadUrl',
    'UPSELL 2 DOWNLOAD URL': 'upsell2DownloadUrl',
    'FROM EMAIL': 'fromEmail',
    'FROM NAME': 'fromName',
  };

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const label = line.substring(0, colonIdx).trim().toUpperCase();
    const value = line.substring(colonIdx + 1).trim();

    if (labelMap[label]) {
      data[labelMap[label]] = value;
    }
  }

  return data;
}

// Read and parse a sales copy Google Doc
async function parseSalesCopyFromDoc(docUrl) {
  const text = await readDoc(docUrl);
  return parseSalesCopyDoc(text);
}

module.exports = {
  readDoc,
  parseSalesCopyDoc,
  parseSalesCopyFromDoc,
  extractDocId,
};
