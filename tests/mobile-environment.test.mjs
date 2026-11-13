import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

async function loadModule(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}
const { isMobileLiteEnvironment, cssColorChannels } = await loadModule('../src/unified-statusbar/core/mobile-environment.ts');
const { snapFloatingToEdge, floatingEdgeAt } = await loadModule('../src/unified-statusbar/core/floating-dock.ts');

function fakeWindow({ width = 360, touch = 0, tt = false, hostname = 'localhost', coarse = false, fine = false, ua = '' } = {}) {
  return {
    innerWidth: width,
    navigator: { maxTouchPoints: touch, userAgent: ua },
    location: { hostname },
    matchMedia: query => ({
      matches: (query === '(pointer: coarse)' && coarse) || (query === '(any-pointer: fine)' && fine),
    }),
    ...(tt ? { __TAURITAVERN__: {} } : {}),
  };
}

test('手机轻量判定：窄屏、移动 UA 或纯粗指针命中，桌面端 TT / 分屏有鼠标不误判', () => {
  assert.equal(isMobileLiteEnvironment(fakeWindow({ width: 1280 })), false);
  assert.equal(isMobileLiteEnvironment(fakeWindow({ width: 1280, touch: 5 })), false);
  assert.equal(isMobileLiteEnvironment(fakeWindow({ width: 1280, tt: true, hostname: 'tauri.localhost' })), false);
  assert.equal(isMobileLiteEnvironment(fakeWindow({ width: 1280, coarse: true, fine: true })), false);
  assert.equal(isMobileLiteEnvironment(fakeWindow({ width: 700, fine: true })), false);
  assert.equal(isMobileLiteEnvironment(fakeWindow({ width: 600 })), true);
  assert.equal(isMobileLiteEnvironment(fakeWindow({ width: 768 })), true);
  assert.equal(isMobileLiteEnvironment(fakeWindow({ width: 1280, ua: 'Mozilla/5.0 (Linux; Android 14)' })), true);
  assert.equal(isMobileLiteEnvironment(fakeWindow({ width: 1280, coarse: true, fine: false })), true);
});

test('主题色只解析 RGB 通道，半透明由调用方指定', () => {
  assert.equal(cssColorChannels('#b9586c'), '185,88,108');
  assert.equal(cssColorChannels('#3D335A'), '61,51,90');
  assert.equal(cssColorChannels('rgba(166,173,200,1)'), '166,173,200');
  assert.equal(cssColorChannels('color-mix(in srgb, red, blue)'), null);
});

test('吸附计算：48px 内贴左右边，顶部钳制，旧坐标可识别', () => {
  assert.deepEqual(snapFloatingToEdge(30, -5, 360, 792, 48, 48), { left: 0, top: 0, edge: 'left' });
  assert.deepEqual(snapFloatingToEdge(300, 800, 360, 792, 48, 48), { left: 312, top: 744, edge: 'right' });
  assert.deepEqual(snapFloatingToEdge(100, 200, 360, 792, 48, 48), { left: 100, top: 200, edge: null });
  assert.equal(floatingEdgeAt(0, 48, 360), 'left');
  assert.equal(floatingEdgeAt(312, 48, 360), 'right');
  assert.equal(floatingEdgeAt(300, 48, 360), null);
});
