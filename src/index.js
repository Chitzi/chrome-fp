#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const { ChromeInstance, createFingerprint, summarize } = require('./launcher');

const HELP = `chrome-fp - launch a throwaway Chrome with a fresh fingerprint every run

Usage: chrome-fp [options] [url]

Options:
  --os <linux|windows|macos>  Platform to impersonate            (default: linux)
  --seed <string>             Reproduce a previous fingerprint
  --locale <tag>              Force locale, e.g. de-DE ("auto" = host locale)
  --tz <zone>                 Force timezone, e.g. Europe/Berlin
                              ("auto" = host timezone, matches your real IP)
  --proxy <server>            Route traffic through a proxy
                              e.g. socks5://127.0.0.1:9050
  --no-noise                  Disable canvas/WebGL/audio/text noise
  --keep-profile              Keep the temp profile after exit
  --profile-dir <path>        Use a specific profile dir (implies --keep-profile)
  --bwrap                     Extra OS-level isolation via bubblewrap
  --app                       Desktop app (Electron) to open/close instances
  --gui                       Terminal UI to open/close several instances
  --check                     Open a fingerprint test page
  --print                     Print the generated fingerprint and exit
  --json                      Print the fingerprint as JSON
  -h, --help                  Show this help
`;

function parseArgs(argv) {
  const opts = { url: null, os: 'linux', noise: true };
  const needsValue = {
    '--os': 'os',
    '--seed': 'seed',
    '--locale': 'locale',
    '--tz': 'timezone',
    '--proxy': 'proxy',
    '--profile-dir': 'profileDir',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (needsValue[arg]) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      opts[needsValue[arg]] = value;
    } else if (arg === '--no-noise') opts.noise = false;
    else if (arg === '--keep-profile') opts.keepProfile = true;
    else if (arg === '--bwrap') opts.bwrap = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--gui' || arg === '--tui') opts.gui = true;
    else if (arg === '--app') opts.app = true;
    else if (arg === '--print') opts.print = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else opts.url = arg;
  }
  if (opts.profileDir) opts.keepProfile = true;
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  if (opts.app) {
    let electronPath;
    try {
      electronPath = require('electron');
    } catch (e) {
      console.error('Electron is not installed. Run `npm install` in the chrome-fp folder first.');
      process.exit(1);
    }
    const mainFile = path.join(__dirname, '..', 'electron', 'main.js');
    const child = spawn(electronPath, [mainFile], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code === null ? 0 : code));
    return;
  }

  if (opts.gui) {
    return require('./tui').run(opts);
  }

  const fp = createFingerprint(opts);

  if (opts.json) {
    console.log(JSON.stringify(fp, null, 2));
    if (opts.print) return;
  }
  if (opts.print) {
    console.log(summarize(fp));
    return;
  }

  const instance = new ChromeInstance(Object.assign({}, opts, {
    fp,
    url: opts.url || (opts.check ? 'https://abrahamjuliot.github.io/creepjs/' : 'about:blank'),
  }));

  console.log('\nchrome-fp: launching Chrome with a fresh fingerprint\n');
  console.log(summarize(fp));
  console.log(
    `\n  profile    ${instance.profileDir}${instance.keepProfile ? '' : ' (deleted on exit)'}\n`
  );

  process.on('SIGINT', () => instance.close());
  process.on('SIGTERM', () => instance.close());

  instance.on('exit', (code) => {
    console.log('chrome-fp: browser closed, profile discarded.');
    process.exit(code === null ? 0 : code);
  });

  try {
    await instance.start();
  } catch (e) {
    console.error(`\nFailed to start Chrome: ${e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
