'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
const path = require('path');

const { createInstance, createIdentity, summarize } = require('../src/launcher');

const instances = new Map();
let nextId = 1;
let mainWindow = null;
let quitting = false;

function appIcon() {
  // The window icon is what the taskbar/dock shows for a running instance.
  const packaged = path.join(process.resourcesPath || '', 'icon.png');
  const source = path.join(__dirname, '..', 'build', 'icons', '256x256.png');
  for (const candidate of [packaged, source]) {
    try {
      if (require('fs').existsSync(candidate)) return candidate;
    } catch (e) {}
  }
  return undefined;
}

function displayBounds() {
  // Keeps the spoofed screen size inside the real one on every platform.
  try {
    const size = screen.getPrimaryDisplay().size;
    if (size && size.width && size.height) {
      return { maxScreenWidth: size.width, maxScreenHeight: size.height };
    }
  } catch (e) {}
  return {};
}

function shortGpu(renderer) {
  const match = /\(([^,]+),\s*([^,]+)/.exec(renderer || '');
  const name = match ? match[2] : renderer || '';
  return name.replace(/\s*(Direct3D11 vs_5_0 ps_5_0|\/PCIe\/SSE2|\(.*?\))/g, '').trim();
}

function serialize(instance) {
  const fp = instance.fp;
  const firefox = instance.browser === 'firefox';
  return {
    id: instance.id,
    status: instance.status,
    browser: firefox ? 'firefox' : 'chrome',
    mode: firefox ? fp.mode : null,
    loginSafe: instance.loginSafe,
    os: fp.os,
    pages: instance.pageCount,
    uptimeMs: instance.uptimeMs,
    profileDir: instance.profileDir,
    seed: fp.seed,
    locale: fp.locale,
    timezone: fp.timezone,
    screen: firefox ? `${fp.window.width}x${fp.window.height}` : `${fp.screen.width}x${fp.screen.height}`,
    hardware: firefox ? `Firefox ${fp.version}` : `${fp.hardwareConcurrency}c / ${fp.deviceMemory}GB`,
    gpu: firefox ? `${fp.mode} protection` : shortGpu(fp.webglRenderer),
    chromeVersion: firefox ? fp.version : fp.chromeVersion,
    proxy: instance.opts.proxy || null,
    details: summarize(fp, { loginSafe: instance.loginSafe && !firefox }),
  };
}

function broadcast(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('state', {
    instances: Array.from(instances.values()).map(serialize),
    message: message || null,
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    title: 'chrome-fp',
    icon: appIcon(),
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links clicked inside the control panel must never open in the panel itself.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function launchInstance(options = {}) {
  const launchOptions = Object.assign(displayBounds(), {
    browser: options.browser === 'firefox' ? 'firefox' : 'chrome',
    mode: options.mode || 'balanced',
    os: options.os || 'linux',
    url: options.url || 'about:blank',
    proxy: options.proxy || undefined,
    seed: options.seed || undefined,
    timezone: options.timezone || undefined,
    locale: options.locale || undefined,
    noise: options.noise !== false,
    bwrap: Boolean(options.bwrap),
    loginSafe: Boolean(options.loginSafe),
  });

  const fp = createIdentity(launchOptions);
  const instance = createInstance(Object.assign({}, launchOptions, { fp, identity: fp }));
  instance.id = nextId++;
  instances.set(instance.id, instance);

  instance.on('pages', () => broadcast());
  instance.on('ready', () =>
    broadcast(
      `#${instance.id} ready · ${fp.locale} · ${fp.timezone}${
        launchOptions.loginSafe ? ' · login-safe' : ''
      }`
    )
  );
  instance.on('exit', () => {
    instances.delete(instance.id);
    broadcast(quitting ? null : `#${instance.id} closed, profile wiped.`);
    if (quitting && instances.size === 0) app.quit();
  });

  instance.start().catch((error) => {
    instances.delete(instance.id);
    broadcast(`#${instance.id} failed: ${String(error.message).split('\n')[0]}`);
  });

  broadcast(`Starting #${instance.id} (${launchOptions.os})…`);
  return instance.id;
}

ipcMain.handle('launch', (event, options) => {
  try {
    return { ok: true, id: launchInstance(options) };
  } catch (error) {
    broadcast(`Launch failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('close', (event, id) => {
  const instance = instances.get(id);
  if (!instance) return { ok: false, error: 'no such instance' };
  broadcast(`Closing #${id}…`);
  instance.close();
  return { ok: true };
});

ipcMain.handle('close-all', () => {
  for (const instance of instances.values()) instance.close();
  broadcast('Closing every instance…');
  return { ok: true };
});

ipcMain.handle('open-url', async (event, { id, url }) => {
  const instance = instances.get(id);
  if (!instance) return { ok: false, error: 'no such instance' };
  const target = /^[a-zA-Z][\w+.-]*:/.test(url) ? url : `https://${url}`;
  try {
    await instance.openUrl(target);
    broadcast(`Opened ${target} in #${id}`);
    return { ok: true };
  } catch (error) {
    broadcast(`Could not open: ${error.message}`);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('preview-fingerprint', (event, options) => {
  try {
    const merged = Object.assign(displayBounds(), options || {});
    return {
      ok: true,
      summary: summarize(createIdentity(merged), {
        loginSafe: Boolean(merged.loginSafe) && merged.browser !== 'firefox',
      }),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('state', () => ({
  instances: Array.from(instances.values()).map(serialize),
  message: null,
}));

app.whenReady().then(() => {
  createWindow();
  setInterval(() => broadcast(), 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (instances.size === 0) return;
  // Chrome instances must be shut down so their throwaway profiles get wiped.
  if (!quitting) {
    quitting = true;
    for (const instance of instances.values()) instance.close();
    setTimeout(() => {
      quitting = true;
      app.exit(0);
    }, 8000).unref();
  }
  event.preventDefault();
});

process.on('uncaughtException', (error) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showErrorBox('chrome-fp', String(error && error.stack ? error.stack : error));
  } else {
    console.error(error);
  }
});
