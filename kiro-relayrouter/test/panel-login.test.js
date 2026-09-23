'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  const requests = [];
  const effects = [];
  let online = true;
  let valid = false;
  let rateLimited = false;
  let expiresAt = null;
  let availablePoints = 12.34567891;
  let models = ['Allowed'];
  const backendUrl = 'http://127.0.0.1:8080';
  let onMessage;
  let receive;
  const elements = new Map();
  const elementListeners = new Map();
  const webviewRequests = [];
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(id === 'connectionMask' ? ['connection-mask'] : []);
      elements.set(id, { value: '', textContent: '', disabled: false,
        title: '', setAttribute: (name, value) => { elements.get(id)[name] = value; },
        addEventListener: (name, callback) => elementListeners.set(`${id}:${name}`, callback),
        classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
          contains: (name) => classes.has(name) } });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    require: (name) => name === 'vscode' ? {
      ConfigurationTarget: { Global: 1 }, window: {
        showInputBox: async () => undefined,
        showInformationMessage: async (message) => effects.push(['info', message]),
      },
      workspace: { getConfiguration: () => ({
        get: (_key, fallback) => fallback,
        update: async () => { effects.push('setting'); },
      }) },
    } : require(name),
    module: { exports: {} }, Buffer, AbortController, setTimeout, clearTimeout,
    effect: (value) => effects.push(value),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (!online) throw new Error('ECONNREFUSED');
      if (url.includes('/health?lang=')) return { ok: true, json: async () => ({ ok: true }) };
      if (rateLimited) return { ok: false, status: 429 };
      if (!valid) return { ok: false, status: 401 };
      return { ok: true, json: async () => ({ authenticated: true, enabled: true, models,
        defaultModel: models[0] || '',
        tokenStatus: { expiresAt, expired: expiresAt !== null && Date.parse(expiresAt) <= Date.now(), serverTime: new Date().toISOString() },
        walletStatus: { availablePoints, frozenPoints: 0, updatedAt: new Date().toISOString() } }) };
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
  vm.runInContext(source + `
    output = { appendLine: () => {} };
    extensionContext = { subscriptions: [], secrets: {
      get: async () => accessToken,
      store: async () => effect('secret'),
    },
      globalState: { update: async () => effect('state') } };
    stopProxy = async () => { effect('stop'); backendReady = false; };
    startProxy = async () => { effect('start'); backendReady = true; };
    scheduleWindowReload = () => effect('reload');
    module.exports = { bind: (webview) => { controlView = { webview }; bindControlWebview(webview); },
      // Simulate a Token which this installation had previously accepted.
      setToken: (value, verified = true) => { accessToken = value; verifiedTokenFingerprint = verified ? tokenFingerprint(value) : ''; }, panelState, refreshModelPermissions,
      initializeIdentity: initializeClientMachineIdentity };
  `, context);
  const api = context.module.exports;
  const identityDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'relayrouter-identity-'));
  try {
    let firstStored = '';
    let secondStored = '';
    await Promise.all([
      api.initializeIdentity({ globalStorageUri: { fsPath: identityDirectory }, secrets: {
        get: async () => '', store: async (_key, value) => { firstStored = value; },
      } }),
      api.initializeIdentity({ globalStorageUri: { fsPath: identityDirectory }, secrets: {
        get: async () => '', store: async (_key, value) => { secondStored = value; },
      } }),
    ]);
    const canonicalIdentity = fs.readFileSync(path.join(identityDirectory, 'device-instance-id'), 'utf8');
    assert.match(canonicalIdentity, /^[a-f0-9]{64}$/);
    assert.equal(firstStored, canonicalIdentity, 'first window must adopt the shared installation identity');
    assert.equal(secondStored, canonicalIdentity, 'second window must adopt the shared installation identity');
  } finally {
    fs.rmSync(identityDirectory, { recursive: true, force: true });
  }
  const webview = { cspSource: 'test', postMessage: async (data) => receive?.({ data }),
    onDidReceiveMessage: (callback) => { onMessage = callback; } };
  api.bind(webview);
  // Execute the real webview script against a minimal DOM, not just string assertions.
  const webviewTimers = [];
  vm.runInNewContext(webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], {
    document: { documentElement: { lang: '' }, getElementById: element },
    window: { addEventListener: (_name, callback) => { receive = callback; } },
    acquireVsCodeApi: () => ({ postMessage: (message) => webviewRequests.push(message) }),
    setInterval: () => {},
    setTimeout: (callback, delay) => webviewTimers.push({ callback, delay }),
    clearTimeout: (handle) => { if (webviewTimers[handle - 1]) webviewTimers[handle - 1].cleared = true; },
  });
  const pendingTimer = () => webviewTimers.filter((timer) => !timer.cleared && !timer.fired).pop();
  const fireTimer = (timer) => { timer.fired = true; timer.callback(); };
  const maskHidden = () => element('connectionMask').classList.contains('hidden');
  assert.equal(maskHidden(), false, 'initial connection check is masked');
  assert.equal(pendingTimer().delay, 8000, 'an unanswered handshake must have its own deadline');

  await onMessage({ type: 'ready' });
  assert.equal(maskHidden(), true, 'healthy backend without Token must show login form');
  assert.equal(requests.length, 1, 'missing Token must not call authenticated configuration endpoint');
  assert.equal(requests[0].options.headers.authorization, undefined, 'health check is anonymous');
  assert.equal(element('accessToken').disabled, false);
  assert.equal(element('statusText').textContent, 'Sign in to continue');
  assert.equal(element('modelCount').textContent, '—');
  assert.equal(element('tokenBalance').textContent, 'Signed out');
  assert.equal(element('save').textContent, 'Save and sign in');
  assert(!webview.html.includes('查看日志'));

  await onMessage({ type: 'save', value: { accessToken: 'invalid', enabled: true } });
  assert.equal(maskHidden(), true, 'invalid login must not restore connection mask');
  assert.match(element('notice').textContent, /Token/);
  assert(!effects.includes('secret') && !effects.includes('setting') && !effects.includes('start') && !effects.includes('reload'),
    'invalid login does not persist credentials, start or reload');

  api.setToken('unverified-residue', false);
  await onMessage({ type: 'ready' });
  assert.equal(maskHidden(), true, 'an unverified residual SecretStorage value is not a Token failure');
  assert.equal(element('loginDetail').textContent, 'Enter a valid Token to continue.');

  api.setToken('disabled');
  await onMessage({ type: 'ready' });
  assert.equal(maskHidden(), true, 'saved disabled Token is a login error, not an outage');
  assert.equal(element('loginStatus').textContent, 'Signed out');
  assert.match(element('loginDetail').textContent, /Token.*invalid|disabled/);
  assert.equal(api.panelState().modelCount, 0);

  online = false;
  await onMessage({ type: 'retry' });
  assert.equal(maskHidden(), false, 'actual server outage must show mask');
  assert.equal(element('connectionTitle').textContent, 'Connecting to server');
  assert.equal(element('connectionError').textContent, 'The service is unreachable. Retrying automatically…');
  // The mask must heal itself: the panel owns a bounded backoff of its own so a
  // lost or unanswered handshake cannot strand this view on "connecting".
  const acknowledgedOutage = pendingTimer();
  assert.equal(acknowledgedOutage.delay, 30000, 'an acknowledged outage is rechecked on the slow interval');
  webviewRequests.length = 0;
  fireTimer(acknowledgedOutage);
  assert.deepEqual(webviewRequests.map((message) => [message.type, message.automatic]), [['retry', true]],
    'the masked panel retries without waiting for a click');
  assert.equal(pendingTimer().delay, 6000, 'a host that stops answering is chased on the backoff ladder');
  online = true;
  await onMessage({ type: 'retry', automatic: true });
  assert.equal(maskHidden(), true, 'server recovery unmasks even if Token is still invalid');
  assert.equal(pendingTimer(), undefined, 'a healthy connection stops the backoff');

  assert(!webview.html.includes('<h2>kiroProxy 后端</h2>'));
  assert(!webview.html.includes('监听地址'));
  assert(webview.html.includes('Let more powerful models empower Kiro-compatible development workflows.'));
  assert(!webview.html.includes('configureBackend'));
  effects.length = 0;

  valid = true;
  await onMessage({ type: 'save', value: { accessToken: 'valid', enabled: true } });
  assert.equal(maskHidden(), true);
  assert.equal(element('loginStatus').textContent, 'Signed in');
  assert.equal(element('modelCount').textContent, '1 available model');
  assert(effects.includes('start'));
  assert(effects.includes('reload'));
  assert.equal(element('tokenExpiry').textContent, 'Never expires');
  assert.equal(element('tokenBalance').textContent, '12.34567891');
  // A network wobble is not a credential problem: the verified session must
  // survive it so the user is not asked to sign in again on every hiccup.
  online = false;
  await onMessage({ type: 'retry', automatic: true });
  assert.equal(maskHidden(), false, 'an outage during an active session masks the panel');
  assert.equal(api.panelState().authenticated, true, 'an unreachable service must not log the user out');
  assert.equal(element('loginStatus').textContent, 'Signed in');
  online = true;
  await onMessage({ type: 'retry', automatic: true });
  assert.equal(maskHidden(), true, 'the panel unmasks itself once the service answers again');
  assert.equal(api.panelState().authenticated, true);
  webviewRequests.length = 0;
  elementListeners.get('refreshAccount:click')();
  elementListeners.get('refreshAccount:click')();
  assert.equal(webviewRequests.filter((message) => message.type === 'refreshAccount').length, 1,
    'refresh button must enforce its five-second frontend cooldown');
  assert.equal(element('refreshAccount').classList.contains('refreshing'), true);
  const refreshRequestCount = requests.length;
  await onMessage({ type: 'refreshAccount' });
  await onMessage({ type: 'refreshAccount' });
  assert.equal(requests.length, refreshRequestCount + 1,
    'extension host must enforce the five-second per-Token cooldown');
  assert.equal(element('save').textContent, 'Save and apply');
  elementListeners.get('language:click')();
  assert.equal(element('heroSubtitle').textContent, '连接更强大的模型，拓展 Kiro 开发体验。');
  assert.equal(element('save').textContent, '保存并应用');
  assert.equal(element('toggleService').textContent, '启动服务');
  assert.equal(element('reloadPage').textContent, '手动刷新页面');
  await onMessage({ type: 'language', language: 'zh' });
  webviewRequests.length = 0;
  effects.length = 0;
  elementListeners.get('toggleService:click')();
  await onMessage(webviewRequests.find((message) => message.type === 'toggleService'));
  assert(effects.includes('start'));
  assert(effects.includes('reload'));
  webviewRequests.length = 0;
  effects.length = 0;
  elementListeners.get('reloadPage:click')();
  await onMessage(webviewRequests.find((message) => message.type === 'reloadPage'));
  assert(effects.includes('reload'));
  effects.length = 0;
  models = ['Replacement'];
  assert.equal(await api.refreshModelPermissions(), true);
  assert(requests.at(-1).url.endsWith('/api/relay/config?lang=zh'));
  assert.equal(api.panelState().modelCount, 1);
  assert(effects.some(([kind, message]) => kind === 'info' && /手动刷新页面/.test(message)));
  assert(!effects.includes('reload'), 'dynamic model refresh must not reload the extension or window');
  availablePoints = -0.167225;
  await onMessage({ type: 'ready' });
  assert.equal(element('tokenBalance').textContent, '0', 'negative database balance is clamped only in the UI');
  assert.match(element('balanceHint').textContent, /额度已用尽/);
  assert.equal(element('balanceHint').textContent, '额度已用尽，请充值或更换 Token');
  assert.equal(element('balanceRow').classList.contains('danger'), true);
  availablePoints = 0.5;
  await onMessage({ type: 'ready' });
  assert.equal(element('balanceHint').textContent, '', 'exactly 0.5 points is not below the warning threshold');
  availablePoints = 12.34567891;
  expiresAt = new Date(Date.now() + 2 * 86400000).toISOString();
  await onMessage({ type: 'ready' });
  assert.equal(element('tokenExpiry').textContent, '2 天');
  expiresAt = new Date(Date.now() + 3600000).toISOString();
  await onMessage({ type: 'ready' });
  assert.match(element('tokenExpiry').textContent, /1 天（不足 24 小时）/);
  expiresAt = new Date(Date.now() - 1000).toISOString();
  effects.length = 0;
  await onMessage({ type: 'save', value: { accessToken: 'expired-but-enabled', enabled: true } });
  assert.equal(maskHidden(), true);
  assert.equal(element('loginStatus').textContent, '已登录');
  assert.equal(element('modelCount').textContent, '1 个可用模型');
  assert.equal(element('tokenExpiry').textContent, '已过期');
  assert(effects.includes('start'));
  assert(effects.includes('reload'));
  assert.equal(element('accessToken').placeholder, 'expired-but-… (留空保留已保存的 Token)');
  assert.equal(element('accessToken').value, '', 'display prefix must not be submitted as a replacement token');
  assert(!JSON.stringify(api.panelState()).includes('expired-but-enabled'), 'panel state must not include full saved token');
  api.setToken('rate-limit-test');
  rateLimited = true;
  await onMessage({ type: 'refreshAccount' });
  assert.equal(api.panelState().authenticated, true, 'a backend 429 must not log out the current session');
  console.log('redesigned panel states, balance clamp, login separation and expiry status passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
