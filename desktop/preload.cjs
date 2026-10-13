const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stillDesktop', {
  pickFolder: () => ipcRenderer.invoke('still:pick-folder'),
  setTheme: theme => {
    if (theme === 'light' || theme === 'dark') ipcRenderer.send('still:theme', theme);
  },
  updates: {
    state: () => ipcRenderer.invoke('still:updates:state'),
    check: () => ipcRenderer.invoke('still:updates:check'),
    connect: () => ipcRenderer.invoke('still:updates:connect'),
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
