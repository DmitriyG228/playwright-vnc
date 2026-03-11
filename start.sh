#!/bin/bash
# Clean stale locks from previous runs
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xvfb :99 -screen 0 1920x1080x24 &
sleep 1

fluxbox &

x11vnc -display :99 -forever -nopw -shared -rfbport 5900 &

websockify --web /usr/share/novnc 6080 localhost:5900 &

mkdir -p /app/userdata
rm -f /app/userdata/SingletonLock /app/userdata/SingletonCookie /app/userdata/SingletonSocket
cd /app && node -e "
const { chromium } = require('playwright');
(async () => {
  const context = await chromium.launchPersistentContext('/app/userdata', {
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--remote-debugging-port=9222',
      '--remote-debugging-address=0.0.0.0',
      '--disable-blink-features=AutomationControlled'
    ],
    viewport: { width: 1280, height: 720 }
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('about:blank');
  console.log('Browser ready. CDP at http://localhost:9222');
  await new Promise(() => {});
})();
" &

# Wait for CDP to be ready, then proxy it on 0.0.0.0
(while ! curl -s http://localhost:9222/json/version > /dev/null 2>&1; do sleep 1; done
echo "CDP ready, starting socat proxy on 0.0.0.0:9223"
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:localhost:9222) &

echo "All services started"
wait
