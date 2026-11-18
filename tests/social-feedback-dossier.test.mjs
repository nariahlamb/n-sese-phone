import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

async function loadTsBundle(contents, sourcefile) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = await build({
    absWorkingDir: root,
    stdin: { contents, resolveDir: root, loader: 'ts', sourcefile },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
  });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

test('社媒发帖与点赞后求回应：资料块直传 ordered_prompts（不走 after_system），完整携带待反馈互动与现有评论并成功解析', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const injectedCalls = [];
  const rawRequests = [];
  let postIdCreated = '';

  const context = {
    chat: [], chatId: 'chat-social-test', characterId: 0, groupId: null,
    characters: [{ name: '白鸟', data: { name: '白鸟' } }],
    chatMetadata: {}, extensionSettings: {},
    eventSource: { on() {}, off() {}, once() {}, removeListener() {} },
    eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'CHAT_COMPLETION_SETTINGS_READY' },
    name1: '桃井奈奈', name2: '白鸟',
  };

  dom.window.SillyTavern = { getContext: () => context };
  dom.window.AutoCardUpdaterAPI = {
    exportTableAsJson: () => ({
      sheet_0: { name: '主角信息表', content: [['姓名', '性别'], ['桃井奈奈', '女']] },
      sheet_1: { name: '重要角色表', content: [['姓名', '性别', '身份', '态度'], ['白鸟', '男', '同学', '友好'], ['苏晴', '女', '同学', '友好']] },
      sheet_2: { name: '全局数据表', content: [['地点', '时间', 'NSFW'], ['东京', '2026年9月3日 15:00', '否']] },
    }),
  };
  dom.window.TavernHelper = {
    substitudeMacros: (s) => s,
    getChatMessages: () => [],
    getLastMessageId: () => -1,
    getCharWorldbookNames: () => ({ primary: null, additional: [] }),
    getWorldbook: async () => [],
    injectPrompts: async (prompts) => { injectedCalls.push(...prompts); },
    generateRaw: async (req) => {
      rawRequests.push(req);
      return `<ubp_social>{"feedback":[{"target":"weibo","postId":"${postIdCreated}","comments":[{"name":"白鸟","c":"这就去看看","t":"2026年9月3日 15:02"}]},{"target":"moments","postId":"p_mom_existing","likes":["苏晴"],"comments":[{"name":"白鸟","c":"赞我干嘛呀","reply":"桃井奈奈","t":"2026年9月3日 15:03"}]}]}</ubp_social>`;
    },
  };

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  try {
    const mod = await loadTsBundle(`
      export { setConfig } from './src/unified-statusbar/core/config-store.ts';
      export { savePhoneSettings } from './src/UBS_phone/core/phone-settings.ts';
      export { mutatePhoneData, readPhoneData } from './src/UBS_phone/core/phone-store.ts';
      export { createUserPost, toggleLike, requestSocialFeedback, getPendingActions } from './src/UBS_phone/core/social-engine.ts';
    `, 'social-feedback-dossier-bundle.ts');

    mod.setConfig('customApiPresets', [{
      id: 'p-test', name: '测试', url: 'http://127.0.0.1:3001/v1', key: 'sk-test',
      model: 'gemini-2.5-pro', maxTokens: 'unset', temperature: 1, topP: 'unset', topK: 'unset',
      frequencyPenalty: 'unset', presencePenalty: 'unset', createdAt: 1,
    }]);
    await mod.savePhoneSettings({ apiMode: 'global', apiPresetId: 'p-test' });

    // 预置一条带现有评论的朋友圈，测试点赞 + 微博发帖两种待反馈动作
    mod.mutatePhoneData((d) => {
      d.social = {
        moments: [{
          id: 'p_mom_existing',
          author: '白鸟',
          text: '午后红茶好喝',
          imageDesc: '',
          likes: [],
          comments: [{ name: '路人甲', text: '哪家买的', time: '2026年9月3日 14:10' }],
          timeLabel: '2026年9月3日 14:00',
          createdAt: 1,
        }],
        tieba: [],
        weibo: [],
        xhs: [],
        bars: [],
        trending: [],
        refreshedAt: 1,
        pending: [],
      };
    });

    const created = mod.createUserPost({ kind: 'weibo', text: '今天在天台晒太阳' });
    postIdCreated = created.postId;
    const likeRes = mod.toggleLike('moments', 'p_mom_existing');
    assert.equal(likeRes.liked, true);
    assert.equal(mod.getPendingActions().length, 2);

    const fbRes = await mod.requestSocialFeedback();
    assert.equal(fbRes.applied, 3, '应成功解析并应用微博评论 + 朋友圈点赞与评论');

    // 1. injectPrompts 仅用于 position:'none' 绿灯触发，绝不再走失效的 after_system
    assert.ok(injectedCalls.length > 0, '应触发绿灯扫描注入');
    for (const item of injectedCalls) {
      assert.equal(item.position, 'none', '资料块不得再走 injectPrompts(after_system/in_chat)');
    }

    // 2. generateRaw.ordered_prompts 直接包含资料块，含待反馈互动与现有评论
    assert.equal(rawRequests.length, 1);
    const req = rawRequests[0];
    assert.equal(req.ordered_prompts.includes('chat_history'), false, '仍不带 chat_history');
    const inlineSystemTexts = req.ordered_prompts
      .filter((item) => item && typeof item === 'object' && item.role === 'system')
      .map((item) => item.content);
    const dossier = inlineSystemTexts.find((c) => c.includes('■ 待反馈的用户互动'));
    assert.ok(dossier, 'ordered_prompts 中必须直接包含「■ 待反馈的用户互动」资料块');
    assert.ok(dossier.includes(postIdCreated), '资料块应含用户新发微博 postId');
    assert.ok(dossier.includes('今天在天台晒太阳'), '资料块应含用户新发微博正文');
    assert.ok(dossier.includes('p_mom_existing'), '资料块应含被点赞朋友圈 postId');
    assert.ok(dossier.includes('现有评论：路人甲：哪家买的'), '资料块应含现有评论防重复');
    assert.ok(dossier.includes('主角动作：发了帖') && dossier.includes('主角动作：点赞了'), '资料块应含发帖与点赞动作');

    // 3. 回应落盘并清空 pending
    assert.equal(mod.getPendingActions().length, 0, '求回应成功后 pending 须清空');
    const afterSocial = mod.readPhoneData().social;
    const wbPost = afterSocial.weibo.find((p) => p.id === postIdCreated);
    assert.equal(wbPost?.comments.length, 1);
    assert.equal(wbPost?.comments[0].name, '白鸟');
    const momPost = afterSocial.moments.find((p) => p.id === 'p_mom_existing');
    assert.ok(momPost?.likes.includes('苏晴'));
    assert.equal(momPost?.comments.length, 2);
  } finally {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    dom.window.close();
  }
});
