import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function loadTs(path) {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm',
    target: 'node22', logLevel: 'silent',
  });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const {
  stripContextTags,
  extractKeepTagBlocks,
  cleanContextText,
  cleanContextMessages,
} = await loadTs('src/unified-statusbar/core/context-strip.ts');

const USER_STRIP_TAGS = [
  '世界状态更新', '角色', '事件池', '记忆', 'state', 'dream_think', 'branches', 'selections',
  'xuan', 'seed', 'choices', 'options', 'user_options', 'pose', 'sumup', 'choice', 'forum',
  'omake', 'bgm', 'ontological_anchor_protocol', 'flux', 'current_event', 'updatevariable',
  'story_driver', 'meow_fm', 'dream_summary', 'orange', 'director_log', 'dream_self_check',
  'progress', 'inner_flow', 'monster', 'think_nya~', 'konatan_planning~', 'think', 'thinking',
  'deep_thinking', 'ecot', 'tucao', 'novel_header', 'meta', 'liwe', 'theater',
];

test('stripContextTags 基本成对、大小写、属性与自闭合剥离', () => {
  assert.equal(stripContextTags('a<image>x</image>b<Image src="1">y</Image>c<image/>d', ['image']), 'abcd');
  assert.equal(stripContextTags('保留<image>孤儿不删', ['image']), '保留<image>孤儿不删');
  assert.equal(stripContextTags('<think><think>内</think>外</think>正文', ['think']), '正文');
  assert.equal(stripContextTags('<think_nya~>猫语思考</think_nya~>正文', ['think_nya~']), '正文');
  assert.equal(stripContextTags('<世界状态更新>旧</世界状态更新>正文', ['世界状态更新']), '正文');
  assert.equal(stripContextTags('<thinking>思考</thinking>正文', ['think']), '<thinking>思考</thinking>正文');
});

test('stripContextTags 思维链内提及未闭合 <orange>/<UpdateVariable>/<options> 且列表在 thinking 之前时，绝不误吞 <content> 正文', () => {
  const raw = [
    '<thinking>',
    '【自言自语】',
    '- 触发第1个 <orange> HTML模块：兽人公寓入住须知',
    '- 检查 <orange> 场景美化模块',
    '- 确认字数：<content> 内正文保持在 1000-2000 字，包含顶部 <novel_header>，正文结束后输出 <UpdateVariable> 和 <options>。',
    '</thinking>',
    '<content>',
    '<novel_header>',
    '[ChapterInfo|1|坠落的自由之云|新邻居与二楼的烟鬼前辈]',
    '</novel_header>',
    '',
    '走廊上的穿堂风裹着一股子廉价烟草味往屋里钻。桃井奈奈扶着门框探出半个身子。',
    '',
    '<orange>',
    '<style>.ui-note-01 { color: #3E2723; }</style>',
    '<div class="ui-note-01">入住须知</div>',
    '</orange>',
    '<span style="display: none;">（入住须知便签）</span>',
    '',
    '尼古喵喵把烫红的食指塞进嘴里嘬了一口。',
    '',
    '<orange>',
    '<style>.ui-receipt-02 { color: #1A1A1A; }</style>',
    '<div class="ui-receipt-02">小票</div>',
    '</orange>',
    '<span style="display: none;">（便利店购物小票）</span>',
    '',
    '尼古喵喵呛得眼泪狂飙。',
    '</content>',
    '<UpdateVariable>',
    '<analysis>状态推进</analysis>',
    '<JSONPatch>[]</JSONPatch>',
    '</UpdateVariable>',
    '<options>',
    '1. 继续收拾纸箱',
    '2. 递一瓶水过去',
    '</options>',
    '<StatusPlaceHolderImpl/>'
  ].join('\n');

  const stripped = stripContextTags(raw, USER_STRIP_TAGS);
  assert.equal(stripped.includes('<thinking>'), false, 'thinking 未剥离');
  assert.equal(stripped.includes('【自言自语】'), false, 'thinking 内容残留');
  assert.equal(stripped.includes('<novel_header>'), false, 'novel_header 未剥离');
  assert.equal(stripped.includes('<orange>'), false, 'orange 未剥离');
  assert.equal(stripped.includes('<UpdateVariable>'), false, 'UpdateVariable 未剥离');
  assert.equal(stripped.includes('<options>'), false, 'options 未剥离');
  assert.equal(stripped.includes('走廊上的穿堂风裹着一股子廉价烟草味往屋里钻'), true, '正文前段被误吞');
  assert.equal(stripped.includes('尼古喵喵把烫红的食指塞进嘴里嘬了一口'), true, '正文中段被误吞');
  assert.equal(stripped.includes('尼古喵喵呛得眼泪狂飙'), true, '正文尾段被误吞');
});

test('stripContextTags 从上到下优先级：交叉重叠时排在前面的标签优先整段剥离', () => {
  const raw = '<options>外误提<thinking>思考内提到</options>思考继续</thinking><content>真实正文</content>';
  const out = stripContextTags(raw, ['thinking', 'options']);
  assert.equal(out.includes('思考继续'), false, '高优先级 thinking 内部残留');
  assert.equal(out.includes('<content>真实正文</content>'), true, '正文被误吞');
});

test('cleanContextText 保留标签与剥离标签分离：thinking 内举例完整 <content> / 提及 </thinking> 均不误伤真实正文', () => {
  const raw = [
    '<thinking>',
    '记住先用 <content>草稿示例，这不是正文</content> 做结构示范，也别提前写 </thinking> 哦。',
    '还有如果遇到 <options>1. 选项</options> 也不算正文。',
    '</thinking>',
    '杂项旁白：<meta>不该出现的信息</meta>',
    '<content>',
    '<novel_header>第1章</novel_header>',
    '真正在故事里的第一段。',
    '<orange><div>状态便签</div></orange>',
    '真正在故事里的第二段。',
    '</content>',
    '<playtxt>补充演出段落。</playtxt>',
    '<options>1. 下一步</options>',
  ].join('\n');

  const cleaned = cleanContextText(raw, {
    keepTags: ['content', 'playtxt'],
    stripTags: ['thinking', 'think', 'novel_header', 'orange', 'options'],
  });
  assert.equal(cleaned.includes('草稿示例'), false, 'thinking 内的假 <content> 泄漏');
  assert.equal(cleaned.includes('不该出现的信息'), false, '保留标签外的杂项泄漏');
  assert.equal(cleaned.includes('第1章'), false, '保留标签内嵌 novel_header 未剥离');
  assert.equal(cleaned.includes('状态便签'), false, '保留标签内嵌 orange 未剥离');
  assert.equal(cleaned.includes('下一步'), false, '尾部 options 泄漏');
  assert.equal(cleaned.includes('真正在故事里的第一段。'), true);
  assert.equal(cleaned.includes('真正在故事里的第二段。'), true);
  assert.equal(cleaned.includes('补充演出段落。'), true);
});

test('cleanContextText 未闭合 thinking + 保留标签，以及嵌套保留标签解包', () => {
  const unclosedThink = '<thinking>模型抽风忘了闭合思考...\n<content>真实正文依然安全提取</content><options>1. A</options>';
  assert.equal(
    cleanContextText(unclosedThink, { keepTags: ['content'], stripTags: ['thinking', 'options'] }),
    '真实正文依然安全提取',
  );

  const nestedKeep = '<content><playtxt>内层正文</playtxt></content>';
  assert.equal(extractKeepTagBlocks(nestedKeep, ['content', 'playtxt']), '内层正文');
});

test('cleanContextText 未命中保留标签时自动回退为「除剥离标签以外的内容」', () => {
  const plainCard = '<thinking>思考中<options>举例</thinking>普通角色卡没有包 content 标签的正文。<options>1. 继续</options>';
  const out = cleanContextText(plainCard, {
    keepTags: ['content', 'playtxt'],
    stripTags: ['thinking', 'options'],
  });
  assert.equal(out, '普通角色卡没有包 content 标签的正文。');
});

test('cleanContextMessages 逐条消息独立清洗再拼接，防止前楼未闭合标签跨楼吞噬后楼', () => {
  const turn1 = '<thinking>第1楼忘了闭合思考，后面都没写完';
  const turn2 = '<thinking>第2楼正常思考</thinking><content>第2楼正文完好无损</content>';
  const joined = cleanContextMessages([turn1, turn2], {
    keepTags: ['content'],
    stripTags: ['thinking'],
    prefix: 'AI：',
  });
  assert.equal(joined.includes('AI：第2楼正文完好无损'), true, '第2楼正文被第1楼未闭合标签误吞');
  assert.equal(joined.startsWith('AI：<thinking>第1楼忘了闭合思考'), true, '第1楼独立保留不跨楼污染');
});

const { extractStoryPhoneEvents } = await loadTs('src/UBS_phone/core/story-link.ts');
const { parseChatReply, stripThinkingBlocks } = await loadTs('src/UBS_phone/core/chat-parser.ts');
const { parseCallReply } = await loadTs('src/UBS_phone/core/call-parser.ts');

test('story-link extractStoryPhoneEvents 绝不提取 <thinking>/<think> 内的假微信与假通话', () => {
  const floor = [
    '<thinking>',
    '草稿举例如下：<微信>坏人|我|假消息</微信>',
    '<通话>坏人：假来电\n我：喂？</通话>',
    '</thinking>',
    '<content>',
    '她发来一条微信：<微信>苏晴|我|晚上一起吃饭吗</微信>',
    '</content>',
  ].join('\n');
  const events = extractStoryPhoneEvents(floor);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'message');
  assert.equal(events[0].name, '苏晴');
  assert.equal(events[0].text, '晚上一起吃饭吗');
});

test('chat-parser 与 call-parser 在思考内提到标签或正文内提到 </think> 时正常解析不截断', () => {
  const smsRaw = [
    '<thinking>考虑先输出 <ubp_reply>林夕: 思考里的假短信</ubp_reply> 和 <think></thinking>',
    '<ubp_reply>',
    '林夕: 你刚才发的那句 </think> 是什么乱码？',
    '林夕: 回我一下',
    '</ubp_reply>',
  ].join('\n');
  const sms = parseChatReply(smsRaw, { allowedSenders: ['林夕'] });
  assert.equal(sms.messages.length, 2);
  assert.equal(sms.messages[0].content.includes('</think>'), true);
  assert.equal(sms.messages[1].content, '回我一下');

  const callRaw = [
    '<think>草稿 <ubp_call>status: rejected\nreason: 假拒接</ubp_call></think>',
    '<ubp_call>',
    'status: answered',
    'thought: 刚接起来',
    'content: 喂？我到楼下了。',
    '刚才信号卡了一下',
    '</ubp_call>',
  ].join('\n');
  const call = parseCallReply(callRaw);
  assert.equal(call.status, 'answered');
  assert.deepEqual(call.lines, ['喂？我到楼下了。', '刚才信号卡了一下']);

  // 未闭合思考开头后接 <ubp_reply>
  const unclosed = '<thinking>忘了闭合... <ubp_reply>林夕: 在吗</ubp_reply>';
  assert.equal(stripThinkingBlocks(unclosed), '<ubp_reply>林夕: 在吗</ubp_reply>');
});
