// Quick test: parse a Drive folder and print what was extracted
// Usage: node test-parse.js <folder-url>
//   e.g. node test-parse.js "https://drive.google.com/drive/folders/1XXXTVC0laJDvjUSWh6ltYtBtXKoNFDfb"
require('dotenv').config();

const { parseOfferFolder, parseBackendFolder } = require('./gdocs');

async function main() {
  const url = process.argv[2];
  const type = process.argv[3] || 'offer'; // 'offer' or 'backend'

  if (!url) {
    console.error('Usage: node test-parse.js <folder-url> [offer|backend]');
    process.exit(1);
  }

  console.log(`\nParsing ${type} folder: ${url}\n`);

  try {
    const data = type === 'backend'
      ? await parseBackendFolder(url)
      : await parseOfferFolder(url);

    console.log('Extracted fields:');
    for (const [key, value] of Object.entries(data)) {
      const display = typeof value === 'string' && value.length > 80
        ? value.slice(0, 80) + '...'
        : value;
      console.log(`  ${key}: ${display}`);
    }
    console.log(`\nTotal fields: ${Object.keys(data).length}`);
  } catch (err) {
    console.error('Parse failed:', err.message);
    if (err.message.includes('key not found')) {
      console.error('\n→ Place google-service-account.json in the project root (or set GOOGLE_SERVICE_ACCOUNT_KEY in .env)');
    }
  }
}

main();
