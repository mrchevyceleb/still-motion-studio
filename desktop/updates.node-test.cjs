const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates } = require('./updates.cjs');

function fixture(available = false, missing = false) {
  let instance;
  class Updater extends EventEmitter {
    constructor(options) { super(); this.options = options; instance = this; }
    async checkForUpdates() {
      this.emit('checking-for-update');
      if (missing) {
        const error = Object.assign(new Error('missing feed'), { statusCode: 404 });
        this.emit('error', error);
        throw error;
      }
      this.info = { version: '0.2.23', runtimeId: 'same-runtime', files: [{ url: 'Still-Motion-Studio-Setup-0.2.23.exe' }, { url: 'Still-Motion-Studio-Update-0.2.23.exe' }] };
      this.emit(available ? 'update-available' : 'update-not-available', this.info);
      return { isUpdateAvailable: available, updateInfo: this.info };
    }
    async downloadUpdate() { this.downloaded = true; this.emit('update-downloaded', this.info); }
  }
  const updates = createUpdates({ app: { getVersion: () => '0.2.22', isPackaged: true }, runtimeId: 'same-runtime', Updater, send() {}, install: async () => { throw new Error('Export is still running.'); } });
  return { updates, instance: () => instance };
}

test('checks a public feed without requesting credentials or auto-installing', async () => {
  const { updates, instance } = fixture();
  assert.equal((await updates.check()).status, 'current');
  assert.equal(instance().options.private, false);
  assert.equal(instance().options.token, undefined);
  assert.equal(instance().autoInstallOnAppQuit, false);
  assert.equal(instance().downloaded, undefined);
  await updates.stop();
});

test('downloads the matching runtime update and preserves a blocked restart', async () => {
  const { updates, instance } = fixture(true);
  assert.equal((await updates.check()).status, 'ready');
  assert.match(instance().info.files[0].url, /-Update-/);
  const result = await updates.apply();
  assert.equal(result.status, 'ready');
  assert.equal(result.message, 'Export is still running.');
  await updates.stop();
});

test('an unavailable public feed gives a retryable error without a login flow', async () => {
  const { updates } = fixture(false, true);
  const result = await updates.check();
  assert.equal(result.status, 'error');
  assert.match(result.message, /public release feed/);
  assert.equal(updates.connect, undefined);
  await updates.stop();
});
