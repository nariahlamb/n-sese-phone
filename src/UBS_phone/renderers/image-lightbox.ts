// ===== 图片放大 · 重新生图（全机唯一入口，所有 App 共用） =====
// 成品图（ready）点击放大一律走这里：宿主页三槽灯箱（主项目 __ub_openLightbox 桥）+ 底部「换一张」。
// 重绘按**相册生图档案重放**（regenAlbumImage：全机引用替换 + 删旧文件 + 通道按小手机 imageMode），
// 与相册 App「换一张」同一条链路——本模块只是把它接到放大页上，不另开生图口径。
// 未生成/失败占位不在此列：占位点击＝各自管线生成/重试（语义不同，刻意不统一）。
// 老主项目兼容：桥不认识 onRegenerate 字段时自动退化为纯浏览（无重绘按钮）；桥完全缺失＝新窗口打开。

import { hostWindow } from '../core/host-env';
import { findReplayableAlbumEntryByPath, regenAlbumImage } from '../core/phone-album';
import { S } from '../core/skins';
import { emitPhoneEvent } from './app-registry';
import { showScreenToast } from './phone-ui';

export interface PhoneLightboxOptions {
  /** 浏览序列（ready 成品图的路径；空串自动剔除）。 */
  paths: string[];
  /** 起始下标（缺省 0，越界自动夹取）。 */
  startIndex?: number;
}

export type PhoneImageRegenResult = { ok: true; path: string } | { ok: false; error: string };

/** 按 path 反查相册档案重绘（同 path 多条条目时取可重放的那条；无档案＝失败）。
 *  成功链路与相册「换一张」完全一致，其中同 path 的兄弟条目也在 regenAlbumImage 内一并跟随。 */
export async function regenPhoneImageByPath(path: string): Promise<PhoneImageRegenResult> {
  const hit = findReplayableAlbumEntryByPath(path);
  if (!hit) return { ok: false, error: S('这张图没有完整生图档案，无法重新生图', '此影未录完整生图档案，无法重新显影') };
  const result = await regenAlbumImage(hit.id);
  if (result.ok) emitPhoneEvent('ubp-phone:data-changed');
  return result;
}

/** 打开全机统一放大页（含「换一张」重绘入口）。container 用于屏内轻提示（失败原因/成功回执）。 */
export function openPhoneLightbox(container: HTMLElement | null | undefined, opts: PhoneLightboxOptions): void {
  const target = opts.paths[Math.max(0, Math.min(opts.paths.length - 1, Math.floor(opts.startIndex || 0)))];
  const paths = opts.paths.filter(p => Boolean(p));
  if (!target || !paths.length) return;
  const startIndex = Math.max(0, paths.indexOf(target));   // 剔除空串后按下标可能错位：按目标路径重新定位
  const w = hostWindow() as { __ub_openLightbox?: (args: unknown) => void };
  if (typeof w.__ub_openLightbox !== 'function') {
    window.open(target, '_blank');   // 主项目未加载/版本过旧：退化为直接打开（改造前行为）
    return;
  }
  w.__ub_openLightbox({
    paths,
    startIndex,
    regenLabel: S('换一张', '再显一影'),
    onRegenerate: async ({ path }: { path: string }) => {
      const r = await regenPhoneImageByPath(path);
      if (!r.ok) {
        if (container) showScreenToast(container, r.error);
        return null;
      }
      if (container) showScreenToast(container, S('已重新生成（旧图已替换）', '已重新显影（旧影已替）'));
      return { path: r.path };
    },
  });
}
