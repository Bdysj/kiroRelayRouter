'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
const properties = manifest.contributes.configuration?.properties || {};

assert(!properties['kiroRelayRouter.backendUrl']);
assert(!properties['kiroRelayRouter.enabled']);
assert.deepStrictEqual(manifest.activationEvents, ['*']);
assert.equal(manifest.icon, 'media/relayrouter-brand.png');
assert(!properties['kiroRelayRouter.baseUrl']);
assert(!properties['kiroRelayRouter.models']);
assert(!properties['kiroRelayRouter.model']);
assert(!properties['kiroRelayRouter.debug']);
assert(source.includes('/api/relay/config'));
assert(source.includes('/api/relay/kiro'));
assert(source.includes("lang=${encodeURIComponent(interfaceLanguage)}"));
assert(source.includes("message.type === 'language'"));
assert(source.includes('.hero { grid-template-columns: 32px minmax(0, 1fr) auto; }'));
assert(source.includes('.hero-actions { grid-column: 3; align-self: start; }'));
assert(source.includes("const BACKEND_ENDPOINT = 'http://127.0.0.1:8080';"));
assert(!source.includes("get('backendUrl'"));
assert(!source.includes('id="backendUrl"'));
assert(!source.includes('configureBackendAddress'));
assert(!source.includes("require('./protocol')"));
assert(source.includes('id="connectionMask"'));
assert(source.includes("message.type === 'ready' || message.type === 'retry'"));
assert(!source.includes('id="debug"'));
assert(source.includes('id="modelCount"'));
assert(source.includes("modelCount + t('modelUnit')"));
assert(source.includes('<h1>Relayrouter</h1>'));
assert(source.includes('Let more powerful models empower Kiro-compatible development workflows.'));
assert(source.includes('连接更强大的模型，拓展 Kiro 开发体验。'));
assert(!source.includes('id="enabled"'));
assert(!source.includes('id="toggle"'));
assert(source.includes('modelCount: Array.isArray(backendConfiguration.models)'));
assert(!source.includes('id="modelNames"'));
assert(!source.includes('后端中转配置'));
assert(source.includes('writeWithBackpressure'));
assert(source.includes("req.once('aborted', abort)"));
assert(source.indexOf('server.listen(port') < source.indexOf('await finishProxyStartup(showMessage)'));
// Reconnecting is owned by one watchdog with a bounded backoff, and it must
// also cover the window that only reuses another window's proxy.
assert(!source.includes('scheduleBackendRetry'));
assert(source.includes('const CONNECTION_RETRY_STEPS_MS = [3_000, 6_000, 12_000, 30_000];'));
assert(source.includes('function scheduleConnectionWatchdog()'));
assert(source.includes('if ((server || usingSharedProxy) && !backendReady)'));
// A masked panel must be able to recover on its own.
assert(source.includes("vscode.postMessage({ type: 'retry', language, automatic: !!automatic })"));
assert(source.includes('{ webviewOptions: { retainContextWhenHidden: true } }'));
// A dropped connection is never reported as a Token failure.
assert(source.includes('function connectivityError(message)'));
assert(source.includes('if (error.connectivity) {'));
assert(!source.includes('连接恢复后请重新验证 Token'));

console.log('transparent proxy contract tests passed');
