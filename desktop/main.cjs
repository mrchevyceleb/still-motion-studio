const { app, BrowserWindow, Menu, Tray, dialog, shell, nativeImage, nativeTheme, ipcMain, utilityProcess, safeStorage } = require('electron');
const { readFileSync } = require('node:fs');
const { mkdir, writeFile, cp, access } = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { prepareRuntimes } = require('./runtime.cjs');
const { createUpdates } = require('./updates.cjs');
const { NsisUpdater } = require('electron-updater');
// An inherited CI/repository token must not override the user's stored login.
for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete process.env[name];

app.setName('Still Motion Studio');
if (process.platform === 'win32') app.setAppUserModelId('studio.still.motion');
if (process.env.STILL_TEST_USER_DATA) app.setPath('userData', path.resolve(process.env.STILL_TEST_USER_DATA));
const acquired = app.requestSingleInstanceLock();
if (!acquired) app.quit();
let window, tray, engine, updates, quitting = false, stopped = false, installingUpdate = false;

async function unusedPort() {
  const probe = net.createServer();
  // IndexedDB projects belong to the origin: keep the desktop port stable over
  // restarts instead of silently opening an empty workspace on a random port.
  await new Promise((resolve, reject) => { probe.once('error', () => reject(new Error('Still needs local port 17175. Close the other Still instance or the program using that port, then reopen.'))); probe.listen(Number(process.env.STILL_DESKTOP_PORT || 17175), '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function icon() {
  return nativeImage.createFromBuffer(readFileSync(path.join(__dirname, '../public/still-icon.png')));
}

async function prepare(bundle, dataRoot) {
  await prepareRuntimes(bundle, dataRoot);
  const native = process.env.CASCADEUR_HOME || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cascadeur');
  try {
    await access(path.join(native, 'cascadeur.exe'));
    await access(path.join(native, 'samples', 'Cascy.casc'));
    for (const physics of [false, true]) {
      const id = physics ? 'cascadeur_physics' : 'cascadeur';
      const directory = path.join(dataRoot, '.local', physics ? 'cascadeur-physics' : 'cascadeur-proof');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'runtime.json'), JSON.stringify({ python: path.join(bundle, 'python', 'python.exe'), requiredFiles: [path.join(native, 'cascadeur.exe'), path.join(native, 'samples', 'Cascy.casc')], config: { installPath: native }, limits: { maxDuration: 20, humanoidOnly: true, ...(physics ? { earthGravityOnly: true, requiresFloorContact: true } : {}) }, provider: { id, name: physics ? 'Cascadeur AutoPhysics' : 'Cascadeur AI', learned: !physics, description: 'Your installed native engine; its scripting bridge must be running.' } }));
    }
  } catch { /* Optional licensed native installation is absent. */ }
  await mkdir(path.join(dataRoot, 'agent-tools'), { recursive: true });
  for (const file of ['still-agent.mjs', 'still-mcp.mjs']) await cp(path.join(bundle, 'app', 'scripts', file), path.join(dataRoot, 'agent-tools', file));
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  await updates?.stop();
  if (engine && !stopped) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { engine.kill(); resolve(); }, 110000);
      engine.once('exit', () => { clearTimeout(timer); resolve(); });
      engine.postMessage({ type: 'shutdown' });
    });
  }
  tray?.destroy();
  app.exit(0);
}

async function installUpdate(updater) {
  if (quitting || stopped || installingUpdate) throw new Error('Reopen Still before installing this update.');
  installingUpdate = true;
  try {
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); engine.removeListener('message', message); engine.removeListener('exit', exit); error ? reject(error) : resolve(); };
      const message = value => { if (value.type === 'update-blocked') finish(new Error('Finish active work and resolve native cleanup before restarting.')); };
      const exit = code => finish(code === 0 ? null : new Error('Native cleanup did not finish. Reopen Still and retry cleanup before updating.'));
      const timer = setTimeout(() => finish(new Error('Engine shutdown is taking longer than expected. Wait for it to finish, then reopen Still.')), 110000);
      engine.on('message', message); engine.once('exit', exit);
      engine.postMessage({ type: 'shutdown-for-update' });
    });
    quitting = true;
    await updates.stop();
    tray?.destroy();
    updater.quitAndInstall(true, true);
  } finally { installingUpdate = false; }
}

function show() { if (window) { window.show(); window.focus(); } }
app.on('second-instance', show);
app.on('activate', show);
app.on('window-all-closed', () => {});
app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void shutdown(); } });
ipcMain.on('still:theme', (event, theme) => {
  if (event.sender !== window?.webContents || (theme !== 'light' && theme !== 'dark')) return;
  nativeTheme.themeSource = theme;
  window.setBackgroundColor(theme === 'dark' ? '#141d19' : '#f4f3ee');
});
for (const method of ['state', 'check', 'connect', 'install']) ipcMain.handle(`still:updates:${method}`, async event => {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('This update request is unavailable.');
  if (!updates) throw new Error('Updates are not ready.');
  return method === 'state' ? updates.getState() : method === 'install' ? updates.apply() : updates[method]();
});

if (acquired) app.whenReady().then(async () => {
  const bundle = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.resolve(__dirname, '../.local/desktop-bundle');
  const dataRoot = app.getPath('userData');
  await prepare(bundle, dataRoot);
  const port = await unusedPort();
  const env = { ...process.env, STILL_ENGINE_PORT: String(port), STILL_DATA_ROOT: dataRoot, STILL_PACKAGED_PYTHON: path.join(bundle, 'python', 'python.exe'), STILL_STATIC_ROOT: path.join(bundle, 'app', 'dist'), STILL_BLENDER_EXECUTABLE: path.join(bundle, 'blender', 'blender.exe'), STILL_ALLOW_UNCLEARED_MODELS: '0', PYTHONUTF8: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  engine = utilityProcess.fork(path.join(bundle, 'app', 'server', 'engine.mjs'), [], { env, cwd: path.join(bundle, 'app'), stdio: 'pipe', serviceName: 'Still motion engine' });
  let log = '';
  engine.stderr.on('data', chunk => { log = (log + chunk).slice(-12000); });
  engine.on('exit', code => {
    stopped = true;
    if (!quitting && !installingUpdate) {
      dialog.showErrorBox('Still engine stopped', `The local engine stopped (${code}). Reopen Still to recover.\n${log}`);
      void shutdown();
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The local engine did not start.')), 30000);
    engine.once('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(); } });
    engine.once('exit', () => { clearTimeout(timer); reject(new Error(log || 'The local engine stopped during startup.')); });
  });
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 900, minHeight: 640, title: 'Still Motion Studio', backgroundColor: nativeTheme.shouldUseDarkColors ? '#141d19' : '#f4f3ee', icon: icon(), show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'persist:still' } });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  const url = `http://127.0.0.1:${port}`;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== url) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const menu = Menu.buildFromTemplate([
    { label: 'Still', submenu: [{ label: 'Show editor', click: show }, { label: 'Updates…', click: () => { show(); window.webContents.send('still:updates:open'); } }, { label: 'Agent tools', click: () => shell.openPath(path.join(dataRoot, 'agent-tools')) }, { label: 'Open local data', click: () => shell.openPath(dataRoot) }, { type: 'separator' }, { label: 'Quit Still', click: () => void shutdown() }] },
    { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]);
  Menu.setApplicationMenu(menu);
  tray = new Tray(icon().resize({ width: 24, height: 24 })); tray.setToolTip('Still — agent scripting remains available');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Still', click: show }, { label: 'Quit Still', click: () => void shutdown() }])); tray.on('double-click', show);
  updates = createUpdates({ app, safeStorage, bundle, Updater: NsisUpdater, install: installUpdate, send: state => { if (!window.webContents.isDestroyed()) window.webContents.send('still:updates:state', state); } });
  await window.loadURL(url);
  updates.start();
  if (process.env.STILL_BACKGROUND !== '1') show();
}).catch(error => { dialog.showErrorBox('Still could not start', error.message); void shutdown(); });
