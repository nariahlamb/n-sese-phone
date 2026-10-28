import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import jquery from 'jquery';
import { JSDOM, VirtualConsole } from 'jsdom';
import { config } from '../runtime/config.js';

test('真实构建产物在无聊天的模拟酒馆中启动，不发送 AI 请求', async () => {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', error => {
    // jsdom 不支持完整 CSS；这不属于 JS 启动异常，也不能据此判断视觉正确。
    if (!String(error.message).includes('Could not parse CSS stylesheet')) errors.push(error.message);
  });
  vc.on('error', (...args) => errors.push(args.map(value => value?.message || String(value)).join(' ').slice(0, 600)));
  const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="extensions_settings2"></div><div id="sheld"><div id="chat"></div></div><form id="send_form"></form></body>', {
    url: 'http://localhost:8000', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
  });
  const win = dom.window;
  const events = new Map();
  let aiRequests = 0;
  const files = new Map();
  const eventSource = {
    on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    off(name, fn) { events.get(name)?.delete(fn); },
    once(name, fn) { const cb = (...args) => { this.off(name, cb); fn(...args); }; this.on(name, cb); },
    async emit(name, ...args) { for (const fn of events.get(name) || []) await fn(...args); },
  };
  const context = {
    chat: [], chatId: '', characterId: undefined, groupId: null, characters: [], chatMetadata: {},
    extensionSettings: {}, eventSource,
    eventTypes: new Proxy({}, { get: (_, name) => name }),
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    saveSettingsDebounced() {}, async saveMetadata() {}, name1: 'User', name2: '',
  };
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
    let status = 200;
    let data = {};
    if (url.pathname.startsWith('/user/files/')) {
      const stored = files.get(url.pathname);
      if (stored === undefined) status = 404;
      else data = stored;
    } else if (url.pathname === '/api/files/upload') {
      const payload = JSON.parse(options.body);
      const file = `/user/files/${payload.name}`;
      files.set(file, JSON.parse(Buffer.from(payload.data, 'base64').toString('utf8')));
      data = { path: file };
    } else if (url.pathname === '/api/files/verify') {
      data = Object.fromEntries(JSON.parse(options.body).urls.map(file => [file, files.has(file)]));
    } else {
      // 不允许测试接触任何真实宿主、网络或用户资料。
      status = 404;
    }
    return { ok: status === 200, status, statusText: status === 404 ? 'Not Found' : 'OK', json: async () => data, text: async () => JSON.stringify(data) };
  };
  try {
    if (config.template) {
      const wrapper = win.document.createElement('div');
      wrapper.id = 'ac-statusbar-wrapper';
      wrapper.innerHTML = await readFile(new URL('../dist/statusbar.html', import.meta.url), 'utf8');
      win.document.body.append(wrapper);
    }
    const bundle = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
    const code = await transform(bundle, { format: 'iife', loader: 'js', target: 'es2022' });
    win.eval(code.code);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(win[config.bootFlag], true, `${config.title}启动标记缺失`);
    if (config.id === 'sese-phone') assert(win.document.getElementById('ubp-root')?.shadowRoot, '手机壳未挂载');
    if (config.id === 'sese-ledger') assert(win.SeseLedgerAPI, '台账 API 未挂载');
    assert.equal(aiRequests, 0);
    assert.deepEqual(errors, [], '模拟启动出现错误日志');
  } finally {
    await win.__SL_DISPOSE__?.();
    win.close();
  }
});
