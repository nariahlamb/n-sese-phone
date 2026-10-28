import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createExtension, REQUIRED_HELPER_METHODS } from '../runtime/extension.js';
import { config } from '../runtime/config.js';

function fixture({ ready = true } = {}) {
  const dom = new JSDOM('<body><div id="extensions_settings"></div><div id="chat"></div></body>', { url: 'http://localhost:8000' });
  const win = dom.window;
  const listeners = new Map();
  const eventSource = {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    off(name, fn) { listeners.get(name)?.delete(fn); },
  };
  win.SillyTavern = { getContext: () => ({ eventSource, eventTypes: { CHAT_CHANGED: 'chat' } }) };
  win.$ = () => {};
  win.toastr = {};
  win.console.error = () => {};
  if (ready) win.TavernHelper = Object.fromEntries(REQUIRED_HELPER_METHODS.map(name => [name, () => {}]));
  let loads = 0;
  const extension = createExtension(win, config, {
    timeoutMs: 40,
    pollMs: 2,
    loadModule: async () => { loads++; win[config.bootFlag] = true; },
    readTemplate: async () => '<div id="ac-content"></div><div id="panelOverlay"></div>',
  });
  return { win, dom, extension, listeners, loads: () => loads };
}

test('依赖缺失时不装载业务、不创建状态栏，并允许依赖就绪后重试', async () => {
  const f = fixture({ ready: false });
  try {
    assert.equal(await f.extension.start(), false);
    assert.equal(f.loads(), 0);
    assert.equal(f.win.document.getElementById('ac-statusbar-wrapper'), null);
    assert.match(f.extension.status().message, /酒馆助手/);
    f.win.TavernHelper = Object.fromEntries(REQUIRED_HELPER_METHODS.map(name => [name, () => {}]));
    assert.equal(await f.extension.start(), true);
    assert.equal(f.loads(), 1);
  } finally { f.dom.window.close(); }
});

test('并发启动和重复点击只装载一次，原有聊天 DOM 保留', async () => {
  const f = fixture();
  try {
    f.win.document.getElementById('chat').innerHTML = '<div id="existing-message">旧消息</div>';
    assert.deepEqual(await Promise.all([f.extension.start(), f.extension.start()]), [true, true]);
    assert.equal(await f.extension.start(), true);
    assert.equal(f.loads(), 1);
    assert.equal(f.win.document.getElementById('existing-message').textContent, '旧消息');
    assert.equal(f.win.document.querySelectorAll(`#${config.id}-settings`).length, 1);
  } finally { f.extension.disposeLoader(); f.dom.window.close(); }
});

test('同名旧脚本已启动时拒绝重复注入', async () => {
  const f = fixture();
  try {
    f.win[config.bootFlag] = true;
    assert.equal(await f.extension.start(), false);
    assert.equal(f.loads(), 0);
    assert.match(f.extension.status().message, /旧脚本/);
  } finally { f.dom.window.close(); }
});

test('部分业务装载失败后禁止再注入，提示刷新', async () => {
  const f = fixture();
  try {
    let loads = 0;
    const ext = createExtension(f.win, config, { loadModule: async () => { loads++; throw new Error('bundle failed'); }, readTemplate: async () => '<div id="ac-content"></div>', timeoutMs: 20, pollMs: 1 });
    assert.equal(await ext.start(), false);
    assert.equal(await ext.start(), false);
    assert.equal(loads, 1);
    assert.match(f.win.document.querySelector('button').textContent, /刷新/);
  } finally { f.dom.window.close(); }
});

test('台账遇到真数据库时在执行业务前停止，其余插件可继续', async () => {
  const f = fixture();
  try {
    f.win.AutoCardUpdaterAPI = {};
    assert.equal(await f.extension.start(), !config.blockDatabase);
    assert.equal(f.loads(), config.blockDatabase ? 0 : 1);
  } finally { f.extension.disposeLoader(); f.dom.window.close(); }
});

test('聊天清空后恢复状态栏壳，保留已迁出的弹窗；卸载器解绑', { skip: !config.template }, async () => {
  const f = fixture();
  try {
    assert.equal(await f.extension.start(), true);
    let restored = 0;
    f.win.__ub_on_reinject = () => { restored++; };
    const overlay = f.win.document.getElementById('panelOverlay');
    f.win.document.body.append(overlay);
    f.win.document.getElementById('chat').append(f.win.document.getElementById('ac-statusbar-wrapper'));
    f.win.document.getElementById('chat').replaceChildren();
    await new Promise(resolve => f.win.setTimeout(resolve, 5));
    assert(f.win.document.getElementById('ac-statusbar-wrapper'));
    assert.equal(f.win.document.querySelectorAll('#panelOverlay').length, 1);
    assert.equal(f.win.document.getElementById('panelOverlay'), overlay);
    assert.equal(restored, 1);
    f.extension.disposeLoader();
    assert.equal(f.listeners.get('chat').size, 0);
  } finally { f.extension.disposeLoader(); f.dom.window.close(); }
});
