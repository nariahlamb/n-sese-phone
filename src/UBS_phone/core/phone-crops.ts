// ===== 取景参数（非破坏性裁剪；docs/13） =====
// 只存 {x,y,z,r,a} 五个数：平移(% of 媒体层自身尺寸)/缩放(1~3)/旋转(90° 步进)/原图宽高比。
// 不动原图、零新增文件。
//
// 渲染口径分两代，同一函数内按 a 有无分派 ⇒ 历史数据零迁移：
//   · 新口径（有 a）：媒体层 = 「cover 后的整张图」——按 aspect-ratio 定形、min 尺寸带缩放 z，
//     居中后整体 translate/rotate，由显示位 overflow:hidden 裁剪。
//     整张图都在媒体层里 ⇒ 平移能把照片任意高度（含顶部）移进窗口。
//   · 旧口径（无 a，历史数据）：媒体层铺满容器 + translate/scale。
//     该口径下 cover 会先按居中把图裁进容器、裁掉的像素当场丢弃，平移拉不回来——
//     这正是「封面长横条选不到照片上半部分」的成因；此处仅为旧数据保留逐字节同观感。
// 默认 {0,0,1,0} 与未取景同观感 ⇒ 无参数时样式函数返回空串（零 style 输出，零开销纪律）。
// 槽位：av:<名>（单人头像，avatarHtml 一处覆盖全部头像位）/ cv:<会话id>（群头像）/
//       cb:<名>（通话背景 .ubp-call-bg）/ bg:<会话id>（聊天背景 .ubp-chat-bg）/ 
//       home（主界面壁纸 .ubp-home-bg）/ lock（锁屏壁纸 .ubp-lock-bg）/ wb:<名>（微博作者封面）。

import { normalizeCropParams, type PhoneCropParams } from './chat-model';
import { mutatePhoneData, readPhoneDataRef } from './phone-store';

/** 读某槽位取景参数（无=undefined；读口走 readPhoneDataRef 只读引用，热路径合规）。 */
export function readCrop(slot: string): PhoneCropParams | undefined {
  return readPhoneDataRef().crops?.[slot];
}

export function hasCrop(slot: string): boolean {
  return Boolean(readCrop(slot));
}

/** 写/清某槽位取景参数（null=清除；落盘走 mutatePhoneData 去抖通道）。 */
export function setCrop(slot: string, params: PhoneCropParams | null): void {
  if (!slot) return;
  mutatePhoneData(d => {
    if (!params) {
      if (d.crops) delete d.crops[slot];
      return;
    }
    const safe = normalizeCropParams(params);
    if (!safe) return;
    if (!d.crops) d.crops = {};
    d.crops[slot] = safe;
  });
}

/** 数值 → style 片段：保留 3 位小数，消掉浮点噪声。 */
function n(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** 参数 → 媒体层 style 片段。含 a=新口径（尺寸 + 居中 + 平移/旋转）；缺 a=旧口径（铺满容器 + 平移/缩放）。 */
export function cropMediaStyleOf(params: PhoneCropParams | undefined): string {
  if (!params) return '';
  if (params.a === undefined) {
    return `inset:0;width:100%;height:100%;transform:translate(${n(params.x)}%,${n(params.y)}%) scale(${n(params.z)}) rotate(${params.r}deg)`;
  }
  return `left:50%;top:50%;right:auto;bottom:auto;aspect-ratio:${n(params.a)};`
    + `min-width:calc(100% * ${n(params.z)});min-height:calc(100% * ${n(params.z)});`
    + `transform:translate(-50%,-50%) translate(${n(params.x)}%,${n(params.y)}%) rotate(${params.r}deg)`;
}

/** 槽位 → 媒体层 style 片段（无参数=空串 ⇒ 调用方不输出 style 属性，渲染逐字节等于现状）。 */
export function cropMediaStyle(slot: string): string {
  return cropMediaStyleOf(readCrop(slot));
}
