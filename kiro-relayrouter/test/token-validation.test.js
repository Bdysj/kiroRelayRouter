'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function main() {
  const effects = [];
  let reply;
  let lastRequest;
  let requestCount = 0;
  const globalStates = new Map();
  let onMessage;
  const context = vm.createContext({
    require: (name) => name === 'vscode' ? {
      ConfigurationTarget: { Global: 1 },
      workspace: { getConfiguration: () => ({
        get: (_key, fallback) => fallback,
        update: async (...args) => effects.push(['setting', ...args]),
      }) },
    } : require(name),
    module: { exports: {} }, Buffer, performance, AbortController, AbortSignal, setTimeout, clearTimeout,
    globalStates,
    fetch: async (url, options) => { requestCount += 1; lastRequest = { url, options }; return reply; },
    effect: (...args) => effects.push(args),
  });
  // The assertions below pin the request URLs, so pin the build-time constant
  // instead of depending on whichever service the package ships with.
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8')
    .replace(/^const BACKEND_ENDPOINT = '[^']*';$/m, "const BACKEND_ENDPOINT = 'http://127.0.0.1:8080';");
  vm.runInContext(source + `
    accessToken = 'previous-valid-token';
    backendConfiguration = { models: ['Previously allowed'] };
    extensionContext = { subscriptions: [], secrets: { store: async (...args) => effect('secret', ...args) },
      globalState: { get: (key, fallback) => globalStates.has(key) ? globalStates.get(key) : fallback,
        update: async (key, value) => { if (value === undefined) globalStates.delete(key); else globalStates.set(key, value); effect('state', key, value); } } };
    output = { appendLine: () => {} };
    status = {};
    const actualStopProxy = stopProxy;
    stopProxy = async () => effect('stop');
    startProxy = async () => { effect('start'); backendReady = true; };
    scheduleWindowReload = () => effect('reload');
    module.exports = { savePanelConfiguration, bindControlWebview, createProxyServer, proxyHealth, useSharedProxy,
      requestProxyShutdown, setServer: (value) => { server = value; },
      restoreStopProxy: () => { stopProxy = actualStopProxy; },
      state: () => ({ accessToken, backendConfiguration }) };
  `, context);
  const api = context.module.exports;
  const webview = { cspSource: 'test', postMessage: async () => {}, onDidReceiveMessage: (fn) => { onMessage = fn; } };
  api.bindControlWebview(webview);

  reply = { ok: false, status: 401 };
  await onMessage({ type: 'save', value: { accessToken: 'random', enabled: true } });
  assert.equal(lastRequest.url, 'http://127.0.0.1:8080/api/relay/session?lang=en');
  assert.equal(lastRequest.options.headers.authorization, 'Bearer random');
  assert.equal(lastRequest.options.headers['x-relay-machine-id'], 'unknown-kiro-machine');
  assert.deepEqual(effects.filter(([kind]) => ['secret', 'setting', 'stop', 'start', 'reload'].includes(kind)), [],
    'invalid token must not write credentials, settings, stop, start or reload');
  assert.equal(api.state().accessToken, 'previous-valid-token');

  reply = { ok: true, status: 200, json: async () => ({ models: ['Unauthorized old backend model'] }) };
  await assert.rejects(api.savePanelConfiguration({ accessToken: 'random' }), /验证结果/);
  assert.deepEqual(effects.filter(([kind]) => ['secret', 'setting', 'stop', 'start', 'reload'].includes(kind)), [],
    'an unauthenticated legacy HTTP 200 is not successful validation');

  reply = { ok: true, status: 200, json: async () => ({ authenticated: true, models: ['Allowed'], enabled: true }) };
  await onMessage({ type: 'save', value: { accessToken: 'verified-token', enabled: true } });
  assert.equal(api.state().accessToken, 'verified-token');
  assert(effects.some(([kind]) => kind === 'secret'));
  assert.deepEqual(effects.filter(([kind]) => ['stop', 'start', 'reload'].includes(kind)), [['stop'], ['start'], ['reload']]);
  effects.length = 0;
  await api.savePanelConfiguration({ accessToken: '', enabled: false });
  assert.equal(lastRequest.options.headers.authorization, 'Bearer verified-token', 'blank input retains and revalidates saved token');
  const peer = api.createProxyServer();
  await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal(await api.proxyHealth(peer.address().port, true), true, 'matching token and backend can share');
    const response = await new Promise((resolve, reject) => {
      require('node:http').get({ host: '127.0.0.1', port: peer.address().port,
        path: '/__kiro_relayrouter_health', headers: { 'x-relay-identity': 'different-token' } }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    assert.equal(response.compatible, false);
  } finally {
    await new Promise((resolve) => peer.close(resolve));
  }
  const stalePeer = api.createProxyServer();
  await new Promise((resolve) => stalePeer.listen(0, '127.0.0.1', resolve));
  api.setServer(stalePeer);
  api.restoreStopProxy();
  assert.equal(await api.requestProxyShutdown(stalePeer.address().port), true,
    'another Kiro window can retire the local proxy during logout or token replacement');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await api.proxyHealth(stalePeer.address()?.port || 1), false,
    'the stale proxy releases its port after the cross-window stop request');
  vm.runInContext('proxyHealth = async () => false', context);
  await assert.rejects(api.useSharedProxy(19801, false), /不同 Token/);
  assert.equal(api.state().backendConfiguration.models.length, 0, 'mismatched shared proxy clears model state');
  reply = { ok: false, status: 401 };
  const beforeInvalidBurst = requestCount;
  for (let index = 0; index < 10; index += 1) {
    await onMessage({ type: 'save', value: { accessToken: 'bad-' + index, enabled: true } });
  }
  assert.equal(requestCount, beforeInvalidBurst + 10);
  await onMessage({ type: 'save', value: { accessToken: 'blocked', enabled: true } });
  assert.equal(requestCount, beforeInvalidBurst + 10, 'the eleventh attempt is blocked locally for one hour');
  console.log('database validation gates save/start/reload; legacy bypass rejected; saved token revalidated');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
