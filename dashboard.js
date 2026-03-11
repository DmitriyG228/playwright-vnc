/**
 * Dashboard server with cookie and browser management API.
 *
 * Usage: node dashboard.js
 * Open: http://localhost:3000
 *
 * API:
 *   POST /api/save          - Save cookies from all browsers
 *   POST /api/sync          - Export from browser-1, import to all others
 *   POST /api/create        - Spin up a new browser container
 *   POST /api/close/:id     - Stop and remove a browser container
 *   GET  /api/browsers      - List running browsers
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const PORT = process.env.DASHBOARD_PORT || 3000;
const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');
const IMAGE_NAME = 'playwright-vnc-poc-browser-1'; // built image name

function getBrowsers() {
  // Get all containers with port 6080 (noVNC) mapped
  try {
    const out = execSync(
      `docker ps --format '{{.Names}}\\t{{.Status}}\\t{{.Ports}}' | grep '6080'`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    return out.split('\n').filter(Boolean).map(line => {
      const [name, status, ports] = line.split('\t');
      const vncMatch = ports?.match(/0\.0\.0\.0:(\d+)->6080/);
      const cdpMatch = ports?.match(/0\.0\.0\.0:(\d+)->9223/);
      return {
        name,
        status,
        vncPort: vncMatch ? parseInt(vncMatch[1]) : null,
        cdpPort: cdpMatch ? parseInt(cdpMatch[1]) : null,
      };
    });
  } catch {
    return [];
  }
}

function findNextPorts() {
  const browsers = getBrowsers();
  const usedVnc = browsers.map(b => b.vncPort).filter(Boolean);
  const usedCdp = browsers.map(b => b.cdpPort).filter(Boolean);
  let vnc = 6080;
  while (usedVnc.includes(vnc)) vnc++;
  let cdp = 9222;
  while (usedCdp.includes(cdp)) cdp += 2;
  return { vnc, cdp };
}

async function saveCookies(port) {
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const context = browser.contexts()[0];
  const cookies = await context.cookies();
  await browser.close();
  return cookies;
}

async function loadCookies(port, cookies) {
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const context = browser.contexts()[0];
  await context.addCookies(cookies);
  await browser.close();
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

async function handleAPI(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // List browsers
  if (req.method === 'GET' && req.url === '/api/browsers') {
    const browsers = getBrowsers();
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, browsers }));
    return true;
  }

  // Save cookies from all browsers
  if (req.method === 'POST' && req.url === '/api/save') {
    try {
      const browsers = getBrowsers().filter(b => b.cdpPort);
      const results = [];
      for (const b of browsers) {
        try {
          const cookies = await saveCookies(b.cdpPort);
          results.push(`${b.name}: ${cookies.length} cookies`);
        } catch (e) {
          results.push(`${b.name}: ${e.message}`);
        }
      }
      // Save first browser's cookies as master
      if (browsers.length > 0) {
        try {
          const cookies = await saveCookies(browsers[0].cdpPort);
          fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
        } catch {}
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: results.join('\n') }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, message: e.message }));
    }
    return true;
  }

  // Sync cookies from first browser to all others
  if (req.method === 'POST' && req.url === '/api/sync') {
    try {
      const browsers = getBrowsers().filter(b => b.cdpPort);
      if (browsers.length === 0) throw new Error('No browsers running');
      const cookies = await saveCookies(browsers[0].cdpPort);
      fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
      const results = [`${browsers[0].name}: exported ${cookies.length} cookies`];
      for (const b of browsers.slice(1)) {
        try {
          await loadCookies(b.cdpPort, cookies);
          results.push(`${b.name}: imported ${cookies.length} cookies`);
        } catch (e) {
          results.push(`${b.name}: ${e.message}`);
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: results.join('\n') }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, message: e.message }));
    }
    return true;
  }

  // Create new browser
  if (req.method === 'POST' && req.url === '/api/create') {
    try {
      const { vnc, cdp } = findNextPorts();
      const id = Date.now().toString(36);
      const name = `browser-${id}`;
      // Get the image from existing containers
      const image = execSync(
        `docker inspect --format='{{.Config.Image}}' playwright-vnc-poc-browser-1-1 2>/dev/null || echo playwright-vnc-poc-browser`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      const cmd = `docker run -d --name ${name} -p ${vnc}:6080 -p ${cdp}:9223 --shm-size=2g -v ${name}-data:/app/userdata ${image}`;
      execSync(cmd, { timeout: 15000 });
      // Import cookies if available
      setTimeout(async () => {
        if (fs.existsSync(COOKIES_FILE)) {
          try {
            const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
            await loadCookies(cdp, cookies);
          } catch {}
        }
      }, 8000);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: `Created ${name} — noVNC :${vnc}, CDP :${cdp}`, name, vncPort: vnc, cdpPort: cdp }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, message: e.message }));
    }
    return true;
  }

  // Close browser
  const closeMatch = req.url.match(/^\/api\/close\/(.+)$/);
  if (req.method === 'POST' && closeMatch) {
    try {
      const name = decodeURIComponent(closeMatch[1]);
      execSync(`docker stop ${name} && docker rm ${name}`, { timeout: 15000 });
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: `Closed ${name}` }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, message: e.message }));
    }
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  if (await handleAPI(req, res)) return;

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
