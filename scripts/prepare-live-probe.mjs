// Local-only acceptance bundle. Config contains synthetic fixture metadata, never credentials.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.notEqual(config.expectedCaller, config.targetOwner);
assert.equal(config.target.kind, 'terms');
assert.equal(config.target.id, 'term-test');
assert.ok(config.target.payload.name.includes('合成验收') && config.target.payload.name.includes('测试专用'),
  'Only the dedicated synthetic acceptance term may be targeted.');
assert.ok(Number.isSafeInteger(config.target.version) && config.target.version > 0);
await build({ configFile: false, root: process.cwd(), envPrefix: 'PUBLIC_',
  define: { __PROBE_CONFIG__: JSON.stringify(config) },
  build: { outDir: 'dist/desk/acceptance/assets', emptyOutDir: true,
    lib: { entry: resolve('scripts/browser-live-probe.ts'), formats: ['es'], fileName: 'probe' } } });
await mkdir('dist/desk/acceptance', { recursive: true });
await writeFile('dist/desk/acceptance/index.html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>真实 API 权限验收</title><style>body{font:16px system-ui;max-width:60rem;margin:2rem auto;padding:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{font:inherit;padding:.6rem}</style><h1>真实 API 权限验收（本机专用）</h1><p id="account">正在确认账号…</p><p>此页仅针对专用测试账号的合成学期。检查结果不包含密码、令牌或学习记录内容。</p><p><a href="/desk/data/">返回数据中心</a></p><button id="run" disabled>运行权限检查</button><p id="summary" role="status"></p><pre id="results"></pre><script type="module" src="./assets/probe.js"></script></html>`);
console.log('Local-only probe ready at /desk/acceptance/. A normal Astro build removes this page.');
