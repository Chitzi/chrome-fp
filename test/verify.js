#!/usr/bin/env node
'use strict';

// Launches chrome-fp and reports what a website actually observes.
// Usage: node test/verify.js [--os windows] [--seed abc]

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CDPClient } = require('../src/cdp');

const PROBE = `(async () => {
  const out = {};
  const nav = navigator;
  out.userAgent = nav.userAgent;
  out.platform = nav.platform;
  out.languages = nav.languages.join(',');
  out.language = nav.language;
  out.hardwareConcurrency = nav.hardwareConcurrency;
  out.deviceMemory = nav.deviceMemory;
  out.webdriver = nav.webdriver;
  out.screen = screen.width + 'x' + screen.height + ' avail ' + screen.availWidth + 'x' + screen.availHeight + ' depth ' + screen.colorDepth;
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.locale = Intl.DateTimeFormat().resolvedOptions().locale;
  out.tzOffset = new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset();
  out.dateString = new Date(Date.UTC(2026, 0, 15, 12)).toString();
  try {
    const hints = await nav.userAgentData.getHighEntropyValues(['platform','platformVersion','architecture','bitness','model','uaFullVersion','fullVersionList']);
    out.uaData = hints.platform + ' ' + hints.platformVersion + ' ' + hints.architecture + '/' + hints.bitness + ' v' + hints.uaFullVersion;
    out.uaBrands = nav.userAgentData.brands.map(b => b.brand + ':' + b.version).join(' | ');
  } catch (e) { out.uaData = 'ERR ' + e.message; }

  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  function canvasHash() {
    const c = document.createElement('canvas');
    c.width = 280; c.height = 60;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(10, 5, 100, 30);
    ctx.fillStyle = '#069';
    ctx.fillText('Fingerprint probe \\u{1F600}', 4, 20);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('Fingerprint probe \\u{1F600}', 6, 25);
    return hashString(c.toDataURL());
  }
  out.canvas = canvasHash();
  out.canvasRepeat = canvasHash();

  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.webglVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
    out.webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  } catch (e) { out.webglRenderer = 'ERR ' + e.message; }

  try {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination);
    osc.start(0);
    const buf = await ctx.startRendering();
    const data = buf.getChannelData(0);
    let sum = 0;
    for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
    out.audio = sum.toFixed(12);
  } catch (e) { out.audio = 'ERR ' + e.message; }

  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '16px Times New Roman';
    out.textWidth = ctx.measureText('mmmmmmmmmmlli').width.toFixed(6);
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;width:120px;height:40px;font:14px serif';
    d.textContent = 'rect probe';
    document.documentElement.appendChild(d);
    const r = d.getBoundingClientRect();
    out.rect = r.width.toFixed(6) + 'x' + r.height.toFixed(6);
  } catch (e) { out.rect = 'ERR ' + e.message; }

  out.toStringCanvas = HTMLCanvasElement.prototype.toDataURL.toString();
  out.toStringPlatformGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform').get.toString();
  out.toStringToString = Function.prototype.toString.toString();
  out.hasCdpArtifacts = Object.keys(window).filter(k => /cdc_|\\$cdc|__nightmare|_selenium|callPhantom/.test(k)).join(',') || 'none';
  return JSON.stringify(out);
})()`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const extraArgs = process.argv.slice(2);
  const profileDir = path.join(os.tmpdir(), `chrome-fp-verify-${process.pid}`);
  const launcher = path.join(__dirname, '..', 'src', 'index.js');

  // Serve the probe page over http://127.0.0.1 so it is a secure context
  // (navigator.userAgentData is unavailable on about:blank).
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>probe</title></head><body>probe</body></html>');
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

  await wait(2500); // let the first window finish loading

  const client = await new CDPClient(endpoint).connect();
  const { targetInfos } = await client.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
  if (!page) throw new Error('No page target found');

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
    console.error('Probe failed:', JSON.stringify(result.exceptionDetails, null, 2));
  } else {
    const data = JSON.parse(result.result.value);
    console.log('\n--- what the page sees ---');
    for (const [k, v] of Object.entries(data)) console.log(`${k.padEnd(22)} ${v}`);
    console.log(`canvas stable within run: ${data.canvas === data.canvasRepeat ? 'yes' : 'NO (bad)'}`);
  }

  // Second phase: a tab opened *after* startup (as a user would) must be patched too.
  const popup = await client.send('Target.createTarget', { url: probeUrl });
  await wait(2000);
  const popupSession = (await client.send('Target.attachToTarget', {
    targetId: popup.targetId,
    flatten: true,
  })).sessionId;
  const popupProbe = await client.send(
    'Runtime.evaluate',
    {
      expression: `JSON.stringify({ screen: screen.width + 'x' + screen.height, platform: navigator.platform, cores: navigator.hardwareConcurrency, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, patched: !!window.__fpPatched })`,
      returnByValue: true,
    },
    popupSession
  );
  console.log('new tab               ' + popupProbe.result.value);

  client.close();
  server.close();
  child.kill('SIGTERM');
  await wait(1200);
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (e) {}
  process.exit(0);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
