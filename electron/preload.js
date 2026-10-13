'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chromefp', {
  platform: process.platform,
  launch: (options) => ipcRenderer.invoke('launch', options),
  close: (id) => ipcRenderer.invoke('close', id),
  closeAll: () => ipcRenderer.invoke('close-all'),
  openUrl: (id, url) => ipcRenderer.invoke('open-url', { id, url }),
  previewFingerprint: (options) => ipcRenderer.invoke('preview-fingerprint', options),
  getState: () => ipcRenderer.invoke('state'),
  onState: (handler) => {
    const listener = (event, state) => handler(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
});
