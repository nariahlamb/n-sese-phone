// ===== 服务商音色列表拉取（有公开列表接口的家：Fish / MiniMax / ElevenLabs）=====
// 纯网络层：给定「服务商 + 凭据 + 合成地址」，拉回该账号的音色池（含克隆音色）。
// 回退口径与合成一致：直连 → 酒馆 /proxy/ → 可读报错。解析在 voice-providers 的 VOICE_FETCHERS。

import { VOICE_FETCHERS, normalizeVoiceFetchResult, resolveProvider } from './voice-providers';
import type { VoiceOption } from './voice-mapping';
import { hostWindow } from './host-env';

export interface VoiceListCred {
  key?: string;
  appId?: string;
}

/** 一页拉取结果：选项 + 下一页游标（无 = 已到底）。 */
export interface VoiceListPage {
  options: VoiceOption[];
  next?: string;
}

function stRequestHeaders(): Record<string, string> {
  try {
    const w = hostWindow() as any;
    const st = w?.SillyTavern || (typeof window !== 'undefined' ? (window as any).SillyTavern : null);
    const ctx = st && typeof st.getContext === 'function' ? st.getContext() : st;
    if (ctx && typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
  } catch (_e) { /* ignore */ }
  return {};
}

/** 拉取某家的音色列表**一页**；无公开接口的家抛可读错误（引导手填）。
 *  filters = 已选筛选值（由 resolveVoiceFilters 归一；空值项不传），见 voice-providers.VoiceFilterSpec。
 *  page = 上一页回传的 next（首页不传）；返回里的 next 供「再拉一页」继续透传。 */
export async function fetchProviderVoices(
  providerId: string,
  cred: VoiceListCred,
  url: string,
  filters?: Readonly<Record<string, string>>,
  page?: string,
): Promise<VoiceListPage> {
  const provider = resolveProvider(providerId);
  const fetcher = VOICE_FETCHERS[provider.id];
  if (!fetcher) {
    throw new Error(`${provider.name} 没有公开的音色列表接口：请在「音色池」手填音色 id（每行一个）`);
  }
  const base = String(url || '').trim() || provider.baseUrl;
  const picked = filters || {};
  const cursor = String(page ?? '').trim();
  const target = fetcher.listUrl(base, cred, picked, cursor || undefined);
  const init: RequestInit = { method: fetcher.method, headers: fetcher.headers(cred) };
  if (fetcher.method === 'POST') init.body = JSON.stringify(fetcher.body ? fetcher.body(cred, picked) : {});

  let json: any = null;
  let serverSaid = '';
  // ① 直连
  try {
    const resp = await fetch(target, init);
    if (resp.ok) json = await resp.json();
    else serverSaid = `HTTP ${resp.status}：${(await resp.text().catch(() => '')).slice(0, 200)}`;
  } catch (_e) { /* 网络/CORS → 落代理 */ }
  // ② 酒馆 CORS 代理
  if (!json && !serverSaid) {
    try {
      const proxied = '/proxy/' + encodeURIComponent(target);
      const resp = await fetch(proxied, { ...init, headers: { ...(init.headers as Record<string, string>), ...stRequestHeaders() } });
      if (resp.ok) json = await resp.json();
      else serverSaid = `HTTP ${resp.status}`;
    } catch (_e2) { /* 落 ③ */ }
  }
  if (!json) {
    throw new Error(serverSaid || '拉取音色失败：地址/密钥不对，或被跨域拦截（可在酒馆 config.yaml 打开 enableCorsProxy）');
  }
  const result = normalizeVoiceFetchResult(fetcher.parse(json, cursor || undefined));
  // 首页空 = 配置/账号问题，如实报错；翻页空 = 接口已到底的正常形态（交给调用方收「已到底」）。
  if (!result.options.length && !cursor) {
    throw new Error('接口返回里没有解析到音色：确认密钥有效、账号下有音色');
  }
  return result;
}
