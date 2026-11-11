const REPOSITORY = { provider: 'github', owner: 'mrchevyceleb', repo: 'still-motion-studio', private: false };
// Electron's net requests never emit 'socket', so electron-updater's 60 s socket
// timeout is never armed: a dropped connection mid-download waits forever. Watch
// for silence ourselves, cancel, and retry.
const STALL_MS = 120 * 1000, STALL_RETRIES = 3;
class Stalled extends Error {}

// Public release checks never read a GitHub login or inherit publisher tokens.
function createUpdates({ app, runtimeId, send, install, Updater }) {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete process.env[name];
  let updater, active = false, timer, startup, retry, closing = false, lastActivity = 0;
  let state = { status: 'idle', currentVersion: app.getVersion(), message: 'Updates download automatically. No account is needed.' };
  const publish = patch => { state = { ...state, ...patch }; send(state); return state; };
  // Releases list the full installer first, so builds that predate this check always
  // get the runtime. When the release ships the runtime this install already has,
  // download the small app-only installer instead.
  let appOnly = false;
  function preferAppOnly(info) {
    const index = info?.files?.findIndex(file => /^Still-Motion-Studio-Update-[^/]+\.exe$/.test(file.url)) ?? -1;
    appOnly = info?.runtimeId === runtimeId && index >= 0;
    if (appOnly && index > 0) info.files.unshift(...info.files.splice(index, 1));
  }
  function configure() {
    const self = updater = new Updater({ ...REPOSITORY });
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
    // Keep the proven full-download path for both full and app-only installers.
    updater.disableDifferentialDownload = true;
    on('checking-for-update', () => publish({ status: 'checking', progress: undefined, message: 'Checking GitHub…' }));
    on('update-not-available', () => publish({ status: 'current', version: undefined, progress: undefined, message: 'You have the latest release.' }));
    on('update-available', info => publish({ status: 'downloading', version: info.version, progress: 0, message: 'Downloading the next release in the background…' }));
    on('download-progress', info => publish({ status: 'downloading', progress: Math.round(info.percent), message: 'Downloading the next release in the background…' }));
    on('update-downloaded', info => publish({ status: 'ready', version: info.version, progress: 100, message: 'Update ready. Your scene will be saved before restarting.' }));
    on('error', error => {
      if (/404/.test(String(error.statusCode || '') + String(error.code || '') + String(error.message || ''))) publish({ status: 'error', progress: undefined, message: 'The public release feed is not available yet. Try again later or visit the release page.' });
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
    let watchdog, cancellation, work;
    try {
      configure();
      const current = updater;
      lastActivity = Date.now();
      work = (async () => {
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
        // A stalled check never reaches the cache. A stalled download retries only once it has
        // settled, so two downloads never share the pending cache.
        const settled = !cancellation || await Promise.race([work.then(() => true, () => true), new Promise(resolve => setTimeout(resolve, 15000, false))]);
        if (settled && stalls < STALL_RETRIES && !closing) {
          publish({ status: 'error', progress: undefined, message: 'The download stopped responding. Retrying automatically…' });
          retry = setTimeout(() => void attempt(stalls + 1), 5000);
          retry.unref();
        } else publish({ status: 'error', progress: undefined, message: 'The download keeps stalling. Check your connection, then choose Check for updates.' });
      } else if (state.status !== 'error') publish({ status: 'error', progress: undefined, message: 'The update check could not finish. Check your connection and try again.' });
    }
    finally { clearInterval(watchdog); active = false; }
    return state;
  }
  async function apply() {
    if (closing || active || state.status !== 'ready' || !updater) return state;
    active = true;
    publish({ status: 'installing', message: appOnly ? 'Saving complete. Still will close, install the update and reopen by itself in under a minute.' : 'Saving complete. Still will close, install the update and its runtime (a few minutes, this time only), then reopen by itself.' });
    try { await install(updater); }
    catch (error) { publish({ status: 'ready', message: error.message || 'The app could not restart. Your scene is saved; try again.' }); }
    finally { active = false; }
    return state;
  }
  function start() {
    startup = setTimeout(() => void check(), 10000);
    timer = setInterval(() => void check(), 6 * 60 * 60 * 1000);
    startup.unref(); timer.unref();
  }
  async function stop() { closing = true; clearTimeout(startup); clearTimeout(retry); clearInterval(timer); }
  return { getState: () => state, check, apply, start, stop };
}
module.exports = { createUpdates };
