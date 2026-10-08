const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stillDesktop', {
  setTheme: theme => {
    if (theme === 'light' || theme === 'dark') ipcRenderer.send('still:theme', theme);
  },
});
