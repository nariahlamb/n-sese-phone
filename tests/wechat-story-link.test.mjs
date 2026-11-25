import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('..', import.meta.url));

async function loadTs(entry) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const {
  STORY_LINK_ME,
  extractStoryPhoneEvents,
  resolveStoryProtagonistEvents,
  applyStoryPhoneEvents,
} = await loadTs('src/UBS_phone/core/story-link.ts');
const { applyWorldPhoneEvents } = await loadTs('src/UBS_phone/core/world-link.ts');
const {
  normalizePhoneChatData,
  isFriend,
  addFriend,
  ensurePrivateConversation,
  appendMessage,
} = await loadTs('src/UBS_phone/core/chat-model.ts');

test('story-link：主角真名对话在窥私关闭时不被吞掉，正确映射进主角微信并自动加好友', () => {
  const floor = [
    '<微信>林小雨|桃井奈奈|奈奈，刚和陈默把立牌支架装好了，血红橘猫摆出来巨吓人</微信>',
    '<微信>林小雨|桃井奈奈|周五下午三点到五点半别忘啦，摊位号周四晚发你，对了你家那位高冷学姐真不来呀</微信>',
    '<微信>我|林小雨|忘不了，保证准时到场当牛马</微信>',
    '<微信>桃井奈奈|林小雨|她真不来，人说了看活人扮死人没意思，咱还是保命要紧</微信>',
    '<微信>林小雨|陈默|工具箱顺手带一下</微信>',
  ].join('\n');

  const rawEvents = extractStoryPhoneEvents(floor);
  const normalized = resolveStoryProtagonistEvents(rawEvents, '桃井奈奈');
  const visibleEvents = normalized.filter(e => !e.spy);

  assert.equal(visibleEvents.length, 4, '应保留全部 4 条与主角有关的微信消息，只过滤真·NPC 间消息');
  assert.equal(visibleEvents[0].name, '林小雨');
  assert.equal(visibleEvents[1].name, '林小雨');
  assert.equal(visibleEvents[2].name, STORY_LINK_ME);
  assert.equal(visibleEvents[3].name, STORY_LINK_ME);

  const data = normalizePhoneChatData({});
  const outcomes = applyStoryPhoneEvents(data, visibleEvents, {
    protagonistName: '桃井奈奈',
    srcMesId: '16',
    storyTime: '2026-10-27 21:10 周二',
  });
  assert.equal(outcomes.filter(o => o.ok).length, 4);
  assert.equal(isFriend(data, '林小雨'), true, '正文已发生微信往来的角色应自动成为好友');

  const conv = data.conversations.find(c => c.id === 'p:林小雨');
  assert(conv, '应建立与林小雨的私聊会话');
  assert.equal(conv.messages.length, 4);
  assert.deepEqual(
    conv.messages.map(m => [m.from, m.content]),
    [
      ['林小雨', '奈奈，刚和陈默把立牌支架装好了，血红橘猫摆出来巨吓人'],
      ['林小雨', '周五下午三点到五点半别忘啦，摊位号周四晚发你，对了你家那位高冷学姐真不来呀'],
      ['me', '忘不了，保证准时到场当牛马'],
      ['me', '她真不来，人说了看活人扮死人没意思，咱还是保命要紧'],
    ],
  );
  assert.equal(data.spy?.conversations?.length || 0, 0, '未开窥私不应写入窥私域');
});

test('story-link：同时支持主角信息表姓名与 {{user}} 别名，且通话内主角真名也归一', () => {
  const floor = [
    '<微信>林小雨|奈奈|到楼下了吗</微信>',
    '<微信>桃井奈奈|林小雨|刚出门</微信>',
    '<通话>林小雨：喂？\n奈奈：在路上了</通话>',
  ].join('\n');

  const resolved = resolveStoryProtagonistEvents(extractStoryPhoneEvents(floor), '桃井奈奈', ['奈奈']);
  assert.equal(resolved.filter(e => !e.spy).length, 3);

  const data = normalizePhoneChatData({});
  const outcomes = applyStoryPhoneEvents(data, resolved, {
    protagonistName: '桃井奈奈',
    protagonistNames: ['奈奈'],
    srcMesId: '20',
  });
  assert.equal(outcomes.every(o => o.ok), true);
  const conv = data.conversations.find(c => c.id === 'p:林小雨');
  assert.deepEqual(conv?.messages.map(m => m.from), ['林小雨', 'me']);
  assert.equal(data.calls.length, 1);
  assert.equal(data.calls[0].peerName, '林小雨');
  assert.equal(data.calls[0].direction, 'incoming');
  assert.deepEqual(data.calls[0].lines.map(l => l.from), ['peer', 'me']);
});

test('world-link：演化投递消息或转账红包时自动加好友，不卡申请分支', () => {
  const data = normalizePhoneChatData({});
  const outcomes = applyWorldPhoneEvents(data, [
    { kind: 'message', name: '苏晴', text: '晚上有空吗' },
    { kind: 'money', moneyKind: 'redpacket', direction: 'in', name: '白露', amount: 88, note: '请你喝奶茶' },
  ], { storyTime: '2026-10-28 12:00 周三' });
  assert.equal(outcomes.every(o => o.ok), true);
  assert.equal(isFriend(data, '苏晴'), true);
  assert.equal(isFriend(data, '白露'), true);
});

test('app-wechat：发送即已发送并自动触发 AI 回复，不再显示「待发送 N 条」，忙碌期间支持队列接力与终止清空', async () => {
  const original = await readFile(new URL('../src/UBS_phone/renderers/app-wechat.ts', import.meta.url), 'utf8');

  const phoneData = normalizePhoneChatData({});
  addFriend(phoneData, '林小雨');
  const conv = ensurePrivateConversation(phoneData, '林小雨');
  appendMessage(conv, { id: 'm0', from: '林小雨', type: 'text', content: '在吗？', ts: 1000 });

  const genCalls = [];
  const pendingResolvers = [];

  const chatEngineStub = [
    'export class PhoneChatError extends Error {',
    '  kind: string;',
    '  constructor(kind: string, message: string) { super(message); this.kind = kind; }',
    '}',
    'export function abortPhoneGeneration(convId?: string) {',
    "  (globalThis as any).__wechatStub.aborted.push(convId || '');",
    '  return true;',
    '}',
    "export function readStrippedAiChatHistory() { return ''; }",
    'export function generateConversationReply(opts: { conversationId: string; extraHint?: string }) {',
    '  return (globalThis as any).__wechatStub.generate(opts);',
    '}',
  ].join('\n');

  const storeStub = [
    "export const PHONE_DATA_KEY = 'ubp_test_data';",
    'export function readPhoneData() { return (globalThis as any).__wechatStub.data; }',
    'export function readPhoneDataRef() { return (globalThis as any).__wechatStub.data; }',
    'export function readPhoneDataSafe() { return (globalThis as any).__wechatStub.data; }',
    'export function mutatePhoneData(fn: (d: any) => void) { fn((globalThis as any).__wechatStub.data); }',
    'export function persistPhoneData() { return Promise.resolve(); }',
    "export function phoneStoreStatus() { return { state: 'ready', error: '' }; }",
    "export function currentPhoneStorageId() { return 'chat-1'; }",
  ].join('\n');

  const rosterStub = [
    'export function getRoster() {',
    '  return {',
    '    hasDb: true,',
    "    protagonistName: '桃井奈奈',",
    "    userName: '桃井奈奈',",
    "    global: { time: '2026-10-27 20:00 周二', location: '' },",
    "    contacts: [{ name: '林小雨', gender: '女', identity: '社长', personality: '元气', appearance: '', relationship: '同学', relationScore: 60, tags: [], recent: '', past: '' }],",
    '    presentNames: [],',
    '    relations: [],',
    '  };',
    '}',
    'export function findContact(roster: any, name: string) {',
    '  return roster.contacts.find((c: any) => c.name === name) || null;',
    '}',
    'export function isKnownContactName(roster: any, name: string) {',
    '  return roster.contacts.some((c: any) => c.name === name);',
    '}',
    'export function bindRosterInvalidation() { return () => {}; }',
    'export function mergeCustomContacts(_roster: any, custom: string[]) { return custom; }',
  ].join('\n');

  const phoneUiSource = (await readFile(new URL('../src/UBS_phone/renderers/phone-ui.ts', import.meta.url), 'utf8'))
    .replace('let _open = false;', 'let _open = true;');

  const stubPlugin = {
    name: 'wechat-test-stubs',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/core\/(chat-engine|phone-store|roster)$/ }, args => ({
        path: args.path,
        namespace: 'wechat-stub',
      }));
      buildApi.onResolve({ filter: /^\.\/phone-ui$/ }, () => ({
        path: root + 'src/UBS_phone/renderers/phone-ui.ts',
        namespace: 'wechat-phone-ui',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'wechat-phone-ui' }, () => ({
        loader: 'ts',
        contents: phoneUiSource,
        resolveDir: root + 'src/UBS_phone/renderers',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'wechat-stub' }, args => {
        if (args.path === '../core/chat-engine') return { loader: 'ts', contents: chatEngineStub };
        if (args.path === '../core/phone-store') return { loader: 'ts', contents: storeStub };
        return { loader: 'ts', contents: rosterStub };
      });
    },
  };

  const marker = 'export function inputRightSlotAct';
  assert(original.includes(marker));
  const probed = original.replace(
    marker,
    'export { wxPendBarHtml, handleSend, handleSendVoice, handleSendMoney, handleAlbumPick, handleTrigger, openConversation };\n' + marker,
  );
  const built = await build({
    absWorkingDir: root,
    stdin: { contents: probed, resolveDir: root + 'src/UBS_phone/renderers', loader: 'ts', sourcefile: 'app-wechat-probe.ts' },
    plugins: [stubPlugin],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
  });

  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost' });
  const win = dom.window;
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    __wechatStub: globalThis.__wechatStub,
  };
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.HTMLInputElement = win.HTMLInputElement;
  globalThis.HTMLTextAreaElement = win.HTMLTextAreaElement;
  globalThis.__wechatStub = {
    data: phoneData,
    aborted: [],
    generate(opts) {
      genCalls.push(opts);
      return new Promise(resolve => pendingResolvers.push(resolve));
    },
  };

  try {
    const mod = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
    const pendEmpty = mod.wxPendBarHtml(0);
    const pendUnreplied = mod.wxPendBarHtml(3);
    assert.equal(pendEmpty.includes('让对方先说'), true);
    assert.equal(pendUnreplied.includes('待发送'), false);
    assert.equal(pendUnreplied.includes('生成回复'), true);

    const container = win.document.getElementById('host');
    const unmount = mod.wechatApp.mount({ container, onBack() {} });
    mod.openConversation('p:林小雨');

    const input = container.querySelector('#ubp-chat-input');
    input.value = '第一句你好';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    mod.handleSend();

    assert.equal(conv.messages.at(-1)?.content, '第一句你好');
    assert.equal(genCalls.length, 1, '发消息后应立即自动触发一次 AI 回复');
    assert.equal(container.textContent.includes('待发送'), false);

    input.value = '第二句补一句';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    mod.handleSend();
    assert.equal(conv.messages.at(-1)?.content, '第二句补一句');
    assert.equal(genCalls.length, 1, '忙碌期间不应并发双发');

    const waitFor = async (pred, timeoutMs = 2500) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred()) {
        if (Date.now() > deadline) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };

    pendingResolvers.shift()({ parsed: { messages: [{ sender: '林小雨', type: 'text', content: '收到第一句啦' }], actions: [], memos: [] } });
    await waitFor(() => genCalls.length === 2);

    assert.equal(genCalls.length, 2, '第一轮送达完成后应自动接力触发队列里的第二轮回复');
    pendingResolvers.shift()({ parsed: { messages: [{ sender: '林小雨', type: 'text', content: '第二句也收到啦' }], actions: [], memos: [] } });
    await waitFor(() => conv.messages.some(m => m.content === '第二句也收到啦') && !container.querySelector('.ubp-typing'));

    const voiceBtn = container.querySelector('[data-ubp-act="send-voice"]');
    assert(voiceBtn, '好友会话应有语音按钮');
    voiceBtn.click();
    const voiceInput = container.querySelector('#ubp-voice-text');
    assert(voiceInput, '应打开语音输入弹层');
    voiceInput.value = '语音测试';
    voiceInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    container.querySelector('[data-ubp-act="voice-confirm"]').click();
    assert.equal(genCalls.length, 3, '发语音后也应立即自动触发 AI 回复');

    input.value = '终止测试追加';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    mod.handleSend();
    assert.equal(genCalls.length, 3, '语音仍在生成中时继续发消息先入队列');
    container.querySelector('[data-ubp-act="abort-gen"]').click();
    pendingResolvers.shift()({ parsed: { messages: [], actions: [], memos: [] } });
    await waitFor(() => !container.querySelector('.ubp-typing'));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(genCalls.length, 3, '点击终止后不应继续触发队列接力');
    unmount?.();
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.HTMLElement = saved.HTMLElement;
    globalThis.HTMLInputElement = saved.HTMLInputElement;
    globalThis.HTMLTextAreaElement = saved.HTMLTextAreaElement;
    globalThis.__wechatStub = saved.__wechatStub;
    win.close();
  }
});
