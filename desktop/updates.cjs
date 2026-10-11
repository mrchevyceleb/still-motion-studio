const { readFile, writeFile, mkdir, mkdtemp, rm, rename, unlink, readdir, lstat } = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const run = promisify(execFile);
const REPOSITORY = { provider: 'github', owner: 'mrchevyceleb', repo: 'still-motion-studio', private: true };

// Credentials stay in the main process. Neither the renderer nor release files
// receive a token; Windows DPAPI protects the optional app-specific credential.
function createUpdates({ app, safeStorage, bundle, send, install, Updater }) {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete process.env[name];
  const gh = path.join(bundle, 'github', 'gh.exe');
  const credential = path.join(app.getPath('userData'), 'github-update-auth.bin');
  let updater, active = false, login, timer, startup, loginDone, cleanupPromise, closing = false;
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
  function configure(secret) {
    updater = new Updater({ ...REPOSITORY, token: secret });
    updater.logger = null; // HTTP failures can contain private headers/URLs.
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false; // Save and stop the engine first.
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    // Private assets use authenticated API redirects; a full download avoids
    // differential range requests across expiring signed asset URLs.
    updater.disableDifferentialDownload = true;
    updater.on('checking-for-update', () => publish({ status: 'checking', message: 'Checking GitHub…' }));
    updater.on('update-not-available', () => publish({ status: 'current', version: undefined, progress: undefined, message: 'You have the latest release.' }));
    updater.on('update-available', info => publish({ status: 'downloading', version: info.version, progress: 0, message: 'Downloading the next release in the background…' }));
    updater.on('download-progress', info => publish({ status: 'downloading', progress: Math.round(info.percent), message: 'Downloading the next release in the background…' }));
    updater.on('update-downloaded', info => publish({ status: 'ready', version: info.version, progress: 100, message: 'Update ready. Your scene will be saved before restarting.' }));
    updater.on('error', error => {
      if (/401|403|404/.test(String(error.statusCode || '') + String(error.code || '') + String(error.message || ''))) authRequired();
      else publish({ status: 'error', message: 'The update could not finish. Check your connection and try again. Your installed version is still available.' });
    });
  }
  async function check() {
    if (closing || active || ['ready', 'installing'].includes(state.status)) return state;
    if (!app.isPackaged) return publish({ status: 'disabled', message: 'Automatic updates are available in the installed Windows app.' });
    active = true;
    try {
      const secret = await token();
      if (!secret) return authRequired();
      configure(secret);
      const result = await updater.checkForUpdates();
      // checkForUpdates returns before its automatic download finishes.
      if (result?.downloadPromise) await result.downloadPromise;
    } catch { if (!['auth-required', 'error'].includes(state.status)) publish({ status: 'error', message: 'The update check could not finish. Check your connection and try again.' }); }
    finally { active = false; }
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
    publish({ status: 'installing', message: 'Saving complete. Restarting to install the update…' });
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
  async function stop() { closing = true; clearTimeout(startup); clearInterval(timer); login?.kill(); await loginDone; }
  return { getState: () => state, check, connect, apply, start, stop };
}
module.exports = { createUpdates };
