/**
 * Example: How an agent connects to the browser running in the container.
 *
 * The browser is already running inside Docker with CDP exposed on port 9222.
 * The agent connects via connectOverCDP() and controls it programmatically.
 * Meanwhile, a human can watch and intervene via noVNC at http://<host>:6080/vnc.html
 *
 * Usage (from the host machine):
 *   node agent-example.js
 */
const { chromium } = require('playwright');

async function main() {
  // Connect to the browser running inside the container
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  console.log('Connected to browser via CDP');

  // Get existing context (the persistent one from the container)
  const contexts = browser.contexts();
  const context = contexts[0];

  // Get existing page or create new one
  const pages = context.pages();
  const page = pages[0] || await context.newPage();

  // === Agent does its thing ===
  console.log('Navigating to example.com...');
  await page.goto('https://example.com');
  console.log('Title:', await page.title());

  // Take a screenshot (agent can "see" what it's doing)
  await page.screenshot({ path: '/tmp/agent-screenshot.png' });
  console.log('Screenshot saved to /tmp/agent-screenshot.png');

  // Example: interact with a page
  const heading = await page.locator('h1').textContent();
  console.log('H1 text:', heading);

  // If the agent hits a Google login, it can:
  // 1. Navigate there
  // 2. Wait for the human to intervene via noVNC
  // 3. Continue after login is detected
  //
  // Example:
  // await page.goto('https://accounts.google.com');
  // console.log('Waiting for human to complete Google login via noVNC...');
  // await page.waitForURL('https://myaccount.google.com/**', { timeout: 300000 });
  // console.log('Login complete! Continuing automation...');

  // Disconnect (doesn't close the browser — it keeps running in the container)
  await browser.close();  // this only disconnects, browser stays alive
  console.log('Agent disconnected. Browser still running in container.');
}

main().catch(console.error);
