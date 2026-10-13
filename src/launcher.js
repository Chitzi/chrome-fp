'use strict';

const { spawn, execFileSync } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { generate } = require('./fingerprint');
const { buildScript } = require('./inject');
const { CDPClient } = require('./cdp');

function chromeCandidates() {
  const candidates = [process.env.CHROME_PATH];
  if (process.platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(programFiles, 'Google/Chrome/Application/chrome.exe'),
      path.join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
      localAppData && path.join(localAppData, 'Google/Chrome/Application/chrome.exe'),
      path.join(programFiles, 'Chromium/Application/chrome.exe'),
      path.join(programFiles, 'BraveSoftware/Brave-Browser/Application/brave.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    );
  }
  return candidates.filter(Boolean);
}

function findChrome() {
  for (const candidate of chromeCandidates()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (e) {}
  }
  throw new Error('No Chrome/Chromium binary found. Set CHROME_PATH to its location.');
}

function realDisplayGeometry() {
  // Only X11 tooling is probed here; the desktop app passes the real size in,
  // and other platforms fall back to a common resolution.
  if (process.platform !== 'linux') return { width: 1920, height: 1080 };
  try {
    const out = execFileSync('xdotool', ['getdisplaygeometry'], { encoding: 'utf8' }).trim();
    const [w, h] = out.split(/\s+/).map(Number);
    if (w > 0 && h > 0) return { width: w, height: h };
  } catch (e) {}
  try {
    const out = execFileSync('xrandr', ['--current'], { encoding: 'utf8' });
    const match = out.match(/current\s+(\d+)\s*x\s*(\d+)/);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  } catch (e) {}
  return { width: 1920, height: 1080 };
}

function createFingerprint(opts = {}) {
  const display = realDisplayGeometry();
  return generate({
    seed: opts.seed,
    os: opts.os || 'linux',
    locale: opts.locale,
    timezone: opts.timezone,
    noise: opts.noise,
    maxScreenWidth: display.width,
    maxScreenHeight: display.height,
  });
}

function summarize(fp) {
  const rows = [
    ['seed', fp.seed],
    ['user agent', fp.userAgent],
    ['platform', `${fp.navigatorPlatform} (Chrome ${fp.chromeVersion})`],
    ['locale / tz', `${fp.locale} [${fp.languages.join(', ')}] / ${fp.timezone}`],
    ['screen', `${fp.screen.width}x${fp.screen.height} (avail ${fp.screen.availWidth}x${fp.screen.availHeight})`],
    ['window', `${fp.window.width}x${fp.window.height} @ ${fp.window.left},${fp.window.top}`],
    ['cpu / memory', `${fp.hardwareConcurrency} cores / ${fp.deviceMemory} GB`],
    ['gpu', fp.webglRenderer],
    [
      'noise',
      fp.noise.enabled
        ? `canvas ${fp.noise.canvas}, webgl ${fp.noise.webgl}, audio ${fp.noise.audio}`
        : 'disabled',
    ],
  ];
  const width = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n');
}

function chromeArgs(fp, profileDir, opts) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-sync',
    '--disable-background-networking',
    '--password-store=basic',
    '--use-mock-keychain',
    '--no-startup-window',
    '--remote-debugging-port=0',
    // Remote debugging otherwise makes Blink report navigator.webdriver = true
    // in every context, which is an instant bot flag.
    '--disable-blink-features=AutomationControlled',
    `--lang=${fp.locale}`,
    `--accept-lang=${fp.acceptLanguage}`,
    `--window-size=${fp.window.width},${fp.window.height}`,
    `--window-position=${fp.window.left},${fp.window.top}`,
    // Keep local IPs out of WebRTC candidates.
    '--force-webrtc-ip-handling-policy=default_public_interface',
  ];
  if (opts.proxy) args.push(`--proxy-server=${opts.proxy}`);
  return args;
}

function bwrapArgs(profileDir, homeDir) {
  const args = [
    '--ro-bind', '/', '/',
    '--dev-bind', '/dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--tmpfs', homeDir,
    '--bind', profileDir, profileDir,
    '--unshare-pid',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
  ];
  for (const socket of ['/tmp/.X11-unix', '/tmp/.ICE-unix']) {
    if (fs.existsSync(socket)) args.push('--bind', socket, socket);
  }
  const xauth = process.env.XAUTHORITY;
  if (xauth && fs.existsSync(xauth)) args.push('--ro-bind', xauth, xauth);
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir && fs.existsSync(runtimeDir)) args.push('--bind', runtimeDir, runtimeDir);
  return args;
}

function waitForDevToolsEndpoint(profileDir, child, timeoutMs = 30000) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (child.exitCode !== null) {
        return reject(new Error(`Chrome exited before starting (code ${child.exitCode})`));
      }
      try {
        const content = fs.readFileSync(portFile, 'utf8').split('\n');
        if (content.length >= 2 && content[0].trim()) {
          return resolve(`ws://127.0.0.1:${content[0].trim()}${content[1].trim()}`);
        }
      } catch (e) {}
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for Chrome DevTools port'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * One sandboxed Chrome process with its own fingerprint and throwaway profile.
 * Events: ready, pages (count), exit (code), error (Error).
 */
class ChromeInstance extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.fp = opts.fp || createFingerprint(opts);
    this.status = 'idle';
    this.pageCount = 0;
    this.startedAt = null;
    this.stderrTail = '';
    this.profileDir = opts.profileDir
      ? path.resolve(opts.profileDir)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-fp-'));
    this.keepProfile = Boolean(opts.keepProfile || opts.profileDir);
    this.startUrl = opts.url || 'about:blank';
    this.child = null;
    this.client = null;
    this._cleanedUp = false;
    this._quitting = false;
    this._openPages = new Set();
    this._sawFirstPage = false;
  }

  get uptimeMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  async start() {
    const chromePath = findChrome();
    fs.mkdirSync(this.profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.profileDir, 'fingerprint.json'),
      JSON.stringify(this.fp, null, 2)
    );

    const env = Object.assign({}, process.env, {
      TZ: this.fp.timezone,
      LANGUAGE: this.fp.languages.join(':'),
    });

    let command = chromePath;
    let args = chromeArgs(this.fp, this.profileDir, this.opts);
    if (this.opts.bwrap && process.platform !== 'linux') {
      throw new Error('bubblewrap isolation (--bwrap) is only available on Linux');
    }
    if (this.opts.bwrap) {
      const homeDir = process.env.HOME || os.homedir();
      command = 'bwrap';
      args = [...bwrapArgs(this.profileDir, homeDir), '--', chromePath, ...args];
    }

    this.status = 'starting';
    this.startedAt = Date.now();
    this.child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    this.child.on('exit', (code) => {
      this.status = 'exited';
      if (this.client) this.client.close();
      this._cleanup();
      this.emit('exit', code);
    });

    let endpoint;
    try {
      endpoint = await waitForDevToolsEndpoint(this.profileDir, this.child);
    } catch (e) {
      this._cleanup();
      this.status = 'exited';
      throw new Error(`${e.message}${this.stderrTail ? `\n${this.stderrTail}` : ''}`);
    }

    this.client = await new CDPClient(endpoint).connect();
    const script = buildScript(this.fp);

    this.client.on('Target.attachedToTarget', async ({ sessionId, targetInfo }) => {
      await this._applyOverrides(script, sessionId, targetInfo.type);
    });

    const isUserPage = (info) =>
      info.type === 'page' && !String(info.url || '').startsWith('devtools://');

    this.client.on('Target.targetCreated', ({ targetInfo }) => {
      if (isUserPage(targetInfo)) {
        this._openPages.add(targetInfo.targetId);
        this._sawFirstPage = true;
        this.pageCount = this._openPages.size;
        this.emit('pages', this.pageCount);
      }
    });

    this.client.on('Target.targetDestroyed', ({ targetId }) => {
      if (!this._openPages.delete(targetId)) return;
      this.pageCount = this._openPages.size;
      this.emit('pages', this.pageCount);
      // Chrome runs with --no-startup-window, so it will not quit on its own
      // when the user closes the last window.
      this._quitIfNoPages(isUserPage);
    });

    this.client.on('__disconnected__', () => {
      // Without the control channel new tabs would be unpatched.
      if (this.child && this.child.exitCode === null) this.close();
    });

    await this.client.send('Target.setDiscoverTargets', { discover: true });
    await this.client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    // Only now is injection armed, so even the very first page load is spoofed.
    await this.openUrl(this.startUrl, true);

    this.status = 'running';
    this.emit('ready');
    return this;
  }

  async openUrl(url, newWindow = false) {
    if (!this.client) throw new Error('instance not started');
    const params = { url };
    if (newWindow) {
      params.newWindow = true;
      params.width = this.fp.window.width;
      params.height = this.fp.window.height;
    }
    try {
      return await this.client.send('Target.createTarget', params);
    } catch (e) {
      return await this.client.send('Target.createTarget', { url });
    }
  }

  async _quitIfNoPages(isUserPage) {
    if (this._quitting || !this._sawFirstPage || this._openPages.size > 0) return;
    await new Promise((r) => setTimeout(r, 600));
    try {
      const { targetInfos } = await this.client.send('Target.getTargets');
      if (targetInfos.some(isUserPage)) return;
    } catch (e) {}
    this.close();
  }

  close() {
    if (this._quitting || !this.child || this.child.exitCode !== null) return;
    this._quitting = true;
    this.status = 'closing';
    const hardKill = setTimeout(() => {
      try {
        this.child.kill('SIGKILL');
      } catch (e) {}
    }, 5000);
    hardKill.unref();
    if (this.client && !this.client.closed) {
      this.client.send('Browser.close').catch(() => {
        try {
          this.child.kill('SIGTERM');
        } catch (e) {}
      });
      setTimeout(() => {
        if (this.child && this.child.exitCode === null) {
          try {
            this.child.kill('SIGTERM');
          } catch (e) {}
        }
      }, 2500).unref();
    } else {
      try {
        this.child.kill('SIGTERM');
      } catch (e) {}
    }
  }

  _cleanup() {
    if (this._cleanedUp) return;
    this._cleanedUp = true;
    if (this.keepProfile) return;
    try {
      fs.rmSync(this.profileDir, { recursive: true, force: true });
    } catch (e) {}
  }

  async _applyOverrides(script, sessionId, targetType) {
    const fp = this.fp;
    const attempt = async (method, params) => {
      try {
        if (process.env.CHROME_FP_DEBUG === '2') console.error(`[t] -> ${targetType} ${method}`);
        await this.client.send(method, params, sessionId);
        if (process.env.CHROME_FP_DEBUG === '2') console.error(`[t] <- ${targetType} ${method}`);
      } catch (e) {
        // Not every domain exists on every target type (workers, etc).
        if (process.env.CHROME_FP_DEBUG) {
          console.error(`[debug] ${targetType} ${method}: ${e.message}`);
        }
      }
    };

    const isWebTarget = ['page', 'iframe', 'worker', 'service_worker', 'shared_worker'].includes(
      targetType
    );
    if (!isWebTarget) {
      await attempt('Runtime.runIfWaitingForDebugger', {});
      return;
    }

    const uaOverride = {
      userAgent: fp.userAgent,
      acceptLanguage: fp.acceptLanguage,
      platform: fp.navigatorPlatform,
      userAgentMetadata: fp.userAgentMetadata,
    };
    await attempt('Emulation.setUserAgentOverride', uaOverride);
    await attempt('Network.setUserAgentOverride', uaOverride);
    await attempt('Emulation.setTimezoneOverride', { timezoneId: fp.timezone });
    await attempt('Emulation.setLocaleOverride', { locale: fp.locale });
    await attempt('Emulation.setHardwareConcurrencyOverride', {
      hardwareConcurrency: fp.hardwareConcurrency,
    });

    if (targetType === 'page' || targetType === 'iframe') {
      // Page must be enabled for the script to reach child frames; without it
      // a detector can read pristine values from a blank/srcdoc iframe.
      await attempt('Page.enable', {});
      // runImmediately also patches the document that already exists in a
      // freshly created target, not just subsequent navigations.
      try {
        await this.client.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: script, runImmediately: true },
          sessionId
        );
      } catch (e) {
        await attempt('Page.addScriptToEvaluateOnNewDocument', { source: script });
        await attempt('Runtime.evaluate', { expression: script, silent: true });
      }
      await attempt('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
    } else if (targetType !== 'worker') {
      // Service/shared workers answer Runtime commands while paused, so patch
      // them here. Dedicated workers do NOT: evaluating in one while it waits
      // for the debugger deadlocks the worker and its page, so those are handled
      // by wrapping the Worker constructor inside the injected script instead.
      await attempt('Runtime.enable', {});
      await attempt('Runtime.evaluate', { expression: script, silent: true });
      await attempt('Runtime.disable', {});
    }
    await attempt('Runtime.runIfWaitingForDebugger', {});
  }
}

module.exports = {
  ChromeInstance,
  createFingerprint,
  findChrome,
  realDisplayGeometry,
  summarize,
};
