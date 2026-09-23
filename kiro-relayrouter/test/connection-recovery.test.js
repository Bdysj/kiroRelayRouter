'use strict';

// A network wobble used to be terminal: the health check cleared the
// authentication flag, the 15s model watcher gated itself on that flag, and the
// only retry timer required a locally owned proxy.  A window reusing another
// window's proxy therefore sat behind the connection mask until it was
// reloaded.  These tests drive the recovery path with a controllable clock.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  const timers = [];
  const intervals = [];
  const requests = [];
  const posted = [];
  let online = true;

  const context = vm.createContext({
    require: (name) => name === 'vscode' ? {
      ConfigurationTarget: { Global: 1 },
      ThemeColor: class { constructor(id) { this.id = id; } },
      window: { showInformationMessage: async () => {}, showWarningMessage: async () => {} },
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => {} }) },
    } : require(name),
    module: { exports: {} }, Buffer, AbortController,
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    clearTimeout: (handle) => { if (timers[handle - 1]) timers[handle - 1].cleared = true; },
    setInterval: (callback, delay) => { intervals.push({ callback, delay }); return { unref() {} }; },
    clearInterval: () => {},
    fetch: async (url) => {
      requests.push(url);
      if (!online) throw new Error('ECONNREFUSED');
      if (url.includes('/api/relay/health')) return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ authenticated: true, enabled: true,
        models: ['Allowed'], defaultModel: 'Allowed',
        tokenStatus: { expiresAt: null, expired: false, serverTime: new Date().toISOString() } }) };
    },
  });

  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8') + `
    output = { appendLine: () => {} };
    status = { text: '', tooltip: '', backgroundColor: undefined };
    extensionContext = { subscriptions: [], secrets: { get: async () => accessToken, store: async () => {} },
      globalState: { get: (_key, fallback) => fallback, update: async () => {} } };
    setEndpointOverrides = async () => { endpointOverridesApplied += 1; };
    var endpointOverridesApplied = 0;
    module.exports = {
      controlView: (webview) => { controlView = { webview }; },
      // A healthy session that reuses the proxy owned by another Kiro window.
      signIn: (token) => {
        accessToken = token;
        verifiedTokenFingerprint = tokenFingerprint(token);
        backendAuthenticated = true;
        backendOnline = true;
        backendReady = true;
        usingSharedProxy = true;
      },
      state: () => ({ online: backendOnline, ready: backendReady,
        authenticated: backendAuthenticated, endpointOverridesApplied }),
      panelState, refreshModelPermissions, startModelPermissionWatcher,
    };
  `, context);

  const api = context.module.exports;
  api.controlView({ postMessage: async (message) => posted.push(message) });
  api.signIn('kr_valid');

  const pending = () => timers.filter((timer) => !timer.cleared && !timer.fired);
  const watchdog = () => pending().at(-1);
  // The scheduled callback deliberately does not await its own async work, so
  // the clock helper has to drain the microtask queue for it.
  const fire = async () => {
    const timer = watchdog();
    assert(timer, 'a masked panel must always have a pending reconnect attempt');
    timer.fired = true;
    timer.callback();
    for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const lastConnection = () => posted.filter((message) => message.type === 'connection').at(-1);

  api.startModelPermissionWatcher();
  const modelWatcher = intervals.find((interval) => interval.delay === 15_000);
  assert(modelWatcher, 'the model permission watcher must keep its 15s interval');

  // The outage is discovered by the ordinary 15s refresh.
  online = false;
  await api.refreshModelPermissions();
  assert.equal(api.state().online, false, 'an unreachable service marks the connection offline');
  assert.equal(api.state().ready, false, 'an offline service is not ready to serve Kiro');
  assert.equal(api.state().authenticated, true, 'a network outage must not discard the verified session');
  assert.equal(api.panelState().tokenConfigured, true);
  assert.equal(lastConnection().connected, false, 'the panel is told about the outage');
  assert.equal(lastConnection().error, 'ECONNREFUSED', 'the outage reason reaches the panel');

  // The watcher must not keep hammering an unreachable service, and it must not
  // be the component responsible for recovery either.
  const quietRequests = requests.length;
  await api.refreshModelPermissions();
  assert.equal(requests.length, quietRequests, 'an offline service is not polled by the model watcher');

  // Recovery is owned by one watchdog with a bounded, widening backoff.
  assert.equal(watchdog().delay, 3000, 'the first reconnect attempt is quick');
  for (const expected of [6000, 12_000, 30_000, 30_000]) {
    await fire();
    assert.equal(watchdog().delay, expected, `backoff step ${expected} must be scheduled`);
    assert.equal(api.state().online, false);
  }
  assert.equal(api.state().authenticated, true, 'a long outage still keeps the session');

  online = true;
  await fire();
  assert.equal(api.state().online, true, 'the watchdog restores the connection on its own');
  assert.equal(api.state().ready, true, 'a reconnect finishes the pending proxy startup');
  assert.equal(api.state().endpointOverridesApplied, 1, 'Kiro endpoints are re-applied once');
  assert.equal(api.panelState().running, true);
  assert.equal(lastConnection().connected, true,
    'the panel mask is lifted without any user interaction');
  assert.equal(pending().length, 0, 'a healthy connection stops the watchdog');

  // The old self-lock: after an outage the watcher stayed disabled forever.
  const recoveredRequests = requests.length;
  await api.refreshModelPermissions();
  assert(requests.length > recoveredRequests, 'the model watcher resumes after a reconnect');
  await modelWatcher.callback();

  console.log('connection watchdog, backoff and outage-safe session tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
