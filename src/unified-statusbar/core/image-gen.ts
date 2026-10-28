import type { PortraitImageGen, NovelAiConfig, OpenAiConfig } from './portrait-config';
import { getConfig } from './config-store';
import { generateComfyUiImage, parseWorkflow, autoInjectPrompt, applyComfyParamOverrides, submitComfyWorkflow } from './comfyui-client';
import { generateImageViaChatu8, getChatu8BackendModel, buildChatu8MultiCharPrompt } from './chatu8-bridge';
import {
  baibaiBackendStatus, baibaiOrientationFromAspectRatio, buildBaiBaiCharacters,
  generateImageViaBaiBai, sanitizeBaiBaiPromptText, baibaiReplayPrompt,
} from './baibai-bridge';
import { getToastr } from './env';
import type { StoryMultiChar } from './story-image-parser';
import { ImageGenError } from './image-gen-error';

// 生图错误类已抽到 ./image-gen-error（解开 image-gen ↔ 两个生图后端的依赖环）；
// 这里再导出保持既有导入路径可用（同一个类对象，instanceof 语义不变）。
export { ImageGenError };

// —— URL 规整 ——
/** NovelAI 端点双形态（对齐 st-chatu8 official 渠道）：去首尾空白与尾斜杠得到 base 后——
 *  primary=完整端点（base 已含 /ai/generate-image 则原样，否则拼接，兼容直接粘贴中转站完整地址）；
 *  fallback=去掉该端点后缀的裸地址。首选地址失败时（网络不通或非 ok）用 fallback 原样再请求一次，
 *  兼容路径已在服务端路由好的中转站（POST 裸地址即生图）。http/https 一视同仁，不做任何改写。 */
function novelaiEndpoints(url: string): { primary: string; fallback: string } {
  const base = url.trim().replace(/\/+$/, '');
  const hasPath = base.includes('/ai/generate-image');
  return {
    primary: hasPath ? base : `${base}/ai/generate-image`,
    fallback: hasPath ? base.replace('/ai/generate-image', '') : base,
  };
}
function openaiBase(url: string): string {
  let n = url.trim().replace(/\/+$/, '');
  if (n.endsWith('/chat/completions')) return n;
  if (n.endsWith('/v1')) return n + '/chat/completions';
  return n + '/v1/chat/completions';
}

// —— WaveSpeed（合并进 OpenAI 兼容通道：地址/模型命中即自动改走其提交+轮询 API，配置面零新增）——
/** WaveSpeed 探测：地址含 wavespeed（如 https://api.wavespeed.ai），或模型路径是 wavespeed 命名空间
 *  （如 wavespeed-ai/qwen-image/text-to-image）。两个信号都不命中时仍走原 OpenAI chat/completions。 */
export function isWavespeedSource(url: string, model: string): boolean {
  if (/wavespeed/i.test(url)) return true;
  return /(^|\/)wavespeed[-_]?ai\//i.test(model.trim());
}

/** 提交端点解析（对齐 NovelAI 端点双形态的宽容度）：
 *  地址已含完整提交端点（/api/v3/ 后还有模型路径）→ 原样使用（用户直接粘贴完整地址）；
 *  否则去掉尾部 /api/v3 得到根，拼 /api/v3/{模型路径}。模型框误填完整 https 地址时自动提取其中路径；
 *  模型路径为空且地址不带端点 → 报错指路。 */
export function wavespeedSubmitEndpoint(url: string, model: string): string {
  const base = url.trim().replace(/\/+$/, '');
  const inline = base.match(/\/api\/v3\/(.+)$/i);
  if (inline && inline[1]) return base;
  let modelPath = model.trim().replace(/^\/+|\/+$/g, '');
  // 模型框粘了完整地址（常见误填）：提取其中的模型路径部分（剥协议+域名，剥 api/v3 前缀）
  const fromUrl = modelPath.match(/^https?:\/\/[^/]+\/(.+)$/i);
  if (fromUrl) modelPath = fromUrl[1].replace(/\/+$/, '');
  const withV3 = modelPath.match(/^api\/v3\/(.+)$/i);
  if (withV3) modelPath = withV3[1];
  if (!modelPath) throw new ImageGenError('WaveSpeed 缺少模型路径：请在模型里填官方模型路径（如 wavespeed-ai/qwen-image/text-to-image），不要填完整 https 地址');
  return `${wavespeedRoot(base)}/api/v3/${modelPath}`;
}

/** WaveSpeed 根地址：剥掉地址尾部 /chat/completions、/v1、/api/v3 残留（从其他中转换过来的常见粘错），轮询地址从这里拼。 */
export function wavespeedRoot(url: string): string {
  let n = url.trim().replace(/\/+$/, '');
  n = n.replace(/\/chat\/completions$/i, '');
  n = n.replace(/\/v1$/i, '');
  n = n.replace(/\/api\/v3$/i, '');
  return n;
}

/** 宽高比 → WaveSpeed 尺寸（"宽*高" 串）。OpenAI 兼容 UI 只暴露宽高比，WaveSpeed 按像素出图，
 *  在此换算并钳制到官方允许范围（256~1536）。auto/未知 → 1024*1024。 */
const WAVESPEED_SIZE_BY_RATIO: Record<string, [number, number]> = {
  '1:1': [1024, 1024],
  '2:3': [832, 1248],
  '3:2': [1248, 832],
  '3:4': [960, 1280],
  '4:3': [1280, 960],
  '4:5': [1024, 1280],
  '5:4': [1280, 1024],
  '9:16': [720, 1280],
  '16:9': [1280, 720],
  '21:9': [1344, 576],
};

export function wavespeedSizeFromAspectRatio(aspectRatio: string): { width: number; height: number } {
  const hit = WAVESPEED_SIZE_BY_RATIO[String(aspectRatio || '').trim()];
  return { width: hit ? hit[0] : 1024, height: hit ? hit[1] : 1024 };
}

/** 尺寸钳制到 WaveSpeed 官方范围（重绘时弹窗自定义宽高可能越界）。 */
function wavespeedClampSize(size: { width: number; height: number }): { width: number; height: number } {
  const clamp = (v: number): number => Math.min(1536, Math.max(256, Math.round(Number(v) || 1024)));
  return { width: clamp(size.width), height: clamp(size.height) };
}

function buildWavespeedBody(promptText: string, size: { width: number; height: number }, seed: number): Record<string, unknown> {
  return {
    prompt: promptText,
    size: `${size.width}*${size.height}`,
    seed,
    output_format: 'png',
    // base64 直回：轮询结果免二次下载（结果 CDN 未必放行跨域 fetch）
    enable_base64_output: true,
  };
}

const WAVESPEED_POLL_INTERVAL_MS = 2000;
const WAVESPEED_POLL_TIMEOUT_MS = 300000;
/** 测试钩子：压缩轮询间隔（生产勿调）。 */
export function __setWavespeedPollIntervalForTests(ms: number): void {
  _wavespeedPollIntervalMs = ms;
}
let _wavespeedPollIntervalMs = WAVESPEED_POLL_INTERVAL_MS;

/** 从任务 outputs 提取 dataURL：优先 base64/dataURL 直取；没有再取第一个 http(s) URL 下载（CDN 无 CORS 时报错）。 */
async function extractWavespeedOutputs(outputs: unknown[], signal?: AbortSignal): Promise<string | null> {
  const direct = extractBase64FromAny(outputs);
  if (direct) return dataUrl(direct);
  const urlItem = outputs.find((o): o is string => typeof o === 'string' && /^https?:\/\//i.test(o.trim()));
  if (!urlItem) return null;
  const resp = await fetch(urlItem.trim(), { signal });
  if (!resp.ok) throw new ImageGenError(`WaveSpeed 图片下载失败 HTTP ${resp.status}`);
  const blob = await resp.blob();
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

/** WaveSpeed 生图：POST 提交任务 → 轮询 predictions/{id}/result 至 completed → 提取图片。
 *  官方 API 形态：提交 POST {root}/api/v3/{模型路径}，轮询 GET {root}/api/v3/predictions/{id}/result
 *  （优先用响应里的 data.urls.get，兼容中转站路由）。opts.size/seed 供正常生图与按档案重绘两个入口。 */
async function generateWavespeedImage(
  c: OpenAiConfig,
  promptText: string,
  signal?: AbortSignal,
  opts?: { size?: { width: number; height: number }; seed?: number },
): Promise<string> {
  if (!c.url) throw new ImageGenError('WaveSpeed 未配置地址（请在 OpenAI 兼容的 API 地址里填 WaveSpeed 服务地址）');
  const submitUrl = wavespeedSubmitEndpoint(c.url, c.model);
  assertNotMixedContent(submitUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (c.key) headers.Authorization = `Bearer ${c.key}`;
  const size = wavespeedClampSize(opts?.size || { width: 1024, height: 1024 });
  const seed = typeof opts?.seed === 'number' && Number.isFinite(opts.seed) && opts.seed >= 0 ? Math.floor(opts.seed) : -1;
  const body = buildWavespeedBody(promptText, size, seed);
  // 提交（网络错误 1 秒原址重试一次，对齐 NAI 路径的瞬时故障容忍）
  let resp: Response | null = null;
  try {
    resp = await fetch(submitUrl, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal?.aborted) throw imageAbortError();
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    if (signal?.aborted) throw imageAbortError();
    try {
      resp = await fetch(submitUrl, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e2) {
      if (signal?.aborted) throw imageAbortError();
      throw new ImageGenError(`WaveSpeed 无法连接 ${submitUrl}：请检查地址是否可达、该站点是否允许跨域（CORS）`);
    }
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    // 404 = 拼出的提交地址在服务端不存在：附上实际地址与正确填法，用户可一眼自查
    const hint = resp.status === 404
      ? `（提交地址 ${submitUrl} 不存在：API 地址应形如 https://api.wavespeed.ai，模型应形如 bytedance/seedream-v5.0-pro 或 wavespeed-ai/qwen-image/text-to-image；模型框只填路径不要填完整 https 地址。若地址里的模型与你在「模型」框填的不一致，是模型改动还没点「保存到预设」——模型属于预设，改完需点保存再测）`
      : '';
    throw new ImageGenError(`WaveSpeed HTTP ${resp.status}${detail ? `：${detail.slice(0, 200)}` : ''}${hint}`, resp.status);
  }
  const submitted = await resp.json().catch(() => null);
  const payload = (submitted && typeof submitted === 'object' ? submitted : {}) as Record<string, unknown>;
  if (payload.code !== undefined && Number(payload.code) !== 200) {
    throw new ImageGenError(`WaveSpeed 提交失败：${String(payload.message || payload.code)}`);
  }
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : null) as Record<string, unknown> | null;
  // 同步模式兼容：提交响应直接带 outputs 时不再轮询
  if (data && Array.isArray(data.outputs) && data.outputs.length) {
    const direct = await extractWavespeedOutputs(data.outputs, signal);
    if (direct) return direct;
  }
  const predictionId = data && typeof data.id === 'string' ? data.id : '';
  if (!predictionId) throw new ImageGenError('WaveSpeed 提交响应缺少任务 id（响应不含 data.id）');
  const pollUrl = (data && data.urls && typeof (data.urls as Record<string, unknown>).get === 'string'
    ? String((data.urls as Record<string, unknown>).get)
    : `${wavespeedRoot(c.url)}/api/v3/predictions/${predictionId}/result`);
  const deadline = Date.now() + WAVESPEED_POLL_TIMEOUT_MS;
  let lastStatus = '';
  for (;;) {
    if (signal?.aborted) throw imageAbortError();
    if (Date.now() > deadline) {
      throw new ImageGenError(`WaveSpeed 生成超时（${Math.round(WAVESPEED_POLL_TIMEOUT_MS / 1000)} 秒，最后状态：${lastStatus || '未知'}）`);
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, _wavespeedPollIntervalMs);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(imageAbortError()); }, { once: true });
    });
    if (signal?.aborted) throw imageAbortError();
    let pr: Response;
    try {
      pr = await fetch(pollUrl, { method: 'GET', headers, signal });
    } catch (e) {
      if (signal?.aborted) throw imageAbortError();
      continue; // 单次轮询网络抖动不终止任务，继续到超时为止
    }
    if (!pr.ok) { lastStatus = `HTTP ${pr.status}`; continue; }
    const pj = await pr.json().catch(() => null);
    const pd = (pj && typeof pj === 'object' && (pj as Record<string, unknown>).data && typeof (pj as Record<string, unknown>).data === 'object'
      ? (pj as Record<string, unknown>).data : null) as Record<string, unknown> | null;
    lastStatus = String((pd && pd.status) || '');
    if (lastStatus === 'completed') {
      const outputs = Array.isArray(pd && pd.outputs) ? (pd!.outputs as unknown[]) : [];
      const img = await extractWavespeedOutputs(outputs, signal);
      if (img) return img;
      throw new ImageGenError('WaveSpeed 任务完成但未提取到图片');
    }
    if (lastStatus === 'failed' || lastStatus === 'error' || lastStatus === 'cancelled') {
      throw new ImageGenError(`WaveSpeed 生成失败：${String((pd && pd.error) || lastStatus)}`);
    }
  }
}


// —— 通用响应图片提取（1:1 复刻 phone-ctn 0685.js x() 递归搜索）——
function extractBase64FromAny(obj: unknown): string | null {
  if (!obj) return null;
  if (typeof obj === 'string') {
    // 直接 base64 串
    if (/^[A-Za-z0-9+/=\s]{200,}$/.test(obj) && !obj.startsWith('data:')) {
      return obj.replace(/\s/g, '');
    }
    // data URL
    const m = obj.match(/data:image\/[\w+]+;base64,([A-Za-z0-9+/=]+)/);
    if (m) return m[1];
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = extractBase64FromAny(item);
      if (r) return r;
    }
    return null;
  }
  if (typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    for (const key of ['resultUrl', 'b64_json', 'image', 'data', 'images', 'output', 'output_text', 'choices', 'candidates', 'message', 'content', 'parts', 'inline_data', 'image_url', 'url']) {
      if (key in o) {
        const r = extractBase64FromAny(o[key]);
        if (r) return r;
      }
    }
  }
  return null;
}

// —— ZIP 解压（NovelAI 常返回 zip 包内含 png）——
async function extractFirstImageFromZip(arrayBuffer: ArrayBuffer): Promise<string | null> {
  try {
    const u8 = new Uint8Array(arrayBuffer);
    // 找 EOCD
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0 && i > u8.length - 65557; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const cdOffset = new DataView(arrayBuffer).getUint32(eocd + 16, true);
    const cdCount = new DataView(arrayBuffer).getUint16(eocd + 10, true);
    const dv = new DataView(arrayBuffer);
    let off = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const compMethod = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const fnLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const fnStart = off + 46;
      const fn = new TextDecoder().decode(u8.slice(fnStart, fnStart + fnLen));
      if (/\.(png|jpe?g|webp)$/i.test(fn)) {
        const localFnLen = dv.getUint16(localOff + 26, true);
        const localExtraLen = dv.getUint16(localOff + 28, true);
        const dataStart = localOff + 30 + localFnLen + localExtraLen;
        const compressed = u8.slice(dataStart, dataStart + compSize);
        if (compMethod === 0) {
          // stored，无压缩
          const byteStr = Array.from(compressed).map((b) => String.fromCharCode(b)).join('');
          return btoa(byteStr);
        }
        if (compMethod === 8) {
          // deflate
          const ds = new (window as any).DecompressionStream('deflate-raw');
          const blob = new Blob([compressed]);
          const reader = (blob.stream() as any).pipeThrough(ds).getReader();
          const chunks: Uint8Array[] = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const total = chunks.reduce((s, c) => s + c.length, 0);
          const merged = new Uint8Array(total);
          let p = 0;
          for (const c of chunks) { merged.set(c, p); p += c.length; }
          const byteStr = Array.from(merged).map((b) => String.fromCharCode(b)).join('');
          return btoa(byteStr);
        }
      }
      off += 46 + fnLen + extraLen + commentLen;
    }
    return null;
  } catch (e) {
    console.warn('[立绘] zip 解压失败:', e);
    return null;
  }
}

function dataUrl(base64: string, mime = 'image/png'): string {
  if (base64.startsWith('data:')) return base64;
  return `data:${mime};base64,${base64}`;
}

async function responseToDataUrl(resp: Response): Promise<string | null> {
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const json = await resp.json();
    const b64 = extractBase64FromAny(json);
    return b64 ? dataUrl(b64) : null;
  }
  if (ct.includes('image/')) {
    const blob = await resp.blob();
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  }
  // 1:1 对齐 phone-ctn 0685.js d()：不依赖 Content-Type，按二进制首字节判定
  // NovelAI 默认返回 zip 包（PK 头 50 4B），也可能返回裸 png 二进制
  const ab = await resp.arrayBuffer();
  const u8 = new Uint8Array(ab);
  if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b) {
    // PK 头 → ZIP
    const b64 = await extractFirstImageFromZip(ab);
    return b64 ? dataUrl(b64) : null;
  }
  // 否则当作裸图片二进制（PNG/JPEG/WebP）
  const blob = new Blob([ab], { type: 'image/png' });
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

// —— NovelAI 请求体（对齐 st-chatu8 payload 结构）——

// AQT 正面质量标签（系统固化，追加在 prompt 末尾）
const NAI_AQT_TAGS = 'very aesthetic, masterpiece, no text';
// UCP 负面质量预设（系统固化，Heavy 预设，前置到 negative_prompt）
const NAI_UCP_NEGATIVE = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';

/** 组装最终 negative_prompt（对齐 st-chatu8：UCP + 用户负面）。
 *  预设里「默认负面提示词」关掉时只发用户自己写的那份（用户反馈 UCP 质量词会拉低画面效果）。
 *  缺失视为开：字段是后加的，旧配置/旧测试夹具不写它时必须保持原行为。 */
function composeFinalNegative(c: NovelAiConfig, negativePrompt: string): string {
  const user = String(negativePrompt || '').trim().replace(/^,+/, '').replace(/,+$/, '');
  if (c.useDefaultNegative === false) return user;
  return user ? `${NAI_UCP_NEGATIVE}, ${user}` : NAI_UCP_NEGATIVE;
}

function buildNovelAiBody(c: NovelAiConfig, promptText: string, negativePrompt: string): Record<string, unknown> {
  const seed = c.seed < 0 ? Math.floor(Math.random() * 4294967296) : c.seed;
  // AQT 质量标签追加在 prompt 末尾（对齐 st-chatu8：前置前→固定前→前置后→主要→后置前→固定后→后置后→AQT→最后置）
  // promptText 已由 portrait-system assembleFinalPrompt 拼好 prefix+main+suffix，此处仅追加 AQT
  const finalPrompt = c.qualityToggle ? `${promptText}, ${NAI_AQT_TAGS}` : promptText;
  // UCP 负面质量预设前置到 negative_prompt（可按预设开关关闭）
  const finalNegative = composeFinalNegative(c, negativePrompt);
  // skip_cfg_above_sigma：始终按像素量与模型动态计算（1:1 对齐 st-chatu8 magicConstant 逻辑）
  // 4.5/5 模型系数 58，其他模型系数 19
  const magicConstant = c.model.includes('nai-diffusion-4-5') || c.model.includes('nai-diffusion-5') ? 58 : 19;
  const varietySigma = Math.pow((c.width * c.height) / 1011712, 0.5) * magicConstant;
  return {
    action: 'generate',
    input: finalPrompt,
    model: c.model,
    parameters: {
      params_version: 3,
      width: c.width, height: c.height,
      scale: c.cfg,
      seed,
      sampler: c.sampler || 'k_euler',
      noise_schedule: c.scheduler || 'karras',
      steps: c.steps,
      n_samples: 1,
      ucPreset: c.ucPreset,
      qualityToggle: c.qualityToggle,
      autoSmea: c.autoSmea,
      cfg_rescale: c.cfgRescale,
      dynamic_thresholding: c.decrisper,
      controlnet_strength: 1,
      legacy: false, add_original_image: true,
      legacy_v3_extend: false, use_coords: false, legacy_uc: false,
      normalize_reference_strength_multiple: false,
      inpaintImg2ImgStrength: 1,
      skip_cfg_above_sigma: varietySigma,
      sm: c.sm, sm_dyn: c.smDyn,
      stream: 'msgpack',
      characterPrompts: [],
      v4_prompt: { caption: { base_caption: finalPrompt, char_captions: [] }, use_coords: false, use_order: true },
      v4_negative_prompt: { caption: { base_caption: finalNegative, char_captions: [] }, legacy_uc: false },
      negative_prompt: finalNegative,
    },
  };
}

/** 拼接两端逗号修剪（与 engine composeStoryPrompt 同源，避免循环依赖就近实现）。 */
function joinComma(parts: string[]): string {
  return parts
    .map((s) => String(s || '').trim().replace(/^,+/, '').replace(/,+$/, ''))
    .filter(Boolean)
    .join(', ');
}

/**
 * 正文插图多角色 NAI 请求体（对齐 st-chatu8 分角色模式 payload）。
 * 与立绘单角色 buildNovelAiBody 的差异：
 *  - base_caption 只放 Scene Composition（+ 预设前缀/后缀 + AQT），不再夹带角色标签/BREAK/|centers；
 *  - 每角色描述进 v4_prompt.caption.char_captions[N].char_caption + centers[{x,y}]；
 *  - 每角色 UC 进 v4_negative_prompt.caption.char_captions[N].char_caption（不再混入正向）；
 *  - characterPrompts[]（NAI 高层字段）同步填充 prompt/center/uc；
 *  - use_coords:true（AI 已产出 |centers 坐标）。
 */
function buildNovelAiStoryBody(
  c: NovelAiConfig,
  multi: StoryMultiChar,
  prefix: string,
  suffix: string,
  globalUc: string,
): Record<string, unknown> {
  const seed = c.seed < 0 ? Math.floor(Math.random() * 4294967296) : c.seed;
  const baseParts = [prefix, multi.scene, suffix];
  let baseCaption = joinComma(baseParts);
  if (c.qualityToggle) baseCaption += `, ${NAI_AQT_TAGS}`;
  const globalUcTrim = String(globalUc || '').trim().replace(/^,+/, '').replace(/,+$/, '');
  const finalNegative = composeFinalNegative(c, globalUcTrim);
  const magicConstant = c.model.includes('nai-diffusion-4-5') || c.model.includes('nai-diffusion-5') ? 58 : 19;
  const varietySigma = Math.pow((c.width * c.height) / 1011712, 0.5) * magicConstant;
  const charCaptions = multi.characters.map((ch) => ({ char_caption: ch.prompt, centers: [ch.centers] }));
  const characterPrompts = multi.characters.map((ch) => ({ enabled: true, prompt: ch.prompt, center: ch.centers, uc: ch.uc }));
  const negCharCaptions = multi.characters.map((ch) => ({ char_caption: ch.uc, centers: [ch.centers] }));
  return {
    action: 'generate',
    input: baseCaption,
    model: c.model,
    parameters: {
      params_version: 3,
      width: c.width, height: c.height,
      scale: c.cfg,
      seed,
      sampler: c.sampler || 'k_euler',
      noise_schedule: c.scheduler || 'karras',
      steps: c.steps,
      n_samples: 1,
      ucPreset: c.ucPreset,
      qualityToggle: c.qualityToggle,
      autoSmea: c.autoSmea,
      cfg_rescale: c.cfgRescale,
      dynamic_thresholding: c.decrisper,
      controlnet_strength: 1,
      legacy: false, add_original_image: true,
      legacy_v3_extend: false, use_coords: true, legacy_uc: false,
      normalize_reference_strength_multiple: false,
      inpaintImg2ImgStrength: 1,
      skip_cfg_above_sigma: varietySigma,
      sm: c.sm, sm_dyn: c.smDyn,
      stream: 'msgpack',
      characterPrompts,
      v4_prompt: { caption: { base_caption: baseCaption, char_captions: charCaptions }, use_coords: true, use_order: true },
      v4_negative_prompt: { caption: { base_caption: finalNegative, char_captions: negCharCaptions }, legacy_uc: false },
      negative_prompt: finalNegative,
    },
  };
}

/** 非 NAI 供应商（OpenAI/ComfyUI 无多角色结构）扁平化：场景+各角色描述拼单段，丢标签/BREAK/|centers/UC。 */
function flattenStoryMulti(multi: StoryMultiChar, prefix: string, suffix: string): string {
  const body = [multi.scene, ...multi.characters.map((ch) => ch.prompt)]
    .map((s) => String(s || '').trim()).filter(Boolean).join(', ');
  return joinComma([prefix, body, suffix]);
}

// —— 智慧姬（st-chatu8）契约标签净化 ——
/**
 * 智慧姬四条执行器（sd/novelai/comfyui/banana）都以「prompt 含 'Scene Composition' 子串」判分角色模式，
 * 判定后只认它自己的解析结果（正则 `Scene Composition:([^;]+);` 提取场景字段 + `Character N Prompt`），
 * 原始提示词整段丢弃。正文插图与小手机 story 管线的「纯景物块」只有 Scene 行、没有 Character 行：
 * 调用方拿不到 StoryMultiChar（parseMultiCharPrompt 返回 null）就不传 storyOpts，这段带标签的契约原文
 * 被当普通提示词直发，而 story-image-parser.normalizeStoryPromptText 会把串尾的 ';' 剥掉
 * ⇒ 智慧姬正则不命中、场景取空 ⇒ 最终正面提示词只剩它自己的质量预设（best quality, amazing quality,
 * very aesthetic, absurdres），出图与提示词/tag 完全无关（2026-10-11 用户日志实证：no humans 静物/食物照
 * 4/4 被清空、不含标签的扁平标签串 4/4 正常）。
 *
 * 本函数是发往智慧姬的唯一净化出口：仅当「含 Scene Composition 标签且智慧姬正则吃不掉」时改写——
 * Scene 标签与 Character N Prompt 标签只去标签留正文、Character N UC 整段丢弃（与 flattenStoryMulti
 * 对非 NAI 的口径一致）、契约分隔 ';' 还原成逗号、|centers 坐标残留清掉，使执行器回到
 * 「标准模式：使用请求中的 prompt」。无标签、或标签完好（带 ';'，智慧姬自己解析得动）的提示词
 * 逐字节原样返回。触发判据与插件同款大小写敏感（插件用 includes('Scene Composition')，小写变体本就不切分）。
 */
export function sanitizeChatu8PromptText(promptText: string): string {
  const text = String(promptText || '');
  if (!/Scene Composition\s*:/.test(text)) return promptText;
  if (/Scene Composition:[^;]+;/.test(text)) return promptText;
  const stripped = text
    .replace(/Character\s+\d+\s+UC\s*:[^;]*;?/gi, '')
    .replace(/Character\s+\d+\s+Prompt\s*:/gi, '')
    .replace(/Scene Composition\s*:/g, '')
    .replace(/\|\s*centers\s*:[^\s,;]*/gi, '')
    .replace(/;/g, ', ');
  const cleaned = stripped
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(?:,\s*)+/g, ', ')
    .replace(/^\s*,\s*|\s*,\s*$/g, '')
    .trim();
  return cleaned || promptText; // 退化输入（连正文都没有）保留原样，行为与修复前一致
}

// ===== 生图档案（逐图最终请求快照：重发即可还原，供图库展示与后续重新生图）=====

/** 单张生图的完整档案 = 生成那一刻实际发给供应商的最终形态（含 AQT/UCP/实际 seed）。
 *  provider 'unknown' 仅用于旧条目手工补建的档案（当时未采集供应商信息）。 */
export type ImageGenProvider = 'novelai' | 'openai' | 'comfyui' | 'unknown';

export interface ImageGenParams {
  width?: number; height?: number;
  /** OpenAI 兼容：请求比例（'auto' 表示未指定）。 */
  aspectRatio?: string;
  /** NAI：实际使用的种子（seed=-1 时由请求体构建期随机定型后的值）。 */
  seed?: number;
  sampler?: string; scheduler?: string; steps?: number; cfg?: number;
  cfgRescale?: number; ucPreset?: number; qualityToggle?: boolean; autoSmea?: boolean;
  decrisper?: boolean; sm?: boolean; smDyn?: boolean;
  /** NAI：variety+ 强度（按尺寸与模型现算的 skip_cfg_above_sigma）。 */
  skipCfgAboveSigma?: number;
}

export interface ImageGenRecord {
  provider: ImageGenProvider;
  /** 生图模型（NAI 模型 id / OpenAI 模型名；ComfyUI 记配置值，真身在工作流 JSON 内）。 */
  model: string;
  /** 最终正向提示词（实际发出的完整形态；NAI 多角色时为 base_caption）。 */
  prompt: string;
  /** 最终负向提示词（NAI=UCP 预设前置后的完整 negative_prompt；OpenAI 恒空串）。 */
  negative: string;
  params: ImageGenParams;
  /** NAI 多角色结构（仅正文插图 NAI 多角色路径）。 */
  characters?: Array<{ prompt: string; uc: string; center?: { x: number; y: number } }>;
  useCoords?: boolean;
  /** ComfyUI 占位符替换后的最终工作流 JSON（含真实 seed/model，即完整请求）。 */
  workflow?: string;
}

/** 生成成功后回传档案的回调（调用方按需落盘；不传=不采集，零影响）。 */
export type ImageGenRecordSink = (record: ImageGenRecord) => void;

/** 元数据文本净化（model 名等非生图文字；超长截断防脏数据）。 */
const clampRecordText = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : '';

/** 生图文字净化：只做类型收敛，不设长度上限（重绘要按档案原样重放提示词/负面词）。 */
const keepRecordText = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 防御性净化：从磁盘读回的 gen 字段重建档案（旧数据/损坏数据容错；生图文字不截断，元数据超长截断）。 */
export function sanitizeImageGenRecord(raw: unknown): ImageGenRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const g = raw as Record<string, unknown>;
  const hasContent = typeof g.prompt === 'string' && g.prompt.trim()
    || typeof g.negative === 'string' && g.negative.trim()
    || typeof g.workflow === 'string' && g.workflow.trim();
  if (!hasContent) return undefined;
  const p = (g.params && typeof g.params === 'object' ? g.params : {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const params: ImageGenParams = {
    ...(num(p.width) !== undefined ? { width: num(p.width) } : {}),
    ...(num(p.height) !== undefined ? { height: num(p.height) } : {}),
    ...(str(p.aspectRatio) ? { aspectRatio: str(p.aspectRatio) } : {}),
    ...(num(p.seed) !== undefined ? { seed: num(p.seed) } : {}),
    ...(str(p.sampler) ? { sampler: str(p.sampler) } : {}),
    ...(str(p.scheduler) ? { scheduler: str(p.scheduler) } : {}),
    ...(num(p.steps) !== undefined ? { steps: num(p.steps) } : {}),
    ...(num(p.cfg) !== undefined ? { cfg: num(p.cfg) } : {}),
    ...(num(p.cfgRescale) !== undefined ? { cfgRescale: num(p.cfgRescale) } : {}),
    ...(num(p.ucPreset) !== undefined ? { ucPreset: num(p.ucPreset) } : {}),
    ...(bool(p.qualityToggle) !== undefined ? { qualityToggle: bool(p.qualityToggle) } : {}),
    ...(bool(p.autoSmea) !== undefined ? { autoSmea: bool(p.autoSmea) } : {}),
    ...(bool(p.decrisper) !== undefined ? { decrisper: bool(p.decrisper) } : {}),
    ...(bool(p.sm) !== undefined ? { sm: bool(p.sm) } : {}),
    ...(bool(p.smDyn) !== undefined ? { smDyn: bool(p.smDyn) } : {}),
    ...(num(p.skipCfgAboveSigma) !== undefined ? { skipCfgAboveSigma: num(p.skipCfgAboveSigma) } : {}),
  };
  const characters = Array.isArray(g.characters)
    ? (g.characters as unknown[]).slice(0, 16).map((c) => {
      const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      const center = (o.center && typeof o.center === 'object' ? o.center : {}) as Record<string, unknown>;
      return {
        prompt: keepRecordText(o.prompt),
        uc: keepRecordText(o.uc),
        ...(num(center.x) !== undefined && num(center.y) !== undefined
          ? { center: { x: num(center.x)!, y: num(center.y)! } }
          : {}),
      };
    })
    : undefined;
  return {
    provider: g.provider === 'openai' || g.provider === 'comfyui' || g.provider === 'novelai' ? g.provider : 'unknown',
    model: clampRecordText(g.model, 200),
    prompt: keepRecordText(g.prompt),
    negative: keepRecordText(g.negative),
    params,
    ...(characters && characters.length ? { characters, useCoords: g.useCoords === true } : {}),
    ...(typeof g.workflow === 'string' && g.workflow ? { workflow: g.workflow.slice(0, 200000) } : {}),
  };
}

/** 从 NAI 请求体提取档案（体即真相：input/negative_prompt/seed/skip_cfg 已是最终形态）。
 *  characters 可选：多角色路径由调用方从 StoryImageGenOpts 或重绘时的旧档案传入。 */
function recordFromNovelAiBody(body: Record<string, unknown>, characters?: ImageGenRecord['characters']): ImageGenRecord {
  const p = body.parameters as Record<string, unknown>;
  return {
    provider: 'novelai',
    model: String(body.model || ''),
    prompt: String(body.input || ''),
    negative: String(p.negative_prompt || ''),
    params: {
      width: Number(p.width), height: Number(p.height), seed: Number(p.seed),
      sampler: String(p.sampler || ''), scheduler: String(p.noise_schedule || ''),
      steps: Number(p.steps), cfg: Number(p.scale),
      cfgRescale: Number(p.cfg_rescale), ucPreset: Number(p.ucPreset),
      qualityToggle: Boolean(p.qualityToggle), autoSmea: Boolean(p.autoSmea),
      decrisper: Boolean(p.dynamic_thresholding),
      sm: Boolean(p.sm), smDyn: Boolean(p.sm_dyn),
      skipCfgAboveSigma: Number(p.skip_cfg_above_sigma),
    },
    ...(characters && characters.length ? { characters, useCoords: true } : {}),
  };
}

/** 正文插图多角色结构化参数（仅 story-image 路径使用；立绘等不传 → 走原扁平路径）。 */
export interface StoryImageGenOpts {
  multi: StoryMultiChar;
  prefix: string;
  suffix: string;
}

/** 宿主页协议（srcdoc iframe 自身 location 是 about:，须看父页面）。跨域父不可读时回退自身。 */
function hostPageProtocol(): string {
  try {
    const parent = (window as any).parent;
    if (parent && parent !== window && parent.location && parent.location.protocol) return String(parent.location.protocol);
  } catch (_e) { /* 跨域父页面 */ }
  try { return String(location.protocol); } catch (_e) { return ''; }
}

/** 混合内容预检：https 页面请求 http 接口必被浏览器静默拦截（表现为 Failed to fetch /「被拒绝」，
 *  与酒馆/云酒馆/TauriTavern 等宿主形态无关，是浏览器对前端请求的统一限制），
 *  提前给出可行动的中文错误；localhost 系视为潜在可信源不拦截。 */
function assertNotMixedContent(url: string): void {
  if (hostPageProtocol() !== 'https:') return;
  let u: URL;
  try { u = new URL(url); } catch (_e) { return; }
  if (u.protocol !== 'http:') return;
  const h = u.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost')) return;
  throw new ImageGenError('浏览器已拦截 http 地址（混合内容）：https 页面不能请求 http 接口。请改用 https 的中转站地址，或通过 http 访问酒馆页面');
}

/** 发送已构建的 NAI 请求体并提取图片（正常生成与按档案重绘共用）。
 *  浏览器直连目标地址（官方 / 中转站、http / https 一视同仁，受跨域与混合内容约束）：
 *  端点双形态（完整端点优先，失败自动改试去后缀裸地址）+ 网络错误 1 秒原址重试。 */
async function postNovelAiBody(
  c: NovelAiConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const { primary, fallback } = novelaiEndpoints(c.url);
  assertNotMixedContent(primary);
  const send = (u: string) => fetch(u, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.key}`,
      'Content-Type': 'application/json',
      Accept: '*/*',
    },
    body: JSON.stringify(body), signal,
  });
  // 单地址尝试：网络错误 1 秒后原址重试一次（瞬时故障，对齐 st-chatu8）；两次都网络失败返回 null
  const tryUrl = async (u: string): Promise<Response | null> => {
    try {
      return await send(u);
    } catch (e) {
      if (signal?.aborted) throw imageAbortError();
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      if (signal?.aborted) throw imageAbortError();
      try {
        return await send(u);
      } catch (e2) {
        if (signal?.aborted) throw imageAbortError();
        return null;
      }
    }
  };
  let resp = await tryUrl(primary);
  // 首选地址失败（网络不通或非 ok）→ 用去端点后缀的裸地址原样再试一次（兼容路径已路由好的中转站）；
  // 回退未成功时保留首选响应，错误仍按用户配置的地址形态报告（回退多打一发属失败路径，可接受）
  if (!resp || !resp.ok) {
    const alt = await tryUrl(fallback);
    if (alt && alt.ok) resp = alt;
  }
  if (!resp) throw new ImageGenError(`NovelAI 无法连接 ${primary}：请检查地址是否可达、该站点是否允许跨域（CORS）`);
  if (!resp.ok) throw new ImageGenError(`NovelAI HTTP ${resp.status}`, resp.status);
  const dataUrl = await responseToDataUrl(resp);
  if (!dataUrl) throw new ImageGenError('NovelAI 响应未提取到图片');
  return dataUrl;
}

async function generateNovelAiImage(
  c: NovelAiConfig,
  promptText: string,
  negativePrompt: string,
  signal?: AbortSignal,
  storyOpts?: StoryImageGenOpts,
  onRecord?: ImageGenRecordSink,
): Promise<string> {
  if (!c.url || !c.key) {
    throw new ImageGenError('NovelAI 配置缺失 url/key');
  }
  const body = storyOpts
    ? buildNovelAiStoryBody(c, storyOpts.multi, storyOpts.prefix, storyOpts.suffix, negativePrompt || '')
    : buildNovelAiBody(c, promptText, negativePrompt || '');
  const dataUrl = await postNovelAiBody(c, body, signal);
  // 生成成功才回传档案（失败没有图，档案无意义）
  try {
    onRecord?.(recordFromNovelAiBody(body, storyOpts
      ? storyOpts.multi.characters.map((ch) => ({ prompt: ch.prompt, uc: ch.uc, center: ch.centers }))
      : undefined));
  } catch (_e) { /* 档案采集不阻塞生图 */ }
  return dataUrl;
}

// —— OpenAI 兼容请求 ——
async function generateOpenAiImage(c: OpenAiConfig, promptText: string, signal?: AbortSignal): Promise<string> {
  if (!c.url || !c.model) throw new ImageGenError('OpenAI 配置缺失 url/model');
  const url = openaiBase(c.url);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (c.key) headers.Authorization = `Bearer ${c.key}`;
  const body: Record<string, unknown> = {
    model: c.model, stream: false,
    messages: [{ role: 'user', content: promptText }],
  };
  if (c.aspectRatio && c.aspectRatio !== 'auto') body.extra_body = { imageConfig: { aspectRatio: c.aspectRatio } };
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!resp.ok) throw new ImageGenError(`OpenAI HTTP ${resp.status}: ${await resp.text().catch(() => '')}`, resp.status);
  const dataUrl = await responseToDataUrl(resp);
  if (!dataUrl) throw new ImageGenError('OpenAI 响应未提取到图片');
  return dataUrl;
}

// —— 全局生图间隔闸门 ——
// 所有立绘/衣柜生图都经 generateImage 出口，在此统一节流：任意两次生图请求间隔 ≥ 配置秒数。
// 完成后计时（resolve/reject 都记录——失败也计入间隔）；间隔 0 不节流；尊重 AbortSignal。
let _lastImageAt = 0;

function currentImageIntervalMs(): number {
  const sec = getConfig().imageGeneration.intervalSeconds ?? 45;
  return sec * 1000;
}

/** 距下次可发起还需多少 ms（≥0）。测试/提示用。 */
export function __measureNextWaitMs(): number {
  const interval = currentImageIntervalMs();
  if (interval <= 0 || !_lastImageAt) return 0;
  return Math.max(0, interval - (Date.now() - _lastImageAt));
}

/** 测试专用：记录一次「生图完成」时间戳。 */
export function __markImageCompleted(): void {
  _lastImageAt = Date.now();
}

/** 等待到全局间隔期满；signal 中止时抛 imageAbortError。 */
export async function __waitForGlobalImageInterval(signal?: AbortSignal): Promise<void> {
  const interval = currentImageIntervalMs();
  if (interval <= 0) return;
  const need = __measureNextWaitMs();
  if (need <= 0) return;
  if (signal?.aborted) throw imageAbortError();
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, need);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(imageAbortError()); }, { once: true });
  });
}

/** 测试复位。 */
export function __resetImageIntervalGateForTests(): void {
  _lastImageAt = 0;
}

// —— 单并发队列（仅 NovelAI，避免限流；1:1 复刻 phone-ctn 0685.js:773-809）——
interface QueueItem { fn: () => Promise<string>; resolve: (v: string) => void; reject: (e: unknown) => void; }
const _queue: QueueItem[] = [];
let _running = false;

function imageAbortError(): Error {
  const error = new Error('图片生成任务已取消');
  error.name = 'AbortError';
  return error;
}

async function _drain(): Promise<void> {
  if (_running) return;
  _running = true;
  while (_queue.length > 0) {
    const item = _queue.shift()!;
    try { item.resolve(await item.fn()); } catch (e) { item.reject(e); }
  }
  _running = false;
}

export async function generateImage(
  config: PortraitImageGen,
  promptText: string,
  negativePrompt: string,
  signal?: AbortSignal,
  quiet?: boolean,
  storyOpts?: StoryImageGenOpts,
  onRecord?: ImageGenRecordSink,
): Promise<string> {
  // 全局间隔节流：距上次生图完成不足间隔时等待。这是尽力而为的间隔约束而非严格串行——
  // 此处测量后、真正等待前若并发任务完成并重置了时间戳，__waitForGlobalImageInterval 会
  // 重测发现 need<=0 而直接放行（并发完成合法地重置计时器）。手动场景（quiet 未传）给 toastr 提示。
  const need = __measureNextWaitMs();
  if (need > 0 && !quiet) {
    const sec = Math.ceil(need / 1000);
    const tr = getToastr();
    tr?.info?.(`距上次生图不足 ${sec} 秒，将自动排队生成`, '立绘');
  }
  return enqueueSharedImageTask(
    () => generateImageUngated(config, promptText, negativePrompt, signal, storyOpts, onRecord),
    signal,
  );
}

/**
 * 共享生图闸门：等待全局间隔 → 执行任务 → 完成（成功/失败都）计时。
 * 主项目 generateImage 与小手机（独立 bundle，经 window.__ubImageGenQueue 桥）的生图第二步
 * 都经此排队，保证跨界面生图共用同一间隔池、互不并发撞车。
 */
export async function enqueueSharedImageTask<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await __waitForGlobalImageInterval(signal);
  try {
    const result = await task();
    _lastImageAt = Date.now();
    return result;
  } catch (e) {
    _lastImageAt = Date.now();
    throw e;
  }
}

/** 生图供应商分发（无间隔闸门、不计时——统一由 enqueueSharedImageTask 负责）。导出供小手机共享闸门内复用。 */
export async function generateImageUngated(
  config: PortraitImageGen,
  promptText: string,
  negativePrompt: string,
  signal?: AbortSignal,
  storyOpts?: StoryImageGenOpts,
  onRecord?: ImageGenRecordSink,
): Promise<string> {
  if (signal?.aborted) throw imageAbortError();
  if (config.apiFormat === 'openai') {
    const flat = storyOpts ? flattenStoryMulti(storyOpts.multi, storyOpts.prefix, storyOpts.suffix) : promptText;
    const c = config.openai;
    // 智慧姬通道（chatu8）：生图整体转交酒馆里的 st-chatu8 插件执行（地址/密钥/模型用智慧姬里配的），
    // 跳过内置直连的 url/model 校验与 WaveSpeed 探测；档案仍记 openai 供应商（重绘按当前通道重新执行）。
    if (c.chatu8 === true) {
      // 分角色结构优先走智慧姬原生契约（NovelAI 4/4.5 → 真分角色 captions；banana → " | " 拼自然语言）；
      // 其余模式（SD/ComfyUI/NAI3）返回 null 回退扁平化——标签行名对它们只是字面垃圾。
      // 无 storyOpts 时直发的提示词同样过标签净化：纯景物块的契约原文（Scene 行无结尾 ';'）会被
      // 智慧姬判成分角色模式却解析不出 → 整段清空（见 sanitizeChatu8PromptText 的事故记录）。
      const chatu8Prompt = sanitizeChatu8PromptText(storyOpts
        ? (buildChatu8MultiCharPrompt(storyOpts.multi, storyOpts.prefix, storyOpts.suffix) ?? flat)
        : flat);
      const chatu8Negative = String(negativePrompt || '').trim();
      const dataUrl = await generateImageViaChatu8(chatu8Prompt, signal, { negative: chatu8Negative });
      try {
        onRecord?.({
          provider: 'openai',
          model: getChatu8BackendModel() || '',
          prompt: chatu8Prompt,
          negative: chatu8Negative,
          params: {},
          // 契约形态存档：重绘按角色结构重建契约（不存则只剩单段串，重绘会丢角色描述）
          ...(storyOpts && chatu8Prompt !== flat
            ? {
                characters: storyOpts.multi.characters.slice(0, 4).map((ch) => ({
                  prompt: ch.prompt,
                  uc: ch.uc || '',
                  ...(ch.centers ? { center: ch.centers } : {}),
                })),
                useCoords: true,
              }
            : {}),
        });
      } catch (_e) { /* 档案采集不阻塞生图 */ }
      return dataUrl;
    }
    // 柏宝绘通道（baibai）：生图整体转交酒馆里的 ST-BaiBai-Image 插件执行（后端/模型/画师串/质量词/
    // 负面/尺寸/并发闸门全用柏宝绘「渠道」页配的那套，本项目只发提示词），同样跳过内置直连的
    // url/model 校验与 WaveSpeed 探测；档案仍记 openai 供应商（重绘按当前通道重新执行）。
    if (c.baibai === true) {
      // 提示词分解与传输（柏宝绘为结构化 API，与智慧姬文本契约不同）：
      //  - 有分角色结构且其后端支持（NAI 4.5/V5）→ 场景进 prompt、各角色描述进 characters（真分角色）；
      //  - 后端不支持（ComfyUI）或无结构 → 扁平化单段（与内置非 NAI 供应商同口径；柏宝绘自己也不做
      //    角色档案降级拼 prompt，但我们发的是 AI 写的画面标签而非外貌档案，扁平化正是既有行为）；
      //  - 负面词透传：只在其 ComfyUI 后端生效（追加在其渠道负面之后），NAI 后端忽略——与智慧姬同构；
      //  - 尺寸只传画幅方向（像素取其渠道配置，渠道锁定方向时以其锁定为准）；seed 不传（其用户设置决定）。
      const status = baibaiBackendStatus();
      const structured = !!(storyOpts && status && status.supportsCharacters && storyOpts.multi.characters.length);
      const characters = structured ? buildBaiBaiCharacters(storyOpts.multi.characters) : [];
      const baibaiPrompt = structured
        ? joinComma([storyOpts.prefix, storyOpts.multi.scene, storyOpts.suffix])
        // 无结构时若提示词还是契约文本形态（纯景物块直发），去标签留正文
        : sanitizeBaiBaiPromptText(flat);
      const baibaiNegative = String(negativePrompt || '').trim();
      const result = await generateImageViaBaiBai({
        prompt: baibaiPrompt,
        negative: baibaiNegative || undefined,
        characters,
        size: baibaiOrientationFromAspectRatio(c.aspectRatio),
        character: '统一状态栏',
      }, signal);
      try {
        onRecord?.({
          provider: 'openai',
          model: status?.model || '',
          prompt: baibaiPrompt,
          negative: baibaiNegative,
          // 柏宝绘回显实际 seed：记进档案供展示与「想复现就填回」；重绘默认新随机（与 NAI/ComfyUI 同策略）
          params: { seed: result.seed },
          // 分角色结构存档：重绘按角色结构重建（角色 UC/坐标柏宝绘 API 不收，存档仍留全量供切回内置用）
          ...(structured && result.charactersApplied
            ? {
                characters: storyOpts.multi.characters.map((ch) => ({
                  prompt: ch.prompt,
                  uc: ch.uc || '',
                  ...(ch.centers ? { center: ch.centers } : {}),
                })),
                useCoords: true,
              }
            : {}),
        });
      } catch (_e) { /* 档案采集不阻塞生图 */ }
      return result.dataUrl;
    }
    // WaveSpeed 合并通道：地址/模型命中 WaveSpeed 时自动改走其提交+轮询 API（供应商枚举与设置面板零新增）。
    // 尺寸按宽高比换算（OpenAI 兼容 UI 只暴露宽高比，WaveSpeed 按像素出图）。
    const isWs = isWavespeedSource(c.url, c.model);
    const wsSize = isWs ? wavespeedSizeFromAspectRatio(c.aspectRatio) : null;
    const dataUrl = isWs
      ? await generateWavespeedImage(c, flat, signal, { size: wsSize! })
      : await generateOpenAiImage(c, flat, signal);
    try {
      // 档案 provider 仍记 'openai'（合并通道不扩枚举）：重绘时按当前 openai 配置重新探测即可复现；
      // WaveSpeed 实际像素尺寸/seed 写进 params 供重绘与展示（seed 恒 -1：API 不回显实际值）。
      onRecord?.({
        provider: 'openai',
        model: c.model || '',
        prompt: flat,
        negative: '',
        params: wsSize
          ? { aspectRatio: c.aspectRatio || 'auto', ...wsSize, seed: -1 }
          : { aspectRatio: c.aspectRatio || 'auto' },
      });
    } catch (_e) { /* 档案采集不阻塞生图 */ }
    return dataUrl;
  }
  if (config.apiFormat === 'comfyui') {
    const flat = storyOpts ? flattenStoryMulti(storyOpts.multi, storyOpts.prefix, storyOpts.suffix) : promptText;
    // 最终工作流（占位符替换后，含真实 seed/model）即 ComfyUI 完整请求，原样存档
    let workflowJson = '';
    const dataUrl = await generateComfyUiImage(config.comfyui, flat, negativePrompt, signal, (wf) => { workflowJson = wf; });
    try {
      onRecord?.({
        provider: 'comfyui',
        model: config.comfyui.model || '',
        prompt: flat,
        negative: negativePrompt || '',
        params: {
          width: config.comfyui.width || undefined,
          height: config.comfyui.height || undefined,
          ...(config.comfyui.steps ? { steps: config.comfyui.steps } : {}),
          ...(config.comfyui.cfg ? { cfg: config.comfyui.cfg } : {}),
        },
        ...(workflowJson ? { workflow: workflowJson } : {}),
      });
    } catch (_e) { /* 档案采集不阻塞生图 */ }
    return dataUrl;
  }
  // NovelAI 走单并发队列（完成计时由外层共享闸门统一负责）
  return new Promise<string>((resolve, reject) => {
    _queue.push({
      fn: () => {
        if (signal?.aborted) throw imageAbortError();
        return generateNovelAiImage(config.novelai, promptText, negativePrompt, signal, storyOpts, onRecord);
      },
      resolve,
      reject,
    });
    void _drain();
  });
}

// ===== 按档案重新生图（原样重放最终请求；改过的提示词/参数仅本次生效，不影响全局设置）=====

/** 重新生图的可调字段：弹窗里改过的提示词/参数。undefined = 沿用档案原值。 */
export interface ImageGenRegenPatch {
  prompt?: string;
  negative?: string;
  params?: {
    width?: number; height?: number;
    /** 留空/不传 = 新随机 seed（默认策略：同 seed 在 NAI/ComfyUI 几乎必然复刻出原图）；填写则按该 seed 重绘。 */
    seed?: number;
    steps?: number; cfg?: number; cfgRescale?: number;
    sampler?: string; scheduler?: string;
    /** OpenAI 兼容：请求比例。 */
    aspectRatio?: string;
  };
}

/** 档案是否具备重绘条件（UI 据此渲染「重新生图」按钮；旧条目/信息不全不开放重绘）。 */
export function isRecordReplayable(record?: ImageGenRecord): boolean {
  if (!record) return false;
  if (record.provider === 'novelai') {
    return !!record.model && !!record.prompt
      && typeof record.params.width === 'number' && record.params.width > 0
      && typeof record.params.height === 'number' && record.params.height > 0
      && typeof record.params.seed === 'number' && Number.isFinite(record.params.seed);
  }
  if (record.provider === 'openai') return !!record.prompt;
  if (record.provider === 'comfyui') return !!record.workflow;
  return false;
}

/** 档案 → NAI 请求体（recordFromNovelAiBody 的逆）：档案文本即最终形态（AQT/UCP 已在其中），原样重发绝不二次追加。
 *  patch 只覆盖弹窗里改过的字段；尺寸改动时 skip_cfg_above_sigma 按新像素量重算（原值与旧尺寸绑定）。 */
function buildNovelAiBodyFromRecord(rec: ImageGenRecord, patch?: ImageGenRegenPatch): Record<string, unknown> {
  const p = rec.params;
  const pp = patch?.params || {};
  const width = typeof pp.width === 'number' && pp.width > 0 ? pp.width : (p.width || 1024);
  const height = typeof pp.height === 'number' && pp.height > 0 ? pp.height : (p.height || 1024);
  // seed 策略：默认新随机；调用方显式传合法 seed 则按其重绘
  const seed = typeof pp.seed === 'number' && Number.isFinite(pp.seed) && pp.seed >= 0
    ? Math.floor(pp.seed)
    : Math.floor(Math.random() * 4294967296);
  const sizeChanged = (typeof pp.width === 'number' && pp.width > 0 && pp.width !== p.width)
    || (typeof pp.height === 'number' && pp.height > 0 && pp.height !== p.height);
  const magicConstant = rec.model.includes('nai-diffusion-4-5') || rec.model.includes('nai-diffusion-5') ? 58 : 19;
  const sigma = sizeChanged || typeof p.skipCfgAboveSigma !== 'number' || !Number.isFinite(p.skipCfgAboveSigma)
    ? Math.pow((width * height) / 1011712, 0.5) * magicConstant
    : p.skipCfgAboveSigma;
  const input = patch?.prompt !== undefined ? patch.prompt : rec.prompt;
  const negative = patch?.negative !== undefined ? patch.negative : rec.negative;
  const chars = (rec.characters || []).filter((ch) => ch.prompt || ch.uc);
  const multi = chars.length > 0;
  const useCoords = multi && rec.useCoords === true;
  const charCaptions = multi ? chars.map((ch) => ({ char_caption: ch.prompt, ...(ch.center ? { centers: [ch.center] } : {}) })) : [];
  const characterPrompts = multi ? chars.map((ch) => ({ enabled: true, prompt: ch.prompt, ...(ch.center ? { center: ch.center } : {}), uc: ch.uc })) : [];
  const negCharCaptions = multi ? chars.map((ch) => ({ char_caption: ch.uc, ...(ch.center ? { centers: [ch.center] } : {}) })) : [];
  return {
    action: 'generate',
    input,
    model: rec.model,
    parameters: {
      params_version: 3,
      width, height,
      scale: typeof pp.cfg === 'number' && Number.isFinite(pp.cfg) ? pp.cfg : (p.cfg ?? 5),
      seed,
      sampler: pp.sampler || p.sampler || 'k_euler',
      noise_schedule: pp.scheduler || p.scheduler || 'karras',
      steps: typeof pp.steps === 'number' && Number.isFinite(pp.steps) ? pp.steps : (p.steps ?? 28),
      n_samples: 1,
      ucPreset: p.ucPreset ?? 0,
      qualityToggle: p.qualityToggle ?? false,
      autoSmea: p.autoSmea ?? false,
      cfg_rescale: typeof pp.cfgRescale === 'number' && Number.isFinite(pp.cfgRescale) ? pp.cfgRescale : (p.cfgRescale ?? 0),
      dynamic_thresholding: p.decrisper ?? false,
      controlnet_strength: 1,
      legacy: false, add_original_image: true,
      legacy_v3_extend: false, use_coords: useCoords, legacy_uc: false,
      normalize_reference_strength_multiple: false,
      inpaintImg2ImgStrength: 1,
      skip_cfg_above_sigma: sigma,
      sm: p.sm ?? false, sm_dyn: p.smDyn ?? false,
      stream: 'msgpack',
      characterPrompts,
      v4_prompt: { caption: { base_caption: input, char_captions: charCaptions }, use_coords: useCoords, use_order: true },
      v4_negative_prompt: { caption: { base_caption: negative, char_captions: negCharCaptions }, legacy_uc: false },
      negative_prompt: negative,
    },
  };
}

/** 重新生图可选设置。 */
export interface ImageGenRegenOptions {
  signal?: AbortSignal;
  /** 不弹「排队生成」提示（进度由调用方的任务通知展示）。 */
  quiet?: boolean;
  /**
   * 通道覆盖（「自己选生图模式」的调用方用，如小手机：它的相册/相机「换一张」必须按**手机自己选的模式**
   * 走，而不是按主项目的「生图接口」开关——两者是各自显式选择，可能不一致）。
   * true=强制转交智慧姬；false=强制按档案走内置通道；undefined=跟随主项目「生图接口」开关（历史行为）。
   * 只影响**走哪条通道**，供应商仍按档案（record.provider）重放。
   */
  chatu8?: boolean;
  /** 同上，柏宝绘通道版：true=强制转交柏宝绘；false=强制内置；undefined=跟随主项目开关。
   *  与 chatu8 同时显式给出时 chatu8 优先（与首图分发 chatu8 → baibai 的判定顺序一致）。 */
  baibai?: boolean;
}

/** 按档案重新生图：按 provider 分发重放（密钥/地址一律用当前设置里该供应商的配置，不入档的字段不造假）。
 *  成功后经 onRecord 回传新档案（=本次实际发送形态，含改过的提示词/参数与新 seed）；失败不回传、调用方不落盘。 */
export async function regenerateFromRecord(
  record: ImageGenRecord,
  patch: ImageGenRegenPatch = {},
  opts: ImageGenRegenOptions = {},
  onRecord?: ImageGenRecordSink,
): Promise<string> {
  // 全局生图间隔闸（与 generateImage 同源；quiet 不弹排队提示，进度由调用方的任务通知展示）
  const need = __measureNextWaitMs();
  if (need > 0) {
    if (!opts.quiet) {
      const sec = Math.ceil(need / 1000);
      getToastr()?.info?.(`距上次生图不足 ${sec} 秒，将自动排队生成`, '重新生图');
    }
    await __waitForGlobalImageInterval(opts.signal);
  }
  if (opts.signal?.aborted) throw imageAbortError();
  // 密钥/地址等连接信息用当前设置的供应商配置（不入档）；模型/参数/提示词以档案为准
  const ig = getConfig().imageGeneration.provider;
  // 智慧姬接口开启时重绘一律转交智慧姬执行（与首图 generateImageUngated 同口径：通道位先于按档案供应商重放）。
  // 通道判据：opts.chatu8 显式给了就用它（小手机按自己的 imageMode 传：智慧姬模式=true、内置模式=false），
  // 否则跟随主项目「生图接口」开关（主项目自己的调用方与旧行为）。
  // 提示词/负面词以档案为准（弹窗改过的覆盖）；尺寸/seed 与首图同规不发送；新档案仍记 openai 供应商。
  const useChatu8 = opts.chatu8 !== undefined ? opts.chatu8 : ig.openai?.chatu8 === true;
  if (useChatu8) {
    const prompt = patch.prompt !== undefined ? patch.prompt : record.prompt;
    const negative = String((patch.negative !== undefined ? patch.negative : record.negative) || '').trim();
    // 档案带分角色结构（NAI 多角色档案/本通道契约档案）且未改词 → 按角色结构重建契约（模式不吃则回退原串）；
    // 弹窗改过词则以改后的单段词为准（改后的词可能与原角色结构不再对应）。
    let sendPrompt = prompt;
    let sentCharacters: ImageGenRecord['characters'];
    if (patch.prompt === undefined && record.characters && record.characters.length) {
      const contract = buildChatu8MultiCharPrompt(
        { scene: prompt, characters: record.characters.map((ch) => ({ prompt: ch.prompt, uc: ch.uc, centers: ch.center ?? null })) },
        '',
        '',
      );
      if (contract) {
        sendPrompt = contract;
        sentCharacters = record.characters;
      }
    }
    // 旧档案/弹窗改过的提示词若仍是「智慧姬吃不掉的契约标签形态」（如修复前生成的纯景物图档案），
    // 重绘前同样净化——否则重放旧串又会被智慧姬清空成只剩它的质量预设。
    sendPrompt = sanitizeChatu8PromptText(sendPrompt);
    try {
      const dataUrl = await generateImageViaChatu8(sendPrompt, opts.signal, { negative });
      try {
        onRecord?.({
          provider: 'openai',
          model: getChatu8BackendModel() || '',
          prompt: sendPrompt,
          negative,
          params: {},
          ...(sentCharacters ? { characters: sentCharacters, useCoords: true } : {}),
        });
      } catch (_e) { /* 档案采集不阻塞生图 */ }
      _lastImageAt = Date.now();
      return dataUrl;
    } catch (e) {
      _lastImageAt = Date.now();
      throw e;
    }
  }
  // 柏宝绘接口开启时重绘转交柏宝绘执行（与首图同口径；判定顺序与首图一致：chatu8 → baibai → 按档案供应商）。
  // opts.baibai 三态语义与 opts.chatu8 同款（「自己选生图模式」的调用方按自己的开关传）。
  // 提示词/负面词以档案为准（弹窗改过的覆盖）；seed 只在弹窗显式指定时发送（默认新随机，与 NAI/ComfyUI
  // 重绘策略一致——档案 params.seed 记着柏宝绘回显的实际种子，想复现原图就把它填回去）；新档案仍记 openai。
  const useBaiBai = !useChatu8 && (opts.baibai !== undefined ? opts.baibai : ig.openai?.baibai === true);
  if (useBaiBai) {
    const negative = String((patch.negative !== undefined ? patch.negative : record.negative) || '').trim();
    const status = baibaiBackendStatus();
    let sendPrompt: string;
    let sentCharacters: ImageGenRecord['characters'];
    if (patch.prompt === undefined && record.characters && record.characters.length && status && status.supportsCharacters) {
      // 档案带分角色结构且未改词 → 按角色结构重放；档案 prompt 可能是智慧姬通道的契约文本 → 抽 Scene 字段，
      // 契约残缺（净化后角色已并入文本）则不带 characters 扁平重放（外貌再发一遍必重复）
      const replay = baibaiReplayPrompt(record.prompt);
      sendPrompt = replay.scene;
      sentCharacters = replay.structured ? record.characters : undefined;
    } else {
      // 扁平重放：改过词或无结构；旧档案若还是契约文本形态，去标签留正文
      sendPrompt = sanitizeBaiBaiPromptText(patch.prompt !== undefined ? patch.prompt : record.prompt);
    }
    const characters = sentCharacters ? buildBaiBaiCharacters(sentCharacters) : [];
    const seed = typeof patch.params?.seed === 'number' && Number.isFinite(patch.params.seed) && patch.params.seed > 0
      ? Math.floor(patch.params.seed)
      : undefined;
    const aspect = patch.params?.aspectRatio || record.params.aspectRatio;
    try {
      const result = await generateImageViaBaiBai({
        prompt: sendPrompt,
        negative: negative || undefined,
        characters,
        ...(seed !== undefined ? { seed } : {}),
        size: baibaiOrientationFromAspectRatio(aspect),
        character: '统一状态栏',
      }, opts.signal);
      try {
        onRecord?.({
          provider: 'openai',
          model: status?.model || '',
          prompt: sendPrompt,
          negative,
          params: { seed: result.seed },
          ...(sentCharacters && result.charactersApplied ? { characters: sentCharacters, useCoords: true } : {}),
        });
      } catch (_e) { /* 档案采集不阻塞生图 */ }
      _lastImageAt = Date.now();
      return result.dataUrl;
    } catch (e) {
      _lastImageAt = Date.now();
      throw e;
    }
  }
  if (record.provider === 'openai') {
    const prompt = patch.prompt !== undefined ? patch.prompt : record.prompt;
    const c = {
      ...ig.openai,
      model: record.model || ig.openai.model,
      aspectRatio: patch.params?.aspectRatio || record.params.aspectRatio || ig.openai.aspectRatio || 'auto',
    };
    try {
      let dataUrl: string;
      if (isWavespeedSource(c.url, c.model)) {
        // WaveSpeed 合并通道重绘：尺寸/seed 以档案（+弹窗改动）为准；缺尺寸时按宽高比换算兜底
        const fallback = wavespeedSizeFromAspectRatio(c.aspectRatio);
        const size = wavespeedClampSize({
          width: typeof patch.params?.width === 'number' && patch.params.width > 0 ? patch.params.width : (record.params.width || fallback.width),
          height: typeof patch.params?.height === 'number' && patch.params.height > 0 ? patch.params.height : (record.params.height || fallback.height),
        });
        const wsSeed = typeof patch.params?.seed === 'number' && patch.params.seed >= 0 ? Math.floor(patch.params.seed) : -1;
        dataUrl = await generateWavespeedImage(c, prompt, opts.signal, { size, seed: patch.params?.seed });
        try {
          onRecord?.({
            provider: 'openai', model: c.model || '', prompt, negative: '',
            params: { aspectRatio: c.aspectRatio, ...size, seed: wsSeed },
          });
        } catch (_e) { /* 档案采集不阻塞生图 */ }
      } else {
        dataUrl = await generateOpenAiImage(c, prompt, opts.signal);
        try {
          onRecord?.({
            provider: 'openai', model: c.model || '', prompt, negative: '',
            params: { aspectRatio: c.aspectRatio || 'auto' },
          });
        } catch (_e) { /* 档案采集不阻塞生图 */ }
      }
      _lastImageAt = Date.now();
      return dataUrl;
    } catch (e) {
      _lastImageAt = Date.now();
      throw e;
    }
  }
  if (record.provider === 'comfyui') {
    try {
      if (!ig.comfyui.url) throw new ImageGenError('ComfyUI 未配置 url，无法按档案重绘（请先在设置中配置）');
      // 存档工作流即完整请求；弹窗改过的提示词经自动注入覆盖提示词节点，改过的参数覆盖采样器/画布节点
      const workflow = parseWorkflow(record.workflow || '');
      const prompt = patch.prompt !== undefined ? patch.prompt : record.prompt;
      const negative = patch.negative !== undefined ? patch.negative : record.negative;
      autoInjectPrompt(workflow, prompt, negative);
      // seed 策略与 NAI 对齐：patch 未显式给 seed 时按新随机覆盖工作流内 seed（同 seed 重放会复刻出原图）
      const wfParams = { ...patch.params, seed: patch.params?.seed ?? Math.floor(Math.random() * 4294967296) };
      applyComfyParamOverrides(workflow, wfParams);
      let workflowJson = '';
      const dataUrl = await submitComfyWorkflow(ig.comfyui, workflow, opts.signal, (final) => { workflowJson = final; });
      try {
        onRecord?.({
          provider: 'comfyui', model: record.model || ig.comfyui.model || '',
          prompt, negative: negative || '',
          params: { ...record.params, ...(patch.params || {}), seed: wfParams.seed },
          ...(workflowJson ? { workflow: workflowJson } : {}),
        });
      } catch (_e) { /* 档案采集不阻塞生图 */ }
      _lastImageAt = Date.now();
      return dataUrl;
    } catch (e) {
      _lastImageAt = Date.now();
      throw e;
    }
  }
  if (record.provider === 'novelai') {
    const c = ig.novelai;
    if (!c.url || !c.key) throw new ImageGenError('NovelAI 未配置 url/key，无法按档案重绘（请先在设置中配置）');
    const body = buildNovelAiBodyFromRecord(record, patch);
    return new Promise<string>((resolve, reject) => {
      _queue.push({
        fn: () => {
          if (opts.signal?.aborted) throw imageAbortError();
          return postNovelAiBody(c, body, opts.signal);
        },
        resolve: (v) => {
          _lastImageAt = Date.now();
          try { onRecord?.(recordFromNovelAiBody(body, record.characters)); } catch (_e) { /* 档案采集不阻塞生图 */ }
          resolve(v);
        },
        reject: (e) => { _lastImageAt = Date.now(); reject(e); },
      });
      void _drain();
    });
  }
  throw new ImageGenError('该条目没有可重绘的完整生图档案（旧条目不支持重新生图）');
}
