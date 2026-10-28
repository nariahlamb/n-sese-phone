// ===== 今日天气（只读主项目日历，docs/03 联动） =====
// 主项目日历的「今日天气」是单条文本（大类:描述，如「晴:22℃，微风…」），存剧情楼层存储
// core 域 journal（usb_story_core_<hash>.json，信封 kind 'story-core'，key='calendar'）。
// 手机 bundle 有自己一份 story-floor-store 实例（永不 bootstrap，D 级写入域），其
// readStoryFeature 在未配置时静默回 fallback——**不能** import calendar-core 的
// getTodayWeather（读链恒空）。照 map-locations 先例：直读信封 + story-domain-store
// 纯函数重放（A 级只读复用），解析与主项目 parseWeatherText 同口径（半角冒号两段非空）。
// 加 60s TTL 缓存 + 主项目落盘事件失效（ub-story-state-invalidated / 存储就绪），
// 无轮询、无监听副作用。

import {
  createAtomicEnvelopeStore,
  type AtomicEnvelopeStore,
} from '../../unified-statusbar/core/atomic-envelope-store';
import { chatStorageHash } from '../../unified-statusbar/core/chat-storage-identity';
import { createServerFileStore, type ServerFileStore } from '../../unified-statusbar/core/server-file-store';
import {
  isStoryDomainJournal,
  replayStoryDomainJournal,
} from '../../unified-statusbar/core/story-domain-store';
import { hostWindow } from './host-env';
import { currentPhoneStorageId } from './phone-store';
import { isRecord } from './ubp-utils';

export interface PhoneWeather {
  /** 天气大类（晴/多云/阴/雨/雪/雾/沙尘/冰雹/台风）。 */
  category: string;
  /** 感官描述（含温度等，10-30 字）。 */
  description: string;
}

export interface PhoneWeatherDeps {
  /** 测试注入；缺省用当前聊天身份。 */
  storageId?: string;
  files?: ServerFileStore;
  now?: () => number;
}

/** 解析「大类:描述」单行文本（对齐主项目 parseWeatherText：半角冒号分隔，两段均非空）。 */
function parseWeatherText(text: string): PhoneWeather | null {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return null;
  const colonIdx = normalized.indexOf(':');
  if (colonIdx === -1) return null;
  const category = normalized.substring(0, colonIdx).trim();
  const description = normalized.substring(colonIdx + 1).trim();
  if (!category || !description) return null;
  return { category, description };
}

const WEATHER_TTL_MS = 60_000;
let _cache: { storageId: string; at: number; value: PhoneWeather | null } | null = null;

/** 缓存失效（主项目落盘事件回调 / 测试用）。 */
export function clearWeatherCache(): void {
  _cache = null;
}

/**
 * 绑定主项目事件驱动的缓存失效（守卫防重，幂等）。功能未触发（从未读过天气）前不绑定。
 * - ub-story-state-invalidated：主项目 journal flush 落盘完成后派发——磁盘此时才有新天气；
 * - ub-statusbar-storage-ready：存储重绑/重置（同 storageId 文件可能被重建）。
 */
function bindWeatherInvalidation(): void {
  const w = hostWindow() as unknown as { __ubp_weather_bound?: boolean; addEventListener?: unknown };
  if (w.__ubp_weather_bound) return;
  if (typeof w.addEventListener !== 'function') return;
  w.__ubp_weather_bound = true;
  try {
    w.addEventListener('ub-story-state-invalidated', () => { _cache = null; });
    w.addEventListener('ub-statusbar-storage-ready', () => { _cache = null; });
  } catch (_e) {
    w.__ubp_weather_bound = false;
  }
}

/** 今日天气（未生成/解析失败/存储未就绪 = null，桌面隐藏天气行）。 */
export async function readTodayWeather(deps: PhoneWeatherDeps = {}): Promise<PhoneWeather | null> {
  bindWeatherInvalidation();
  const storageId = deps.storageId ?? currentPhoneStorageId();
  if (!storageId) return null;
  const now = deps.now ?? (() => Date.now());
  if (_cache && _cache.storageId === storageId && now() - _cache.at < WEATHER_TTL_MS) return _cache.value;
  let value: PhoneWeather | null = null;
  try {
    const store: AtomicEnvelopeStore<Record<string, unknown>> = createAtomicEnvelopeStore({
      files: deps.files ?? createServerFileStore(),
      filename: `usb_story_core_${chatStorageHash(storageId)}.json`,
      kind: 'story-core',
      scopeId: storageId,
      domainCreated: true, // 只读挂载：不参与主项目 domainsCreated 域标记
      emptyValue: {},
      now,
    });
    const status = await store.load();
    if (status.state === 'ready' || status.state === 'uninitialized') {
      const raw = store.readAll();
      const all = isStoryDomainJournal(raw) ? replayStoryDomainJournal(raw) : raw;
      const story = all['calendar'];
      if (isRecord(story) && isRecord(story.future) && typeof story.future.weather === 'string') {
        value = parseWeatherText(story.future.weather);
      }
    }
  } catch (_e) {
    value = null;
  }
  _cache = { storageId, at: now(), value };
  return value;
}

