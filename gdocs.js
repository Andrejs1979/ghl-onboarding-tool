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

  // Fallback product name extraction: look for "The X" pattern in headings,
  // or use the first HEADING_2/HEADING_3 that looks like a product title
  if (!data.mainProductName) {
    // Try: lines containing "The [Something] Method/System/Guide/Course/Toolkit/Roadmap/Checklist/Blueprint/Program"
    const allLines = paragraphs.map(p => p.text);
    for (const line of allLines) {
      const prodMatch = line.match(/\b(The\s+[\w\s]+(?:Method|System|Guide|Course|Toolkit|Roadmap|Checklist|Blueprint|Program|Audit|Framework|Playbook|Masterclass|Workshop|Academy))\b/i);
      if (prodMatch) {
        data.mainProductName = prodMatch[1].trim();
        break;
      }
    }
  }
  // Further fallback: first heading that isn't a section label
  if (!data.mainProductName) {
    const sectionLabels = /^(header|headline|price|offer|solution|product|section|body|footer|cta|call to action|benefits|features|guarantee|testimonial|faq|bonus)/i;
    for (const para of paragraphs) {
      if (para.style.startsWith('HEADING') && !sectionLabels.test(para.text.trim()) && para.text.trim().length > 3 && para.text.trim().length < 80) {
        data.mainProductName = para.text.trim();
        break;
      }
    }
  }

  // Extract price — search all paragraphs if no price section exists
  const priceLines = sections['price'] || [];
  for (const line of priceLines) {
    const match = line.match(/\$\s*(\d+(?:\.\d{2})?)/);
    if (match) { data.mainProductPrice = match[1]; break; }
  }
  if (!data.mainProductPrice) {
    for (const para of paragraphs) {
      const match = para.text.match(/\$\s*(\d+(?:\.\d{2})?)/);
      if (match) { data.mainProductPrice = match[1]; break; }
    }
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
  let name = base.mainProductName || '';

  // If parseSalesPageDoc didn't find a name, try the first heading in the doc
  if (!name) {
    for (const para of paragraphs) {
      if (para.style.startsWith('HEADING') && para.text.trim().length > 3 && para.text.trim().length < 80) {
        name = para.text.trim();
        break;
      }
    }
  }

  return {
    name,
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
  const subjectOptions = [];

  for (const line of lines) {
    const upper = line.toUpperCase().trim();

    // Skip separator lines
    if (/^[─━\-=]{5,}$/.test(line.trim())) continue;
    // Skip section headers — but set inBody flag when we pass EMAIL BODY
    if (upper === 'EMAIL BODY' || upper === 'BODY') { inBody = true; continue; }
    if (upper === 'SUBJECT LINES' || upper === 'SUBJECT LINE' || upper === 'PREVIEW TEXT') continue;
    if (upper.match(/^SUBJECT LINES?\s*\(.*\)$/)) continue;

    if (upper.startsWith('SUBJECT:') || upper.startsWith('EMAIL SUBJECT:')) {
      subject = line.replace(/^.*?:\s*/i, '').trim();
    } else if (upper.startsWith('OPTION') && upper.includes(':') && !inBody) {
      subjectOptions.push(line.replace(/^Option\s*\d+:\s*/i, '').trim());
    } else if (inBody) {
      bodyLines.push(line);
    }
  }

  // Use first subject option if no explicit "SUBJECT:" was found
  if (!subject && subjectOptions.length > 0) {
    subject = subjectOptions[0];
  }

  // Fallback: first non-empty, non-separator line is subject, rest is body
  if (!subject && lines.length > 0) {
    const contentLines = lines.filter(l => !/^[─━─\-=]{5,}$/.test(l.trim()) && l.trim());
    subject = contentLines[0] || lines[0];
    bodyLines = contentLines.slice(1);
  }

  // Clean up body: strip separators, replace [DOWNLOAD LINK] / [BOOKING LINK] placeholders
  const cleanedBody = bodyLines
    .filter(l => !/^[─━─\-=]{5,}$/.test(l.trim()))
    .filter(l => {
      const u = l.trim().toUpperCase();
      return u !== 'SUBJECT LINES' && u !== 'PREVIEW TEXT' && u !== 'EMAIL BODY' && !u.match(/^SUBJECT LINES?\s*\(.*\)$/);
    })
    .join('\n')
    .replace(/\[DOWNLOAD[^\]]*(?:LINK|HERE)\]/gi, '{{download_link}}')
    .replace(/\[BOOK[^\]]*(?:LINK|HERE|CALL|SESSION)\]/gi, '{{booking_link}}')
    .replace(/\[CALENDLY\s+LINK\]/gi, '{{booking_link}}')
    .trim();

  return {
    subject,
    body: cleanedBody,
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
      // Extract actual download URL from doc content (external links, Drive files)
      const docText = paragraphs.map(p => p.text).join('\n');
      const externalUrl = docText.match(/https?:\/\/(?!docs\.google\.com\/document)[^\s\])<]+/);
      if (externalUrl) {
        data.downloadUrl = externalUrl[0];
      } else {
        // Fallback: use the doc itself (Steve's original intent — link to the Google Doc as the deliverable)
        data.downloadUrl = `https://docs.google.com/document/d/${file.id}/edit`;
      }
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
      // Extract product name and URL from product doc (only if not already set)
      const urlMatch = text.match(/https?:\/\/[^\s]+/);
      if (urlMatch && !data.upsell1DownloadUrl) data.upsell1DownloadUrl = urlMatch[0];
      if (!data.upsell1Name) {
        // Try explicit label format first: "Product Name: X" or "Offer: X"
        const labelMatch = text.match(/(?:product\s*name|offer\s*name|name)\s*[:]\s*(.+)/i);
        if (labelMatch) {
          data.upsell1Name = labelMatch[1].trim();
        } else {
          // Try "The X Method/Toolkit/etc" pattern
          const prodMatch = text.match(/\b(The\s+[\w\s]+(?:Method|System|Guide|Course|Toolkit|Roadmap|Checklist|Blueprint|Program|Audit|Framework|Playbook))\b/i);
          if (prodMatch) data.upsell1Name = prodMatch[1].trim();
          // Last resort: first heading
          else {
            for (const para of paragraphs) {
              if (para.style.startsWith('HEADING') && para.text.trim().length > 3) {
                data.upsell1Name = para.text.trim();
                break;
              }
            }
          }
        }
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
