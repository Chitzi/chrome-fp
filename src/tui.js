'use strict';

const { ChromeInstance, createFingerprint, summarize } = require('./launcher');

const ESC = '\x1b';
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR = `${ESC}[2J${ESC}[H`;

const useColor = !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text);
const bold = (t) => paint('1', t);
const dim = (t) => paint('2', t);
const green = (t) => paint('32', t);
const yellow = (t) => paint('33', t);
const red = (t) => paint('31', t);
const cyan = (t) => paint('36', t);
const inverse = (t) => paint('7', t);

const STATUS_COLORS = {
  starting: yellow,
  running: green,
  closing: yellow,
  exited: dim,
  failed: red,
};

function fit(str, width) {
  const plain = str.replace(/\x1b\[[0-9;]*m/g, '');
  if (plain.length <= width) return str + ' '.repeat(width - plain.length);
  return plain.slice(0, Math.max(0, width - 1)) + '…';
}

function shortGpu(renderer) {
  const match = /\(([^,]+),\s*([^,]+)/.exec(renderer || '');
  let name = match ? match[2] : renderer || '';
  return name.replace(/\s*(Direct3D11 vs_5_0 ps_5_0|\/PCIe\/SSE2|\(.*?\))/g, '').trim();
}

function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

class Tui {
  constructor(opts) {
    this.opts = opts;
    this.instances = [];
    this.nextId = 1;
    this.selected = 0;
    this.message = 'Press [n] to launch a Chrome instance with a fresh fingerprint.';
    this.showDetails = false;
    this.mode = 'list'; // 'list' | 'prompt'
    this.prompt = null;
    this.quitting = false;
  }

  run() {
    if (!process.stdout.isTTY) {
      console.error('chrome-fp --gui needs an interactive terminal.');
      process.exit(2);
    }
    process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => this.onKey(key));
    process.stdout.on('resize', () => this.render());
    this.ticker = setInterval(() => this.render(), 1000);
    process.on('exit', () => this.restoreTerminal());
    this.render();
    if (this.opts.url) this.launch({ url: this.opts.url });
  }

  restoreTerminal() {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch (e) {}
    process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);
  }

  setMessage(text) {
    this.message = text;
    this.render();
  }

  /* ---------- instance management ---------- */

  launch(overrides = {}) {
    const opts = Object.assign({}, this.opts, overrides, { gui: false });
    delete opts.profileDir; // every GUI instance gets its own throwaway profile
    opts.url = overrides.url || this.opts.url || 'about:blank';

    let fp;
    try {
      fp = createFingerprint(opts);
    } catch (e) {
      return this.setMessage(red(`Could not build fingerprint: ${e.message}`));
    }

    const instance = new ChromeInstance(Object.assign({}, opts, { fp }));
    instance.id = this.nextId++;
    this.instances.push(instance);
    this.selected = this.instances.length - 1;

    instance.on('pages', () => this.render());
    instance.on('ready', () => {
      this.setMessage(green(`#${instance.id} ready · ${fp.locale} · ${fp.timezone}`));
    });
    instance.on('exit', () => {
      this.instances = this.instances.filter((i) => i !== instance);
      if (this.selected >= this.instances.length) this.selected = Math.max(0, this.instances.length - 1);
      if (!this.quitting) this.setMessage(dim(`#${instance.id} closed, profile wiped.`));
      else this.render();
    });

    this.setMessage(`Starting #${instance.id} (${opts.os || 'linux'})…`);
    instance.start().catch((e) => {
      instance.status = 'failed';
      this.instances = this.instances.filter((i) => i !== instance);
      this.setMessage(red(`#${instance.id} failed: ${String(e.message).split('\n')[0]}`));
    });
    this.render();
  }

  current() {
    return this.instances[this.selected] || null;
  }

  closeSelected() {
    const instance = this.current();
    if (!instance) return this.setMessage('Nothing to close.');
    this.setMessage(`Closing #${instance.id}…`);
    instance.close();
  }

  closeAll() {
    if (this.instances.length === 0) return this.setMessage('Nothing to close.');
    this.setMessage(`Closing ${this.instances.length} instance(s)…`);
    for (const instance of this.instances.slice()) instance.close();
  }

  quit() {
    if (this.quitting) return;
    this.quitting = true;
    clearInterval(this.ticker);
    const pending = this.instances.slice();
    if (pending.length === 0) {
      this.restoreTerminal();
      process.exit(0);
    }
    this.setMessage(`Shutting down ${pending.length} instance(s)…`);
    for (const instance of pending) instance.close();
    const deadline = Date.now() + 8000;
    const wait = setInterval(() => {
      if (this.instances.length === 0 || Date.now() > deadline) {
        clearInterval(wait);
        this.restoreTerminal();
        process.exit(0);
      }
    }, 200);
  }

  /* ---------- input ---------- */

  onKey(key) {
    if (this.mode === 'prompt') return this.onPromptKey(key);

    switch (key) {
      case 'n':
        return this.launch();
      case 'l':
        return this.launch({ os: 'linux' });
      case 'w':
        return this.launch({ os: 'windows' });
      case 'm':
        return this.launch({ os: 'macos' });
      case 'c':
        return this.launch({ url: 'https://abrahamjuliot.github.io/creepjs/' });
      case 'x':
      case '\x7f':
        return this.closeSelected();
      case 'X':
        return this.closeAll();
      case 'i':
        this.showDetails = !this.showDetails;
        return this.render();
      case 'o':
        if (!this.current()) return this.setMessage('No instance selected.');
        this.mode = 'prompt';
        this.prompt = { label: `Open URL in #${this.current().id}`, value: '' };
        return this.render();
      case 'j':
      case `${ESC}[B`:
        this.selected = Math.min(this.instances.length - 1, this.selected + 1);
        return this.render();
      case 'k':
      case `${ESC}[A`:
        this.selected = Math.max(0, this.selected - 1);
        return this.render();
      case 'q':
      case '\x03':
        return this.quit();
      default:
        if (/^[1-9]$/.test(key)) {
          const index = this.instances.findIndex((i) => i.id === Number(key));
          if (index >= 0) {
            this.selected = index;
            this.render();
          }
        }
    }
  }

  onPromptKey(key) {
    if (key === ESC || key === '\x03') {
      this.mode = 'list';
      this.prompt = null;
      return this.render();
    }
    if (key === '\x7f' || key === '\b') {
      this.prompt.value = this.prompt.value.slice(0, -1);
      return this.render();
    }

    // Typed or pasted text arrives in chunks, not one key at a time.
    const submitIndex = key.search(/[\r\n]/);
    const text = submitIndex === -1 ? key : key.slice(0, submitIndex);
    this.prompt.value += text
      .split('')
      .filter((ch) => ch >= ' ' && ch !== '\x7f')
      .join('');
    if (submitIndex === -1) return this.render();

    const value = this.prompt.value.trim();
    const instance = this.current();
    this.mode = 'list';
    this.prompt = null;
    if (value && instance) {
      const url = /^[a-zA-Z][\w+.-]*:/.test(value) ? value : `https://${value}`;
      instance
        .openUrl(url)
        .then(() => this.setMessage(`Opened ${url} in #${instance.id}`))
        .catch((e) => this.setMessage(red(`Could not open: ${e.message}`)));
    }
    return this.render();
  }

  /* ---------- rendering ---------- */

  render() {
    if (this.quitting && this.instances.length === 0) return;
    const width = Math.max(60, process.stdout.columns || 80);
    const lines = [];
    const body = [];
    const footer = [];
    const running = this.instances.filter((i) => i.status === 'running').length;

    lines.push(
      bold(cyan(' chrome-fp ')) +
        dim(` ${this.instances.length} instance(s), ${running} running`)
    );
    lines.push(dim('─'.repeat(width)));

    const idW = 3;
    const statusW = 9;
    const osW = 8;
    const tabsW = 5;
    const upW = 6;
    const identW = Math.max(20, width - (idW + statusW + osW + tabsW + upW + 7));

    lines.push(
      dim(
        ' ' +
          fit('#', idW) +
          ' ' +
          fit('STATUS', statusW) +
          ' ' +
          fit('OS', osW) +
          ' ' +
          fit('IDENTITY', identW) +
          ' ' +
          fit('TABS', tabsW) +
          ' ' +
          fit('UPTIME', upW)
      )
    );

    if (this.instances.length === 0) {
      body.push('');
      body.push(dim('   No instances running — press [n] to launch one.'));
    }

    this.instances.forEach((instance, index) => {
      const fp = instance.fp;
      const identity = `${fp.locale} · ${fp.timezone.split('/').pop()} · ${fp.screen.width}x${fp.screen.height} · ${fp.hardwareConcurrency}c/${fp.deviceMemory}GB · ${shortGpu(fp.webglRenderer)}`;
      const colorFn = STATUS_COLORS[instance.status] || ((t) => t);
      const cells = [
        fit(String(instance.id), idW),
        fit(instance.status, statusW),
        fit(fp.os, osW),
        fit(identity, identW),
        fit(String(instance.pageCount), tabsW),
        fit(formatUptime(instance.uptimeMs), upW),
      ];
      const plainRow = ' ' + cells.join(' ');
      if (index === this.selected) {
        body.push(inverse(plainRow));
      } else {
        cells[1] = colorFn(cells[1]);
        body.push(' ' + cells.join(' '));
      }
    });

    if (this.showDetails && this.current()) {
      body.push('');
      body.push(dim('─'.repeat(width)));
      body.push(bold(` details · instance #${this.current().id}`));
      for (const line of summarize(this.current().fp).split('\n')) {
        body.push(fit(line, width));
      }
      body.push(fit(`  profile       ${this.current().profileDir}`, width));
    }

    footer.push('');
    footer.push(dim('─'.repeat(width)));
    footer.push(
      ' ' +
        [
          `${bold('n')} new`,
          `${bold('l/w/m')} new linux/win/mac`,
          `${bold('c')} new + fp test`,
          `${bold('o')} open URL`,
        ].join(dim('  ·  '))
    );
    footer.push(
      ' ' +
        [
          `${bold('↑/↓')} select`,
          `${bold('x')} close`,
          `${bold('X')} close all`,
          `${bold('i')} details`,
          `${bold('q')} quit`,
        ].join(dim('  ·  '))
    );
    footer.push('');
    if (this.mode === 'prompt') {
      footer.push(` ${this.prompt.label}: ${this.prompt.value}${useColor ? `${ESC}[7m \x1b[0m` : '_'}`);
      footer.push(dim(' Enter to open · Esc to cancel'));
    } else {
      footer.push(' ' + this.message);
    }

    // The footer carries the key bindings and status, so the body is what gets
    // trimmed when the terminal is short.
    const height = process.stdout.rows || 24;
    const bodyRoom = Math.max(1, height - 1 - lines.length - footer.length);
    const shownBody =
      body.length <= bodyRoom
        ? body
        : body.slice(0, bodyRoom - 1).concat(dim(`   … ${body.length - bodyRoom + 1} more line(s)`));

    const out = lines
      .concat(shownBody, footer)
      .map((l) => `${ESC}[2K${l}`)
      .join('\n');
    process.stdout.write(CLEAR + out);
  }
}

function run(opts) {
  const tui = new Tui(opts);
  tui.run();
  return new Promise(() => {});
}

module.exports = { run, Tui };
