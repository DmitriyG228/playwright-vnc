/**
 * Dashboard server with cookie and browser management API.
 *
 * Usage: node dashboard.js
 * Open: http://localhost:3000
 *
 * API:
 *   GET  /api/browsers      - List running browsers (with lock status)
 *   POST /api/create        - Spin up a new browser container
 *   POST /api/close/:name   - Stop and remove a browser container
 *   POST /api/acquire       - Get an exclusive browser (creates one if none free)
 *   POST /api/release/:name - Release a browser back to the pool
 *   POST /api/save          - Save cookies from all browsers to disk
 *   POST /api/sync          - Export from browser-1, import to all others
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const PORT = process.env.DASHBOARD_PORT || 3000;
const COOKIES_FILE = path.join(__dirname, 'cookies.json');

// In-memory lock table: { containerName: { agent: string, acquiredAt: timestamp } }
const locks = {};

function getBrowsers() {
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
        lock: locks[name] || null,
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

function createBrowser() {
  const { vnc, cdp } = findNextPorts();
  const id = Date.now().toString(36);
  const name = `browser-${id}`;
  const image = execSync(
    `docker inspect --format='{{.Config.Image}}' $(docker ps --format '{{.Names}}' | grep browser | head -1) 2>/dev/null || echo playwright-vnc-poc-browser`,
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
  return { name, vncPort: vnc, cdpPort: cdp };
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
      const b = createBrowser();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: `Created ${b.name} — noVNC :${b.vncPort}, CDP :${b.cdpPort}`, ...b }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, message: e.message }));
    }
    return true;
  }

  // Acquire a browser (get exclusive access, creates one if none free)
  if (req.method === 'POST' && req.url === '/api/acquire') {
    try {
      const body = await parseBody(req);
      const agent = body.agent || 'anonymous-' + Date.now().toString(36);
      const browsers = getBrowsers();

      // Find an unlocked browser
      let target = browsers.find(b => b.cdpPort && !locks[b.name]);

      if (!target) {
        // No free browsers — create one
        const created = createBrowser();
        // Wait for CDP to be ready
        let ready = false;
        for (let i = 0; i < 15; i++) {
          try {
            execSync(`curl -s --max-time 2 http://localhost:${created.cdpPort}/json/version`, { timeout: 5000 });
            ready = true;
            break;
          } catch {}
          await new Promise(r => setTimeout(r, 1000));
        }
        if (!ready) throw new Error('Browser created but CDP not ready after 15s');
        target = { name: created.name, cdpPort: created.cdpPort, vncPort: created.vncPort };
      }

      // Lock it
      locks[target.name] = { agent, acquiredAt: Date.now() };

      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        name: target.name,
        cdpPort: target.cdpPort,
        vncPort: target.vncPort,
        agent,
        message: `Acquired ${target.name} (CDP :${target.cdpPort}) for agent "${agent}"`,
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, message: e.message }));
    }
    return true;
  }

  // Release a browser (unlock it for others)
  const releaseMatch = req.url.match(/^\/api\/release\/(.+)$/);
  if (req.method === 'POST' && releaseMatch) {
    const name = decodeURIComponent(releaseMatch[1]);
    if (locks[name]) {
      const lock = locks[name];
      delete locks[name];
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: `Released ${name} (was held by "${lock.agent}")` }));
    } else {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: `${name} was not locked` }));
    }
    return true;
  }

  // Close browser
  const closeMatch = req.url.match(/^\/api\/close\/(.+)$/);
  if (req.method === 'POST' && closeMatch) {
    try {
      const name = decodeURIComponent(closeMatch[1]);
      delete locks[name]; // Clean up any lock
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
