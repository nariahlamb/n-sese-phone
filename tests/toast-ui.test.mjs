import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

async function loadTs(path) {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm',
    target: 'node22', logLevel: 'silent',
  });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

async function loadPhoneAiNotifyBundle() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: "export * from './src/UBS_phone/core/ai-activity-notify.ts'; export * from './src/UBS_phone/core/ai-activity.ts';",
      resolveDir: root, loader: 'ts', sourcefile: 'phone-ai-notify-bundle.ts',
    },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
  });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

test('phone-theme CSS：.ubp-toast 屏内轻提示改为半透明与紧凑尺寸', async () => {
  const { PHONE_CSS } = await loadTs('src/UBS_phone/styles/phone-theme.ts');
  assert(PHONE_CSS.includes('background: rgba(0, 0, 0, 0.52); color: #fff; font-size: var(--fs-11); border-radius: 7px;'));
  assert(PHONE_CSS.includes('backdrop-filter: blur(8px);'));
  assert(PHONE_CSS.includes('padding: 5px 10px; pointer-events: none; white-space: normal; max-width: 72%;'));
  assert(PHONE_CSS.includes('flex: none; border: none; background: transparent; color: var(--ubp-accent); font-size: var(--fs-11);'));
});

test('phone ai-activity-notify：点关闭 ×（及安全边沿）不中止任务并关闭通知，单开注入大 × 兜底样式', async () => {
  const { initPhoneAiActivityNotify, _resetPhoneAiActivityNotifyForTest, beginPhoneAiActivity } = await loadPhoneAiNotifyBundle();
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="toast-container"></div></body></html>', { url: 'http://localhost' });
  const prev = { window: globalThis.window, document: globalThis.document, MouseEvent: globalThis.MouseEvent };
  let aborted = 0;
  let closeClicks = 0;
  let lastOpts = null;
  dom.window.toastr = {
    info(msg, title, opts) {
      lastOpts = opts;
      const el = dom.window.document.createElement('div');
      el.className = 'toast toast-info ' + (opts?.extraClasses || '');
      const closeBtn = dom.window.document.createElement('button');
      closeBtn.className = 'toast-close-button';
      closeBtn.textContent = '×';
      closeBtn.getBoundingClientRect = () => ({ left: 220, top: 2, right: 250, bottom: 32, width: 30, height: 30 });
      closeBtn.addEventListener('click', () => { closeClicks++; });
      const msgDiv = dom.window.document.createElement('div');
      msgDiv.className = 'toast-message';
      msgDiv.textContent = msg;
      el.append(closeBtn, msgDiv);
      dom.window.document.getElementById('toast-container').appendChild(el);
      return {
        0: el,
        find(sel) {
          const hit = el.querySelector(sel);
          return { get: () => hit };
        },
        remove() { el.remove(); },
      };
    },
    clear(el) { el?.[0]?.remove?.(); },
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.MouseEvent = dom.window.MouseEvent;
  try {
    _resetPhoneAiActivityNotifyForTest();
    initPhoneAiActivityNotify();
    const handle = beginPhoneAiActivity({
      feature: '微信回复',
      label: '微信回复',
      phase: 'requesting',
      cancelable: true,
      cancel() { aborted++; },
    });
    assert.equal(lastOpts?.extraClasses, 'ub-progress-toast');
    const fallbackCss = dom.window.document.getElementById('ubp-progress-toast-fallback-css');
    assert(fallbackCss, '单开小手机时应注入兜底样式');
    assert((fallbackCss.textContent || '').includes('width:30px !important; height:30px !important'));

    const toastNode = dom.window.document.querySelector('#toast-container .toast');
    const closeBtn = toastNode.querySelector('.toast-close-button');
    assert.equal(closeBtn.getAttribute('aria-label'), '只关闭通知（任务在后台继续）');
    closeBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 235, clientY: 16 }));
    assert.equal(aborted, 0);
    assert.equal(closeClicks, 1);
    toastNode.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 215, clientY: 36 }));
    assert.equal(aborted, 0);
    assert.equal(closeClicks, 2);
    toastNode.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 18 }));
    assert.equal(aborted, 1);
    handle.end();
  } finally {
    _resetPhoneAiActivityNotifyForTest();
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    globalThis.MouseEvent = prev.MouseEvent;
    dom.window.close();
  }
});
