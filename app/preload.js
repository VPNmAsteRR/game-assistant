const { contextBridge, ipcRenderer } = require('electron');

/**
 * Мост между изолированной страницей оверлея и главным процессом.
 * Ничего лишнего наружу не отдаём — только то, что нужно интерфейсу.
 */
contextBridge.exposeInMainWorld('MineBuddyHost', {
  onMessage(cb) {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('minebuddy', handler);
    return () => ipcRenderer.removeListener('minebuddy', handler);
  },

  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: patch => ipcRenderer.send('save-config', patch),
  toggleClickThrough: () => ipcRenderer.invoke('toggle-click-through'),
  bridgeStatus: () => ipcRenderer.invoke('bridge-status')
});
