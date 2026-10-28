import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await mkdir(path.join(root, 'dist'), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: [`src/${pkg.sourceModule}/index.ts`],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  charset: 'utf8',
  minify: true,
  legalComments: 'eof',
  logLevel: 'info',
});
if (pkg.sourceModule === 'unified-statusbar') {
  const html = await readFile(path.join(root, 'src/unified-statusbar/index.html'), 'utf8');
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (!body || !body.includes('id="ac-content"')) throw new Error('状态栏 HTML 模板缺失');
  await writeFile(path.join(root, 'dist/statusbar.html'), body.trim() + '\n');
}
