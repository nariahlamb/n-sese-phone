// —— 智慧姬（st-chatu8）生图桥 ——
// OpenAI 兼容供应商下的可选执行通道：生图整体转交酒馆里的智慧姬插件执行
//（地址/密钥/模型全用智慧姬里配的那套），经酒馆事件总线请求-应答配对：
//   emit 'generate-image-request'  {id, prompt}
//   on   'generate-image-response' {id, success, imageData?, error?, prompt?...}
// 事件契约与 st-chatu8 v2.7.x 的 novelai/sd/comfyui/runninghub/banana 执行器一致。
import { ImageGenError } from './image-gen-error';
import { makeUniqueId } from './id';
import type { FanTagTransferMode, NaturalPromptLanguage, PortraitComposeMode } from './portrait-config';

/** 智慧姬通道判定：存储位恒为 apiFormat='openai' + openai.chatu8=true（主项目/小手机同款）。 */
export function isChatu8Channel(provider: { apiFormat?: unknown; openai?: { chatu8?: unknown } | null } | null | undefined): boolean {
  return !!provider && provider.apiFormat === 'openai' && provider.openai?.chatu8 === true;
}

/**
 * 提示词格式对齐：智慧姬各模式对提示词形态的要求不同，通道开启时据其当前模式改写。
 * banana（Gemini 系）读逗号标签流效果差 → 自然语言；sd/novelai/comfyui/runninghub 吃标签。
 * 未选模式返回 ''（不猜）；「非绘图」由用户显式选择，调用方会拦下，不改写。
 */
export interface Chatu8AlignableFormat {
  promptComposeMode: PortraitComposeMode;
  naturalPromptLanguage: NaturalPromptLanguage;
  fanTagTransferMode: FanTagTransferMode;
}

/** 智慧姬当前模式要求的提示词形态：标签 / 自然语言 / ''（模式未选，无从判断）。 */
export function chatu8PromptComposeMode(): '' | 'tags' | 'natural' {
  const mode = getChatu8Mode();
  if (mode === 'sd' || mode === 'novelai' || mode === 'comfyui' || mode === 'runninghub') return 'tags';
  if (mode === 'banana') return 'natural';
  return '';
}

/** 同人身份 tag 加权写法建议：NAI 系吃 1.2::tag::；SD 系（sd/comfyui/runninghub）建议 (tag:2)。 */
export function chatu8FanTagStyle(): FanTagTransferMode {
  const mode = getChatu8Mode();
  return mode === 'sd' || mode === 'comfyui' || mode === 'runninghub' ? 'anima' : 'novelai';
}

/**
 * 提示词格式建议（**只提示、不代改**）：全局三件套（提示词模式/同人tag传输模式）与智慧姬当前模式的
 * 形态不一致时返回建议文案；一致或模式未选返回 ''（未选模式时给一句说明）。
 * 历史背景：曾用 alignChatu8Format 强制覆盖三件套，与「这三项属于生图 AI 请求层、用户配置为准」冲突，已降级为提示。
 */
export function chatu8FormatHint(format: Chatu8AlignableFormat): string {
  const mode = getChatu8Mode();
  const compose = chatu8PromptComposeMode();
  if (!compose) {
    return '智慧姬还没选生图模式：选好后可对照本板块三项检查提示词格式（SD / NovelAI / ComfyUI 吃标签，Banana 读自然语言）';
  }
  const hints: string[] = [];
  if (compose !== format.promptComposeMode) {
    hints.push(compose === 'natural'
      ? `智慧姬当前是「${chatu8ModeLabel(mode)}」，读自然语言效果更好：建议把「提示词模式」改为自然语言`
      : `智慧姬当前是「${chatu8ModeLabel(mode)}」，吃标签：建议把「提示词模式」改为标签`);
  }
  if (compose === 'tags' && chatu8FanTagStyle() !== format.fanTagTransferMode) {
    hints.push('智慧姬当前是 SD 系模式，建议把「同人tag传输模式」改为 Anima ((tag:2))');
  }
  return hints.join('；');
}

/** 智慧姬设置对象（extensionSettings['st-chatu8'] 或 .chatu8）。未装/不可用时 null。 */
export function getChatu8Settings(): Record<string, any> | null {
  const ctx = _chatu8Context();
  if (!ctx) return null;
  const settings = ctx.extensionSettings;
  if (!settings || typeof settings !== 'object') return null;
  return settings['st-chatu8'] || settings.chatu8 || null;
}

/** 智慧姬当前模式：''（未装/未配置）| sd | novelai | comfyui | runninghub | banana。 */
export function getChatu8Mode(): string {
  const settings = getChatu8Settings();
  return settings && typeof settings.mode === 'string' ? settings.mode : '';
}

/** 模式显示名（设置面板提示与报错文案用）。 */
export function chatu8ModeLabel(mode: string): string {
  if (mode === 'sd') return 'SD';
  if (mode === 'novelai') return 'NovelAI';
  if (mode === 'comfyui') return 'ComfyUI';
  if (mode === 'runninghub') return 'RunningHub';
  if (mode === 'banana') return 'OpenAI 兼容（Banana）';
  return mode || '未知';
}

/** 当前模式对应的智慧姬生图执行器监听函数名（探测在岗用）。 */
export function chatu8GeneratorName(): string {
  const mode = getChatu8Mode();
  if (mode === 'novelai') return 'novelaigenerate';
  if (mode === 'banana') return 'bananaGenerate';
  if (mode === 'comfyui') return 'comfyuigenerate';
  if (mode === 'sd') return 'sdgenerate';
  if (mode === 'runninghub') return 'runninghubgenerate';
  return '';
}

/** 智慧姬是否已挂生图监听：generate-image-request 上存在名字含 generate 且不含 response 的监听器
 *  （st-chatu8 各模式的执行器都以 generate* 命名注册在该事件上；只挂应答监听的不算）。 */
export function chatu8HasGenerator(): boolean {
  try {
    const bus = _chatu8Bus();
    const listeners = bus && bus.events && bus.events['generate-image-request'];
    if (!Array.isArray(listeners)) return false;
    for (const listener of listeners) {
      const name = String(listener && listener.name || '').toLowerCase();
      if (name.includes('generate') && !name.includes('esponse')) return true;
    }
    return false;
  } catch (_e) {
    return false;
  }
}

/** 智慧姬 NovelAI 面板的模型下拉（宿主页元素；不在则 null）。 */
function _chatu8NaiSelect(): HTMLSelectElement | null {
  try {
    const doc = _chatu8Context()?.document || (typeof document !== 'undefined' ? document : null);
    const el = doc && doc.getElementById ? doc.getElementById('novelaimode') : null;
    return el && (el as HTMLSelectElement).options ? el as HTMLSelectElement : null;
  } catch (_e) {
    return null;
  }
}

/** Banana 公益站模型候选（对齐智慧姬内置表；实际生效值以智慧姬设置为准）。 */
const CHATU8_BANANA_MODELS = ['gemini-2.5-flash-image', 'gemini-3-pro-image', 'imagen-4.0-generate-001', 'imagen-4.0-ultra-generate-001'];
/** 智慧姬 NovelAI 模型兜底表（宿主页下拉不可达时用）。 */
const CHATU8_NAI_MODELS_FALLBACK = ['nai-diffusion-3', 'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-5-full'];

/** 模型候选列表：novelai 读宿主页 #novelaimode 下拉（不可达用兜底表）；banana 固定表；其余模式为空（不在这里选）。 */
export function getChatu8Models(): string[] {
  const mode = getChatu8Mode();
  if (mode === 'novelai') {
    const select = _chatu8NaiSelect();
    if (select) {
      const values: string[] = [];
      for (let i = 0; i < select.options.length; i++) {
        const value = String(select.options[i].value || '');
        if (value) values.push(value);
      }
      if (values.length) return values;
    }
    return CHATU8_NAI_MODELS_FALLBACK;
  }
  if (mode === 'banana') return [...CHATU8_BANANA_MODELS];
  return [];
}

/** 智慧姬当前生效模型（novelai→novelaimode 字段；banana→banana.model 字段；其余模式空）。 */
export function getChatu8BackendModel(): string {
  const mode = getChatu8Mode();
  const settings = getChatu8Settings();
  if (!settings) return '';
  if (mode === 'banana') {
    return settings.banana && typeof settings.banana.model === 'string' ? settings.banana.model : '';
  }
  if (mode === 'novelai') {
    return typeof settings.novelaimode === 'string' ? settings.novelaimode : '';
  }
  return '';
}

/** 写智慧姬模型：novelai 同步宿主页 #novelaimode 下拉并派发 change；banana 写 banana.model；
 *  其余模式抛错引导去智慧姬设置改。写后触发酒馆持久化（saveSettingsDebounced）。 */
export function setChatu8Model(model: string): string {
  const mode = getChatu8Mode();
  const settings = getChatu8Settings();
  const value = String(model == null ? '' : model).trim();
  if (!settings) throw new ImageGenError('没找到智慧姬的设置，模型写不进去');
  if (mode === 'novelai') {
    const select = _chatu8NaiSelect();
    const prev = settings.novelaimode;
    settings.novelaimode = value;
    if (select && select.value !== value) {
      select.value = value;
      if (prev !== value) {
        try {
          const doc = select.ownerDocument;
          const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
          const EventCtor = win && win.Event;
          if (EventCtor) select.dispatchEvent(new EventCtor('change', { bubbles: true }));
        } catch (_e) { /* 同步宿主页下拉尽力而为 */ }
      }
    }
  } else if (mode === 'banana') {
    if (!settings.banana || typeof settings.banana !== 'object') settings.banana = {};
    settings.banana.model = value;
  } else {
    throw new ImageGenError('智慧姬当前的「' + chatu8ModeLabel(mode) + '」模式不用在这里选模型：请到智慧姬设置面板里改');
  }
  try {
    const ctx = _chatu8Context();
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
  } catch (_e) { /* 持久化尽力而为 */ }
  return value;
}

/** 智慧姬模型为空时补默认（novelai→nai-diffusion-4-5-full；banana→gemini-2.5-flash-image）；其余模式不动。 */
export function ensureChatu8Model(): string {
  const mode = getChatu8Mode();
  try {
    if (mode === 'novelai') {
      if (!getChatu8BackendModel()) return setChatu8Model('nai-diffusion-4-5-full');
    } else if (mode === 'banana' && !getChatu8BackendModel()) {
      return setChatu8Model('gemini-2.5-flash-image');
    }
  } catch (_e) { /* 补默认尽力而为 */ }
  return getChatu8BackendModel();
}

/** 设置面板/Toast 用的状态注记（当前模式/执行器在岗/模型）。 */
export function chatu8StatusNote(): string {
  const compose = chatu8PromptComposeMode();
  return '（智慧姬当前模式：' + chatu8ModeLabel(getChatu8Mode()) + '；'
    + (chatu8HasGenerator() ? '生图执行器 ' + chatu8GeneratorName() + ' 在岗' : '没挂上生图监听')
    + '；模型：' + (getChatu8BackendModel() || '空')
    + '；该模式吃：' + (compose === 'tags' ? '标签' : compose === 'natural' ? '自然语言' : '未选模式（无从判断）') + '）';
}

/** 面板提示词格式行的完整说明（提示词格式由全局三件套决定；智慧姬会拼它自己的固定词/质量预设）。 */
export function chatu8FormatNote(): string {
  const mode = getChatu8Mode();
  const compose = chatu8PromptComposeMode();
  if (!compose) {
    return '智慧姬还没选生图模式：选好后可对照「生图 AI 请求提示词」板块的三项检查格式（SD / NovelAI / ComfyUI 吃标签，Banana 读自然语言）';
  }
  if (compose === 'natural') {
    return '当前提示词按「全局三件套」生成；智慧姬（' + chatu8ModeLabel(mode) + '）读自然语言效果好，你的模式若不匹配可在上方板块调整——智慧姬会在前后拼它自己的固定词/质量预设';
  }
  const fanHint = chatu8FanTagStyle() === 'anima' ? '（该模式建议同人身份 tag 用 SD 系 (tag:2) 写法）' : '';
  return '当前提示词按「全局三件套」生成；智慧姬会在标签前后拼它自己的固定词/质量预设' + fanHint;
}

// —— 分角色（多人）契约 ——

/** 智慧姬 NovelAI 侧会真正分角色的模型档（按其 novelaimode 判定表；NAI3 不吃契约）。 */
const CHATU8_NAI_MULTI_MODELS = [
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-4-full',
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
];
/** 归一化坐标 → 五格网格（与主线 STORY_CENTER_LAYOUTS / 智慧姬 centersToCoordinates 同一 0.1~0.9 步进）。 */
const CHATU8_GRID_X: Record<string, string> = { '0.1': 'a', '0.3': 'b', '0.5': 'c', '0.7': 'd', '0.9': 'e' };
const CHATU8_GRID_Y: Record<string, string> = { '0.1': '1', '0.3': '2', '0.5': '3', '0.7': '4', '0.9': '5' };

/**
 * 智慧姬是否吃「Scene Composition / Character N Prompt / Character N UC」分角色契约：
 *  - novelai + NAI4/4.5 模型 → 转 char_captions/characterPrompts 真分角色（我们自建 NAI 请求体同口径）；
 *  - banana → 场景与各角色按 " | " 拼自然语言（比标签汤更贴其对话式模型）；
 *  - sd/comfyui → 它自己会拆平（与我们的扁平化等价，不值得多绕一圈）；NAI3/未选模式 → 不吃（标签行会变成字面垃圾）。
 */
export function chatu8SupportsMultiCharContract(): boolean {
  const mode = getChatu8Mode();
  if (mode === 'banana') return true;
  if (mode !== 'novelai') return false;
  return CHATU8_NAI_MULTI_MODELS.indexOf(getChatu8BackendModel()) >= 0;
}

/** 契约字段清洗：行尾分号是智慧姬解析器的硬分隔符，字段内分号/换行会让它丢行或串行。 */
function _chatu8ContractField(text: unknown): string {
  return String(text == null ? '' : text)
    .replace(/[;\r\n]+/g, ', ')
    .replace(/(,\s*)+/g, ', ')
    .replace(/^[,\s]+|[,\s]+$/g, '');
}

function _chatu8CenterGrid(center?: { x: number; y: number } | null): string {
  if (!center) return '';
  const x = CHATU8_GRID_X[String(center.x)] || '';
  const y = CHATU8_GRID_Y[String(center.y)] || '';
  return x && y ? x + y : '';
}

/**
 * 组装智慧姬分角色契约文本（不支持的模式返回 null，调用方回退扁平化）。
 * 前缀/后缀并进 Scene 行：智慧姬重组契约时只认标签行，行外文字会被静默丢弃。
 * N 上限 4 与智慧姬解析器一致；UC 为空则整行省略（它会补自己的默认角色负面）。
 */
export function buildChatu8MultiCharPrompt(
  multi: { scene: string; characters: Array<{ prompt: string; uc?: string; centers?: { x: number; y: number } | null }> },
  prefix = '',
  suffix = '',
): string | null {
  if (!chatu8SupportsMultiCharContract()) return null;
  const scene = [prefix, multi.scene, suffix].map(_chatu8ContractField).filter(Boolean).join(', ');
  const lines: string[] = ['Scene Composition: ' + (scene || '1girl, solo') + ';'];
  const characters = (multi.characters || []).slice(0, 4);
  for (let i = 0; i < characters.length; i++) {
    const prompt = _chatu8ContractField(characters[i].prompt);
    if (!prompt) continue;
    const grid = _chatu8CenterGrid(characters[i].centers);
    lines.push('Character ' + (i + 1) + ' Prompt: ' + prompt + (grid ? ', |centers:' + grid : '') + ';');
    const uc = _chatu8ContractField(characters[i].uc);
    if (uc) lines.push('Character ' + (i + 1) + ' UC: ' + uc + ';');
  }
  return lines.join(' ');
}

// —— 生图请求 —— 

/** 智慧姬生图超时（毫秒）：大图/排队都可能慢，对齐原引用实现给足 180 秒；测试可缩短。 */
let _chatu8TimeoutMs = 180000;
export function __setChatu8TimeoutForTests(ms: number): void {
  _chatu8TimeoutMs = ms;
}

/** 应答 imageData 归一为 data:URL：data: 直通；http(s)/blob 拉回转 base64；其余按裸 base64 包装。失败 null。 */
async function _imageDataToDataUrl(imageData: string, signal?: AbortSignal): Promise<string | null> {
  if (typeof imageData !== 'string' || !imageData) return null;
  if (imageData.startsWith('data:')) return imageData;
  if (/^(https?:|blob:)/i.test(imageData)) {
    try {
      const resp = await fetch(imageData, { signal });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch (_e) {
      return null;
    }
  }
  const cleaned = imageData.replace(/[^A-Za-z0-9+/=]/g, '');
  return cleaned ? 'data:image/png;base64,' + cleaned : null;
}

/** 经智慧姬生图：发 generate-image-request、等同 id 的 generate-image-response。
 *  抛 ImageGenError（含可行动指引）；支持 AbortSignal；超时自动摘除监听。
 *  opts.negative：任务负面词（智慧姬把它追加到自己负面预设之后；banana 模式不读负面）。 */
export async function generateImageViaChatu8(
  promptText: string,
  signal?: AbortSignal,
  opts?: { negative?: string },
): Promise<string> {
  const bus = _chatu8Bus();
  if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
    throw new ImageGenError('智慧姬接口不可用：没取到酒馆事件总线');
  }
  try { ensureChatu8Model(); } catch (_e) { /* 模型补默认尽力而为 */ }
  if (!chatu8HasGenerator()) {
    throw new ImageGenError('智慧姬那边没挂上生图监听：请打开智慧姬设置面板，在「模式」里选一个能生图的模式（现在是「'
      + chatu8ModeLabel(getChatu8Mode()) + '」），再来点生图');
  }
  if (signal?.aborted) throw _chatu8AbortError();
  const id = makeUniqueId('ub-chatu8');
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const removeListener = () => {
      try {
        if (typeof bus.removeListener === 'function') bus.removeListener('generate-image-response', onResponse);
        else if (typeof bus.off === 'function') bus.off('generate-image-response', onResponse);
      } catch (_e) { /* 摘除监听尽力而为 */ }
      try { signal?.removeEventListener?.('abort', onAbort); } catch (_e) { /* ignore */ }
    };
    const onResponse = (event: any) => {
      if (settled) return;
      if (!event || String(event.id || '') !== id) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeListener();
      if (event.success === true && typeof event.imageData === 'string' && event.imageData) {
        void _imageDataToDataUrl(event.imageData, signal).then((dataUrl) => {
          if (dataUrl) resolve(dataUrl);
          else reject(new ImageGenError('智慧姬返回的图片无法转成 base64 数据'));
        }).catch((e) => reject(e instanceof Error ? e : new ImageGenError(String(e))));
        return;
      }
      reject(new ImageGenError('智慧姬生图失败：' + String(event.error || '未知错误')));
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeListener();
      reject(_chatu8AbortError());
    };
    bus.on('generate-image-response', onResponse);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      removeListener();
      reject(new ImageGenError('智慧姬接口超时（' + Math.round(_chatu8TimeoutMs / 1000) + ' 秒）：智慧姬没回图，去智慧姬设置 → 日志页看报错'));
    }, _chatu8TimeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const negative = String(opts?.negative || '').trim();
      // 无负面词时保持 {id, prompt} 历史请求形态（字节不变）；有则附 negative_prompt 供智慧姬追加
      bus.emit('generate-image-request', negative ? { id, prompt: promptText, negative_prompt: negative } : { id, prompt: promptText });
    } catch (e) {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        removeListener();
        reject(new ImageGenError('智慧姬生图请求发送失败：' + ((e && (e as Error).message) || e)));
      }
    }
  });
}

function _chatu8AbortError(): Error {
  const error = new Error('图片生成任务已取消');
  error.name = 'AbortError';
  return error;
}

// —— 宿主访问（iframe 兼容：优先当前窗口，回退父窗口；SillyTavern 或 TavernHelper.SillyTavern 两条路） ——

function _chatu8Context(): any {
  const candidates: any[] = [];
  try {
    candidates.push((window as any).SillyTavern);
    candidates.push((window as any).TavernHelper?.SillyTavern);
  } catch (_e) { /* cross-origin 或 node 测试环境 */ }
  try {
    candidates.push((window.parent as any)?.SillyTavern);
    candidates.push((window.parent as any)?.TavernHelper?.SillyTavern);
  } catch (_e) { /* cross-origin */ }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate.getContext === 'function') {
      try {
        const ctx = candidate.getContext();
        if (ctx) return ctx;
      } catch (_e) { /* 回退直用对象 */ }
    }
    return candidate;
  }
  return null;
}

function _chatu8Bus(): any {
  const ctx = _chatu8Context();
  return ctx && ctx.eventSource || null;
}
