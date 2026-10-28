import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const manifest = await readJson('manifest.json');
const pkg = await readJson('package.json');
assert.equal(manifest.version, pkg.version);
assert.equal(new URL(manifest.homePage).hostname, 'github.com');
assert.equal(new URL(manifest.homePage).pathname.split('/').filter(Boolean).at(-1), pkg.name);
assert.equal(manifest.js, 'index.js');
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
for (const name of ['index.js', 'runtime/extension.js', 'runtime/config.js', 'dist/index.js', 'SOURCE_NOTICE.md', 'README.md']) {
  assert((await stat(path.join(root, name))).isFile(), `${name} 缺失`);
}
if (pkg.sourceModule === 'unified-statusbar') {
  assert((await readFile(path.join(root, 'dist/statusbar.html'), 'utf8')).includes('id="ac-content"'));
}
// 验证浏览器入口的所有本地静态依赖都能解析；不执行任何酒馆业务代码。
await build({ absWorkingDir: root, entryPoints: ['index.js'], bundle: true, write: false, platform: 'browser', format: 'esm', logLevel: 'silent' });
const dist = await readFile(path.join(root, 'dist/index.js'), 'utf8');
assert(dist.length > 1000, '构建产物为空');
assert(!dist.includes('D:\\酒馆知识库'), '产物包含本机绝对路径');
const receipt = await readJson('source-files.sha256.json');
for (const [name, expected] of Object.entries(receipt.files)) {
  assert(name.startsWith('src/') && !name.includes('..'), '源码校验路径不安全');
  const actual = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
  assert.equal(actual, expected, `原始源码被修改：${name}`);
}
console.log(`${pkg.name}: 清单、入口依赖、构建产物检查通过（不代表真机验收）。`);
