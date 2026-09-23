'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function main() {
  const image = { format: 'png', source: { bytes: Buffer.from('test-image-bytes').toString('base64') } };
  const document = { filename: 'test.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF').toString('base64') };
  const body = { conversationState: {
    history: [{ userInputMessage: { content: '上一张', images: [image] } }],
    currentMessage: { userInputMessage: { content: '读出图片和PDF的内容', images: [image], documents: [document], userInputMessageContext: { images: [] } } },
  } };
  let received;
  const logs = [];
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    res.end('ok');
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendUrl = `http://127.0.0.1:${backend.address().port}`;
  const context = vm.createContext({
    require: (name) => name === 'vscode' ? {
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    } : require(name),
    module: { exports: {} }, Buffer, performance, fetch, AbortController, setTimeout, clearTimeout,
    logLine: (line) => logs.push(line),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8')
    // Point the build-time constant at this test's stub backend, whatever the
    // packaged default happens to be.
    .replace(/^const BACKEND_ENDPOINT = '[^']*';$/m, `const BACKEND_ENDPOINT = '${backendUrl}';`);
  vm.runInContext(source +
    '\noutput = { appendLine: logLine }; module.exports = { createProxyServer };', context);
  const proxy = context.module.exports.createProxyServer();
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
    });
    assert.equal(await response.text(), 'ok');
    assert.deepEqual(received, body, 'actual proxy request path preserves current and historical image bytes and text');
    assert(logs.some((line) => line.includes('"images":2')));
    assert(logs.some((line) => line.includes('"documents":1')));
    assert(!logs.some((line) => line.includes(image.source.bytes) || line.includes(document.data) || line.includes('读出图片')));
    console.log('rich content HTTP forwarding preserves payload; logs contain counts only');
  } finally {
    backend.closeAllConnections();
    backend.close();
    await new Promise((resolve) => proxy.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
