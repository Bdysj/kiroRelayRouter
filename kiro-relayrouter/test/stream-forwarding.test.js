'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');

async function main() {
  let releaseTail;
  const tailReady = new Promise((resolve) => { releaseTail = resolve; });
  const deadlineTimers = new Set();
  const logs = [];
  let requestId;
  let requestUrl;
  const head = Buffer.from([0, 1, 2, 255, 128]);
  const tail = Buffer.from([42, 0, 254]);
  const backend = http.createServer(async (req, res) => {
    requestId = req.headers['x-relay-request-id'];
    requestUrl = req.url;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    res.write(head);
    await tailReady;
    res.end(tail);
  });
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await listen(backend);
  const backendUrl = `http://127.0.0.1:${backend.address().port}`;
  const context = vm.createContext({
    require: (name) => name === 'vscode' ? {
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    } : require(name),
    module: { exports: {} }, Buffer, performance, fetch, AbortController, AbortSignal,
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      if (ms === 600000) deadlineTimers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => { deadlineTimers.delete(timer); clearTimeout(timer); },
    testLog: (line) => logs.push(line),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8')
    // Point the build-time constant at this test's stub backend, whatever the
    // packaged default happens to be.
    .replace(/^const BACKEND_ENDPOINT = '[^']*';$/m, `const BACKEND_ENDPOINT = '${backendUrl}';`);
  vm.runInContext(source + `
    output = { appendLine: testLog };
    module.exports.forward = forwardToBackend;
    module.exports.initializeLanguage = initializeInterfaceLanguage;
  `, context);
  const languageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'relayrouter-language-'));
  await context.module.exports.initializeLanguage({
    globalStorageUri: { fsPath: languageDirectory },
    globalState: { get: () => 'zh', update: async () => {} },
  });
  // Simulate another Kiro window switching the shared UI to English while
  // this extension host remains the owner of the local proxy server.
  fs.writeFileSync(path.join(languageDirectory, 'interface-language'), 'en');
  const proxy = http.createServer((req, res) => {
    req.resume();
    void context.module.exports.forward(req, res, { conversationState: {} }).catch((error) => res.destroy(error));
  });
  await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}`, { signal: AbortSignal.timeout(3000) });
    const reader = response.body.getReader();
    assert.deepEqual(Buffer.from((await reader.read()).value), head);
    assert.equal(deadlineTimers.size, 1, 'deadline must survive response headers');
    assert.match(requestId, /^[a-f0-9-]{36}$/);
    assert.equal(requestUrl, '/api/relay/kiro?lang=en',
      'the proxy owner must read the latest language selected in another window');
    assert(!logs.some((line) => line.includes('后端流已完整结束')));
    releaseTail();
    const chunks = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    assert.deepEqual(Buffer.concat(chunks), tail);
    assert.equal(deadlineTimers.size, 0);
    assert(logs.some((line) => line.includes('后端流已完整结束') && line.includes(requestId)));
    console.log('stream bytes, immediate forwarding, deadline lifecycle and request correlation passed');
  } finally {
    releaseTail();
    proxy.closeAllConnections();
    backend.closeAllConnections();
    proxy.close();
    backend.close();
    fs.rmSync(languageDirectory, { recursive: true, force: true });
    for (const timer of deadlineTimers) clearTimeout(timer);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
