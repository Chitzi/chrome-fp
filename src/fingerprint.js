'use strict';

// Seeded PRNG (mulberry32) so a run can be reproduced with --seed.
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const rand = mulberry32(hashSeed(seed));
  return {
    next: rand,
    int: (min, max) => min + Math.floor(rand() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
    // Weighted pick: entries are [value, weight]
    weighted: (entries) => {
      const total = entries.reduce((s, e) => s + e[1], 0);
      let r = rand() * total;
      for (const [value, weight] of entries) {
        r -= weight;
        if (r <= 0) return value;
      }
      return entries[entries.length - 1][0];
    },
  };
}

// Recent, plausible Chrome releases. Keeping the major close to the real binary
// avoids UA/feature-detection mismatches.
const CHROME_VERSIONS = [
  '153.0.7049.115',
  '153.0.7049.96',
  '154.0.7123.92',
  '154.0.7123.60',
  '155.0.8059.39',
  '155.0.8059.17',
];

const PLATFORMS = {
  linux: {
    uaPlatform: 'X11; Linux x86_64',
    navPlatform: 'Linux x86_64',
    chPlatform: 'Linux',
    chPlatformVersions: ['6.8.0', '6.11.0', '6.14.0', '6.17.0'],
    chArch: 'x86',
    chBitness: '64',
    chModel: '',
    gpus: [
      ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.5.0)'],
      ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0)'],
      ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi, navi22, LLVM 18.1.8), OpenGL 4.6)'],
      ['Google Inc. (Intel)', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 770 (ADL-S GT1), OpenGL 4.6)'],
      ['Google Inc. (Intel)', 'ANGLE (Intel, Mesa Intel(R) Arc(tm) A750 Graphics (DG2), OpenGL 4.6)'],
    ],
    fontBias: 'linux',
  },
  windows: {
    uaPlatform: 'Windows NT 10.0; Win64; x64',
    navPlatform: 'Win32',
    chPlatform: 'Windows',
    chPlatformVersions: ['10.0.0', '15.0.0', '19.0.0'], // Win10 / Win11 CH encoding
    chArch: 'x86',
    chBitness: '64',
    chModel: '',
    gpus: [
      ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
      ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)'],
      ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
      ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
      ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ],
    fontBias: 'windows',
  },
  macos: {
    uaPlatform: 'Macintosh; Intel Mac OS X 10_15_7',
    navPlatform: 'MacIntel',
    chPlatform: 'macOS',
    chPlatformVersions: ['14.5.0', '15.1.0', '15.3.0', '26.0.0'],
    chArch: 'arm',
    chBitness: '64',
    chModel: '',
    gpus: [
      ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)'],
      ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'],
      ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)'],
    ],
    fontBias: 'macos',
  },
};

// Locale bundles keep language, timezone and geography coherent.
const LOCALES = [
  { locale: 'en-US', languages: ['en-US', 'en'], timezones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'] },
  { locale: 'en-GB', languages: ['en-GB', 'en'], timezones: ['Europe/London'] },
  { locale: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'], timezones: ['Europe/Berlin'] },
  { locale: 'fr-FR', languages: ['fr-FR', 'fr', 'en-US', 'en'], timezones: ['Europe/Paris'] },
  { locale: 'es-ES', languages: ['es-ES', 'es', 'en'], timezones: ['Europe/Madrid'] },
  { locale: 'it-IT', languages: ['it-IT', 'it', 'en'], timezones: ['Europe/Rome'] },
  { locale: 'nl-NL', languages: ['nl-NL', 'nl', 'en-US', 'en'], timezones: ['Europe/Amsterdam'] },
  { locale: 'pl-PL', languages: ['pl-PL', 'pl', 'en-US', 'en'], timezones: ['Europe/Warsaw'] },
  { locale: 'pt-BR', languages: ['pt-BR', 'pt', 'en-US', 'en'], timezones: ['America/Sao_Paulo'] },
  { locale: 'en-CA', languages: ['en-CA', 'en', 'fr-CA'], timezones: ['America/Toronto', 'America/Vancouver'] },
  { locale: 'en-AU', languages: ['en-AU', 'en'], timezones: ['Australia/Sydney', 'Australia/Melbourne'] },
  { locale: 'sv-SE', languages: ['sv-SE', 'sv', 'en-US', 'en'], timezones: ['Europe/Stockholm'] },
  { locale: 'tr-TR', languages: ['tr-TR', 'tr', 'en-US', 'en'], timezones: ['Europe/Istanbul'] },
];

const SCREENS = [
  [1920, 1080, 10],
  [1920, 1200, 3],
  [2560, 1440, 6],
  [1680, 1050, 2],
  [1600, 900, 3],
  [1536, 864, 4],
  [1440, 900, 3],
  [3840, 2160, 2],
  [2560, 1600, 2],
  [1366, 768, 4],
];

function generate(options = {}) {
  const seed = options.seed || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const rng = makeRng(seed);

  const osKey = options.os || 'linux';
  const platform = PLATFORMS[osKey];
  if (!platform) throw new Error(`Unknown os "${osKey}" (expected linux, windows or macos)`);

  const fullVersion = options.chromeVersion || rng.pick(CHROME_VERSIONS);
  const major = fullVersion.split('.')[0];

  // "auto" keeps the host's own timezone/locale, which avoids the timezone-vs-IP
  // mismatch that anti-fraud vendors report as "VPN detected".
  const hostIntl = Intl.DateTimeFormat().resolvedOptions();
  const wantTimezone = options.timezone === 'auto' ? hostIntl.timeZone : options.timezone;
  const wantLocale = options.locale === 'auto' ? hostIntl.locale : options.locale;

  let localeBundle = wantLocale ? LOCALES.find((l) => l.locale === wantLocale) : null;
  if (!localeBundle && wantLocale) {
    const base = wantLocale.split('-')[0];
    const languages = [wantLocale];
    if (base !== wantLocale) languages.push(base);
    for (const extra of ['en-US', 'en']) if (!languages.includes(extra)) languages.push(extra);
    localeBundle = { locale: wantLocale, languages, timezones: [wantTimezone || 'UTC'] };
  }
  if (!localeBundle) {
    const matching = wantTimezone ? LOCALES.filter((l) => l.timezones.includes(wantTimezone)) : [];
    localeBundle = rng.pick(matching.length ? matching : LOCALES);
  }
  const locale = localeBundle.locale;
  const languages = localeBundle.languages.slice();
  const timezone = wantTimezone || rng.pick(localeBundle.timezones);

  // Pick a screen that fits inside the real display so window/screen stay coherent.
  const maxW = options.maxScreenWidth || 1920;
  const maxH = options.maxScreenHeight || 1080;
  let screenChoices = SCREENS.filter(([w, h]) => w <= maxW && h <= maxH);
  if (screenChoices.length === 0) screenChoices = [[maxW, maxH, 1]];
  const [screenWidth, screenHeight] = rng.weighted(
    screenChoices.map(([w, h, weight]) => [[w, h], weight])
  );

  // OS taskbar/menubar allowance, then a believable window inside it.
  const availInset = osKey === 'macos' ? rng.int(25, 38) : rng.int(0, 48);
  const availHeight = screenHeight - availInset;
  const availWidth = screenWidth;
  const windowWidth = Math.max(1024, screenWidth - rng.int(0, 160));
  const windowHeight = Math.max(720, availHeight - rng.int(0, 90));
  const windowLeft = Math.max(0, Math.floor((screenWidth - windowWidth) / 2) + rng.int(-40, 40));
  const windowTop = Math.max(0, rng.int(0, Math.max(1, availHeight - windowHeight)));

  const [webglVendor, webglRenderer] = rng.pick(platform.gpus);

  const hardwareConcurrency = rng.weighted([
    [4, 3], [6, 3], [8, 6], [10, 2], [12, 4], [16, 3], [20, 1], [24, 1],
  ]);
  const deviceMemory = rng.weighted([[4, 3], [8, 6], [16, 3], [32, 1]]);

  const uaFullVersionList = [
    { brand: 'Chromium', version: fullVersion },
    { brand: 'Google Chrome', version: fullVersion },
    { brand: 'Not=A?Brand', version: '24.0.0.0' },
  ];
  const brands = uaFullVersionList.map((b) => ({
    brand: b.brand,
    version: b.brand === 'Not=A?Brand' ? '24' : major,
  }));

  const userAgent =
    `Mozilla/5.0 (${platform.uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36`;

  return {
    seed,
    os: osKey,
    chromeVersion: fullVersion,
    chromeMajor: major,
    userAgent,
    acceptLanguage: languages
      .map((l, i) => (i === 0 ? l : `${l};q=${(1 - i * 0.1).toFixed(1)}`))
      .join(','),
    userAgentMetadata: {
      brands,
      fullVersionList: uaFullVersionList,
      fullVersion,
      platform: platform.chPlatform,
      platformVersion: rng.pick(platform.chPlatformVersions),
      architecture: platform.chArch,
      model: platform.chModel,
      mobile: false,
      bitness: platform.chBitness,
      wow64: false,
    },
    navigatorPlatform: platform.navPlatform,
    locale,
    languages,
    timezone,
    screen: {
      width: screenWidth,
      height: screenHeight,
      availWidth,
      availHeight,
      availLeft: 0,
      availTop: osKey === 'macos' ? availInset : 0,
      colorDepth: 24,
      pixelDepth: 24,
    },
    window: {
      width: windowWidth,
      height: windowHeight,
      left: windowLeft,
      top: windowTop,
    },
    hardwareConcurrency,
    deviceMemory,
    maxTouchPoints: 0,
    webglVendor,
    webglRenderer,
    fontBias: platform.fontBias,
    connection: {
      downlink: Number((rng.int(50, 100) / 10).toFixed(2)),
      rtt: rng.int(1, 12) * 25,
      effectiveType: '4g',
    },
    // Independent noise seeds so canvas/webgl/audio/text hashes differ per run
    // but stay stable within a run (a site re-measuring must get the same value).
    noise: {
      enabled: options.noise !== false,
      canvas: rng.int(1, 2 ** 30),
      webgl: rng.int(1, 2 ** 30),
      audio: rng.int(1, 2 ** 30),
      rects: rng.int(1, 2 ** 30),
      text: rng.int(1, 2 ** 30),
    },
  };
}

module.exports = { generate, makeRng, LOCALES, PLATFORMS };
