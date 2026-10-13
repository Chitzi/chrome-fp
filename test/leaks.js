#!/usr/bin/env node
'use strict';

// Hunts for contexts that escape fingerprint patching: pristine iframes,
// workers, and CDP-presence tricks used by commercial bot detectors.
// Usage: node test/leaks.js [--os windows]

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CDPClient } = require('../src/cdp');

const PROBE = `(async () => {
  const out = {};
  const gpuOf = (win) => {
    try {
      const c = win.document.createElement('canvas');
      const gl = c.getContext('webgl');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    } catch (e) { return 'ERR ' + e.message; }
  };

  out['main.webdriver'] = navigator.webdriver;
  out['main.screen'] = screen.width + 'x' + screen.height;
  out['main.gpu'] = gpuOf(window);
  out['main.cores'] = navigator.hardwareConcurrency;

  // 1. pristine natives from a blank iframe
  try {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.body.appendChild(f);
    const w = f.contentWindow;
    out['iframe.webdriver'] = w.navigator.webdriver;
    out['iframe.screen'] = w.screen.width + 'x' + w.screen.height;
    out['iframe.gpu'] = gpuOf(w);
    out['iframe.cores'] = w.navigator.hardwareConcurrency;
    out['iframe.platform'] = w.navigator.platform;
    out['iframe.ua'] = String(w.navigator.userAgent).slice(-22);
    // a detector can also steal the iframe's unpatched toDataURL
    const pristineToDataURL = w.HTMLCanvasElement.prototype.toDataURL;
    const c = document.createElement('canvas');
    c.width = 60; c.height = 20;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 60, 20);
    ctx.fillStyle = '#069'; ctx.fillText('probe', 2, 12);
    const viaPristine = pristineToDataURL.call(c);
    const viaPatched = c.toDataURL();
    out['iframe.canvasBypass'] = viaPristine === viaPatched ? 'no (same)' : 'YES - noise bypassed';
  } catch (e) { out['iframe.error'] = e.message; }

  // 2. srcdoc iframe
  try {
    const f = document.createElement('iframe');
    f.srcdoc = '<html><body>x</body></html>';
    document.body.appendChild(f);
    await new Promise((r) => { f.onload = r; setTimeout(r, 1500); });
    out['srcdoc.webdriver'] = f.contentWindow.navigator.webdriver;
    out['srcdoc.gpu'] = gpuOf(f.contentWindow);
    out['srcdoc.screen'] = f.contentWindow.screen.width + 'x' + f.contentWindow.screen.height;
  } catch (e) { out['srcdoc.error'] = e.message; }

  // 3. dedicated worker (OffscreenCanvas WebGL works here)
  try {
    const src = \`self.onmessage = () => {
      const o = { ua: navigator.userAgent.slice(-22), cores: navigator.hardwareConcurrency, platform: navigator.platform, wd: navigator.webdriver, lang: navigator.language };
      try {
        const c = new OffscreenCanvas(64, 64);
        const gl = c.getContext('webgl');
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        o.gpu = gl.getParameter(d.UNMASKED_RENDERER_WEBGL);
      } catch (e) { o.gpu = 'ERR ' + e.message; }
      try {
        const c2 = new OffscreenCanvas(80, 24);
        const x = c2.getContext('2d');
        x.fillStyle = '#f60'; x.fillRect(0, 0, 80, 24);
        x.fillStyle = '#069'; x.font = '12px sans-serif'; x.fillText('probe', 2, 14);
        const d2 = x.getImageData(0, 0, 80, 24).data;
        let h = 5381;
        for (let i = 0; i < d2.length; i += 7) h = ((h << 5) + h + d2[i]) >>> 0;
        o.canvas = h.toString(16);
      } catch (e) { o.canvas = 'ERR ' + e.message; }
      try { o.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
      postMessage(o);
    };\`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const result = await new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = (e) => resolve({ error: e.message });
      worker.postMessage('go');
      setTimeout(() => resolve({ error: 'timeout' }), 6000);
    });
    for (const [k, v] of Object.entries(result)) out['worker.' + k] = v;
  } catch (e) { out['worker.error'] = e.message; }

  // 3b. is the Worker wrapper itself visible?
  try {
    out['worker.ctorToString'] = Worker.toString();
    out['worker.ctorName'] = Worker.name;
    const src2 = \`self.postMessage({ loc: self.location.href, isBlob: self.location.href.startsWith('blob:'), ctor: self.constructor && self.constructor.name });\`;
    const u2 = URL.createObjectURL(new Blob([src2], { type: 'text/javascript' }));
    const w2 = new Worker(u2);
    const r2 = await new Promise((res) => {
      w2.onmessage = (e) => res(e.data);
      w2.onerror = (e) => res({ error: e.message });
      setTimeout(() => res({ error: 'timeout' }), 5000);
    });
    out['worker.location'] = r2.loc
      ? (r2.isBlob ? 'blob: (correct - this worker was created from a blob)' : r2.loc)
      : JSON.stringify(r2);
    out['worker.scope'] = r2.ctor || '?';
  } catch (e) { out['worker.ctorError'] = e.message; }

  // 4. CDP presence tricks
  try {
    let hit = false;
    const err = new Error('probe');
    Object.defineProperty(err, 'stack', { get() { hit = true; return ''; } });
    console.debug(err);
    out['cdp.consoleStackLeak'] = hit;
  } catch (e) { out['cdp.consoleStackLeak'] = 'ERR ' + e.message; }

  out['dom.webdriverAttr'] = String(document.documentElement.getAttribute('webdriver'));
  out['dom.windowChrome'] = typeof window.chrome + '/' + typeof (window.chrome || {}).runtime;
  out['dom.plugins'] = navigator.plugins.length + ' plugins';
  out['cdp.windowKeys'] = Object.keys(window).filter((k) => /cdc_|\\$cdc|driver|selenium|webdriver/i.test(k)).join(',') || 'none';
  out['cdp.documentKeys'] = Object.keys(document).filter((k) => /cdc_|\\$cdc|driver|selenium/i.test(k)).join(',') || 'none';
  out['cdp.permissions'] = await (async () => {
    try {
      const s = await navigator.permissions.query({ name: 'notifications' });
      return s.state + '/' + Notification.permission;
    } catch (e) { return 'ERR'; }
  })();

  return JSON.stringify(out);
})()`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const extraArgs = process.argv.slice(2);
  const profileDir = path.join(os.tmpdir(), `chrome-fp-leaks-${process.pid}`);
  const launcher = path.join(__dirname, '..', 'src', 'index.js');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>leaks</title></head><body>leak probe</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const probeUrl = `http://127.0.0.1:${server.address().port}/`;

  const child = spawn(
    process.execPath,
    [launcher, '--profile-dir', profileDir, probeUrl, ...extraArgs],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  let endpoint = null;
  for (let i = 0; i < 300 && !endpoint; i++) {
    await wait(100);
    try {
      const lines = fs.readFileSync(portFile, 'utf8').split('\n');
      if (lines.length >= 2 && lines[0].trim()) {
        endpoint = `ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`;
      }
    } catch (e) {}
  }
  if (!endpoint) throw new Error('Chrome did not expose a DevTools endpoint');
  await wait(2500);

  const client = await new CDPClient(endpoint).connect();
  const { targetInfos } = await client.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
  const { sessionId } = await client.send('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  });

  const result = await client.send(
    'Runtime.evaluate',
    { expression: PROBE, awaitPromise: true, returnByValue: true },
    sessionId
  );

  if (result.exceptionDetails) {
    console.error('probe failed:', JSON.stringify(result.exceptionDetails.exception, null, 2));
  } else {
    const data = JSON.parse(result.result.value);
    console.log('\n--- leak probe ---');
    for (const [k, v] of Object.entries(data)) console.log(`${k.padEnd(24)} ${v}`);
  }

  client.close();
  server.close();
  child.kill('SIGTERM');
  await wait(1500);
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (e) {}
  process.exit(0);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
