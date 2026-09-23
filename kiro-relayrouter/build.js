'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const sourceDir = path.join(root, 'src');
const outputDir = path.join(root, 'dist');

// 构建期注入后端地址，优先级：环境变量 > 未跟踪的 .endpoint.local > 源码默认值。
// src/extension.js 里只保留 http://127.0.0.1:8080，保证仓库不含真实服务地址。
// Build-time backend injection. Precedence: env var > untracked .endpoint.local >
// the localhost default kept in source, so the repository stays free of real hosts.
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8080';
const LOCAL_ENDPOINT_FILE = path.join(root, '.endpoint.local');

function resolveEndpoint() {
  const fromEnv = (process.env.RELAYROUTER_BACKEND_ENDPOINT || '').trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync(LOCAL_ENDPOINT_FILE)) {
    const fromFile = fs.readFileSync(LOCAL_ENDPOINT_FILE, 'utf8').trim();
    if (fromFile) return fromFile;
  }
  return DEFAULT_ENDPOINT;
}

function assertHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid backend endpoint: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Backend endpoint must use http/https: ${value}`);
  }
  // 去掉结尾斜杠，扩展内部按 `${BACKEND_ENDPOINT}/api/...` 拼接。
  return value.replace(/\/+$/, '');
}

const endpoint = assertHttpUrl(resolveEndpoint());

fs.mkdirSync(outputDir, { recursive: true });

for (const file of ['extension.js']) {
  const source = fs.readFileSync(path.join(sourceDir, file), 'utf8');
  const marker = `const BACKEND_ENDPOINT = '${DEFAULT_ENDPOINT}';`;
  if (!source.includes(marker)) {
    throw new Error(`Cannot locate the BACKEND_ENDPOINT constant in src/${file}`);
  }
  const output = source.replace(marker, `const BACKEND_ENDPOINT = ${JSON.stringify(endpoint)};`);
  fs.writeFileSync(path.join(outputDir, file), output);
}

console.log(`Built transparent proxy extension from src/ (backend: ${endpoint})`);
