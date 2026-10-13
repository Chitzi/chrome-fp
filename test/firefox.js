#!/usr/bin/env node
'use strict';

// Launches Firefox instances through the launcher and reports what a page
// actually observes. Firefox exposes no automation protocol, so the probe page
// posts its results back to a local server instead of being driven over CDP.
// Usage: node test/firefox.js [--mode strict] [--os windows]

const http = require('http');
const { createInstance, createIdentity, summarize } = require('../src/launcher');

const PAGE = `<!doctype html><meta charset="utf-8"><title>probe</title><body>probe
<script>
(async () => {
  const out = {};
  out.ua = navigator.userAgent;
  out.platform = navigator.platform;
  out.oscpu = navigator.oscpu || '(none)';
  out.languages = navigator.languages.join(',');
  out.cores = navigator.hardwareConcurrency;
  out.deviceMemory = String(navigator.deviceMemory);
  out.webdriver = String(navigator.webdriver);
  out.screen = screen.width + 'x' + screen.height;
  out.innerSize = innerWidth + 'x' + innerHeight;
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.tzOffset = new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset();

  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); };
  const drawCanvas = () => {
    const c = document.createElement('canvas');
    c.width = 280; c.height = 60;
    const x = c.getContext('2d');
    x.textBaseline = 'top'; x.font = '14px Arial';
    x.fillStyle = '#f60'; x.fillRect(10, 5, 100, 30);
    x.fillStyle = '#069'; x.fillText('Fingerprint probe \\u{1F600}', 4, 20);
    return hash(c.toDataURL());
  };
  out.canvas = drawCanvas();
  out.canvasRepeat = drawCanvas();

  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.glRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(extension blocked)';
  } catch (e) { out.glRenderer = 'ERR ' + e.message; }

  try {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
    const buf = await ctx.startRendering();
    const data = buf.getChannelData(0);
    let sum = 0; for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
    out.audio = sum.toFixed(10);
  } catch (e) { out.audio = 'ERR'; }

  out.tab = new URLSearchParams(location.search).get('tab') || '1';
  await fetch('/r', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
})();
</script></body>`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const waiters = [];
  const results = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.end('ok');
        const data = JSON.parse(body);
        results.push(data);
        const next = waiters.shift();
        if (next) next(data);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  server.nextResult = (timeoutMs = 45000) =>
    Promise.race([
      new Promise((resolve) => {
        if (results.length) return resolve(results.shift());
        waiters.push(resolve);
      }),
      wait(timeoutMs).then(() => ({ error: 'timeout' })),
    ]);
  return server;
}

async function runInstance(label, options, server, url) {
  const identity = createIdentity(Object.assign({ browser: 'firefox' }, options));
  const instance = createInstance(Object.assign({ browser: 'firefox', identity, url }, options));
  await instance.start();
  const data = await server.nextResult();
  console.log(`\n--- ${label} ---`);
  console.log(summarize(identity));
  console.log('  observed:');
  for (const [k, v] of Object.entries(data)) console.log(`    ${k.padEnd(14)} ${v}`);
  return { instance, data, identity };
}

async function main() {
  const argv = process.argv.slice(2);
  const modeIndex = argv.indexOf('--mode');
  const osIndex = argv.indexOf('--os');
  const options = {
    mode: modeIndex >= 0 ? argv[modeIndex + 1] : 'balanced',
    os: osIndex >= 0 ? argv[osIndex + 1] : 'linux',
  };

  const server = startServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const first = await runInstance('instance A', options, server, base);
  // A second tab proves URL hand-off works without any automation protocol.
  await first.instance.openUrl(`${base}?tab=2`);
  const tabTwo = await server.nextResult(30000);
  console.log(`\n  new tab opened via profile hand-off: ${tabTwo.error ? 'FAILED' : 'yes'}`);
  first.instance.close();
  await wait(6000);

  const second = await runInstance('instance B', options, server, base);
  second.instance.close();
  await wait(6000);

  console.log('\n=== verdict ===');
  console.log(`  canvas stable within a run : ${first.data.canvas === first.data.canvasRepeat ? 'yes' : 'NO'}`);
  console.log(`  canvas differs per instance: ${first.data.canvas !== second.data.canvas ? 'yes' : 'no'}`);
  console.log(`  webdriver flag             : ${first.data.webdriver}`);
  console.log(`  profiles wiped             : ${[first, second].every((r) => !require('fs').existsSync(r.instance.profileDir)) ? 'yes' : 'NO'}`);
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
