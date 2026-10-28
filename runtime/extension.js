export const REQUIRED_HELPER_METHODS = [
  'generateRaw', 'injectPrompts', 'getWorldbook', 'replaceWorldbook',
  'getCharWorldbookNames', 'getWorldbookNames',
];

export function missingCapabilities(win) {
  const missing = [];
  let context;
  try { context = win.SillyTavern?.getContext?.(); } catch { /* 依赖仍在启动 */ }
  if (!context?.eventSource?.on || !context?.eventTypes?.CHAT_CHANGED) missing.push('SillyTavern.getContext / CHAT_CHANGED');
  if (typeof win.$ !== 'function') missing.push('酒馆 jQuery');
  if (!win.toastr) missing.push('酒馆通知组件 toastr');
  for (const method of REQUIRED_HELPER_METHODS) {
    if (typeof win.TavernHelper?.[method] !== 'function') missing.push(`TavernHelper.${method}`);
  }
  return missing;
}

/** 原模块仍各自管理业务；这里只补原分享包缺失的宿主装载器。 */
export function createExtension(win, config, {
  loadModule, readTemplate, timeoutMs = 30000, pollMs = 300,
}) {
  const doc = win.document;
  let phase = 'idle';
  let message = '等待启动';
  let activePromise = null;
  let template = '';
  let status;
  let button;
  let chatTimer;
  let resizeTimer;
  let chatObserver;
  let observedChat;
  let detachEvents;
  let moduleStarted = false;

  function show(nextPhase, text) {
    phase = nextPhase;
    message = text;
    if (status) status.textContent = text;
    if (button) {
      button.disabled = ['waiting', 'loading', 'ready'].includes(nextPhase);
      button.textContent = moduleStarted && nextPhase === 'error' ? '刷新页面后重试' : '重新检查并启动';
    }
  }

  function mountPanel() {
    if (doc.getElementById(`${config.id}-settings`)) return;
    const panel = doc.createElement('details');
    panel.id = `${config.id}-settings`;
    panel.style.cssText = 'padding:8px;margin:8px 0;border:1px solid var(--SmartThemeBorderColor,#666);border-radius:8px;';
    const title = doc.createElement('summary');
    title.textContent = `${config.title} · 安装状态`;
    status = doc.createElement('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    button = doc.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.addEventListener('click', () => {
      if (moduleStarted) win.location.reload();
      else void start();
    });
    panel.append(title, status, button);
    (doc.getElementById('extensions_settings2') || doc.getElementById('extensions_settings') || doc.body).append(panel);
  }

  function ensureShell() {
    if (!config.template || doc.getElementById('ac-statusbar-wrapper')) return;
    const wrapper = doc.createElement('div');
    wrapper.id = 'ac-statusbar-wrapper';
    wrapper.innerHTML = template;
    // 原入口会把弹层移到 body，恢复壳时保留已有弹层及其事件。
    for (const id of ['char-tooltip', 'panelOverlay', 'settingsOverlay', 'helpTooltipGlobal']) {
      if (doc.getElementById(id)) wrapper.querySelector(`[id="${id}"]`)?.remove();
    }
    doc.body.append(wrapper);
  }

  function watchChat() {
    if (!config.template) return;
    const chat = doc.getElementById('chat');
    if (chat === observedChat) return;
    chatObserver?.disconnect();
    observedChat = chat;
    if (!chat) return;
    chatObserver = new win.MutationObserver(() => {
      if (phase !== 'ready' || doc.getElementById('ac-statusbar-wrapper')) return;
      ensureShell();
      win.__ub_on_reinject?.();
    });
    chatObserver.observe(chat, { childList: true });
  }

  function bindEvents() {
    if (!config.template) return; // 手机、台账入口已有各自的聊天切换处理。
    const context = win.SillyTavern.getContext();
    const onChat = () => {
      win.clearTimeout(chatTimer);
      chatTimer = win.setTimeout(() => {
        ensureShell();
        watchChat();
        win.__ub_on_reinject?.();
      }, 200);
    };
    const onResize = () => {
      win.clearTimeout(resizeTimer);
      resizeTimer = win.setTimeout(() => win.__ub_on_resize?.(), 120);
    };
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, onChat);
    win.addEventListener('resize', onResize);
    win.addEventListener('orientationchange', onResize);
    watchChat();
    detachEvents = () => {
      context.eventSource.off?.(context.eventTypes.CHAT_CHANGED, onChat);
      win.removeEventListener('resize', onResize);
      win.removeEventListener('orientationchange', onResize);
      win.clearTimeout(chatTimer);
      win.clearTimeout(resizeTimer);
      chatObserver?.disconnect();
    };
    win.addEventListener('pagehide', () => detachEvents?.(), { once: true });
  }

  async function waitUntil(check) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => win.setTimeout(resolve, pollMs));
    }
    return true;
  }

  async function run() {
    mountPanel();
    show('waiting', '正在等待酒馆和酒馆助手就绪……');
    if (!await waitUntil(() => missingCapabilities(win).length === 0)) {
      throw new Error(`依赖未就绪：${missingCapabilities(win).join('、')}。请安装并启用酒馆助手，然后重新检查。`);
    }
    if (win[config.bootFlag]) {
      throw new Error(`检测到已运行的${config.title}旧脚本。请停用同名旧脚本并刷新页面，避免重复启动和写入。`);
    }
    // 原代码对真数据库与台账的优先级存在不同读取路径，首版不发布未经验证的混用模式。
    if (config.blockDatabase && (win.AutoCardUpdaterAPI || win.__ACU_STAR_DB_III_LOADED__)) {
      throw new Error('检测到另一个数据库插件。台账预发布版暂不支持同时启用：请先停用该数据库并刷新页面。此检查不会删除现有数据。');
    }
    show('loading', `正在装载${config.title}……`);
    if (config.template) {
      template = await readTemplate();
      if (!template.includes('id="ac-content"')) throw new Error('状态栏模板不完整，请更新扩展后刷新页面。');
      ensureShell();
    }
    moduleStarted = true;
    await loadModule();
    if (!await waitUntil(() => win[config.bootFlag])) throw new Error(`${config.title}入口未启动，请查看控制台后刷新页面。`);
    bindEvents();
    show('ready', '模块入口已装载。聊天数据初始化和功能状态请查看插件界面；首次安装后建议刷新一次。');
    return true;
  }

  function start() {
    if (phase === 'ready') return Promise.resolve(true);
    if (activePromise) return activePromise;
    // 业务模块并未提供完整热卸载，部分启动失败后禁止重复注入。
    if (moduleStarted) return Promise.resolve(false);
    activePromise = run().catch(error => {
      show('error', error instanceof Error ? error.message : String(error));
      win.console.error(`[${config.title}安装入口]`, error);
      return false;
    }).finally(() => { activePromise = null; });
    return activePromise;
  }

  return { start, status: () => ({ phase, message }), disposeLoader: () => detachEvents?.() };
}
