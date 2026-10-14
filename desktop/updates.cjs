const { readFile, writeFile, mkdir, mkdtemp, rm, rename, unlink, readdir, lstat } = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const run = promisify(execFile);
const REPOSITORY = { provider: 'github', owner: 'mrchevyceleb', repo: 'still-motion-studio', private: true };
// Electron's net requests never emit 'socket', so electron-updater's 60 s socket
// timeout is never armed: a dropped connection mid-download waits forever. Watch
// for silence ourselves, cancel, and retry.
const STALL_MS = 120 * 1000, STALL_RETRIES = 3;
class Stalled extends Error {}

// Credentials stay in the main process. Neither the renderer nor release files
// receive a token; Windows DPAPI protects the optional app-specific credential.
function createUpdates({ app, safeStorage, runtime, runtimeId, send, install, Updater }) {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete process.env[name];
  const gh = path.join(runtime, 'github', 'gh.exe');
  const credential = path.join(app.getPath('userData'), 'github-update-auth.bin');
  let updater, active = false, login, timer, startup, retry, loginDone, cleanupPromise, closing = false, lastActivity = 0;
  let state = { status: 'idle', currentVersion: app.getVersion(), message: 'Updates download automatically. You choose when to restart.' };
  const publish = patch => { state = { ...state, deviceCode: undefined, ...patch }; send(state); return state; };
  const authRequired = () => publish({ status: 'auth-required', message: 'Connect a GitHub account with access to the private Still repository.' });
  const loginRoot = path.join(app.getPath('userData'), 'github-login');
  async function removeLoginDirectory(directory) {
    if (path.dirname(path.resolve(directory)) !== loginRoot || !/^attempt-[A-Za-z0-9]{6}$/.test(path.basename(directory))) throw new Error('Sign-in cleanup escaped application data.');
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Sign-in cleanup requires its own real directory.');
    await rm(directory, { recursive: true, force: true });
  }
  async function clearInterruptedLogins() {
    await mkdir(loginRoot, { recursive: true });
    const info = await lstat(loginRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The sign-in directory must be a real directory.');
    for (const name of await readdir(loginRoot)) if (/^attempt-[A-Za-z0-9]{6}$/.test(name)) await removeLoginDirectory(path.join(loginRoot, name));
  }
  function initialCleanup() {
    if (!cleanupPromise) cleanupPromise = clearInterruptedLogins().catch(error => { cleanupPromise = null; throw error; });
    return cleanupPromise;
  }
  async function token() {
    try { return safeStorage.decryptString(await readFile(credential)); }
    catch (error) { if (error.code !== 'ENOENT') await unlink(credential).catch(() => {}); }
    try {
      return (await run(gh, ['auth', 'token', '--hostname', 'github.com'], { windowsHide: true, timeout: 15000, maxBuffer: 16384 })).stdout.trim();
    } catch { return null; }
  }
  // Releases list the full installer first, so builds that predate this check always
  // get the runtime. When the release ships the runtime this install already has,
  // download the small app-only installer instead.
  function preferAppOnly(info) {
    const index = info?.files?.findIndex(file => /^Still-Motion-Studio-Update-[^/]+\.exe$/.test(file.url)) ?? -1;
    if (info.runtimeId === runtimeId && index > 0) info.files.unshift(...info.files.splice(index, 1));
  }
  function configure(secret) {
    const self = updater = new Updater({ ...REPOSITORY, token: secret });
    updater.logger = null; // HTTP failures can contain private headers/URLs.
    // A cancelled, stalled updater may still emit late events; only the current one reports.
    const on = (event, handler) => self.on(event, (...args) => { if (updater !== self) return; lastActivity = Date.now(); handler(...args); });
    // We start the download ourselves with its own cancellation token, so a stalled
    // download can always be cancelled and an abandoned check can never start one.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false; // Save and stop the engine first.
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    // Private assets use authenticated API redirects; a full download avoids
    // differential range requests across expiring signed asset URLs.
    updater.disableDifferentialDownload = true;
    on('checking-for-update', () => publish({ status: 'checking', progress: undefined, message: 'Checking GitHub…' }));
    on('update-not-available', () => publish({ status: 'current', version: undefined, progress: undefined, message: 'You have the latest release.' }));
    on('update-available', info => publish({ status: 'downloading', version: info.version, progress: 0, message: 'Downloading the next release in the background…' }));
    on('download-progress', info => publish({ status: 'downloading', progress: Math.round(info.percent), message: 'Downloading the next release in the background…' }));
    on('update-downloaded', info => publish({ status: 'ready', version: info.version, progress: 100, message: 'Update ready. Your scene will be saved before restarting.' }));
    on('error', error => {
      if (/401|403|404/.test(String(error.statusCode || '') + String(error.code || '') + String(error.message || ''))) authRequired();
      else publish({ status: 'error', message: 'The update could not finish. Check your connection and try again. Your installed version is still available.' });
    });
  }
  // A manual or scheduled check starts a fresh retry chain; only stall retries continue one.
  function check() { clearTimeout(retry); return attempt(0); }
  async function attempt(stalls) {
    if (closing || active || ['ready', 'installing'].includes(state.status)) return state;
    if (!app.isPackaged) return publish({ status: 'disabled', message: 'Automatic updates are available in the installed Windows app.' });
    active = true;
    clearTimeout(retry);
    let watchdog, cancellation;
    try {
      const secret = await token();
      if (!secret) return authRequired();
      configure(secret);
      const current = updater;
      lastActivity = Date.now();
      const work = (async () => {
        const result = await current.checkForUpdates();
        // A check abandoned after a stall may still answer; it must not start a download.
        if (updater !== current || !result?.isUpdateAvailable) return;
        preferAppOnly(result.updateInfo);
        cancellation = result.cancellationToken;
        await current.downloadUpdate(cancellation);
      })();
      work.catch(() => {}); // A stalled attempt may reject after we stop waiting.
      // Any silence, while checking or downloading, counts. Progress events keep it alive
      // and the download resolves on update-downloaded, so no completed step is mistaken.
      const stalled = new Promise((_, reject) => {
        watchdog = setInterval(() => { if (Date.now() - lastActivity > STALL_MS) reject(new Stalled()); }, 5000);
      });
      await Promise.race([work, stalled]);
    } catch (error) {
      if (error instanceof Stalled) {
        cancellation?.cancel();
        updater = null;
        if (stalls < STALL_RETRIES && !closing) {
          publish({ status: 'error', progress: undefined, message: 'The download stopped responding. Retrying automatically…' });
          retry = setTimeout(() => void attempt(stalls + 1), 5000);
          retry.unref();
        } else publish({ status: 'error', progress: undefined, message: 'The download keeps stalling. Check your connection, then choose Check for updates.' });
      } else if (!['auth-required', 'error'].includes(state.status)) publish({ status: 'error', progress: undefined, message: 'The update check could not finish. Check your connection and try again.' });
    }
    finally { clearInterval(watchdog); active = false; }
    return state;
  }
  async function connect() {
    if (closing || active || ['ready', 'installing'].includes(state.status)) return state;
    if (!safeStorage.isEncryptionAvailable()) return publish({ status: 'error', message: 'Windows credential encryption is unavailable. Sign into GitHub CLI securely, then check again.' });
    active = true;
    let loginFinished;
    loginDone = new Promise(resolve => { loginFinished = resolve; });
    let directory;
    publish({ status: 'signing-in', message: 'Preparing GitHub sign-in…' });
    try {
      await initialCleanup();
      directory = await mkdtemp(path.join(loginRoot, 'attempt-'));
      if (closing) throw new Error('The app is closing.');
      const env = { ...process.env, GH_CONFIG_DIR: directory, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' };
      delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.GH_ENTERPRISE_TOKEN; delete env.GITHUB_ENTERPRISE_TOKEN;
      await new Promise((resolve, reject) => {
        login = spawn(gh, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const timeout = setTimeout(() => { login?.kill(); reject(new Error('Sign-in expired.')); }, 10 * 60 * 1000);
        let output = '';
        const onOutput = data => {
          output = (output + data.toString()).slice(-4096);
          const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
          if (code) publish({ status: 'signing-in', deviceCode: code, message: 'Enter this code in the GitHub browser window and authorize GitHub CLI.' });
        };
        login.stdout.on('data', onOutput); login.stderr.on('data', onOutput);
        login.once('error', error => { clearTimeout(timeout); reject(error); });
        login.once('exit', code => { clearTimeout(timeout); login = null; code === 0 ? resolve() : reject(new Error('Sign-in did not finish.')); });
      });
      const secret = (await run(gh, ['auth', 'token', '--hostname', 'github.com'], { env, windowsHide: true, timeout: 15000, maxBuffer: 16384 })).stdout.trim();
      if (!secret) throw new Error('No credential returned.');
      await writeFile(credential + '.pending', safeStorage.encryptString(secret), { mode: 0o600 });
      await rename(credential + '.pending', credential);
      publish({ status: 'idle', message: 'GitHub connected. Checking for updates…' });
    } catch { publish({ status: 'error', message: 'GitHub sign-in did not finish. Try Connect GitHub again.' }); }
    finally {
      // gh may fall back to plaintext if its own keyring fails. Always remove
      // that isolated temporary configuration; only our DPAPI copy persists.
      try { if (directory) await removeLoginDirectory(directory); }
      finally { active = false; loginFinished(); }
    }
    if (state.status === 'idle') return check();
    return state;
  }
  async function apply() {
    if (closing || active || state.status !== 'ready' || !updater) return state;
    active = true;
    publish({ status: 'installing', message: 'Saving complete. Still will close, install for a few minutes in the background, then reopen by itself.' });
    try { await install(updater); }
    catch (error) { publish({ status: 'ready', message: error.message || 'The app could not restart. Your scene is saved; try again.' }); }
    finally { active = false; }
    return state;
  }
  function start() {
    void initialCleanup().catch(() => publish({ status: 'error', message: 'An interrupted sign-in could not be cleaned up. Check the app’s local data folder before connecting again.' }));
    startup = setTimeout(() => void check(), 10000);
    timer = setInterval(() => void check(), 6 * 60 * 60 * 1000);
    startup.unref(); timer.unref();
  }
  async function stop() { closing = true; clearTimeout(startup); clearTimeout(retry); clearInterval(timer); login?.kill(); await loginDone; }
  return { getState: () => state, check, connect, apply, start, stop };
}
module.exports = { createUpdates };
