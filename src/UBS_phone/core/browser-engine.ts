// ===== 幻想浏览器 · 引擎（第八轮 §5 · N8）=====
// 三段式管线（镜像 call-engine/social-engine 的收编件）：
//   ① 绿灯触发注入 ubp_browser_trigger（position:'none' + should_scan）——点了搜索才注入（零常驻）
//   ② 资料块 ubp_browser_dossier（after_system）——主角档案 + 在场状态 + 最近正文 + 手机既有记录
//   ③ runPhoneRaw（全槽位 + max_chat_history 0 + generation_id 可中止）
// 解析失败抛可读错误（不静默）；落库与盖戳由调用方（app-browser）处理。

import { stripWithContextConfig } from '../../unified-statusbar/core/context-strip';
import { readChronicleDossierBlocks } from '../../unified-statusbar/core/chronicle-blocks';
import { PhoneChatError, readAiChatHistory } from './chat-engine';
import { getTavernHelper, makeGenerationId, stopGenerationById } from './host-env';
import { keepSpyAndPublicEntries } from './message-worldbook';
import { mergeOneShotHint } from './extra-hint';
import { buildMixedRecords } from './phone-timeline';
import { readPhoneData } from './phone-store';
import { getPhoneSettings } from './phone-settings';
import { validatePhoneApi } from './phone-api';
import { runPhoneRaw } from './phone-raw';
import { getRoster } from './roster';
import { buildBrowserDossierText, buildBrowserInstruction, buildBrowserTriggerText } from './browser-prompts';
import { parseBrowserReply } from './browser-parser';
import type { BrowserPage } from './browser-model';
import type { RosterSnapshot } from './roster';

export interface BrowserEngineResult {
  /** 解析出的搜索词（空则回落用户输入）。 */
  query: string;
  results: BrowserPage[];
  /** 请求实际使用的风格（调用方盖戳用）。 */
  style: string;
}

/** 当前进行中的浏览器 generation id 集合（中止用；与聊天/通话生成独立计数）。 */
const _activeGenerations = new Set<string>();

/** 终止当前全部浏览器生成。返回是否有请求被终止。 */
export function abortBrowserGeneration(): boolean {
  let stopped = false;
  for (const id of _activeGenerations) {
    if (stopGenerationById(id)) stopped = true;
  }
  _activeGenerations.clear();
  return stopped;
}

/** 生成一次「网页结果」（AI 按世界观编；前端只展示，绝不发起真实请求）。 */
export async function generateBrowserSearch(args: {
  query: string;
  rosterOverride?: RosterSnapshot;
}): Promise<BrowserEngineResult> {
  const th = getTavernHelper();
  if (!th?.generateRaw || !th?.injectPrompts) {
    throw new PhoneChatError('env', '无法访问酒馆助手 API（generateRaw/injectPrompts），请检查酒馆助手版本');
  }
  const apiError = validatePhoneApi('chat');
  if (apiError) throw new PhoneChatError('api', apiError);

  const settings = getPhoneSettings() as {
    summaryCount?: number; chatHistoryCount?: number; phoneHistoryCount?: number; extraPrompt?: string;
  };
  const roster = args.rosterOverride ?? getRoster();
  const phoneData = readPhoneData();
  const style = phoneData.style || '';
  const chronicleBlocks = readChronicleDossierBlocks([roster.protagonistName || '我'], Number(settings.summaryCount) || 5);
  const storyText = stripWithContextConfig(readAiChatHistory(Number(settings.chatHistoryCount) || 5));
  const mixedRecords = buildMixedRecords({
    names: [roster.protagonistName || '我'],
    conversations: phoneData.conversations,
    groupConversations: [],
    calls: phoneData.calls || [],
    moments: phoneData.social?.moments || [],
    me: roster.protagonistName,
    count: Number(settings.phoneHistoryCount) || 8,
    style: phoneData.style || '',
  });
  const mergedExtra = mergeOneShotHint(String(settings.extraPrompt || ''), undefined);

  const prepare = async (): Promise<void> => {
    await th.injectPrompts([{
      id: 'ubp_browser_trigger',
      position: 'none',
      depth: 0,
      role: 'system',
      content: [buildBrowserTriggerText({ query: args.query, roster, style }), mergedExtra.trim()].filter(Boolean).join(' '),
      should_scan: true,
    }], { once: true });
    await th.injectPrompts([{
      id: 'ubp_browser_dossier',
      position: 'after_system',
      depth: 0,
      role: 'system',
      content: buildBrowserDossierText({
        roster, query: args.query, chronicleBlocks, storyText, mixedRecords, style,
      }),
      should_scan: false,
    }], { once: true });
  };

  const instructionText = buildBrowserInstruction({ roster, query: args.query, extraPrompt: mergedExtra, style });
  const instruction = th.substitudeMacros ? th.substitudeMacros(instructionText) : instructionText;
  const generationId = makeGenerationId('ubp-browser');
  _activeGenerations.add(generationId);
  let raw = '';
  try {
    raw = await runPhoneRaw({
      scope: 'chat',
      instruction,
      generationId,
      keep: keepSpyAndPublicEntries,
      prepare,
      activity: {
        feature: '浏览器',
        label: '浏览器',
        appId: 'browser',
        tone: 'ai',
        onCancel: () => { abortBrowserGeneration(); },
      },
    });
  } finally {
    _activeGenerations.delete(generationId);
  }

  const parsed = parseBrowserReply(String(raw));
  if (!parsed || !parsed.results.length) {
    throw new PhoneChatError('parse', 'AI 没有按格式给出网页结果：换一个搜索词再试一次');
  }
  return { query: parsed.query || args.query, results: parsed.results, style };
}
