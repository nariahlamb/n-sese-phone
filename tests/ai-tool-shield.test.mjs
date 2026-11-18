import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// 小手机出站防护（U34 共享件）在小手机绑定 API 上的接线验证：
//   resolvePhoneApi() → custom_api 的 source / top_p / 后处理策略登记；
//   phoneFullSlots() 的尾部破限 + semi 规整后「首条对话消息之后不得再有 system/developer」。

async function loadTsBundle(contents, sourcefile) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = await build({
    absWorkingDir: root,
    stdin: { contents, resolveDir: root, loader: 'ts', sourcefile },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
  });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const {
  resolvePhoneApi,
  phoneFullSlots,
  setConfig,
  savePhoneSettings,
  getCustomApiPostProcessingMode,
  scrubGenerateData,
  buildRequestFingerprint,
} = await loadTsBundle(`
export { resolvePhoneApi } from './src/UBS_phone/core/phone-api.ts';
export { phoneFullSlots } from './src/UBS_phone/core/phone-raw.ts';
export { setConfig } from './src/unified-statusbar/core/config-store.ts';
export { savePhoneSettings } from './src/UBS_phone/core/phone-settings.ts';
export {
  getCustomApiPostProcessingMode, scrubGenerateData, buildRequestFingerprint,
} from './src/unified-statusbar/core/ai-tool-shield.ts';
`, 'phone-ai-tool-shield-bundle.ts');

/** 一条合法预设（默认值可用，over 覆盖关注字段）。 */
function preset(over) {
  return {
    id: 'preset-default', name: '预设', url: 'http://127.0.0.1:3001/v1', key: 'sk-test',
    model: 'gemini-2.5-pro', maxTokens: 'unset', temperature: 1, topP: 'unset', topK: 'unset',
    frequencyPenalty: 'unset', presencePenalty: 'unset', createdAt: 1, ...over,
  };
}

test('resolvePhoneApi：非 openai 源透传、openai 不设 source、top_p=0 归 unset、后处理策略可读取', async () => {
  setConfig('customApiPresets', [
    preset({ id: 'p-maker', source: 'makersuite', topP: 0, promptPostProcessing: 'strict' }),
  ]);
  await savePhoneSettings({ apiMode: 'global', apiPresetId: 'p-maker' });

  const maker = resolvePhoneApi();
  assert.equal(maker.presetId, 'p-maker');
  assert.ok(maker.api, '绑定预设必须解析出 custom_api');
  assert.equal(maker.api.source, 'makersuite', '非 openai 源须透传给 generateRaw');
  assert.equal(maker.api.top_p, 'unset', 'top_p=0 越界须按 unset 处理');
  assert.equal(getCustomApiPostProcessingMode(maker.api), 'strict', '预设显式策略须登记在 custom_api 上');

  setConfig('customApiPresets', [
    preset({ id: 'p-openai', source: 'openai', topP: 0.9 }),
  ]);
  await savePhoneSettings({ apiMode: 'global', apiPresetId: 'p-openai' });

  const oa = resolvePhoneApi();
  assert.ok(oa.api);
  assert.equal(oa.api.source, undefined, 'openai 为默认口径，不得显式写 source');
  assert.equal(oa.api.top_p, 0.9, '合法 top_p 原样透传');
  assert.equal(
    getCustomApiPostProcessingMode(oa.api), 'semi',
    '预设未声明策略时须回退 semi（与 CUSTOM_API_POST_PROCESSING_DEFAULT 一致）',
  );

  // 未知 source 归一为 openai（不把脏值发给上游），越界 top_p（>1）同样归 unset
  setConfig('customApiPresets', [
    preset({ id: 'p-bad', source: 'not-a-source', topP: 1.5, promptPostProcessing: 'nope' }),
  ]);
  await savePhoneSettings({ apiMode: 'global', apiPresetId: 'p-bad' });
  const bad = resolvePhoneApi();
  assert.ok(bad.api);
  assert.equal(bad.api.source, undefined);
  assert.equal(bad.api.top_p, 'unset');
  assert.equal(getCustomApiPostProcessingMode(bad.api), 'semi');
});

test('phoneFullSlots 不含 chat_history 且含尾部破限；semi 规整后首条对话消息之后不得残留 system/developer', () => {
  const slots = phoneFullSlots();
  assert.equal(slots.includes('chat_history'), false, 'phoneFullSlots 不得再包含 chat_history');
  const uiIdx = slots.indexOf('user_input');
  assert.ok(uiIdx > 0, 'user_input 槽位须位于尾部破限之前');

  const tail = slots.slice(uiIdx + 1);
  assert.ok(tail.length > 0, 'phoneFullSlots 必须包含尾部破限');
  for (const entry of tail) {
    assert.equal(typeof entry, 'object');
    assert.equal(entry.role, 'system', '尾部破限应为 system 段');
    assert.ok(typeof entry.content === 'string' && entry.content.trim() !== '', '尾部破限内容不得为空');
  }

  // 按真实出站形态还原消息序列：对象槽位用自身 role，字符串槽位（world_info_* 等）
  // 在宿主侧展开为 system（资料块）或 user（user_input）；此处只需保证首条为 system 头。
  const messages = slots.map(entry => (
    typeof entry === 'string'
      ? { role: entry === 'user_input' ? 'user' : 'system', content: '§' + entry }
      : { role: entry.role, content: entry.content }
  ));
  messages.splice(uiIdx + 1, 0, { role: 'assistant', content: '上一条回复' });

  const fp = buildRequestFingerprint({ ordered_prompts: [{ content: messages[0].content + '…' }] });
  assert.ok(fp && typeof fp.head === 'string' && fp.head.length > 0, '结构头指纹须可建立');

  const data = {
    model: 'gemini-2.5-pro',
    messages: messages.map(m => ({ ...m })),
    custom_prompt_post_processing: '',
    tools: [{ type: 'function', function: { name: 'emit_complete_response_x' } }],
    tool_choice: 'auto',
  };
  const result = scrubGenerateData(data, fp, 'semi');
  assert.equal(result.touched, true, '本插件请求须被识别并规整');
  assert.deepEqual(result.removedTools, ['emit_complete_response_x']);
  assert.equal('tools' in data, false);
  assert.equal('tool_choice' in data, false);

  let seenConversation = false;
  for (const msg of data.messages) {
    if (msg.role !== 'system' && msg.role !== 'developer') { seenConversation = true; continue; }
    assert.equal(seenConversation, false, '首条非系统消息之后不得残留 ' + msg.role);
  }

  // 尾部破限只是角色降级为 user，内容一个字节都不许丢
  const userText = data.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
  for (const entry of tail) {
    assert.ok(userText.includes(entry.content), '尾部破限内容须保留（仅角色转 user）');
  }

  // 非本插件请求（指纹不命中）零改动
  const foreign = { model: 'other', messages: [{ role: 'system', content: '对方头部' }, { role: 'user', content: 'hi' }] };
  const untouched = scrubGenerateData(foreign, fp, 'semi');
  assert.equal(untouched.touched, false);
  assert.deepEqual(foreign.messages.map(m => m.role), ['system', 'user']);
});

test('phoneScanOptions + withNativeScanWorldbook：屏蔽外挂书/assistant/内置正文向词根，同时放行 keep 手机记录族', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const prevWin = globalThis.window;
  const listeners = new Map();
  dom.window.SillyTavern = {
    getContext: () => ({
      eventSource: { on(evt, fn) { listeners.set(evt, fn); } },
    }),
  };
  dom.window.TavernHelper = {
    getCharWorldbookNames: () => ({ primary: '主书', additional: ['附加美化书'] }),
    getWorldbook: async (name) => name === '附加美化书' ? [{ uid: 5, comment: '附加', content: 'x' }] : [],
  };
  globalThis.window = dom.window;

  try {
    const phoneMod = await loadTsBundle(`
      export { phoneScanOptions } from './src/UBS_phone/core/phone-raw.ts';
      export {
        withNativeScanWorldbook,
        keepSpyRecordEntries,
        __setBackgroundIsolationForTests,
      } from './src/unified-statusbar/core/worldbook-entry.ts';
    `, 'phone-bg-isolation.ts');
    phoneMod.__setBackgroundIsolationForTests({
      blockGlobalLore: true,
      blockAdditionalLore: true,
      dropAssistantLore: true,
      useBuiltinKeywords: true,
      allowedBooks: [],
    });

    const payload = {
      globalLore: [{ uid: 9, world: '全局书', comment: '#状态栏', content: '全局垃圾' }],
      characterLore: [
        { uid: 1, world: '主书', comment: '角色设定-苏晴', content: '主设定' },
        { uid: 2, world: '主书', comment: '正文文风规范', content: '词根拦截' },
        { uid: 3, world: '主书', comment: '<场景美化>', position: { role: 'assistant' }, content: 'HTML' },
        { uid: 4, world: '主书', comment: '[UBS手机]窥私记录-苏晴', content: '手机窥私族应放行' },
        { uid: 5, world: '主书', comment: '[UBS手机]正文联动格式', content: '联动格式条目应剔除' },
        { uid: 6, world: '附加美化书', comment: '附加设定', content: '附加书剔除' },
      ],
      chatLore: [],
      personaLore: [],
    };
    await phoneMod.withNativeScanWorldbook(phoneMod.phoneScanOptions(phoneMod.keepSpyRecordEntries), async () => {
      await listeners.get('worldinfo_entries_loaded')?.(payload);
    });

    assert.deepEqual(payload.globalLore, []);
    assert.deepEqual(payload.characterLore.map(e => e.comment), ['角色设定-苏晴', '[UBS手机]窥私记录-苏晴']);
  } finally {
    globalThis.window = prevWin;
    dom.window.close();
  }
});

test('phoneFullSlots(dossier)：资料块直接作为 system 槽位内联于 dialogue_examples 与 user_input 之间，且经 semi 规整完整保留', () => {
  const dossier = '■ 待反馈的用户互动\n◇ 微博博文 p_wb_1（白鸟）：今天天气不错\n　主角动作：点赞了';
  const slots = phoneFullSlots(dossier);
  assert.equal(slots.includes('chat_history'), false, '仍不得包含 chat_history');
  const deIdx = slots.indexOf('dialogue_examples');
  const uiIdx = slots.indexOf('user_input');
  assert.ok(deIdx >= 0 && uiIdx > deIdx + 1, 'dossier 槽位须位于 dialogue_examples 与 user_input 之间');
  const dossierSlot = slots[deIdx + 1];
  assert.equal(typeof dossierSlot, 'object');
  assert.equal(dossierSlot.role, 'system');
  assert.equal(dossierSlot.content, dossier);

  const messages = slots.map(entry => (
    typeof entry === 'string'
      ? { role: entry === 'user_input' ? 'user' : 'system', content: '§' + entry }
      : { role: entry.role, content: entry.content }
  ));
  const fp = buildRequestFingerprint({ ordered_prompts: [{ content: messages[0].content + '…' }] });
  const data = { model: 'gemini-2.5-pro', messages, custom_prompt_post_processing: '' };
  const result = scrubGenerateData(data, fp, 'semi');
  assert.equal(result.touched, true);
  const combined = data.messages.map(m => m.content).join('\n');
  assert.ok(combined.includes(dossier), '经 semi 规整后资料块内容必须完整保留');
});
