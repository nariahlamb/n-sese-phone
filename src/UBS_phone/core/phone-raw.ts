// ===== 小手机「裸生成」标准模板（chat / call / social / spy 四个 1A 级请求的唯一事实源） =====
//
// 契约（对齐 CLAUDE.md 与主项目 claude_memory/ai-request-pipeline.md「标准结构」）：
//   ordered_prompts 全槽位：jailbreak(system) → world_info_before → persona_description
//     → char_description → char_personality → scenario → world_info_after
//     → dialogue_examples → chat_history → user_input
//   max_chat_history 硬编码 0（原生 chat_history 不带楼层；at_depth 世界书条目仍照常插入）
//   user_input = 本功能指令，走 'user_input' 槽位，内容由功能决定，不参与绿灯扫描。
//   绿灯扫描文本 = 真实酒馆聊天（按全局 scan_depth）+ 触发注入；user_input/资料块不参与。
//
// 扫描前统一：剔除数据库纪要自投影条目（纪要已走资料块，防重复回喂）+ [UBS手机] 前缀条目
// 按族 keep 豁免 + EJS 预渲染（withNativeScanWorldbook）。
//
// ★ 不含 th 守卫、validatePhoneApi 闸门、generation 记账：三者的时机语义各引擎不同
//   （闸门必须在注入触发/资料块之前；记账形态 chat=Map<convId,Set> / 其余=Set），留在调用侧。
//
// ★ 游戏中心（2 类轻量管线）刻意不走本模板：其形状为 system + 'user_input' + 结构尾三槽，
//   且禁 world_info 槽位与 injectPrompts（tests/phone-game-ui.test.ts 锁定），继续自拼。

import { CHRONICLE_WB_PREFIX } from '../../unified-statusbar/core/chronicle-blocks';
import { getJailbreakHeadPrompts, getJailbreakTailPrompts } from '../../unified-statusbar/core/jailbreak-config';
import { wbEntryName, withNativeScanWorldbook, type NativeScanPrepareOptions } from '../../unified-statusbar/core/worldbook-entry';
import { getTavernHelper, stopGenerationById } from './host-env';
import { resolvePhoneApi, getPhoneAiRetryOptions, withPhoneTextAiRetry } from './phone-api';
import {
  beginPhoneAiActivity, updatePhoneAiActivity,
  type PhoneAiActivityHandle, type PhoneAiTone,
} from './ai-activity';
import { PhoneChatError } from './phone-error';
import type { PhoneApiScopeKey } from './phone-settings';

/**
 * 1A 全槽位（单一事实源；chat/call/social/spy 共用）。
 * ★ 必须是函数而非模块级常量：破限头/尾部破限需按请求实时求值
 *   （破限与反八股配置可被用户随时改；且模块求值时机早于宿主配置就绪，冻结会拿到空破限）。
 */
export function phoneFullSlots() {
  return [
    ...getJailbreakHeadPrompts({ antiCliche: true }),
    'world_info_before', 'persona_description', 'char_description', 'char_personality',
    'scenario', 'world_info_after', 'dialogue_examples', 'chat_history', 'user_input',
    ...getJailbreakTailPrompts(),
  ] as const;
}

/**
 * 世界书扫描选项：纪要自投影 suspend（防回喂）+ [UBS手机] 前缀条目按族 keep 豁免。
 * keep 语义（放行族）由调用方决定：
 *   聊天/通话/社媒 = keepSpyAndPublicEntries（放行窥私族 + 公共舆论条目）
 *   窥私 = keepPhoneRecordEntries（另放行消息记录族；其资料块无消息记录段）
 */
export function phoneScanOptions(keep: (name: string) => boolean): NativeScanPrepareOptions {
  return { suspend: (e: any) => wbEntryName(e).startsWith(CHRONICLE_WB_PREFIX), keep };
}

export interface PhoneRawArgs {
  /** 请求 API 预设 scope（通话与聊天同用 'chat'，与原实现一致）。 */
  scope: PhoneApiScopeKey;
  /** 已做宏替换的指令文本（走 user_input 槽位）。 */
  instruction: string;
  /** 可中止的 generation id（记账在调用侧）。 */
  generationId: string;
  /** 扫描期 [UBS手机] 前缀条目的 keep 谓词。 */
  keep: (name: string) => boolean;
  /**
   * 每次尝试前重跑的一次性注入（绿灯触发 + 资料块）。
   * once:true 的语义是「只在下一次请求生成中有效」——注入若只做一次，自动重试的那一发就会
   * 丢掉资料块与触发素材，因此由本函数在每个尝试前调用（关闭重试时也只调用一次）。
   */
  prepare?: () => void | Promise<void>;
  /**
   * 统一 AI 活动登记（可选）：灵动岛/收起浮球/宿主聚合通知的数据源。
   * onCancel 由各引擎提供（abortXxx）；注册表取消时还会 stopGenerationById(generationId)。
   */
  activity?: {
    feature: string;
    label: string;
    appId?: string;
    tone?: PhoneAiTone;
    suppressToast?: boolean;
    onCancel?: () => void;
  };
}

/**
 * 裸生成：全槽位 + max_chat_history 0 + custom_api + generation_id 可中止。
 * 返回非空文本（已 trim 判定）；失败抛 PhoneChatError（env/network/parse）。
 * 「空内容」判定在 try 之外，故不会被包成 network——与原四引擎实现逐字一致。
 */
export async function runPhoneRaw(args: PhoneRawArgs): Promise<string> {
  const th = getTavernHelper();
  if (!th?.generateRaw || !th?.injectPrompts) {
    throw new PhoneChatError('env', '无法访问酒馆助手 API（generateRaw/injectPrompts），请检查酒馆助手版本');
  }
  let raw: unknown;
  let activity: PhoneAiActivityHandle | null = null;
  let controller: AbortController | null = null;
  const spec = args.activity;
  if (spec) {
    controller = new AbortController();
    activity = beginPhoneAiActivity({
      feature: spec.feature,
      label: spec.label,
      phase: 'preparing',
      generationId: args.generationId,
      appId: spec.appId,
      tone: spec.tone || 'ai',
      cancelable: true,
      suppressToast: spec.suppressToast === true,
      cancel: () => {
        if (activity) updatePhoneAiActivity(activity.id, { phase: 'terminating' });
        try { spec.onCancel?.(); } catch (_e) { /* ignore */ }
        try { controller?.abort(); } catch (_e) { /* ignore */ }
        stopGenerationById(args.generationId);
      },
    });
  }
  try {
    raw = await withPhoneTextAiRetry(args.scope, async () => {
      // 一次性注入必须每次尝试前重跑（见 PhoneRawArgs.prepare 注释）
      if (args.prepare) await args.prepare();
      if (controller?.signal.aborted) throw new Error('请求已取消');
      return await withNativeScanWorldbook(
        phoneScanOptions(args.keep),
        () => th.generateRaw({
          should_silence: true,
          user_input: args.instruction,
          ordered_prompts: phoneFullSlots(),
          max_chat_history: 0,
          custom_api: resolvePhoneApi(args.scope).api,
          generation_id: args.generationId,
        }),
      );
    }, {
      signal: controller?.signal,
      activityId: activity?.id,
      maxAttempts: getPhoneAiRetryOptions(args.scope).attempts ?? 1,
    });
  } catch (error) {
    // 用户终止（活动取消会 abort 本控制器）：静默收口，UI 不报网络错误
    if (controller?.signal.aborted) throw new PhoneChatError('aborted', '已终止本次生成');
    const message = error instanceof Error ? error.message : String(error);
    throw new PhoneChatError('network', `AI 请求失败：${message}`);
  } finally {
    activity?.end();
  }
  const text = String(raw ?? '');
  if (!text.trim()) {
    throw new PhoneChatError('parse', 'AI 返回了空内容');
  }
  return text;
}
