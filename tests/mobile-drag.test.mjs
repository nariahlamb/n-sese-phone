import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build, transform } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import jquery from 'jquery';

const root = new URL('..', import.meta.url).pathname;
const pointer = (win, el, type, x, y) => {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1 });
  el.dispatchEvent(event);
};

test('小手机真实拖拽绑定：跟手、右缘吸附与旧格式存档', async () => {
  const original = await readFile(new URL('../src/UBS_phone/renderers/phone-ui.ts', import.meta.url), 'utf8');
  const needle = 'function readPos(key: string)';
  assert(original.includes(needle));
  const probeSource = original.replace(needle, 'export { bindDrag, readPos };\n' + needle);
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: probeSource, resolveDir: root + 'src/UBS_phone/renderers', loader: 'ts', sourcefile: 'phone-drag-test.ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
  });
  const dom = new JSDOM('<div id="ubp-root"><div id="ball"></div></div>', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  try {
    Object.defineProperty(win, 'innerWidth', { value: 360, configurable: true });
    Object.defineProperty(win, 'innerHeight', { value: 792, configurable: true });
    win.__ubp_phone_style = 'minimal';
    // 非生产接口：同一份源码经测试专用打包暴露私有函数；不在宿主直接执行模块。
    const source = result.outputFiles[0].text.replace(/export\s*\{[^}]*\};?\s*$/s, 'globalThis.__testDrag = { bindDrag, readPos };');
    assert(!source.includes('bindDrag: void 0'), '测试探针不得把私有函数打包成 undefined');
    win.eval(source);
    const ball = win.document.getElementById('ball');
    ball.setPointerCapture = () => {};
    let left = 100, top = 100, clicked = 0;
    ball.getBoundingClientRect = () => {
      left = Number.parseFloat(ball.style.left) || left;
      top = Number.parseFloat(ball.style.top) || top;
      return { left, top, width: 48, height: 48, right: left + 48, bottom: top + 48 };
    };
    ball.addEventListener('click', () => clicked++);
    win.__testDrag.bindDrag(ball, ball, 'ubp_ball_pos_v2', () => 48, () => 48, { snapBall: true });
    pointer(win, ball, 'pointerdown', 120, 120);
    pointer(win, ball, 'pointermove', 180, 200);
    assert.equal(ball.style.left, '160px');
    assert.equal(ball.style.top, '180px');
    assert(ball.classList.contains('ubp-dragging'));
    pointer(win, ball, 'pointermove', 300, 320);
    pointer(win, ball, 'pointerup', 300, 320);
    assert.equal(ball.style.left, '312px');
    assert.equal(ball.style.top, '300px');
    assert(ball.classList.contains('ubp-dock-right'));
    assert.equal(ball.classList.contains('ubp-dragging'), false);
    assert.equal(JSON.stringify(win.__testDrag.readPos('ubp_ball_pos_v2')), '{"left":312,"top":300}');
    ball.click();
    assert.equal(clicked, 1, '这里只测拖拽函数，生产 click 守卫由下方真实挂载用例验证');
  } finally { win.close(); }
});

test('手机挂载：环境标记、主题 RGBA、48px 外框与静态角标；自定义皮肤保持收口', async () => {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', error => {
    if (!String(error.message).includes('Could not parse CSS stylesheet')) errors.push(error.message);
  });
  vc.on('error', (...args) => errors.push(args.map(value => value?.message || String(value)).join(' ').slice(0, 600)));
  const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="extensions_settings2"></div><div id="sheld"><div id="chat"></div></div><form id="send_form"></form></body>', {
    url: 'http://localhost:8000', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
  });
  const win = dom.window;
  const events = new Map();
  const eventSource = {
    on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    off(name, fn) { events.get(name)?.delete(fn); },
    once(name, fn) { const cb = (...args) => { this.off(name, cb); fn(...args); }; this.on(name, cb); },
    async emit(name, ...args) { for (const fn of events.get(name) || []) await fn(...args); },
  };
  const context = {
    chat: [], chatId: '', characterId: undefined, groupId: null, characters: [], chatMetadata: {},
    extensionSettings: {}, eventSource, eventTypes: new Proxy({}, { get: (_, name) => name }),
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    saveSettingsDebounced() {}, async saveMetadata() {}, name1: 'User', name2: '',
  };
  let aiRequests = 0;
  const files = new Map();
  Object.defineProperty(win, 'innerWidth', { value: 360, configurable: true });
  Object.defineProperty(win.navigator, 'maxTouchPoints', { value: 5, configurable: true });
  win.SillyTavern = { getContext: () => context };
  win.$ = win.jQuery = jquery(win);
  win.TextEncoder = TextEncoder;
  win.TextDecoder = TextDecoder;
  win.structuredClone = structuredClone;
  win.toastr = Object.fromEntries(['info', 'warning', 'error', 'success', 'clear', 'remove'].map(name => [name, () => win.$('<div>')]));
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.TavernHelper = {
    generateRaw: async () => { aiRequests++; throw new Error('模拟环境禁止 AI 请求'); },
    generate: async () => { aiRequests++; throw new Error('模拟环境禁止 AI 请求'); },
    injectPrompts() {}, uninjectPrompts() {}, stopGenerationById() {},
    getWorldbook: async () => [], replaceWorldbook: async () => {}, getWorldbookNames: () => [],
    getCharWorldbookNames: () => ({ primary: null, additional: [] }),
    getTavernRegexes: () => [], replaceTavernRegexes: async () => {},
    getVariables: () => ({}), getAllVariables: () => ({}),
    getCurrentCharacterName: () => '', getLastMessageId: () => -1,
    getChatMessages: () => [], substitudeMacros: value => value,
  };
  win.fetch = async (input, options = {}) => {
    const url = new URL(String(input), win.location.href);
    let status = 200, data = {};
    if (url.pathname.startsWith('/user/files/')) {
      const stored = files.get(url.pathname);
      if (stored === undefined) status = 404; else data = stored;
    } else if (url.pathname === '/api/files/upload') {
      const payload = JSON.parse(options.body);
      const file = `/user/files/${payload.name}`;
      files.set(file, JSON.parse(Buffer.from(payload.data, 'base64').toString('utf8')));
      data = { path: file };
    } else if (url.pathname === '/api/files/verify') {
      data = Object.fromEntries(JSON.parse(options.body).urls.map(file => [file, files.has(file)]));
    } else status = 404;
    return { ok: status === 200, status, statusText: status === 404 ? 'Not Found' : 'OK', json: async () => data, text: async () => JSON.stringify(data) };
  };
  try {
    const bundle = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
    const { code } = await transform(bundle, { format: 'iife', loader: 'js', target: 'es2022' });
    win.eval(code);
    await new Promise(resolve => setTimeout(resolve, 500));
    const shadow = win.document.getElementById('ubp-root')?.shadowRoot;
    assert(shadow);
    const scope = shadow.querySelector('.ubp-scope');
    const ball = shadow.querySelector('.ubp-ball');
    assert(scope.classList.contains('ubp-mobile-lite'));
    assert.equal(win.document.documentElement.getAttribute('data-ubp-mobile-lite'), '1');
    assert.equal(ball.style.getPropertyValue('--ubp-ball-rgb'), '16,16,19');
    assert(shadow.querySelector('.ubp-ball-face'));
    for (const cls of ['ubp-ball-dot', 'ubp-ball-ai', 'ubp-ball-game']) assert(shadow.querySelector('.' + cls));
    assert.equal(ball.getAttribute('role'), 'button');
    // 真实 mountPhone 绑定的球：拖到右缘后仍存旧格式，残留 click 不会打开手机。
    Object.defineProperty(ball, 'offsetWidth', { value: 48, configurable: true });
    Object.defineProperty(ball, 'offsetHeight', { value: 48, configurable: true });
    ball.getBoundingClientRect = () => {
      const left = Number.parseFloat(ball.style.left) || 8;
      const top = Number.parseFloat(ball.style.top) || 396;
      return { left, top, width: 48, height: 48, right: left + 48, bottom: top + 48 };
    };
    ball.setPointerCapture = () => {};
    pointer(win, ball, 'pointerdown', 30, 410);
    pointer(win, ball, 'pointermove', 300, 510);
    pointer(win, ball, 'pointerup', 300, 510);
    assert.equal(ball.style.left, '312px');
    assert.equal(JSON.parse(win.localStorage.getItem('ubp_ball_pos_v2')).left, 312);
    assert(ball.classList.contains('ubp-dock-right'));
    ball.click();
    assert.equal(shadow.querySelector('.ubp-phone').classList.contains('ubp-open'), false, '拖后残留 click 不得误展开小手机');
    assert.equal(win.__ubp_booted, true);
    assert.equal(aiRequests, 0);
    assert.deepEqual(errors, []);
  } finally { await win.__SL_DISPOSE__?.(); win.close(); }
});
