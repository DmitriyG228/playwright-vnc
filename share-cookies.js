/**
 * Export cookies from one browser and import into others.
 *
 * Usage:
 *   node share-cookies.js export 9222          # export from browser-1
 *   node share-cookies.js import 9224          # import into browser-2
 *   node share-cookies.js import 9226          # import into browser-3
 *   node share-cookies.js sync                 # export from 9222, import into all others
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const ALL_PORTS = [9222, 9224, 9226];

async function exportCookies(port) {
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const context = browser.contexts()[0];
  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  console.log(`Exported ${cookies.length} cookies from port ${port} → ${COOKIES_FILE}`);
  await browser.close();
}

async function importCookies(port) {
  if (!fs.existsSync(COOKIES_FILE)) {
    console.error(`No cookies file found. Run: node share-cookies.js export <port>`);
    process.exit(1);
  }
  const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const context = browser.contexts()[0];
  await context.addCookies(cookies);
  console.log(`Imported ${cookies.length} cookies into port ${port}`);
  await browser.close();
}

async function sync() {
  const sourcePort = ALL_PORTS[0];
  await exportCookies(sourcePort);
  for (const port of ALL_PORTS.slice(1)) {
    await importCookies(port);
  }
  console.log('All browsers synced.');
}

const [action, port] = process.argv.slice(2);

if (action === 'export') {
  exportCookies(parseInt(port || 9222)).catch(console.error);
} else if (action === 'import') {
  importCookies(parseInt(port || 9224)).catch(console.error);
} else if (action === 'sync') {
  sync().catch(console.error);
} else {
  console.log('Usage:');
  console.log('  node share-cookies.js export 9222   # export from browser-1');
  console.log('  node share-cookies.js import 9224   # import into browser-2');
  console.log('  node share-cookies.js sync          # export from 9222, import into all others');
}
