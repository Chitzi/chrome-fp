'use strict';

const { spawn, execFileSync } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeRng, LOCALES } = require('./fingerprint');

function firefoxCandidates() {
  const candidates = [process.env.FIREFOX_PATH];
  if (process.platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(programFiles, 'Mozilla Firefox/firefox.exe'),
      path.join(programFilesX86, 'Mozilla Firefox/firefox.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Firefox.app/Contents/MacOS/firefox');
  } else {
    candidates.push(
      '/usr/bin/firefox',
      '/usr/bin/firefox-esr',
      '/usr/lib/firefox/firefox',
      '/snap/bin/firefox'
    );
  }
  return candidates.filter(Boolean);
}

function findFirefox() {
  for (const candidate of firefoxCandidates()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (e) {}
  }
  throw new Error('No Firefox binary found. Set FIREFOX_PATH to its location.');
}

// Firefox's UA is far more uniform than Chrome's, so only a handful of recent
// versions are plausible; claiming an old one is a signal in itself.
const FIREFOX_VERSIONS = ['155.0', '156.0', '157.0'];

const FIREFOX_PLATFORMS = {
  linux: { ua: 'X11; Linux x86_64', platform: 'Linux x86_64', oscpu: 'Linux x86_64' },
  windows: { ua: 'Windows NT 10.0; Win64; x64', platform: 'Win32', oscpu: 'Windows NT 10.0; Win64; x64' },
  macos: { ua: 'Macintosh; Intel Mac OS X 10.15', platform: 'MacIntel', oscpu: 'Intel Mac OS X 10.15' },
};

const MODES = {
  // Firefox's own fingerprinting protection: canvas randomization per profile
  // plus generalized hardware values. Sites keep working.
  balanced: 'balanced',
  // Tor-style uniformity: screen reports the window size, letterboxing on.
  strict: 'strict',
  // Nothing but a clean profile (plus UA/language/timezone).
  off: 'off',
};

function displaySize() {
  if (process.platform !== 'linux') return { width: 1920, height: 1080 };
  try {
    const out = execFileSync('xdotool', ['getdisplaygeometry'], { encoding: 'utf8' }).trim();
    const [w, h] = out.split(/\s+/).map(Number);
    if (w > 0 && h > 0) return { width: w, height: h };
  } catch (e) {}
  return { width: 1920, height: 1080 };
}

function createFirefoxIdentity(opts = {}) {
  const seed = opts.seed || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const rng = makeRng(seed);

  const osKey = opts.os && FIREFOX_PLATFORMS[opts.os] ? opts.os : 'linux';
  const platform = FIREFOX_PLATFORMS[osKey];
  const version = opts.firefoxVersion || rng.pick(FIREFOX_VERSIONS);

  const hostIntl = Intl.DateTimeFormat().resolvedOptions();
  const wantTimezone = opts.timezone === 'auto' ? hostIntl.timeZone : opts.timezone;
  const wantLocale = opts.locale === 'auto' ? hostIntl.locale : opts.locale;

  let bundle = wantLocale ? LOCALES.find((l) => l.locale === wantLocale) : null;
  if (!bundle && wantLocale) {
    const base = wantLocale.split('-')[0];
    const languages = [wantLocale];
    if (base !== wantLocale) languages.push(base);
    for (const extra of ['en-US', 'en']) if (!languages.includes(extra)) languages.push(extra);
    bundle = { locale: wantLocale, languages, timezones: [wantTimezone || 'UTC'] };
  }
  if (!bundle) {
    const matching = wantTimezone ? LOCALES.filter((l) => l.timezones.includes(wantTimezone)) : [];
    bundle = rng.pick(matching.length ? matching : LOCALES);
  }
  const timezone = wantTimezone || rng.pick(bundle.timezones);

  const display = opts.maxScreenWidth
    ? { width: opts.maxScreenWidth, height: opts.maxScreenHeight }
    : displaySize();
  const width = Math.max(1024, Math.min(display.width - rng.int(0, 220), display.width));
  const height = Math.max(700, Math.min(display.height - rng.int(60, 180), display.height));

  return {
    browser: 'firefox',
    seed,
    os: osKey,
    mode: MODES[opts.mode] || MODES.balanced,
    version,
    userAgent: `Mozilla/5.0 (${platform.ua}; rv:${version}) Gecko/20100101 Firefox/${version}`,
    navigatorPlatform: platform.platform,
    oscpu: platform.oscpu,
    locale: bundle.locale,
    languages: bundle.languages.slice(),
    acceptLanguages: bundle.languages.join(', '),
    timezone,
    window: {
      width,
      height,
      left: Math.max(0, Math.floor((display.width - width) / 2) + rng.int(-40, 40)),
      top: Math.max(0, rng.int(0, Math.max(1, display.height - height - 40))),
    },
  };
}

function proxyPrefs(proxy) {
  if (!proxy) return {};
  let url;
  try {
    url = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
  } catch (e) {
    return {};
  }
  const host = url.hostname;
  const port = Number(url.port) || (url.protocol.startsWith('socks') ? 1080 : 8080);
  if (url.protocol.startsWith('socks')) {
    return {
      'network.proxy.type': 1,
      'network.proxy.socks': host,
      'network.proxy.socks_port': port,
      'network.proxy.socks_version': url.protocol === 'socks4:' ? 4 : 5,
      // Resolve DNS through the proxy, otherwise the real resolver leaks.
      'network.proxy.socks_remote_dns': true,
    };
  }
  return {
    'network.proxy.type': 1,
    'network.proxy.http': host,
    'network.proxy.http_port': port,
    'network.proxy.ssl': host,
    'network.proxy.ssl_port': port,
    'network.proxy.share_proxy_settings': true,
  };
}

function buildPrefs(identity, opts = {}) {
  const prefs = {
    // Keep a throwaway profile quiet: no onboarding, telemetry or update nags.
    'browser.shell.checkDefaultBrowser': false,
    'browser.aboutwelcome.enabled': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.sessionstore.resume_from_crash': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'datareporting.healthreport.uploadEnabled': false,
    'toolkit.telemetry.enabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
    'app.update.auto': false,
    'app.update.checkInstallTime': false,
    'browser.discovery.enabled': false,
    'extensions.getAddons.cache.enabled': false,

    'general.useragent.override': identity.userAgent,
    'general.platform.override': identity.navigatorPlatform,
    'general.oscpu.override': identity.oscpu,
    'intl.accept_languages': identity.acceptLanguages,
    'intl.locale.requested': identity.locale,

    // Keep local IPs out of WebRTC candidates.
    'media.peerconnection.ice.default_address_only': true,
    'media.peerconnection.ice.no_host': true,
  };

  if (identity.mode === MODES.strict) {
    prefs['privacy.resistFingerprinting'] = true;
    prefs['privacy.resistFingerprinting.letterboxing'] = true;
  } else if (identity.mode === MODES.balanced) {
    // Firefox's own protection already randomizes canvas per profile and
    // generalizes hardware values, which is why no JS injection is needed.
    prefs['privacy.fingerprintingProtection'] = true;
  }

  if (opts.noise === false && identity.mode === MODES.balanced) {
    prefs['privacy.fingerprintingProtection'] = false;
  }

  return Object.assign(prefs, proxyPrefs(opts.proxy));
}

function serializePrefs(prefs) {
  return (
    Object.entries(prefs)
      .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
      .join('\n') + '\n'
  );
}

function summarizeFirefox(identity) {
  const modeText = {
    balanced: 'balanced — Firefox fingerprinting protection (canvas randomized per profile)',
    strict: 'strict — resistFingerprinting, uniform values, letterboxing',
    off: 'off — clean profile only, no fingerprinting protection',
  }[identity.mode];
  const rows = [
    ['seed', identity.seed],
    ['engine', `Firefox ${identity.version} (no automation protocol attached)`],
    ['user agent', identity.userAgent],
    ['locale / tz', `${identity.locale} [${identity.languages.join(', ')}] / ${identity.timezone}`],
    ['window', `${identity.window.width}x${identity.window.height} @ ${identity.window.left},${identity.window.top}`],
    ['mode', modeText],
  ];
  const width = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n');
}

/**
 * A Firefox instance with a disposable profile. Everything is configured through
 * profile preferences, so no debugging port or automation flag is ever exposed —
 * which is what keeps sites like Google sign-in working.
 * Events: ready, exit (code).
 */
class FirefoxInstance extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.browser = 'firefox';
    this.loginSafe = true; // no automation surface, by construction
    this.identity = opts.identity || createFirefoxIdentity(opts);
    this.fp = this.identity;
    this.status = 'idle';
    this.pageCount = 1;
    this.startedAt = null;
    this.stderrTail = '';
    this.profileDir = opts.profileDir
      ? path.resolve(opts.profileDir)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'firefox-fp-'));
    this.keepProfile = Boolean(opts.keepProfile || opts.profileDir);
    this.startUrl = opts.url || 'about:blank';
    this.child = null;
    this._cleanedUp = false;
    this._closing = false;
  }

  get uptimeMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  async start() {
    const binary = findFirefox();
    fs.mkdirSync(this.profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.profileDir, 'user.js'),
      serializePrefs(buildPrefs(this.identity, this.opts))
    );
    fs.writeFileSync(
      path.join(this.profileDir, 'fingerprint.json'),
      JSON.stringify(this.identity, null, 2)
    );
    // Firefox has no window-size switch, but it restores geometry from here.
    fs.writeFileSync(
      path.join(this.profileDir, 'xulstore.json'),
      JSON.stringify({
        'chrome://browser/content/browser.xhtml': {
          'main-window': {
            screenX: String(this.identity.window.left),
            screenY: String(this.identity.window.top),
            width: String(this.identity.window.width),
            height: String(this.identity.window.height),
            sizemode: 'normal',
          },
        },
      })
    );

    const env = Object.assign({}, process.env, {
      TZ: this.identity.timezone,
      MOZ_DISABLE_AUTO_SAFE_MODE: '1',
    });

    const args = ['--profile', this.profileDir, '--new-instance', this.startUrl];
    this.status = 'starting';
    this.startedAt = Date.now();
    this.child = spawn(binary, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    this.child.on('exit', (code) => {
      this.status = 'exited';
      this._cleanup();
      this.emit('exit', code);
    });

    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const tick = () => {
        if (this.child.exitCode !== null) {
          return reject(
            new Error(
              `Firefox exited before starting (code ${this.child.exitCode})${
                this.stderrTail ? `\n${this.stderrTail}` : ''
              }`
            )
          );
        }
        // The profile lock appears once the instance owns the profile.
        const lock = path.join(this.profileDir, '.parentlock');
        if (fs.existsSync(lock) || Date.now() > deadline) return resolve();
        setTimeout(tick, 150);
      };
      tick();
    });

    this.status = 'running';
    this.emit('ready');
    return this;
  }

  async openUrl(url) {
    // Firefox hands the URL to the instance that owns this profile and exits.
    const opener = spawn(findFirefox(), ['--profile', this.profileDir, '--new-tab', url], {
      env: Object.assign({}, process.env, { TZ: this.identity.timezone }),
      stdio: 'ignore',
      detached: true,
    });
    opener.unref();
    return { browser: 'firefox' };
  }

  close() {
    if (this._closing || !this.child || this.child.exitCode !== null) return;
    this._closing = true;
    this.status = 'closing';

    // Firefox ignores SIGTERM, but closing its windows shuts it down cleanly.
    if (process.platform === 'linux') {
      try {
        const out = execFileSync('xdotool', ['search', '--pid', String(this.child.pid), '--onlyvisible'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        for (const id of out.split('\n').filter(Boolean)) {
          try {
            execFileSync('xdotool', ['windowclose', id], { stdio: 'ignore' });
          } catch (e) {}
        }
      } catch (e) {}
    }

    setTimeout(() => {
      if (this.child && this.child.exitCode === null) {
        try {
          this.child.kill('SIGTERM');
        } catch (e) {}
      }
    }, 4000).unref();
    setTimeout(() => {
      if (this.child && this.child.exitCode === null) {
        try {
          this.child.kill('SIGKILL');
        } catch (e) {}
      }
    }, 8000).unref();
  }

  _cleanup() {
    if (this._cleanedUp) return;
    this._cleanedUp = true;
    if (this.keepProfile) return;
    try {
      fs.rmSync(this.profileDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

module.exports = {
  FirefoxInstance,
  createFirefoxIdentity,
  summarizeFirefox,
  findFirefox,
  buildPrefs,
  serializePrefs,
  MODES,
};
