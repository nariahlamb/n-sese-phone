// ===== 通话/聊天背景（每角色一张，独立保存，docs/05 §6） =====
// 通话背景按角色名 key（默认回落头像）；聊天背景按会话 id key（p:名字 / g:xxx，群聊同样支持）。
// 四个图源：本地导入（主项目图床 phone 目录，phone_img_ 前缀）/ 主项目立绘图库 /
// 主项目正文插图图库（usb_global_story-images_*，手机端只读，照 storage-bootstrap 的
// createGlobalStore('story-images') 同参重建——信封 load 一次性守卫决定了重读必须换实例；
// **只取当前角色卡那一批**，见 storyGalleryImages）/ 小手机相册。
// 图本体都已是 /user/images/ 路径，背景映射只存路径，不复制图片数据。

import { getCurrentCardName } from '../../unified-statusbar/core/current-card';
import { createExternalObjectStore } from '../../unified-statusbar/core/external-object-store';
import { uploadGeneratedImage } from '../../unified-statusbar/core/image-storage';
import { createServerFileStore } from '../../unified-statusbar/core/server-file-store';
import {
  configureStoryImageGalleryStorage,
  readStoryImageGallery,
  type StoryImageEntry,
} from '../../unified-statusbar/core/story-image-gallery-store';
import { mutatePhoneData, readPhoneDataRef } from './phone-store';
import type { PhoneChatData } from './chat-model';

// ─── 读写（通话=名字 key；聊天=会话 id key） ───
// 三个读口都带可选 data（同一渲染帧内已有 data 时传入复用）；缺省走 readPhoneDataRef 零拷贝
// ——三者都只读映射取字符串，不深拷贝（纪律见 phone-store.readPhoneDataRef）。

export function readCallBg(name: string, data: PhoneChatData = readPhoneDataRef()): string {
  return (data.callBgs || {})[name] || '';
}

export function setCallBg(name: string, path: string): void {
  if (!name.trim() || !path) return;
  mutatePhoneData(d => { d.callBgs = { ...(d.callBgs || {}), [name]: path }; });
}

export function clearCallBg(name: string): void {
  mutatePhoneData(d => { if (d.callBgs) delete d.callBgs[name]; });
}

export function readChatBg(convId: string, data: PhoneChatData = readPhoneDataRef()): string {
  return (data.chatBgs || {})[convId] || '';
}

export function setChatBg(convId: string, path: string): void {
  if (!convId || !path) return;
  mutatePhoneData(d => { d.chatBgs = { ...(d.chatBgs || {}), [convId]: path }; });
}

export function clearChatBg(convId: string): void {
  mutatePhoneData(d => { if (d.chatBgs) delete d.chatBgs[convId]; });
}

// ─── 主界面壁纸（桌面背景；单值路径，空=默认渐变底） ───

export function readHomeBg(data: PhoneChatData = readPhoneDataRef()): string {
  return data.homeBg || '';
}

export function setHomeBg(path: string): void {
  if (!path) return;
  mutatePhoneData(d => { d.homeBg = path; });
}

export function clearHomeBg(): void {
  mutatePhoneData(d => { d.homeBg = ''; });
}

// ─── 锁屏壁纸（锁屏背景；单值路径，空=默认深色渐变底；与主界面壁纸各自独立） ───

export function readLockBg(data: PhoneChatData = readPhoneDataRef()): string {
  return data.lockBg || '';
}

export function setLockBg(path: string): void {
  if (!path) return;
  mutatePhoneData(d => { d.lockBg = path; });
}

export function clearLockBg(): void {
  mutatePhoneData(d => { d.lockBg = ''; });
}

// ─── 主项目文生图图库（手机端只读加载；一次会话内缓存，picker 打开时可强制重读） ───

let _galleryLoaded = false;

/** 重建全局图库 store 并加载（对齐主项目 createGlobalStore('story-images') 的文件协议）。 */
export async function loadStoryImageGallery(force = false): Promise<boolean> {
  if (_galleryLoaded && !force) return true;
  try {
    const store = createExternalObjectStore({
      files: createServerFileStore(),
      namespace: 'story-images',
      writerId: 'ubp-phone',
      now: () => Date.now(),
      makeId: (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    });
    await store.load();
    configureStoryImageGalleryStorage(store);
    _galleryLoaded = true;
    return true;
  } catch (_e) {
    return false;
  }
}

/** **当前角色卡**对应的文生图条目（新→旧；认不出当前卡=空数组）。
 *  主项目插图图库是全局的（跨聊天/跨角色卡共享，条目带来源卡名 charName），小手机只用当前这张卡的：
 *  charName 由主项目 `getCurrentCardName()` 写入，此处用同一函数取值——口径与写入侧严格一致
 *  （群聊取 name2，其余取 characters[characterId].name）；不自行另写一套角色名解析。 */
export function storyGalleryImages(): StoryImageEntry[] {
  try {
    const card = getCurrentCardName();
    if (!card) return [];
    return readStoryImageGallery().filter(e => e.charName === card);
  } catch (_e) {
    return [];
  }
}

// ─── 本地导入（dataUrl → 图床 phone 目录；phone_img_ 前缀与 deletePhoneImage 白名单兼容） ───
// 统一选图弹层所有「导入图片」共用（头像/背景/封面/壁纸），故取中性前缀。

export async function importPhoneImageFromDataUrl(dataUrl: string): Promise<string> {
  const stem = `phone_img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const result = await uploadGeneratedImage(dataUrl, 'phone', stem);
  if (!result.path) throw new Error(result.error || '背景上传失败');
  return result.path;
}