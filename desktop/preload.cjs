const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stillDesktop', {
  pickFolder: () => ipcRenderer.invoke('still:pick-folder'),
  openExternal: url => ipcRenderer.invoke('still:open-external', url),
  meshyKey: {
    get: () => ipcRenderer.invoke('still:meshy-key:get'),
    set: key => ipcRenderer.invoke('still:meshy-key:set', key),
    clear: () => ipcRenderer.invoke('still:meshy-key:clear'),
  },
  setTheme: theme => {
    if (theme === 'light' || theme === 'dark') ipcRenderer.send('still:theme', theme);
  },
  updates: {
    state: () => ipcRenderer.invoke('still:updates:state'),
    check: () => ipcRenderer.invoke('still:updates:check'),
    install: () => ipcRenderer.invoke('still:updates:install'),
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('still:updates:state', listener);
      return () => ipcRenderer.removeListener('still:updates:state', listener);
    },
    onOpen: callback => {
      const listener = () => callback();
      ipcRenderer.on('still:updates:open', listener);
      return () => ipcRenderer.removeListener('still:updates:open', listener);
    },
  },
});
