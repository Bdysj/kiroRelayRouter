'use strict';

const http2 = require('http2');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const vscode = require('vscode');
const KIRO_CONFIG = 'codewhisperer.config';
const ENDPOINT_KEYS = ['krsEndpoints', 'cpsEndpoints'];
const LOCAL_PORT = 19801;
// 后端地址是构建期常量：打包时由 build.js 用 RELAYROUTER_BACKEND_ENDPOINT 替换，
//   私有部署：RELAYROUTER_BACKEND_ENDPOINT=https://your-domain.example npm run package
// The backend address is a build-time constant. build.js substitutes it from
// RELAYROUTER_BACKEND_ENDPOINT at packaging time and falls back to localhost,
// so no real service address is ever committed to this repository.
const BACKEND_ENDPOINT = 'http://127.0.0.1:8080';

const ACCESS_TOKEN_SECRET = 'kiroRelayRouter.accessToken';
const ACCOUNT_REFRESH_COOLDOWN_MS = 5_000;
const MODEL_PERMISSION_POLL_MS = 15_000;
// Reconnect probing uses the public health route only, with a bounded
// exponential backoff so a long outage cannot become a request flood.
const CONNECTION_RETRY_STEPS_MS = [3_000, 6_000, 12_000, 30_000];
const INVALID_TOKEN_LIMIT = 10;
const INVALID_TOKEN_COOLDOWN_MS = 60 * 60 * 1000;
const INVALID_TOKEN_STATE_KEY = 'invalidTokenLoginState';
// A SecretStorage value can survive an interrupted install/upgrade.  Keep a
// fingerprint only after the backend has accepted that exact Token, so an
// unconfigured client never presents a stale-token error as a login state.
const VERIFIED_TOKEN_FINGERPRINT_STATE_KEY = 'verifiedTokenFingerprint';
const LANGUAGE_STATE_KEY = 'interfaceLanguage';
const LANGUAGE_STATE_FILE = 'interface-language';
const DEVICE_INSTANCE_SECRET = 'kiroRelayRouter.deviceInstanceSecret';
const DEVICE_INSTANCE_FILE = 'device-instance-id';

let server;
let output;
let status;
let extensionContext;
let controlPanel;
let controlPanelBinding;
let controlView;
let controlViewBinding;
let usingSharedProxy = false;
let takeoverTimer;
let takeoverInProgress = false;
let reloadTimer;
let connectionWatchdogTimer;
let connectionRetryStep = 0;
let connectionProbe;
let balanceRefreshTimer;
let modelPermissionTimer;
let modelPermissionRefresh;
let backendOnline = true;
let backendReady = false;
let backendAuthenticated = false;
let loginMessage = '请输入访问 Token 登录。';
let accessToken = '';
let verifiedTokenFingerprint = '';
let configurationSaving = false;
let interfaceLanguage = 'en';
let sharedStorageDirectory = '';
let deviceInstanceSecret = '';
let machineIdentityNeedsMigration = false;
let backendConfiguration = { enabled: false, models: [], defaultModel: '' };
let tokenStatusCheckedAt = 0;
const accountRefreshTimes = new Map();

function modelSignature(value = backendConfiguration) {
  return JSON.stringify({
    models: Array.isArray(value?.models) ? value.models : [],
    defaultModel: value?.defaultModel || '',
  });
}

function log(message, detail) {
  const suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  output.appendLine(`[${new Date().toISOString()}] ${message}${suffix}`);
}

function localEndpoint() {
  return `http://127.0.0.1:${LOCAL_PORT}`;
}

function backendEndpoint() {
  return BACKEND_ENDPOINT;
}

function backendApi(pathname) {
  const separator = pathname.includes('?') ? '&' : '?';
  return `${backendEndpoint()}${pathname}${separator}lang=${encodeURIComponent(interfaceLanguage)}`;
}

function normalizeInterfaceLanguage(language) {
  return language === 'zh' ? 'zh' : 'en';
}

function sharedLanguageFile() {
  return sharedStorageDirectory ? path.join(sharedStorageDirectory, LANGUAGE_STATE_FILE) : '';
}

async function persistSharedInterfaceLanguage(language) {
  const filename = sharedLanguageFile();
  if (!filename) return;
  await fs.mkdir(sharedStorageDirectory, { recursive: true });
  await fs.writeFile(filename, language, { encoding: 'utf8', mode: 0o600 });
}

async function initializeInterfaceLanguage(context) {
  sharedStorageDirectory = context.globalStorageUri?.fsPath || '';
  interfaceLanguage = normalizeInterfaceLanguage(context.globalState.get(LANGUAGE_STATE_KEY, 'en'));
  const filename = sharedLanguageFile();
  if (!filename) return;
  await fs.mkdir(sharedStorageDirectory, { recursive: true });
  try {
    const shared = String(await fs.readFile(filename, 'utf8')).trim();
    if (shared === 'en' || shared === 'zh') interfaceLanguage = shared;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await persistSharedInterfaceLanguage(interfaceLanguage);
  }
  await context.globalState.update(LANGUAGE_STATE_KEY, interfaceLanguage);
}

async function syncInterfaceLanguageFromSharedStorage() {
  const filename = sharedLanguageFile();
  if (!filename) return;
  try {
    const shared = String(await fs.readFile(filename, 'utf8')).trim();
    if (shared === 'en' || shared === 'zh') interfaceLanguage = shared;
  } catch (error) {
    if (error?.code !== 'ENOENT') log('读取跨窗口语言设置失败', error.message);
  }
}

async function setInterfaceLanguage(language) {
  interfaceLanguage = normalizeInterfaceLanguage(language);
  await extensionContext?.globalState?.update?.(LANGUAGE_STATE_KEY, interfaceLanguage);
  await persistSharedInterfaceLanguage(interfaceLanguage);
}

function interfaceText(chinese, english) {
  return interfaceLanguage === 'zh' ? chinese : english;
}

function backendHeaders(headers = {}) {
  const machineId = clientMachineId();
  const identityHeaders = { 'x-relay-machine-id': machineId };
  if (deviceInstanceSecret) identityHeaders['x-relay-legacy-machine-id'] = legacyMachineId();
  return accessToken
    ? { ...headers, ...identityHeaders, authorization: `Bearer ${accessToken}` }
    : { ...headers, ...identityHeaders };
}

function clientMachineId() {
  if (deviceInstanceSecret) {
    return 'v2-' + crypto.createHash('sha256')
      .update(`${legacyMachineId()}:${deviceInstanceSecret}`).digest('hex');
  }
  return legacyMachineId();
}

function legacyMachineId() {
  return String(vscode.env?.machineId || 'unknown-kiro-machine').trim();
}

async function initializeClientMachineIdentity(context) {
  const storedSecret = String(await context.secrets.get(DEVICE_INSTANCE_SECRET) || '').trim();
  const candidate = /^[a-f0-9]{64}$/i.test(storedSecret)
    ? storedSecret : crypto.randomBytes(32).toString('hex');
  const storageDirectory = context.globalStorageUri?.fsPath;

  if (storageDirectory) {
    await fs.mkdir(storageDirectory, { recursive: true });
    const identityFile = path.join(storageDirectory, DEVICE_INSTANCE_FILE);
    try {
      // Extension hosts run once per Kiro window. An exclusive create makes
      // the first window's identity canonical when windows start together.
      await fs.writeFile(identityFile, candidate, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    deviceInstanceSecret = String(await fs.readFile(identityFile, 'utf8')).trim();
  } else {
    // Compatibility fallback for older hosts and lightweight test contexts.
    deviceInstanceSecret = candidate;
  }

  if (!/^[a-f0-9]{64}$/i.test(deviceInstanceSecret)) {
    throw new Error('本机 RelayRouter 设备身份文件无效，请重新安装扩展。');
  }
  if (storedSecret !== deviceInstanceSecret) {
    await context.secrets.store(DEVICE_INSTANCE_SECRET, deviceInstanceSecret);
  }
  machineIdentityNeedsMigration = !storedSecret || storedSecret !== deviceInstanceSecret;
}

function loginCooldownRemaining() {
  const state = extensionContext?.globalState?.get?.(INVALID_TOKEN_STATE_KEY, {}) || {};
  return Math.max(0, Number(state.cooldownUntil || 0) - Date.now());
}

async function recordInvalidToken() {
  const state = extensionContext?.globalState?.get?.(INVALID_TOKEN_STATE_KEY, {}) || {};
  const attempts = Number(state.attempts || 0) + 1;
  await extensionContext?.globalState?.update?.(INVALID_TOKEN_STATE_KEY, attempts >= INVALID_TOKEN_LIMIT
    ? { attempts, cooldownUntil: Date.now() + INVALID_TOKEN_COOLDOWN_MS }
    : { attempts, cooldownUntil: 0 });
  return attempts;
}

async function clearInvalidTokenAttempts() {
  await extensionContext?.globalState?.update?.(INVALID_TOKEN_STATE_KEY, undefined);
}

function proxyIdentity() {
  // Only a local compatibility fingerprint; access tokens stay in SecretStorage.
  return crypto.createHash('sha256').update(JSON.stringify([backendEndpoint(), accessToken])).digest('hex');
}

function tokenFingerprint(token = accessToken) {
  return token ? crypto.createHash('sha256').update(token).digest('hex') : '';
}

function tokenWasPreviouslyVerified(token = accessToken) {
  return Boolean(token) && verifiedTokenFingerprint === tokenFingerprint(token);
}

async function rememberVerifiedToken(token = accessToken) {
  const fingerprint = tokenFingerprint(token);
  if (!fingerprint || fingerprint === verifiedTokenFingerprint) return;
  verifiedTokenFingerprint = fingerprint;
  await extensionContext?.globalState?.update?.(VERIFIED_TOKEN_FINGERPRINT_STATE_KEY, fingerprint);
}

async function forgetVerifiedToken() {
  verifiedTokenFingerprint = '';
  await extensionContext?.globalState?.update?.(VERIFIED_TOKEN_FINGERPRINT_STATE_KEY, undefined);
}

function proxyControlIdentity() {
  // Stable across Kiro windows on the same machine, but independent of the
  // currently selected Token so a new login can retire a stale local proxy.
  return crypto.createHash('sha256').update(JSON.stringify([backendEndpoint(), clientMachineId(), 'local-control'])).digest('hex');
}

function proxyHealth(port, requireSameIdentity = false) {
  return new Promise((resolve) => {
    let settled = false;
    let client;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { client?.close(); } catch { /* already closed */ }
      resolve(healthy);
    };
    const timeout = setTimeout(() => finish(false), 800);
    try {
      client = http2.connect(`http://127.0.0.1:${port}`);
      client.once('error', () => finish(false));
      const request = client.request({ ':method': 'GET', ':path': '/__kiro_relayrouter_health',
        ...(requireSameIdentity ? { 'x-relay-identity': proxyIdentity() } : {}) });
      let body = '';
      let statusCode = 0;
      request.on('response', (headers) => { statusCode = Number(headers[':status'] || 0); });
      request.on('data', (chunk) => { body += chunk; });
      request.on('error', () => finish(false));
      request.on('end', () => {
        try {
          const health = JSON.parse(body);
          finish(statusCode === 200 && health.ok === true && (!requireSameIdentity || health.compatible === true));
        }
        catch { finish(false); }
      });
      request.end();
    } catch { finish(false); }
  });
}

function requestProxyShutdown(port) {
  return new Promise((resolve) => {
    let settled = false;
    let client;
    const finish = (stopped) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { client?.close(); } catch { /* already closed */ }
      resolve(stopped);
    };
    const timeout = setTimeout(() => finish(false), 1200);
    try {
      client = http2.connect(`http://127.0.0.1:${port}`);
      client.once('error', () => finish(false));
      const request = client.request({ ':method': 'POST', ':path': '/__kiro_relayrouter_stop',
        'x-relay-control': proxyControlIdentity() });
      let statusCode = 0;
      request.on('response', (headers) => { statusCode = Number(headers[':status'] || 0); });
      request.on('error', () => finish(false));
      request.on('end', () => finish(statusCode === 202));
      request.resume();
      request.end();
    } catch { finish(false); }
  });
}

async function waitForProxyShutdown(port) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!await proxyHealth(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function syncAccessTokenFromStorage() {
  const stored = await extensionContext.secrets.get(ACCESS_TOKEN_SECRET) || '';
  if (stored === accessToken) return false;
  accessToken = stored;
  invalidateBackendAuthentication(stored ? '其他 Kiro 窗口已更换 Token，正在重新验证。' : '当前设备已在另一窗口退出或解绑。');
  return true;
}

function legacyProxyHealth(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(healthy);
    };
    const timeout = setTimeout(() => finish(false), 800);
    const request = http.get({ host: '127.0.0.1', port, path: '/__kiro_relayrouter_health', timeout: 700 }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { finish(response.statusCode === 200 && JSON.parse(body).ok === true); }
        catch { finish(false); }
      });
    });
    request.on('error', () => finish(false));
    request.on('timeout', () => { request.destroy(); finish(false); });
  });
}

async function incompatibleProxyError(port) {
  if (await legacyProxyHealth(port)) {
    return new Error(`端口 ${port} 被旧版 HTTP/1 RelayRouter 代理占用。请完全退出所有 Kiro 窗口后重新打开，再启动代理。`);
  }
  return undefined;
}

function clearTakeoverTimer() {
  if (takeoverTimer) clearInterval(takeoverTimer);
  takeoverTimer = undefined;
}

function clearConnectionWatchdog() {
  if (connectionWatchdogTimer) clearTimeout(connectionWatchdogTimer);
  connectionWatchdogTimer = undefined;
}

// Single owner of "the service is unreachable" recovery. Startup, a mid-session
// outage and a window that only reuses another window's proxy all funnel into
// this timer, so the panel mask can never stay up with nothing retrying.
function scheduleConnectionWatchdog() {
  if (connectionWatchdogTimer) return;
  const delay = CONNECTION_RETRY_STEPS_MS[Math.min(connectionRetryStep, CONNECTION_RETRY_STEPS_MS.length - 1)];
  connectionRetryStep += 1;
  connectionWatchdogTimer = setTimeout(() => {
    connectionWatchdogTimer = undefined;
    void runConnectionWatchdog();
  }, delay);
  if (typeof connectionWatchdogTimer.unref === 'function') connectionWatchdogTimer.unref();
}

async function runConnectionWatchdog() {
  if (!extensionContext) return;
  // A failed probe reschedules itself through markBackendOffline.
  try { await probeBackendConnection(); }
  catch { return; }
  try { await recoverBackendSession(); }
  catch (error) {
    log('连接恢复后重新验证失败', error.message);
    // A Token problem is not an outage: stop probing and let the panel ask.
    if (!error.authentication) scheduleConnectionWatchdog();
  }
}

async function recoverBackendSession() {
  if (!accessToken) {
    sendPanelState();
    return;
  }
  // A local or shared proxy that is listening but not ready still needs its
  // endpoint overrides and status line finished off.
  if ((server || usingSharedProxy) && !backendReady) {
    await finishProxyStartup(false);
    return;
  }
  await refreshBackendConfiguration();
  sendPanelState();
}

function scheduleWindowReload(showPrompt = true) {
  if (reloadTimer) clearTimeout(reloadTimer);
  const timer = setTimeout(() => {
    if (reloadTimer !== timer) return;
    reloadTimer = undefined;
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }, 3000);
  reloadTimer = timer;

  // Kiro needs a window reload to make the Agent read its new endpoint/model
  // configuration.  Give the user a short, explicit chance to defer it rather
  // than unexpectedly closing the current workbench state.
  if (!showPrompt) return;
  void vscode.window.showInformationMessage(
    '代理状态已变更，Kiro 将在 3 秒后自动重载以应用配置。',
    '稍后手动重载',
  ).then((selection) => {
    if (selection !== '稍后手动重载') return;
    // Do not let a stale notification cancel a reload scheduled by a newer
    // start/stop action.
    if (reloadTimer !== timer) return;
    clearTimeout(timer);
    reloadTimer = undefined;
    log('已取消自动重载，等待用户稍后手动重载窗口');
  });
}

function showSharedProxyStatus(port) {
  status.text = `$(link) Kiro → kiroProxy :${port}`;
  status.tooltip = '正在复用另一 Kiro 窗口中的 kiroProxy 代理';
  status.backgroundColor = undefined;
}

function watchSharedProxy(port) {
  clearTakeoverTimer();
  takeoverTimer = setInterval(async () => {
    if (!usingSharedProxy || server || takeoverInProgress) return;
    if (!accessToken) return;
    if (await proxyHealth(port)) return;
    takeoverInProgress = true;
    try {
      usingSharedProxy = false;
      await syncAccessTokenFromStorage();
      if (!accessToken) {
        status.text = '$(circle-slash) Kiro RelayRouter';
        status.tooltip = '当前未登录；其他窗口已退出或解绑';
        sendPanelState({ text: '当前设备已退出，请使用 Token 重新登录。' });
        return;
      }
      await startProxy(false);
    } catch (error) {
      log('尝试接管本地代理失败', error.message);
    } finally {
      takeoverInProgress = false;
    }
  }, 750);
}

async function useSharedProxy(port, showMessage) {
  if (!await proxyHealth(port, true)) {
    usingSharedProxy = false;
    invalidateBackendAuthentication('另一窗口的代理使用不同的后端或 Token，或版本过旧。请完全退出所有 Kiro 窗口后重新打开。');
    throw new Error('不能复用使用不同 Token 的代理，请完全退出所有 Kiro 窗口后重新打开。');
  }
  await refreshBackendConfiguration();
  backendReady = true;
  usingSharedProxy = true;
  showSharedProxyStatus(port);
  watchSharedProxy(port);
  log('复用另一窗口中的本地代理', `127.0.0.1:${port}`);
  sendPanelState({ text: '正在复用另一 Kiro 窗口中的代理。' });
  if (showMessage) vscode.window.showInformationMessage(`正在复用另一 Kiro 窗口中的 kiroProxy 代理：127.0.0.1:${port}`);
}

function userSettingsPath() {
  const appName = vscode.env.appName || 'Kiro';
  if (process.platform === 'darwin') return path.join(process.env.HOME || '', 'Library', 'Application Support', appName, 'User', 'settings.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', appName, 'User', 'settings.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), appName, 'User', 'settings.json');
}

function skipJsonString(source, index) {
  index++;
  while (index < source.length) {
    if (source[index] === '\\') index += 2;
    else if (source[index++] === '"') break;
  }
  return index;
}

function jsonValueEnd(source, start) {
  let index = start;
  while (/\s/.test(source[index])) index++;
  if (source[index] === '"') return skipJsonString(source, index);
  if (source[index] !== '[' && source[index] !== '{') {
    while (index < source.length && !',}\n\r'.includes(source[index])) index++;
    return index;
  }
  const stack = [source[index++] === '[' ? ']' : '}'];
  while (index < source.length && stack.length) {
    if (source[index] === '"') { index = skipJsonString(source, index); continue; }
    if (source[index] === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index < 0) return source.length;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2);
      if (index < 0) return source.length;
      index += 2;
      continue;
    }
    if (source[index] === '[') stack.push(']');
    else if (source[index] === '{') stack.push('}');
    else if (source[index] === stack[stack.length - 1]) stack.pop();
    index++;
  }
  return index;
}

async function updateUnregisteredKiroSetting(settingKey, value) {
  const settingsPath = userSettingsPath();
  let source;
  try { source = await fs.readFile(settingsPath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = '{}\n';
  }
  const property = new RegExp(`(^|\\n)([\\t ]*)"${settingKey.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"\\s*:\\s*`, 'm');
  const match = property.exec(source);
  const replacement = JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
  let updated;
  if (match) {
    const start = match.index + match[0].length;
    updated = source.slice(0, start) + replacement + source.slice(jsonValueEnd(source, start));
  } else {
    const close = source.lastIndexOf('}');
    if (close < 0) throw new Error('无法读取 Kiro 用户设置文件。');
    const before = source.slice(0, close);
    const needsComma = before.trimEnd().endsWith('{') ? '' : ',';
    updated = `${before.trimEnd()}${needsComma}\n  "${settingKey}": ${replacement}\n${source.slice(close)}`;
  }
  const temporaryPath = `${settingsPath}.kiro-relayrouter.tmp`;
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(temporaryPath, updated, 'utf8');
  await fs.rename(temporaryPath, settingsPath);
}

function isUnregisteredConfigurationError(error) {
  return /没有注册配置|not\s+(?:a\s+)?registered(?:\s+configuration)?/i.test(error?.message || '');
}

async function updateKiroSetting(settings, settingKey, value) {
  try {
    await settings.update(settingKey, value, vscode.ConfigurationTarget.Global);
  } catch (error) {
    if (!isUnregisteredConfigurationError(error)) throw error;
    await updateUnregisteredKiroSetting(settingKey, value);
    log('通过用户设置写入未注册的 Kiro endpoint', settingKey);
  }
}

async function setEndpointOverrides() {
  const target = localEndpoint();
  // These are Kiro-owned settings. Access them by their complete key instead
  // of contributing duplicate configuration entries from this extension.
  const settings = vscode.workspace.getConfiguration();
  for (const key of ENDPOINT_KEYS) {
    const settingKey = `${KIRO_CONFIG}.${key}`;
    const current = settings.get(settingKey, []);
    const backupKey = `original.${key}`;
    if (!extensionContext.globalState.get(backupKey)) {
      await extensionContext.globalState.update(backupKey, current.filter((x) => !/127\.0\.0\.1|localhost/i.test(x?.endpoint || '')));
    }
    const keep = current.filter((x) => !/127\.0\.0\.1|localhost/i.test(x?.endpoint || ''));
    const overrides = [
      { region: 'us-east-1', endpoint: target },
      { region: 'eu-central-1', endpoint: target },
    ];
    await updateKiroSetting(settings, settingKey, [...keep, ...overrides]);
  }
  log('Kiro endpoints 已指向本地代理', target);
}

async function restoreOfficial(showMessage = true) {
  const settings = vscode.workspace.getConfiguration();
  let changed = false;
  for (const key of ENDPOINT_KEYS) {
    const settingKey = `${KIRO_CONFIG}.${key}`;
    const current = settings.get(settingKey, []);
    const clean = current.filter((x) => !/127\.0\.0\.1|localhost/i.test(x?.endpoint || ''));
    const original = extensionContext.globalState.get(`original.${key}`);
    const restored = clean.length ? clean : (Array.isArray(original) ? original : []);
    if (JSON.stringify(current) !== JSON.stringify(restored)) changed = true;
    await updateKiroSetting(settings, settingKey, restored);
  }
  log('已移除本地 endpoint override');
  if (showMessage) scheduleWindowReload();
  return changed;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('请求体超过 32 MiB'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(new Error(`Kiro 请求不是有效 JSON: ${error.message}`)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, {
    'content-type': 'application/x-amz-json-1.0',
    'content-length': body.length,
  });
  res.end(body);
}

function writeWithBackpressure(response, chunk) {
  if (response.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('error', onError);
      response.off('close', onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('Kiro 客户端已断开')); };
    response.once('drain', onDrain);
    response.once('error', onError);
    response.once('close', onClose);
  });
}

function authenticationError(message) {
  return Object.assign(new Error(message), { authentication: true });
}

// The service could not be reached at all. This says nothing about the Token,
// so it must never be reported as a login failure.
function connectivityError(message) {
  return Object.assign(new Error(message), { connectivity: true });
}

function panelWebviews() {
  return [controlPanel?.webview, controlView?.webview].filter(Boolean);
}

function sendConnectionState(connected, error) {
  for (const webview of panelWebviews()) {
    webview.postMessage({ type: 'connection', connected, error });
  }
}

function markBackendOnline() {
  connectionRetryStep = 0;
  clearConnectionWatchdog();
  backendOnline = true;
  sendConnectionState(true);
}

// Keep the verified session in memory across an outage: a short network wobble
// must not force the user to sign in again, and the watchdog restores the rest.
function markBackendOffline(message) {
  if (backendOnline) log('后端连接不可用，开始自动重连', message);
  backendOnline = false;
  backendReady = false;
  sendPanelState();
  sendConnectionState(false, message);
  scheduleConnectionWatchdog();
}

// Collapse concurrent probes (panel button, panel backoff, watchdog, startup)
// into a single health request.
function probeBackendConnection() {
  if (connectionProbe) return connectionProbe;
  const probe = checkBackendConnection();
  connectionProbe = probe;
  const release = () => { if (connectionProbe === probe) connectionProbe = undefined; };
  probe.then(release, release);
  return probe;
}

async function checkBackendConnection() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    // Public health checks must never depend on a saved or valid Token.
    const response = await fetch(backendApi('/api/relay/health'), {
      headers: { accept: 'application/json' }, signal: controller.signal,
    });
    if (!response.ok || (await response.json()).ok !== true) throw new Error('后端健康检查未通过');
    markBackendOnline();
  } catch (error) {
    markBackendOffline(error.name === 'AbortError' ? '连接检查超时' : error.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function queryBackendConfiguration(endpoint, token, validate = false) {
  if (!token) throw authenticationError('请输入后端发放的访问 Token。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const route = validate ? '/api/relay/session' : '/api/relay/config';
    let response;
    try {
      response = await fetch(`${endpoint}${route}?lang=${encodeURIComponent(interfaceLanguage)}`, {
        method: validate ? 'POST' : 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}`,
          'x-relay-machine-id': clientMachineId(),
          ...(deviceInstanceSecret ? { 'x-relay-legacy-machine-id': legacyMachineId() } : {}) },
        signal: controller.signal,
      });
    } catch (error) {
      throw connectivityError(error.name === 'AbortError' ? '连接检查超时' : error.message);
    }
    let backendError = '';
    if (!response.ok) {
      try {
        const payload = await response.json();
        backendError = String(payload.message || payload.error || '').trim();
      } catch { /* use localized fallback */ }
    }
    if (response.status === 401) {
      const error = authenticationError(backendError || interfaceText(
        'Token 不存在、已禁用或所属分类已禁用。',
        'The Token does not exist, is disabled, or belongs to a disabled group.'));
      error.invalidToken = true;
      throw error;
    }
    if (response.status === 429) {
      const error = authenticationError(backendError || interfaceText(
        '无效 Token 尝试次数过多，请在 1 小时后重试。',
        'Too many invalid Token attempts. Please try again in 1 hour.'));
      error.rateLimited = true;
      throw error;
    }
    if (response.status === 409 || response.status === 400) {
      throw authenticationError(backendError || interfaceText('设备授权失败', 'Device authorization failed.'));
    }
    if (!response.ok) {
      // A gateway or upstream failure is an outage, not a credential problem.
      const error = new Error(`kiroProxy 验证接口 HTTP ${response.status}`);
      if (response.status >= 500) error.connectivity = true;
      throw error;
    }
    const value = await response.json();
    if (value.authenticated !== true || !Array.isArray(value.models)) {
      throw new Error('后端未返回有效的 Token 验证结果，请升级 kiroProxy。');
    }
    return value;
  } catch (error) {
    if (error.name === 'AbortError') throw connectivityError('连接检查超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshBackendConfiguration() {
  try {
    const value = await queryBackendConfiguration(
      backendEndpoint(), accessToken, machineIdentityNeedsMigration);
    machineIdentityNeedsMigration = false;
    backendConfiguration = value;
    tokenStatusCheckedAt = Date.now();
    backendAuthenticated = true;
    loginMessage = '';
    // This is the only point at which a Token earns the "previously logged
    // in" state.  The stored value is a one-way hash, never the Token itself.
    await rememberVerifiedToken(accessToken);
    markBackendOnline();
    if (server || usingSharedProxy) backendReady = true;
    return value;
  } catch (error) {
    if (error.rateLimited) throw error;
    // An unreachable service keeps its own state machine: hold on to the
    // verified session and let the watchdog restore readiness.
    if (error.connectivity) {
      markBackendOffline(error.message);
      throw error;
    }
    // Do not call an unverified, leftover SecretStorage value "deleted" or
    // "disabled".  That diagnosis is meaningful only for a Token that this
    // installation has previously authenticated successfully.
    if (error.invalidToken && !tokenWasPreviouslyVerified(accessToken)) {
      error.message = '请输入访问 Token 登录。';
    }
    invalidateBackendAuthentication(error.message);
    // The service answered, so the panel must show the sign-in form rather
    // than the connection mask.
    if (accessToken) markBackendOnline();
    throw error;
  }
}

async function refreshModelPermissions({ announce = true } = {}) {
  // Gate on connectivity, never on the authentication flag: an outage used to
  // clear that flag and silently disable this watcher for the whole session.
  if (!accessToken || !backendOnline) return;
  if (modelPermissionRefresh) return modelPermissionRefresh;
  const previous = modelSignature();
  // Re-authenticating after a reconnect is not a permission change.
  const announceChange = announce && backendAuthenticated;
  modelPermissionRefresh = (async () => {
    try {
      const value = await refreshBackendConfiguration();
      const changed = previous !== modelSignature(value);
      if (changed) {
        log('Token 可用模型已动态更新', {
          models: value.models.length,
          defaultModel: value.defaultModel || '',
        });
        sendPanelState({ text: 'Token 可用模型已更新；如需立即更新 Kiro 模型下拉框，请点击“手动刷新页面”。' });
        if (announceChange) {
          void vscode.window.showInformationMessage(
            '当前 Token 的可用模型已更新。如需立即刷新 Kiro 模型下拉框，请在面板点击“手动刷新页面”。',
          );
        }
      }
      return changed;
    } catch (error) {
      if (!error.rateLimited) log('自动刷新模型权限失败', error.message);
      return false;
    } finally {
      modelPermissionRefresh = undefined;
    }
  })();
  return modelPermissionRefresh;
}

function startModelPermissionWatcher() {
  if (modelPermissionTimer) clearInterval(modelPermissionTimer);
  modelPermissionTimer = setInterval(() => {
    void refreshModelPermissions();
  }, MODEL_PERMISSION_POLL_MS);
  if (typeof modelPermissionTimer.unref === 'function') modelPermissionTimer.unref();
}

function invalidateBackendAuthentication(message) {
  backendConfiguration = { enabled: false, models: [], defaultModel: '' };
  backendReady = false;
  backendAuthenticated = false;
  loginMessage = message;
  sendPanelState();
}

function requestImageCount(body) {
  const state = body?.conversationState || {};
  const messages = [state.currentMessage?.userInputMessage,
    ...(Array.isArray(state.history) ? state.history.map((entry) => entry.userInputMessage) : [])];
  return messages.filter(Boolean).reduce((count, message) => {
    for (const container of [message, message.userInputMessageContext]) {
      if (container?.images != null) count += Array.isArray(container.images) ? container.images.length : 1;
    }
    if (Array.isArray(message.content)) count += message.content.filter((part) => ['image', 'image_url'].includes(part.type)).length;
    return count;
  }, 0);
}

function requestDocumentCount(body) {
  const state = body?.conversationState || {};
  const messages = [state.currentMessage?.userInputMessage,
    ...(Array.isArray(state.history) ? state.history.map((entry) => entry.userInputMessage) : [])];
  return messages.filter(Boolean).reduce((count, message) => {
    for (const container of [message, message.userInputMessageContext]) {
      for (const field of ['documents', 'attachments']) {
        if (container?.[field] != null) count += Array.isArray(container[field]) ? container[field].length : 1;
      }
    }
    if (Array.isArray(message.content)) count += message.content
      .filter((part) => ['document', 'file', 'input_file'].includes(part.type)).length;
    return count;
  }, 0);
}

async function forwardToBackend(req, res, body) {
  // The local proxy can be owned by a different Kiro window. Read the shared
  // selection for every request so that window does not keep forwarding its
  // stale in-memory language after another window switches languages.
  await syncInterfaceLanguageFromSharedStorage();
  const target = String(req.headers['x-amz-target'] || '');
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  const chat = /GenerateAssistantResponse|SendMessage/i.test(target) || Boolean(body.conversationState);
  const elapsed = () => Math.round(performance.now() - startedAt);
  const controller = new AbortController();
  // Keep the timeout active until the response body ends, not just its headers.
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  const abort = () => controller.abort();
  const abortOnClose = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', abortOnClose);
  let reader;
  let firstByte = true;
  try {
    if (chat) log('请求已转交后端', {
      requestId, images: requestImageCount(body), documents: requestDocumentCount(body),
    });
    const response = await fetch(backendApi('/api/relay/kiro'), {
      method: 'POST',
      headers: backendHeaders({
        'content-type': 'application/json',
        accept: String(req.headers.accept || '*/*'),
        'x-amz-target': target,
        'x-relay-request-id': requestId,
      }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (chat) log('后端响应头', { requestId, elapsedMs: elapsed(), status: response.status });
    if (response.status === 401) {
      invalidateBackendAuthentication('访问 Token 已失效，请重新登录。');
      sendConnectionState(true);
    }
    if (response.headers.get('x-relay-token-expired') === 'true') {
      backendConfiguration.tokenStatus = { ...currentTokenStatus(), expired: true, remainingDays: 0 };
      tokenStatusCheckedAt = Date.now();
      for (const webview of panelWebviews()) {
        webview.postMessage({ type: 'tokenStatus', value: currentTokenStatus() });
      }
    }
    if (response.headers.get('x-relay-result-code') === 'MODEL_ACCESS_CHANGED') {
      void refreshModelPermissions({ announce: true });
    }
    const headers = {};
    for (const name of ['content-type', 'cache-control', 'x-accel-buffering']) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(response.status, headers);
    if (!response.body) return res.end();
    reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstByte) {
        firstByte = false;
        if (chat) log('后端流首字节（不代表首个内容）', { requestId, elapsedMs: elapsed() });
      }
      await writeWithBackpressure(res, Buffer.from(value));
    }
    res.end();
    if (chat) {
      log('后端流已完整结束', { requestId, elapsedMs: elapsed() });
      scheduleBalanceRefresh();
    }
  } finally {
    clearTimeout(timer);
    req.off('aborted', abort);
    res.off('close', abortOnClose);
    if (reader) {
      try { await reader.cancel(); } catch { /* stream already completed */ }
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
  }
}

function scheduleBalanceRefresh() {
  if (balanceRefreshTimer) clearTimeout(balanceRefreshTimer);
  // RabbitMQ normally completes settlement within one outbox polling cycle.
  // Coalesce concurrent completions and fetch the authoritative DB balance.
  balanceRefreshTimer = setTimeout(async () => {
    balanceRefreshTimer = undefined;
    if (!accessToken || !backendOnline) return;
    try {
      await refreshBackendConfiguration();
      sendPanelState();
    } catch (error) {
      log('刷新 Token 积分失败', error.message);
    }
  }, 1500);
}

function createProxyServer() {
  const requestHandler = (req, res) => void handleRequest(req, res);
  const http1Server = http.createServer(requestHandler);
  const http2Server = http2.createServer(requestHandler);

  http1Server.on('clientError', (error, socket) => {
    // Kiro periodically probes the local endpoint with a non-request
    // connection. It does not affect KRS/CPS chat traffic, but Node reports
    // it as an invalid HTTP method. Keep it out of the normal proxy log.
    if (/HPE_INVALID_METHOD|Parse Error: Invalid method/i.test(error.code || '') || /Parse Error: Invalid method/i.test(error.message || '')) {
      socket.destroy();
      return;
    }
    log('HTTP/1 客户端连接错误', error.message);
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  http2Server.on('sessionError', (error) => {
    log('HTTP/2 会话错误', error.message);
  });

  // Kiro uses both HTTP/1.1 and cleartext HTTP/2 (h2c) for its KRS/CPS
  // traffic. Node exposes them as separate servers, so inspect the first
  // bytes and hand the socket to the matching protocol parser. TCP may split
  // the HTTP/2 preface across reads, so wait until it can be identified.
  const sockets = new Set();
  const multiplexer = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let prefix = Buffer.alloc(0);
    const inspectPrefix = (chunk) => {
      prefix = Buffer.concat([prefix, chunk]);
      const http2Magic = 'PRI * HTTP/2.0';
      const inspectedLength = Math.min(prefix.length, http2Magic.length);
      const mightBeHttp2 = prefix.subarray(0, inspectedLength).toString('ascii') === http2Magic.slice(0, inspectedLength);
      if (mightBeHttp2 && prefix.length < http2Magic.length) {
        socket.once('data', inspectPrefix);
        return;
      }
      socket.pause();
      const isHttp2 = prefix.subarray(0, http2Magic.length).toString('ascii') === http2Magic;
      (isHttp2 ? http2Server : http1Server).emit('connection', socket);
      socket.unshift(prefix);
      socket.resume();
    };
    socket.once('data', inspectPrefix);
  });
  multiplexer.on('close', () => {
    try { http1Server.close(); } catch { /* no standalone listener */ }
    try { http2Server.close(); } catch { /* no standalone listener */ }
  });
  multiplexer.destroyConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  return multiplexer;
}

async function handleRequest(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') return sendJson(res, 200, {});
  if (req.url === '/__kiro_relayrouter_health') return sendJson(res, 200, {
    ok: true, compatible: Boolean(accessToken) && req.headers['x-relay-identity'] === proxyIdentity(),
  });
  if (req.url === '/__kiro_relayrouter_stop' && req.method === 'POST') {
    if (req.headers['x-relay-control'] !== proxyControlIdentity()) return sendJson(res, 403, { stopped: false });
    sendJson(res, 202, { stopped: true });
    setTimeout(async () => {
      accessToken = '';
      invalidateBackendAuthentication('当前设备已在另一 Kiro 窗口退出或解绑。');
      await stopProxy({ restore: false, showMessage: false, force: true });
    }, 10);
    return;
  }
  try {
    const body = await readJson(req);
    return await forwardToBackend(req, res, body);
  } catch (error) {
    if (req.aborted || res.destroyed) return;
    log('代理请求失败', error.message);
    if (!res.headersSent) return sendJson(res, 502, { message: `kiroProxy 请求失败: ${error.message}` });
    try { res.end(); } catch { /* response already closed */ }
  }
}

async function startProxy(showMessage = true) {
  if (server) {
    if (!backendReady) scheduleConnectionWatchdog();
    return;
  }
  const port = LOCAL_PORT;
  if (await proxyHealth(port)) {
    if (await proxyHealth(port, true)) {
      await useSharedProxy(port, showMessage);
      return;
    }
    if (!await requestProxyShutdown(port) || !await waitForProxyShutdown(port)) {
      await useSharedProxy(port, showMessage);
      return;
    }
    log('已关闭使用旧 Token 的本地共享代理');
  }
  const incompatible = await incompatibleProxyError(port);
  if (incompatible) throw incompatible;
  clearTakeoverTimer();
  clearConnectionWatchdog();
  usingSharedProxy = false;
  backendReady = false;
  server = createProxyServer();
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server = undefined; reject(error); };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(); });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE' && await proxyHealth(port)) {
      await useSharedProxy(port, showMessage);
      return;
    }
    if (error.code === 'EADDRINUSE') {
      const incompatible = await incompatibleProxyError(port);
      if (incompatible) throw incompatible;
    }
    throw error;
  }
  // Bind first because Kiro may already have the local endpoint persisted
  // from the previous window. This removes the startup window in which its
  // account/chat requests previously received ECONNREFUSED.
  try {
    await finishProxyStartup(showMessage);
  } catch (error) {
    status.text = `$(sync~spin) Kiro → kiroProxy :${port}`;
    status.tooltip = error.authentication ? '服务器连接与 Token 登录独立检查，请在面板登录' : '本地代理已就绪，正在等待 kiroProxy 后端';
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    log('本地代理已监听，等待后端就绪', error.message);
    if (!error.authentication) scheduleConnectionWatchdog();
    if (showMessage) vscode.window.showWarningMessage(error.authentication ? '请在控制面板输入有效 Token 登录。' : '本地代理已启动，kiroProxy 后端暂不可用，将自动重试。');
  }
}

async function finishProxyStartup(showMessage) {
  await refreshBackendConfiguration();
  await setEndpointOverrides();
  backendReady = true;
  clearConnectionWatchdog();
  status.text = `$(radio-tower) Kiro → kiroProxy :${LOCAL_PORT}`;
  status.tooltip = '点击配置访问 Token';
  status.backgroundColor = undefined;
  await extensionContext.globalState.update('manualStop', false);
  log('代理已启动', `127.0.0.1:${LOCAL_PORT}`);
  sendPanelState({ text: '代理已启动。' });
  if (showMessage) vscode.window.showInformationMessage(`Kiro RelayRouter 代理已启动：127.0.0.1:${LOCAL_PORT}`);
}

async function stopProxy({ restore = true, showMessage = true, manual = false, force = false } = {}) {
  if (manual) await extensionContext.globalState.update('manualStop', true);
  clearTakeoverTimer();
  clearConnectionWatchdog();
  backendReady = false;
  if (!server && usingSharedProxy) {
    usingSharedProxy = false;
    status.text = '$(circle-slash) Kiro RelayRouter';
    status.tooltip = '代理由另一窗口运行；此窗口未停止它';
    sendPanelState({ text: '当前窗口未拥有代理，未停止另一窗口中的共享代理。' });
    if (showMessage) vscode.window.showInformationMessage('当前窗口复用的是另一窗口的代理，未停止共享代理。');
    return;
  }
  if (server) {
    const active = server;
    server = undefined;
    if (force) active.destroyConnections?.();
    await new Promise((resolve) => active.close(resolve));
  }
  if (restore) await restoreOfficial(false);
  status.text = '$(circle-slash) Kiro RelayRouter';
  status.tooltip = '代理已停止；点击配置';
  sendPanelState({ text: '代理已停止。' });
  if (showMessage) vscode.window.showInformationMessage('Kiro RelayRouter 代理已停止。');
}

async function configure() {
  const newAccessToken = await vscode.window.showInputBox({
    title: 'kiroProxy 访问 Token',
    prompt: accessToken ? '已配置 Token；留空保留原 Token，确认后将向后端验证' : '请输入后端发放的 Token，确认后将向后端验证',
    password: true,
    ignoreFocusOut: true,
  });
  if (newAccessToken === undefined) return;
  await savePanelConfiguration({ accessToken: newAccessToken });
  sendPanelState({ text: 'Token 验证成功，配置已保存。' });
  scheduleWindowReload();
  vscode.window.showInformationMessage(`已连接 kiroProxy：${backendEndpoint()}`);
}

function currentTokenStatus() {
  const tokenStatus = backendConfiguration.tokenStatus;
  if (!tokenStatus) return null;
  const serverTime = Date.parse(tokenStatus.serverTime);
  return { ...tokenStatus, serverTime: Number.isFinite(serverTime)
    ? new Date(serverTime + Math.max(0, Date.now() - tokenStatusCheckedAt)).toISOString() : null };
}

function panelState() {
  return {
    running: (Boolean(server) || usingSharedProxy) && backendReady,
    serviceActive: Boolean(server) || usingSharedProxy,
    modelCount: Array.isArray(backendConfiguration.models) ? backendConfiguration.models.length : 0,
    tokenConfigured: Boolean(accessToken),
    // Only send a masked prefix to the webview; the full token stays in SecretStorage.
    tokenPrefix: accessToken ? accessToken.slice(0, accessToken.length > 12 ? 12 : Math.floor(accessToken.length / 2)) + '…' : '',
    authenticated: backendAuthenticated,
    tokenStatus: backendAuthenticated ? currentTokenStatus() : null,
    walletStatus: backendAuthenticated ? backendConfiguration.walletStatus || null : null,
    machineBindingStatus: backendAuthenticated ? backendConfiguration.machineBindingStatus || null : null,
    loginMessage,
  };
}

function controlPanelHtml(webview) {
  const nonce = crypto.randomUUID();
  const version = extensionContext?.extension?.packageJSON?.version || '0.9.0';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Relayrouter</title>
  <style>
    :root {
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      color-scheme: dark;
      --surface: color-mix(in srgb, var(--vscode-editor-background) 88%, #27324a 12%);
      --surface-strong: color-mix(in srgb, var(--vscode-editor-background) 78%, #334264 22%);
      --line: color-mix(in srgb, var(--vscode-panel-border) 72%, #8091b8 28%);
      --muted: var(--vscode-descriptionForeground);
      --purple: #7657ff;
      --blue: #6d91ff;
      --green: #4ed991;
      --red: #ff706a;
      --amber: #ffb44c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      padding: 16px;
      background:
        radial-gradient(circle at 30% 8%, rgba(84, 98, 154, .13), transparent 32%),
        var(--vscode-editor-background);
    }
    button, input { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: wait; opacity: .65; }
    .app { width: min(100%, 760px); margin: 0 auto; }
    .hero { display: grid; grid-template-columns: 36px 1fr auto; gap: 14px; align-items: start; padding: 4px 10px 18px; }
    .brand-mark {
      display: grid; place-items: center; width: 36px; height: 36px; border-radius: 13px;
      color: white; font-size: 22px; line-height: 1; font-weight: 300;
      background: linear-gradient(145deg, #8c65ff, #4c38e9);
      border: 1px solid rgba(255,255,255,.22); box-shadow: 0 8px 20px rgba(82,55,220,.3);
    }
    h1 { min-width: 0; overflow: hidden; font-size: 20px; line-height: 1.08; margin: 0 0 10px; letter-spacing: -.5px; white-space: nowrap; text-overflow: ellipsis; }
    .hero-description { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .hero-actions { display: flex; flex-wrap: nowrap; flex: 0 0 auto; gap: 6px; align-items: center; white-space: nowrap; }
    .version, .language-button { padding: 7px 10px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; background: var(--surface-strong); }
    .language-button { flex: 0 0 auto; min-width: 42px; color: var(--vscode-foreground); line-height: 1; white-space: nowrap; }
    .language-button:hover { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--surface-strong) 70%, var(--purple) 30%); }
    .card { margin: 0 0 12px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: linear-gradient(145deg, var(--surface-strong), var(--surface)); box-shadow: 0 10px 38px rgba(0,0,0,.08); }
    .card-heading { display: flex; gap: 10px; align-items: flex-start; }
    .section-icon { display: inline-grid; place-items: center; flex: 0 0 20px; height: 20px; color: var(--blue); font-size: 18px; }
    .heading-copy { min-width: 0; flex: 1; }
    .heading-copy h2 { margin: 0 0 6px; font-size: 16px; line-height: 1.25; }
    .heading-copy p, .section-note, .auth-subtitle { margin: 0; color: var(--muted); line-height: 1.5; }
    .status-dot { flex: 0 0 10px; width: 10px; height: 10px; margin-top: 2px; border-radius: 50%; background: #8e98b4; box-shadow: 0 0 12px rgba(142,152,180,.35); }
    .status-dot.on { background: var(--green); box-shadow: 0 0 14px rgba(78,217,145,.5); }
    .status-pill { align-self: flex-start; padding: 7px 12px; border-radius: 999px; border: 1px solid #4abf7a; color: var(--green); white-space: nowrap; }
    .status-pill.off { border-color: var(--line); color: var(--muted); }
    .status-table { margin-top: 12px; border-top: 1px solid var(--line); }
    .status-row { display: grid; grid-template-columns: 20px minmax(140px, .8fr) minmax(170px, 1.8fr) auto; gap: 12px; align-items: center; min-height: 38px; border-bottom: 1px solid var(--line); }
    .row-icon { color: #b8c3df; font-size: 12px; text-align: center; }
    .row-label { color: #d7dbea; }
    .row-value { min-width: 0; overflow-wrap: anywhere; }
    .row-note { color: var(--muted); text-align: right; }
    .status-row.balance.danger { margin: 0 -6px; padding: 0 6px; border: 1px solid rgba(255,112,106,.35); border-radius: 8px; color: #ffaaa6; background: rgba(132,46,43,.2); }
    .status-row.balance.danger .row-icon, .status-row.balance.danger .row-label, .status-row.balance.danger .row-note { color: var(--red); }
    .status-banner { display: flex; justify-content: space-between; gap: 12px; margin-top: 12px; padding: 10px 12px; border: 1px solid rgba(255,180,76,.35); border-radius: 8px; color: var(--amber); background: rgba(127,83,25,.17); }
    .status-banner.hidden, .hidden { display: none !important; }
    .section-card { display: grid; grid-template-columns: 32px 1fr; gap: 10px; }
    .section-card h2 { margin: 2px 0 8px; font-size: 15px; }
    .section-note { margin-top: 8px; }
    .reveal-button { border: 0; padding: 5px 8px; color: #bfc8df; background: transparent; border-radius: 5px; }
    .reveal-button:hover { color: white; background: rgba(255,255,255,.08); }
    .balance-value { display: flex; align-items: center; gap: 5px; min-width: 0; }
    .refresh-button { display: inline-grid; place-items: center; flex: 0 0 26px; width: 26px; height: 26px; padding: 5px; border: 0; border-radius: 5px; color: var(--muted); background: transparent; }
    .refresh-button:hover { color: var(--vscode-foreground); background: rgba(255,255,255,.08); }
    .refresh-button.cooling, .refresh-button:disabled { color: var(--blue); opacity: 1; }
    .refresh-button.refreshing .icon { animation: refresh-spin .7s linear infinite; }
    @keyframes refresh-spin { to { transform: rotate(360deg); } }
    .token-input-wrap { position: relative; }
    #accessToken { width: 100%; height: 32px; padding: 0 22px 0 10px; color: var(--vscode-input-foreground); background: color-mix(in srgb, var(--vscode-input-background) 86%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-input-border) 60%, #7f8cb0 40%); border-radius: 8px; outline: none; }
    #accessToken:focus { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
    .reveal-button { position: absolute; top: 8px; right: 8px; font-size: 12px; }
    .auth-status { display: grid; grid-template-columns: 20px 1fr; gap: 10px; margin-top: 8px; align-items: start; }
    .auth-indicator { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; color: white; background: var(--red); box-shadow: 0 0 10px rgba(255,112,106,.28); }
    .auth-indicator.ok { background: #23bd72; }
    #loginStatus { margin: 0 0 2px; color: var(--red); font-size: 13px; font-weight: 600; }
    #loginStatus.ok { color: var(--green); }
    .footer-actions { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
    .secondary-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .button { min-height: 32px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 9px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font-weight: 600; }
    .button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .button.primary { color: white; border-color: #8a6cff; background: linear-gradient(100deg, #6540e9, #7d55fb); }
    .button.primary:hover { filter: brightness(1.08); }
    .button.start { color: #d8ffea; border-color: #36bd79; background: rgba(35,189,114,.18); }
    .button.danger { color: #ffd5d2; border-color: #ff625c; background: linear-gradient(100deg, rgba(155,55,51,.68), rgba(118,49,54,.42)); }
    #notice { min-height: 12px; margin: 12px 4px 0; color: var(--muted); text-align: center; }
    #notice.error { color: var(--red); }
    .connection-mask { position: fixed; inset: 0; z-index: 999; display: flex; align-items: center; justify-content: center; padding: 14px; text-align: center; background: var(--vscode-editor-background); }
    .connection-mask.hidden { display: none; }
    .connection-mask h2 { margin: 0 0 10px; font-size: 16px; }
    .connection-mask p { max-width: 440px; color: var(--muted); }
    :root { font-size: var(--vscode-font-size, 13px); line-height: 1.5; color-scheme: light dark; }
    body { padding: clamp(10px, 3vw, 20px); }
    .hero { grid-template-columns: 32px minmax(0, 1fr) auto; gap: 10px; padding: 0 0 16px; }
    .brand-mark { width: 32px; height: 32px; border-radius: 8px; box-shadow: none; }
    .brand-mark .icon { width: 20px; height: 20px; }
    h1 { font-size: 1.3rem; line-height: 1.3; margin-bottom: 5px; letter-spacing: -.2px; overflow-wrap: anywhere; }
    .hero-description, #loginStatus { font-size: 1rem; }
    .heading-copy h2, .section-card h2 { font-size: 1.08rem; }
    .hero-description, .section-note, .auth-subtitle, .row-note, .version, .language-button { font-size: .92rem; }
    .card { padding: 14px; margin-bottom: 12px; border-radius: 8px; box-shadow: none; }
    .section-card { grid-template-columns: 18px minmax(0, 1fr); gap: 10px; }
    .section-icon { width: 18px; height: 20px; }
    .icon { display: block; width: 16px; height: 16px; flex-shrink: 0; }
    .row-icon { display: grid; place-items: center; }
    .status-dot { margin-top: 5px; box-shadow: none; }
    .status-dot.on { box-shadow: none; }
    .status-row { grid-template-columns: 18px minmax(90px, .8fr) minmax(0, 1.5fr) auto; gap: 8px; min-height: 38px; padding: 6px 0; }
    .row-label { color: var(--vscode-foreground); }
    .row-note { overflow-wrap: anywhere; }
    .reveal-button { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 6px; color: var(--vscode-descriptionForeground); }
    .token-details { margin-top: 12px; }
    #accessToken { height: 32px; padding: 0 34px 0 9px; border-radius: 5px; }
    .reveal-button { top: 2px; right: 2px; }
    .auth-status { grid-template-columns: 18px minmax(0, 1fr); gap: 8px; }
    .auth-indicator { width: 16px; height: 16px; margin-top: 2px; font-size: 10px; box-shadow: none; }
    .button { min-height: 32px; padding: 5px 12px; border-radius: 5px; font-size: 1rem; line-height: 1.5; }
    .footer-actions { grid-template-columns: minmax(0, 1fr); gap: 8px; }
    button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    @media (max-width: 540px) {
      .hero { grid-template-columns: 32px minmax(0, 1fr) auto; }
      .version { display: none; }
      .hero-actions { grid-column: 3; align-self: start; }
      .status-row { grid-template-columns: 18px minmax(0, 1fr) auto; gap: 3px 8px; }
      .status-row .row-value { grid-column: 2; }
      .status-row .row-note { grid-column: 2 / -1; text-align: left; }
      .status-row > span:empty { display: none; }
      .status-row.balance { padding-block: 8px; }
      .status-pill { display: none; }
      .status-banner { flex-direction: column; gap: 4px; }
    }
    @media (max-width: 320px) {
      .card { padding: 10px; }
      .footer-actions { grid-template-columns: minmax(0, 1fr); }
      .secondary-actions { grid-template-columns: minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <div id="connectionMask" class="connection-mask">
    <div><h2 id="connectionTitle">Connecting</h2><p id="connectionError">Checking service availability…</p><button id="retry" class="button primary">Retry</button></div>
  </div>
  <main id="app" class="app">
    <header class="hero">
      <div class="brand-mark" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4"/></svg></div>
      <div><h1>Relayrouter</h1><p id="heroSubtitle" class="hero-description">Let more powerful models empower Kiro-compatible development workflows.</p></div>
      <div class="hero-actions"><button id="language" class="language-button" type="button" aria-label="切换为中文">中文</button><span class="version">v${version}</span></div>
    </header>

    <section id="statusCard" class="card">
      <div class="card-heading">
        <span id="dot" class="status-dot"></span>
        <div class="heading-copy"><h2 id="statusText">Checking status…</h2><p id="statusDescription">Preparing your connection</p></div>
        <span id="statusPill" class="status-pill off">Waiting</span>
      </div>
      <div id="statusBanner" class="status-banner"><strong id="statusBannerTitle">Service is not active. Enter your Token.</strong><span id="statusBannerDetail">The connection will be prepared automatically after sign-in.</span></div>
    </section>

    <section class="card section-card">
      <span class="section-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="9" r="4"/><path d="m11 12 9 9m-3-3 3-3m-6 0 3-3"/></svg></span>
      <div><h2><label id="accessTokenLabel" for="accessToken">Access Token</label></h2><div class="token-input-wrap"><input id="accessToken" type="password" autocomplete="off" placeholder="Enter your access Token"><button id="revealToken" class="reveal-button" type="button" title="Show or hide Token"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><div class="auth-status"><span id="authIndicator" class="auth-indicator">●</span><div><p id="loginStatus" role="status">Signed out</p><p id="loginDetail" class="auth-subtitle">Enter a valid Token to continue.</p></div></div><div class="status-table token-details"><div class="status-row"><span class="row-icon">◈</span><span id="boundMachinesLabel" class="row-label">Authorized devices</span><span id="boundMachines" class="row-value">—</span><span></span></div><div class="status-row"><span class="row-icon">↺</span><span id="remainingUnbindsLabel" class="row-label">Unbinds remaining</span><span id="remainingUnbinds" class="row-value">—</span><button id="unbindMachine" class="button" type="button">Unbind device</button></div><div class="status-row"><span class="row-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 6v6h5"/></svg></span><span id="tokenExpiryLabel" class="row-label">Token validity</span><span id="tokenExpiry" class="row-value" role="status">Signed out</span><span></span></div><div class="status-row"><span class="row-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 9-9 9-9-9Z"/></svg></span><span id="modelCountLabel" class="row-label">Available models</span><span id="modelCount" class="row-value">—</span><span></span></div><div id="balanceRow" class="status-row balance"><span class="row-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 10 18H2Z M12 9v5m0 3h.01"/></svg></span><span id="tokenBalanceLabel" class="row-label">Credits balance</span><span class="balance-value"><span id="tokenBalance" class="row-value" role="status">Signed out</span><button id="refreshAccount" class="refresh-button" type="button" title="Refresh Token details" aria-label="Refresh Token details"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.5-2.6L20 9M4 15l2.4 2.6A7 7 0 0 0 17.9 15"/></svg></button></span><span id="balanceHint" class="row-note">Sign in to view</span></div></div></div>
    </section>

    <div class="footer-actions">
      <button id="save" class="button primary">Save and sign in</button>
      <div class="secondary-actions">
        <button id="toggleService" class="button start" type="button">Start service</button>
        <button id="reloadPage" class="button" type="button">Refresh page</button>
      </div>
    </div>
    <div id="notice" role="status"></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const ACCOUNT_REFRESH_COOLDOWN_MS = 5000;
    let activeTokenStatus;
    let tokenStatusReceivedAt = 0;
    let accountRefreshAvailableAt = 0;
    let accountRefreshAuthenticated = false;
    let accountRefreshTimer;
    let latestState;
    let latestConnection = { connected: false, error: '' };
    // Backoff for a host that answers nothing at all; an acknowledged outage is
    // rechecked on the slow interval because the host retries on its own.
    const RECONNECT_STEPS_MS = [3000, 6000, 12000, 30000];
    const HOST_REPLY_TIMEOUT_MS = 8000;
    const OFFLINE_RECHECK_MS = 30000;
    let reconnectTimer;
    let reconnectStep = 0;
    const savedWebviewState = typeof vscode.getState === 'function' ? vscode.getState() : null;
    let language = savedWebviewState && savedWebviewState.language === 'zh'
      ? 'zh' : '${interfaceLanguage === 'zh' ? 'zh' : 'en'}';
    const messages = {
      en: {
        heroSubtitle: 'Let more powerful models empower Kiro-compatible development workflows.',
        connecting: 'Connecting',
        checkingService: 'Checking service availability…',
        retry: 'Retry',
        retrying: 'Reconnecting…',
        connectionLost: 'Connecting to server',
        connectionError: 'The service is unreachable. Retrying automatically…',
        checkingStatus: 'Checking status…',
        preparing: 'Preparing your connection',
        signInFirst: 'Sign in to continue',
        signInDescription: 'Enter a valid access Token.',
        serviceReady: 'Service ready',
        serviceReadyDescription: 'Kiro-compatible workflows are connected.',
        servicePreparing: 'Preparing service',
        servicePreparingDescription: 'Your Token is verified. The connection is being prepared automatically.',
        waiting: 'Waiting',
        ready: 'Ready',
        bannerTitle: 'Service is not active. Enter your Token.',
        bannerDetail: 'The connection will be prepared automatically after sign-in.',
        accessToken: 'Access Token',
        tokenPlaceholder: 'Enter your access Token (for example, kr_xxxxxxxxxx)',
        tokenPreserved: 'Leave blank to keep the saved Token',
        revealToken: 'Show or hide Token',
        signedOut: 'Signed out',
        signedIn: 'Signed in',
        authorizedDevices: 'Authorized devices',
        unbindsRemaining: 'Unbinds remaining',
        unbindDevice: 'Unbind device',
        tokenValidity: 'Token validity',
        availableModels: 'Available models',
        pointsRemaining: 'Credits balance',
        signInToView: 'Sign in to view',
        unavailable: 'Unavailable',
        reconnect: 'Reconnect to the service',
        lowBalance: 'No usable balance. Please recharge or use another Token.',
        frozenPoints: 'Frozen points: ',
        updatedAt: '\\nService updated: ',
        expired: 'Expired',
        neverExpires: 'Never expires',
        lessThanDay: ' (less than 24 hours)',
        days: ' days',
        expiresAt: 'Expires: ',
        modelUnit: ' available models',
        unlimited: 'Unlimited',
        tokenExpired: 'This Token has expired. New chat requests will be declined.',
        tokenUsable: 'This Token is ready to use.',
        tokenPrompt: 'Enter a valid Token to continue.',
        saveAndSignIn: 'Save and sign in',
        saveAndApply: 'Save and apply',
        saving: 'Verifying Token…',
        refreshToken: 'Refresh Token details',
        startService: 'Start service',
        restoreDefaults: 'Restore initial settings',
        refreshPage: 'Refresh page',
        working: 'Working…',
      },
      zh: {
        heroSubtitle: '连接更强大的模型，拓展 Kiro 开发体验。',
        connecting: '正在连接',
        checkingService: '正在检查服务连接…',
        retry: '重试',
        retrying: '正在重新连接…',
        connectionLost: '正在连接服务器',
        connectionError: '服务暂时无法连接，正在自动重试…',
        checkingStatus: '正在读取状态…',
        preparing: '正在准备连接',
        signInFirst: '请先登录',
        signInDescription: '请输入有效的访问 Token。',
        serviceReady: '服务已就绪',
        serviceReadyDescription: 'Kiro 开发工作流已连接。',
        servicePreparing: '正在准备服务',
        servicePreparingDescription: 'Token 已验证，正在自动完成连接。',
        waiting: '等待中',
        ready: '已就绪',
        bannerTitle: '当前服务未启动，请输入Token',
        bannerDetail: '登录后将自动完成连接。',
        accessToken: '访问 Token',
        tokenPlaceholder: '请输入访问 Token（如 kr_xxxxxxxxxx）',
        tokenPreserved: '留空保留已保存的 Token',
        revealToken: '显示或隐藏 Token',
        signedOut: '未登录',
        signedIn: '已登录',
        authorizedDevices: '已绑定设备',
        unbindsRemaining: '剩余可解绑次数',
        unbindDevice: '解绑',
        tokenValidity: 'Token 有效期',
        availableModels: '当前共有模型',
        pointsRemaining: 'Token 剩余积分',
        signInToView: '请先登录后查看',
        unavailable: '暂不可用',
        reconnect: '请重新连接服务',
        lowBalance: '额度已用尽，请充值或更换 Token',
        frozenPoints: '当前冻结积分：',
        updatedAt: '\\n服务更新时间：',
        expired: '已过期',
        neverExpires: '永不过期',
        lessThanDay: '（不足 24 小时）',
        days: ' 天',
        expiresAt: '到期时间：',
        modelUnit: ' 个可用模型',
        unlimited: '不限',
        tokenExpired: '当前 Token 已过期，新的聊天请求将被拒绝。',
        tokenUsable: '当前 Token 可正常使用',
        tokenPrompt: '请输入有效 Token。',
        saveAndSignIn: '保存并登录',
        saveAndApply: '保存并应用',
        saving: '正在验证 Token…',
        refreshToken: '刷新 Token 信息',
        startService: '启动服务',
        restoreDefaults: '恢复初始设置',
        refreshPage: '手动刷新页面',
        working: '正在处理…',
      },
    };
    const t = (key) => messages[language][key];
    function localizeHostMessage(message) {
      if (!message) return '';
      if (language === 'zh') return String(message).replaceAll('本地代理', '本地连接').replace(/代理(?:服务)?/g, '连接');
      const value = String(message);
      if (/已成功解绑/.test(value)) return 'This device has been unbound successfully.';
      if (/已解绑|退出或解绑|重新登录/.test(value)) return 'This device is signed out. Sign in again to continue.';
      if (/配置已保存/.test(value)) return 'Settings saved. The window will reload to refresh model access.';
      if (/模型.*更新/.test(value)) return 'Available models have been updated.';
      if (/已恢复初始设置/.test(value)) return 'Initial settings restored. The window will refresh in 3 seconds.';
      if (/服务已启动/.test(value)) return 'Service started. The window will refresh in 3 seconds.';
      if (/3 秒后刷新窗口/.test(value)) return 'The window will refresh in 3 seconds.';
      if (/不存在|已禁用|分类已禁用/.test(value)) return 'The Token is invalid, disabled, or no longer authorized.';
      if (/达到.*上限/.test(value)) return 'This Token has reached its device authorization limit.';
      if (/无效 Token 尝试次数过多/.test(value)) return 'Too many invalid Token attempts. Please try again later.';
      if (/服务器已连接|请输入.*Token/.test(value)) return t('tokenPrompt');
      return value.replaceAll('本地代理', 'local connection').replace(/代理(?:服务)?/g, 'service').replaceAll('后端', 'service');
    }
    function applyLanguage() {
      document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
      $('language').textContent = language === 'en' ? '中文' : 'EN';
      $('language').setAttribute('aria-label', language === 'en' ? '切换为中文' : 'Switch to English');
      $('heroSubtitle').textContent = t('heroSubtitle');
      $('retry').textContent = t('retry');
      $('accessTokenLabel').textContent = t('accessToken');
      $('revealToken').title = t('revealToken');
      $('boundMachinesLabel').textContent = t('authorizedDevices');
      $('remainingUnbindsLabel').textContent = t('unbindsRemaining');
      $('unbindMachine').textContent = t('unbindDevice');
      $('tokenExpiryLabel').textContent = t('tokenValidity');
      $('modelCountLabel').textContent = t('availableModels');
      $('tokenBalanceLabel').textContent = t('pointsRemaining');
      $('refreshAccount').title = t('refreshToken');
      $('refreshAccount').setAttribute('aria-label', t('refreshToken'));
      $('reloadPage').textContent = t('refreshPage');
      if (!latestState) $('toggleService').textContent = t('startService');
      $('statusBannerTitle').textContent = t('bannerTitle');
      $('statusBannerDetail').textContent = t('bannerDetail');
      if (latestState) apply(latestState);
      else {
        $('connectionTitle').textContent = t('connecting');
        $('connectionError').textContent = t('checkingService');
        $('statusText').textContent = t('checkingStatus');
        $('statusDescription').textContent = t('preparing');
        $('statusPill').textContent = t('waiting');
        $('save').textContent = t('saveAndSignIn');
      }
      if (latestConnection.connected === false && latestConnection.error) connection(false, latestConnection.error);
      renderTokenExpiry();
    }
    function finishAccountRefreshCooldown() {
      const button = $('refreshAccount');
      const remaining = accountRefreshAvailableAt - Date.now();
      button.classList.toggle('refreshing', false);
      if (remaining > 0) {
        button.disabled = true;
        button.classList.toggle('cooling', true);
        clearTimeout(accountRefreshTimer);
        accountRefreshTimer = setTimeout(finishAccountRefreshCooldown, remaining);
      } else {
        button.disabled = !accountRefreshAuthenticated;
        button.classList.toggle('cooling', false);
      }
    }
    function refreshAccount() {
      if (!accountRefreshAuthenticated || Date.now() < accountRefreshAvailableAt) return;
      accountRefreshAvailableAt = Date.now() + ACCOUNT_REFRESH_COOLDOWN_MS;
      const button = $('refreshAccount');
      button.disabled = true;
      button.classList.toggle('cooling', true);
      button.classList.toggle('refreshing', true);
      clearTimeout(accountRefreshTimer);
      accountRefreshTimer = setTimeout(finishAccountRefreshCooldown, ACCOUNT_REFRESH_COOLDOWN_MS);
      vscode.postMessage({ type: 'refreshAccount', language });
    }
    function setTokenStatus(value) {
      activeTokenStatus = value;
      tokenStatusReceivedAt = Date.now();
      renderTokenExpiry();
    }
    function renderTokenExpiry() {
      const value = activeTokenStatus;
      let text = t('signedOut');
      if (value) {
        const expiry = Date.parse(value.expiresAt);
        const serverTime = Date.parse(value.serverTime);
        const remaining = expiry - (serverTime + Math.max(0, Date.now() - tokenStatusReceivedAt));
        if (value.expired || (Number.isFinite(remaining) && remaining <= 0)) {
          text = t('expired');
        } else if (value.expiresAt === null) {
          text = t('neverExpires');
        } else if (Number.isFinite(remaining)) {
          text = Math.ceil(remaining / 86400000) + t('days') + (remaining < 86400000 ? t('lessThanDay') : '');
        } else {
          text = t('unavailable');
        }
        $('tokenExpiry').title = Number.isFinite(expiry) ? t('expiresAt') + new Date(expiry).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US') : '';
      } else { $('tokenExpiry').title = ''; }
      $('tokenExpiry').textContent = text;
    }
    setInterval(renderTokenExpiry, 60000);
    function formatPoints(value) {
      const points = Number(value);
      return Number.isFinite(points) ? points.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 8 }) : t('unavailable');
    }
    function renderTokenBalance(state) {
      $('balanceRow').classList.toggle('danger', false);
      if (!state.authenticated) {
        $('tokenBalance').textContent = t('signedOut');
        $('balanceHint').textContent = t('signInToView');
        $('tokenBalance').title = '';
        return;
      }
      const wallet = state.walletStatus;
      if (!wallet) {
        $('tokenBalance').textContent = t('unavailable');
        $('balanceHint').textContent = t('reconnect');
        return;
      }
      const available = Number(wallet.availablePoints);
      const displayed = Number.isFinite(available) ? Math.max(0, available) : wallet.availablePoints;
      $('tokenBalance').textContent = formatPoints(displayed);
      $('balanceHint').textContent = available < 0.5 ? t('lowBalance') : '';
      $('balanceRow').classList.toggle('danger', available < 0.5);
      $('tokenBalance').title = t('frozenPoints') + formatPoints(wallet.frozenPoints)
        + (wallet.updatedAt ? t('updatedAt') + new Date(wallet.updatedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US') : '');
    }
    function show(message, error = false) { $('notice').textContent = localizeHostMessage(message); $('notice').className = error ? 'error' : ''; }
    function apply(state) {
      latestState = state;
      accountRefreshAuthenticated = !!state.authenticated;
      $('accessToken').value = '';
      $('accessToken').placeholder = state.tokenConfigured ? state.tokenPrefix + ' (' + t('tokenPreserved') + ')' : t('tokenPlaceholder');
      $('dot').classList.toggle('on', !!state.running);
      $('statusText').textContent = !state.authenticated ? t('signInFirst') : (state.running ? t('serviceReady') : t('servicePreparing'));
      $('statusDescription').textContent = !state.authenticated ? t('signInDescription') : (state.running ? t('serviceReadyDescription') : t('servicePreparingDescription'));
      $('statusPill').textContent = state.running ? t('ready') : t('waiting');
      $('statusPill').classList.toggle('off', !state.running);
      const modelCount = state.modelCount || 0;
      $('modelCount').textContent = state.authenticated
        ? (language === 'en' ? modelCount + (modelCount === 1 ? ' available model' : ' available models') : modelCount + t('modelUnit'))
        : '—';
      const binding = state.machineBindingStatus;
      $('boundMachines').textContent = binding ? binding.boundMachineCount + (binding.maxMachineBindings === 0 ? ' / ' + t('unlimited') : ' / ' + binding.maxMachineBindings) : '—';
      $('remainingUnbinds').textContent = binding ? String(binding.remainingUnbindCount) : '—';
      $('unbindMachine').disabled = !state.authenticated || !binding || !binding.currentMachineBound || binding.remainingUnbindCount <= 0;
      renderTokenBalance(state);
      $('loginStatus').textContent = state.authenticated ? t('signedIn') : t('signedOut');
      $('loginStatus').classList.toggle('ok', !!state.authenticated);
      $('authIndicator').classList.toggle('ok', !!state.authenticated);
      $('authIndicator').textContent = state.authenticated ? '✓' : '●';
      $('loginDetail').textContent = state.authenticated
        ? (state.tokenStatus && state.tokenStatus.expired ? t('tokenExpired') : t('tokenUsable'))
        : localizeHostMessage(state.loginMessage || t('tokenPrompt'));
      setTokenStatus(state.tokenStatus);
      $('refreshAccount').disabled = !state.authenticated || Date.now() < accountRefreshAvailableAt;
      $('statusBanner').classList.toggle('hidden', !!state.authenticated);
      $('save').textContent = state.authenticated ? t('saveAndApply') : t('saveAndSignIn');
      $('toggleService').textContent = state.serviceActive ? t('restoreDefaults') : t('startService');
      $('toggleService').classList.toggle('danger', !!state.serviceActive);
      $('toggleService').classList.toggle('start', !state.serviceActive);
      $('toggleService').disabled = !state.serviceActive && !state.authenticated;
    }
    function connection(connected, error) {
      latestConnection = { connected: !!connected, error: error || '' };
      $('connectionMask').classList.toggle('hidden', !!connected);
      $('connectionTitle').textContent = connected ? '' : t('connectionLost');
      $('connectionError').textContent = connected ? '' : t('connectionError');
      reconnectStep = 0;
      // An explicit outage notice proves the host is alive and already running
      // its own backoff, so this view only has to watch for it going silent.
      if (connected) clearReconnect();
      else scheduleReconnect(OFFLINE_RECHECK_MS);
    }
    function panelVisible() {
      return typeof document.visibilityState !== 'string' || document.visibilityState !== 'hidden';
    }
    function reconnectDelay() {
      return RECONNECT_STEPS_MS[Math.min(reconnectStep, RECONNECT_STEPS_MS.length - 1)];
    }
    function clearReconnect() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    // Only the extension host can lift the mask, so this view keeps a bounded
    // backoff of its own. A dropped, lost or never-answered request must not
    // leave the panel waiting for a click that may never come.
    function scheduleReconnect(delay) {
      clearReconnect();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (latestConnection.connected) return;
        // Retrying while the panel is hidden only wastes backend requests;
        // becoming visible again triggers an immediate attempt.
        if (!panelVisible()) return scheduleReconnect(OFFLINE_RECHECK_MS);
        requestReconnect(true);
      }, delay);
    }
    function requestReconnect(automatic) {
      // An explicit click restarts the backoff; an automatic attempt widens it.
      if (automatic) reconnectStep += 1;
      else reconnectStep = 0;
      $('connectionError').textContent = t('retrying');
      vscode.postMessage({ type: 'retry', language, automatic: !!automatic });
      scheduleReconnect(reconnectDelay());
    }
    function values() { return { accessToken: $('accessToken').value, language }; }
    $('save').addEventListener('click', () => vscode.postMessage({ type: 'save', value: values() }));
    $('toggleService').addEventListener('click', () => vscode.postMessage({ type: 'toggleService', language }));
    $('reloadPage').addEventListener('click', () => vscode.postMessage({ type: 'reloadPage', language }));
    $('revealToken').addEventListener('click', () => { $('accessToken').type = $('accessToken').type === 'password' ? 'text' : 'password'; });
    $('refreshAccount').addEventListener('click', refreshAccount);
    $('unbindMachine').addEventListener('click', () => vscode.postMessage({ type: 'unbindMachine', language }));
    $('retry').addEventListener('click', () => requestReconnect(false));
    $('language').addEventListener('click', () => {
      language = language === 'en' ? 'zh' : 'en';
      if (typeof vscode.setState === 'function') vscode.setState({ ...(savedWebviewState || {}), language });
      applyLanguage();
      vscode.postMessage({ type: 'language', language });
    });
    window.addEventListener('message', (event) => { const message = event.data; if (message.type === 'state') apply(message.value); if (message.type === 'tokenStatus') setTokenStatus(message.value); if (message.type === 'notice') show(message.text, message.error); if (message.type === 'connection') connection(message.connected, message.error); if (message.type === 'saving') { $('save').disabled = message.value; if (message.value) $('save').textContent = t('saving'); } if (message.type === 'serviceAction') { $('toggleService').disabled = message.value; $('reloadPage').disabled = message.value; if (message.value) $('toggleService').textContent = t('working'); } });
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (!panelVisible() || latestConnection.connected) return;
        requestReconnect(false);
      });
    }
    applyLanguage();
    vscode.postMessage({ type: 'ready', language });
    // Nothing has answered yet, so the initial mask needs its own deadline:
    // a lost handshake used to strand this view on "connecting" forever.
    scheduleReconnect(HOST_REPLY_TIMEOUT_MS);
    setInterval(() => {
      if (latestConnection.connected) vscode.postMessage({ type: 'refreshAccount', automatic: true, language });
    }, 30000);
  </script>
</body>
</html>`;
}

function sendPanelState(message) {
  for (const webview of panelWebviews()) {
    webview.postMessage({ type: 'state', value: panelState() });
    if (message) webview.postMessage({ type: 'notice', ...message });
  }
}

async function savePanelConfiguration(value) {
  if (configurationSaving) throw new Error('正在验证 Token，请稍候。');
  configurationSaving = true;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = undefined;
  const views = panelWebviews();
  for (const view of views) view.postMessage({ type: 'saving', value: true });
  try {
    await applyPanelConfiguration(value);
  } finally {
    configurationSaving = false;
    for (const view of views) view.postMessage({ type: 'saving', value: false });
  }
}

async function applyPanelConfiguration(value) {
  const remaining = loginCooldownRemaining();
  if (remaining > 0) throw authenticationError(`无效 Token 尝试次数过多，请在 ${Math.ceil(remaining / 60000)} 分钟后重试。`);
  const candidateToken = String(value.accessToken || '').trim() || accessToken;
  // No settings, credentials, running proxy or reload may change before the
  // backend confirms this exact candidate against its database.
  let validated;
  try {
    validated = await queryBackendConfiguration(BACKEND_ENDPOINT, candidateToken, true);
  } catch (error) {
    if (error.invalidToken || error.rateLimited) await recordInvalidToken();
    throw error;
  }
  await clearInvalidTokenAttempts();
  await extensionContext.secrets.store(ACCESS_TOKEN_SECRET, candidateToken);
  accessToken = candidateToken;
  await rememberVerifiedToken(candidateToken);
  backendConfiguration = validated;
  machineIdentityNeedsMigration = false;
  tokenStatusCheckedAt = Date.now();
  backendAuthenticated = true;
  loginMessage = '';
  sendConnectionState(true);
  await extensionContext.globalState.update('manualStop', false);
  await stopProxy({ restore: false, showMessage: false });
  await startProxy(false);
  if (!backendReady) throw new Error('Token 已验证，但服务连接未就绪；请重试，不会自动重载。');
}

function bindControlWebview(webview) {
  webview.options = { enableScripts: true };
  webview.html = controlPanelHtml(webview);
  return webview.onDidReceiveMessage(async (message) => {
    try {
      if (message.language || message.value?.language) {
        await setInterfaceLanguage(message.language || message.value.language);
      }
      if (message.type === 'language') return;
      if (message.type === 'ready' || message.type === 'retry') {
        // An explicit click restarts the backoff; the panel's own timer keeps
        // the schedule it already negotiated with the watchdog.
        if (!message.automatic) connectionRetryStep = 0;
        try {
          const tokenChanged = await syncAccessTokenFromStorage();
          await probeBackendConnection();
          if (accessToken && tokenChanged && !server && !usingSharedProxy && await proxyHealth(LOCAL_PORT)) {
            await useSharedProxy(LOCAL_PORT, false);
          } else if (accessToken) await refreshBackendConfiguration();
          else invalidateBackendAuthentication('服务器已连接，请输入访问 Token 登录。');
          sendPanelState();
        } catch (error) {
          // The panel already contains the normal sign-in instruction for an
          // unverified residual value; do not add a red error banner to a
          // first-run experience.
          if (error.invalidToken && !tokenWasPreviouslyVerified(accessToken)) sendPanelState();
          else sendPanelState({ text: error.message, error: true });
        }
        return;
      }
      if (message.type === 'refreshAccount') {
        const tokenChanged = await syncAccessTokenFromStorage();
        if (accessToken) {
          const tokenKey = crypto.createHash('sha256').update(accessToken).digest('hex');
          const now = Date.now();
          const lastRefresh = accountRefreshTimes.get(tokenKey) || 0;
          if (now - lastRefresh < ACCOUNT_REFRESH_COOLDOWN_MS) return;
          accountRefreshTimes.set(tokenKey, now);
          try {
            if (tokenChanged && !server && !usingSharedProxy && await proxyHealth(LOCAL_PORT)) {
              await useSharedProxy(LOCAL_PORT, false);
            } else {
              await refreshBackendConfiguration();
            }
            sendPanelState();
          } catch (error) {
            // Manual refreshes use icon state only; a 429 must not log the user out
            // or surface a transient rate-limit message in the panel.
            log('刷新 Token 信息失败', error.message);
          }
        }
        return;
      }
      if (message.type === 'toggleService') {
        const views = panelWebviews();
        for (const view of views) view.postMessage({ type: 'serviceAction', value: true });
        try {
          if (server || usingSharedProxy) {
            await stopProxy({ restore: false, showMessage: false, manual: true, force: true });
            await restoreOfficial(false);
            sendPanelState({ text: '已恢复初始设置，3 秒后刷新窗口。' });
          } else {
            if (!accessToken || !backendAuthenticated) throw new Error('请先使用有效 Token 登录。');
            await startProxy(false);
            sendPanelState({ text: '服务已启动，3 秒后刷新窗口。' });
          }
          scheduleWindowReload(false);
        } finally {
          for (const view of views) view.postMessage({ type: 'serviceAction', value: false });
          sendPanelState();
        }
        return;
      }
      if (message.type === 'reloadPage') {
        sendPanelState({ text: '3 秒后刷新窗口。' });
        scheduleWindowReload(false);
        return;
      }
      if (message.type === 'save') {
        await savePanelConfiguration(message.value || {});
        sendPanelState({ text: '配置已保存；3 秒后自动重载窗口以更新模型列表。' });
        scheduleWindowReload();
        return;
      }
      if (message.type === 'unbindMachine') {
        const response = await fetch(backendApi('/api/relay/session/machine'), {
          method: 'DELETE', headers: backendHeaders({ accept: 'application/json' }),
        });
        if (!response.ok) {
          let detail = '机器码解绑失败';
          try { detail = (await response.json()).message || detail; } catch { /* use fallback */ }
          throw new Error(detail);
        }
        await extensionContext.secrets.delete(ACCESS_TOKEN_SECRET);
        await forgetVerifiedToken();
        if (server) await stopProxy({ restore: false, showMessage: false, force: true });
        else if (usingSharedProxy || await proxyHealth(LOCAL_PORT)) {
          await requestProxyShutdown(LOCAL_PORT);
          await waitForProxyShutdown(LOCAL_PORT);
          clearTakeoverTimer();
          usingSharedProxy = false;
        }
        await restoreOfficial(false);
        accessToken = '';
        invalidateBackendAuthentication('当前设备已解绑，请使用 Token 重新登录。');
        sendPanelState({ text: '当前设备已成功解绑。' });
        return;
      }
    } catch (error) {
      log('控制面板操作失败', error.message);
      sendPanelState({ text: error.message, error: true });
    }
  }, undefined, extensionContext.subscriptions);
}

function openControlPanel() {
  if (controlPanel) {
    controlPanel.reveal(vscode.ViewColumn.One);
    sendPanelState();
    return;
  }
  const panel = vscode.window.createWebviewPanel('kiroRelayRouter.controlPanel', 'Relayrouter', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  controlPanel = panel;
  controlPanelBinding?.dispose?.();
  controlPanelBinding = bindControlWebview(panel.webview);
  panel.onDidDispose(() => {
    // Only the live view may clear the shared reference: a late dispose of a
    // replaced view used to hide the current panel from every state update.
    if (controlPanel !== panel) return;
    controlPanelBinding?.dispose?.();
    controlPanelBinding = undefined;
    controlPanel = undefined;
  }, undefined, extensionContext.subscriptions);
}

const controlViewProvider = {
  resolveWebviewView(webviewView) {
    // A sidebar view can be resolved again after being hidden. Release the
    // previous binding so one message is not handled several times.
    controlViewBinding?.dispose?.();
    controlView = webviewView;
    controlViewBinding = bindControlWebview(webviewView.webview);
    webviewView.onDidDispose(() => {
      if (controlView !== webviewView) return;
      controlViewBinding?.dispose?.();
      controlViewBinding = undefined;
      controlView = undefined;
    });
  },
};

async function activate(context) {
  extensionContext = context;
  await initializeInterfaceLanguage(context);
  await initializeClientMachineIdentity(context);
  accessToken = await context.secrets.get(ACCESS_TOKEN_SECRET) || '';
  verifiedTokenFingerprint = String(context.globalState.get(VERIFIED_TOKEN_FINGERPRINT_STATE_KEY, '') || '');
  output = vscode.window.createOutputChannel('Kiro RelayRouter');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'kiroRelayRouter.openControlPanel';
  status.text = '$(loading~spin) Kiro RelayRouter';
  status.show();
  context.subscriptions.push(
    output,
    status,
    // Keeping the sidebar view alive while hidden preserves its reconnect
    // backoff instead of restarting the handshake on every panel switch.
    vscode.window.registerWebviewViewProvider('kiroRelayRouter.controlView', controlViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('kiroRelayRouter.openControlPanel', openControlPanel),
    vscode.commands.registerCommand('kiroRelayRouter.configure', async () => {
      try { await configure(); }
      catch (error) { vscode.window.showErrorMessage(error.message); }
    }),
  );
  startModelPermissionWatcher();
  if (!accessToken) {
    // A previous logged-in window may have exited without restoring Kiro's
    // endpoint settings. Leaving 127.0.0.1:19801 behind makes Kiro Agent show
    // an ECONNREFUSED account-usage notification even though logged-out is a
    // perfectly normal state.
    if (await proxyHealth(LOCAL_PORT)) {
      await requestProxyShutdown(LOCAL_PORT);
      await waitForProxyShutdown(LOCAL_PORT);
    }
    const restoredEndpoints = await restoreOfficial(false);
    status.text = '$(circle-slash) Kiro RelayRouter';
    status.tooltip = '请先使用访问 Token 登录';
    status.backgroundColor = undefined;
    invalidateBackendAuthentication('请输入访问 Token 登录。');
    if (restoredEndpoints) {
      log('检测到未登录状态下的残留本地 endpoint，已恢复官方服务并重载当前窗口');
      setTimeout(() => void vscode.commands.executeCommand('workbench.action.reloadWindow'), 0);
    }
  } else if (context.globalState.get('manualStop', false)) {
    try {
      await refreshBackendConfiguration();
      await restoreOfficial(false);
      status.text = '$(circle-slash) Kiro RelayRouter';
      status.tooltip = '服务已恢复初始设置；点击面板可重新启动';
      status.backgroundColor = undefined;
      sendPanelState();
    } catch (error) {
      // An outage already owns its own retry schedule and keeps the session.
      if (!error.connectivity) invalidateBackendAuthentication(error.message);
    }
  } else {
    try { await startProxy(false); }
    catch (error) { showStartError(error); }
  }
}

function showStartError(error) {
  log('启动失败', error.message);
  if (error.invalidToken && !tokenWasPreviouslyVerified(accessToken)) {
    status.text = '$(circle-slash) Kiro RelayRouter';
    status.tooltip = '请先使用访问 Token 登录';
    status.backgroundColor = undefined;
    return;
  }
  status.text = '$(error) Kiro RelayRouter';
  status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  vscode.window.showErrorMessage(`Kiro RelayRouter 启动失败：${error.message}`);
}

async function deactivate() {
  clearTakeoverTimer();
  clearConnectionWatchdog();
  if (reloadTimer) clearTimeout(reloadTimer);
  if (balanceRefreshTimer) clearTimeout(balanceRefreshTimer);
  if (modelPermissionTimer) clearInterval(modelPermissionTimer);
  usingSharedProxy = false;
  if (server) {
    const active = server;
    server = undefined;
    await new Promise((resolve) => active.close(resolve));
  }
}

module.exports = { activate, deactivate };
