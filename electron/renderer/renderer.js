'use strict';

const api = window.chromefp;

const el = (id) => document.getElementById(id);
const rows = el('rows');
const expanded = new Set();
const urlBarOpen = new Set();

function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function launchOptions() {
  return {
    os: el('os').value,
    url: el('url').value.trim() || 'about:blank',
    timezone: el('tz').value || undefined,
    locale: el('locale').value || undefined,
    seed: el('seed').value.trim() || undefined,
    proxy: el('proxy').value.trim() || undefined,
    noise: el('noise').checked,
    bwrap: el('bwrap').checked,
  };
}

function makeButton(label, className, onClick, title) {
  const button = document.createElement('button');
  button.textContent = label;
  button.className = `small ${className}`;
  if (title) button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function renderInstance(instance) {
  const tr = document.createElement('tr');

  const id = document.createElement('td');
  id.textContent = `#${instance.id}`;
  tr.appendChild(id);

  const status = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `badge ${instance.status}`;
  badge.textContent = instance.status;
  status.appendChild(badge);
  tr.appendChild(status);

  const os = document.createElement('td');
  os.textContent = instance.os;
  tr.appendChild(os);

  const identity = document.createElement('td');
  identity.className = 'identity';
  identity.textContent = `${instance.locale} · ${instance.timezone} · ${instance.screen}`;
  const extra = document.createElement('small');
  extra.textContent = `${instance.hardware} · ${instance.gpu}${
    instance.proxy ? ` · proxy ${instance.proxy}` : ''
  }`;
  identity.appendChild(extra);
  tr.appendChild(identity);

  const tabs = document.createElement('td');
  tabs.textContent = String(instance.pages);
  tr.appendChild(tabs);

  const uptime = document.createElement('td');
  uptime.textContent = formatUptime(instance.uptimeMs);
  tr.appendChild(uptime);

  const actions = document.createElement('td');
  const group = document.createElement('div');
  group.className = 'actions';
  group.appendChild(
    makeButton('Open URL', 'ghost', () => {
      if (urlBarOpen.has(instance.id)) urlBarOpen.delete(instance.id);
      else urlBarOpen.add(instance.id);
      render(lastState);
    }, 'Open a URL in a new tab of this instance')
  );
  group.appendChild(
    makeButton(expanded.has(instance.id) ? 'Hide' : 'Details', 'ghost', () => {
      if (expanded.has(instance.id)) expanded.delete(instance.id);
      else expanded.add(instance.id);
      render(lastState);
    }, 'Show the full fingerprint')
  );
  group.appendChild(
    makeButton('Close', 'ghost danger', () => api.close(instance.id), 'Close and wipe the profile')
  );
  actions.appendChild(group);
  tr.appendChild(actions);

  const result = [tr];

  if (urlBarOpen.has(instance.id)) {
    const bar = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    const wrap = document.createElement('div');
    wrap.className = 'urlbar';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = `Open in #${instance.id} — e.g. example.com`;
    input.dataset.keepFocus = `url-${instance.id}`;
    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      api.openUrl(instance.id, value);
      input.value = '';
      urlBarOpen.delete(instance.id);
      render(lastState);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') {
        urlBarOpen.delete(instance.id);
        render(lastState);
      }
    });
    wrap.appendChild(input);
    wrap.appendChild(makeButton('Open', 'primary', submit));
    cell.appendChild(wrap);
    bar.appendChild(cell);
    result.push(bar);
  }

  if (expanded.has(instance.id)) {
    const detailRow = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    const pre = document.createElement('pre');
    pre.className = 'details';
    pre.textContent = `${instance.details}\n  profile       ${instance.profileDir}`;
    cell.appendChild(pre);
    detailRow.appendChild(cell);
    result.push(detailRow);
  }

  return result;
}

let lastState = { instances: [], message: null };

function render(state) {
  lastState = state;
  const focused = document.activeElement;
  const focusKey = focused && focused.dataset ? focused.dataset.keepFocus : null;
  const caret = focused && focused.selectionStart;

  rows.textContent = '';
  for (const instance of state.instances) {
    for (const node of renderInstance(instance)) rows.appendChild(node);
  }

  el('empty').classList.toggle('hidden', state.instances.length > 0);
  el('close-all').disabled = state.instances.length === 0;
  const running = state.instances.filter((i) => i.status === 'running').length;
  el('count').textContent = state.instances.length
    ? `${state.instances.length} instance(s), ${running} running`
    : '';
  if (state.message) el('message').textContent = state.message;

  if (focusKey) {
    const next = document.querySelector(`[data-keep-focus="${focusKey}"]`);
    if (next) {
      next.focus();
      if (caret !== null && next.setSelectionRange) next.setSelectionRange(caret, caret);
    }
  }
}

el('launch').addEventListener('click', async () => {
  el('launch').disabled = true;
  await api.launch(launchOptions());
  el('launch').disabled = false;
});

el('url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el('launch').click();
});

el('close-all').addEventListener('click', () => api.closeAll());

el('toggle-advanced').addEventListener('click', () => {
  el('advanced').classList.toggle('hidden');
});

el('preview').addEventListener('click', async () => {
  const result = await api.previewFingerprint(launchOptions());
  const out = el('preview-out');
  out.classList.remove('hidden');
  out.textContent = result.ok ? result.summary : `Error: ${result.error}`;
});

// Impersonating the host OS is the most coherent default (fonts are real), and
// bubblewrap only exists on Linux.
const hostOs =
  api.platform === 'win32' ? 'windows' : api.platform === 'darwin' ? 'macos' : 'linux';
el('os').value = hostOs;
Array.from(el('os').options).forEach((option) => {
  if (option.value === hostOs) option.textContent += ' (most coherent here)';
  else option.textContent = option.textContent.replace(' (most coherent here)', '');
});
if (api.platform !== 'linux') {
  el('bwrap').checked = false;
  el('bwrap').disabled = true;
  el('bwrap').closest('.check').title = 'bubblewrap isolation is Linux-only';
  el('bwrap').closest('.check').classList.add('hidden');
}

api.onState(render);
api.getState().then(render);
