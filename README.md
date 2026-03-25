# GHL Client Onboarding Tool

One-click automation that builds a complete GHL funnel from your Master Snapshot.

## What it does

1. Creates a new GHL sub-account for the client
2. Loads your Master Snapshot (all funnel pages, pipelines, templates)
3. Reads the client's sales copy Google Doc (or form input)
4. Populates all funnel page variables with client copy
5. Creates products (main + upsells)
6. Creates post-purchase thank you emails
7. Sets up the custom domain

**Result:** Full funnel live in GHL in under 2 minutes.

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Edit `.env` with your values:
```
GHL_API_KEY=your_agency_api_key
GHL_COMPANY_ID=your_company_id
MASTER_SNAPSHOT_ID=your_snapshot_id
```

**Where to find these:**
- **GHL_API_KEY**: Agency view → Settings → API Keys → Create key with full permissions
- **GHL_COMPANY_ID**: Agency view → Settings → Company → Company ID field
- **MASTER_SNAPSHOT_ID**: Agency view → Snapshots → click your snapshot → ID in the URL

### 3. (Optional) Google Docs auto-parsing

To auto-read client Google Docs:
1. Create a Google Cloud Service Account
2. Download the JSON key file → save as `google-service-account.json`
3. Share each client's Google Doc with the service account email

If you skip this, just enter sales copy manually in the form.

---

## Running

### Web UI (recommended)
```bash
npm start
```
Open `http://localhost:3000` — fill in the form and click Start.

### GHL Form Webhook
Point your GHL form's webhook to:
```
POST http://YOUR_SERVER:3000/webhook/ghl-form
```
The tool will run automatically on every form submission.

### CLI (for testing)
```bash
node onboard.js client.json
```

Example `client.json`:
```json
{
  "businessName": "Acme Corp",
  "clientEmail": "client@example.com",
  "clientPhone": "+1 555-123-4567",
  "domain": "acmecorp.com",
  "timezone": "America/New_York",
  "salesCopyDocUrl": "https://docs.google.com/document/d/YOUR_DOC_ID/edit",
  "productName": "Amazing Course",
  "productPrice": "197",
  "downloadUrl": "https://drive.google.com/...",
  "fromName": "John Smith",
  "fromEmail": "john@acmecorp.com"
}
```

---

## Google Doc Format

The tool reads labeled sections from your sales copy doc:

```
HEADLINE: Your amazing headline here
SUBHEADLINE: The subheadline text
PRODUCT NAME: Amazing Course
PRICE: 197
PRODUCT DESCRIPTION: The complete guide to...
DOWNLOAD URL: https://...
UPSELL 1 NAME: VIP Upgrade
UPSELL 1 PRICE: 97
UPSELL 1 DESCRIPTION: Exclusive bonus...
UPSELL 1 DOWNLOAD URL: https://...
THANK YOU SUBJECT: Thank you for your purchase!
FROM NAME: John Smith
FROM EMAIL: john@acmecorp.com
```

---

## Custom Values in GHL

The Master Snapshot funnel pages should use these custom value placeholders:

| GHL Custom Value | Content |
|---|---|
| `{{custom_value.business_name}}` | Client business name |
| `{{custom_value.sales_headline}}` | Sales page headline |
| `{{custom_value.sales_subheadline}}` | Sales page subheadline |
| `{{custom_value.product_name}}` | Main product name |
| `{{custom_value.product_price}}` | Main product price |
| `{{custom_value.download_url}}` | Product download link |
| `{{custom_value.upsell_1_name}}` | Upsell 1 name |
| `{{custom_value.upsell_1_price}}` | Upsell 1 price |
| `{{custom_value.upsell_2_name}}` | Upsell 2 name |
| `{{custom_value.upsell_2_price}}` | Upsell 2 price |
| `{{custom_value.from_name}}` | Email sender name |

---

## Hosting

For the webhook to work, deploy to any Node.js host:
- **Railway**: `railway up` (free tier available)
- **Render**: connect repo, set env vars, deploy
- **VPS**: `pm2 start server.js`
