// ===== 本地模型 TTS（ComfyUI 音频工作流） =====
// 与主项目生图的 ComfyUI 路径同构，但**自包含**（不 import 主项目 comfyui-client：
//   其依赖 portrait-config/image-gen，不在小手机跨项目 import 白名单内）。
// 支持的形态：ComfyUI「Save (API Format)」导出的 API 格式工作流（节点值带 class_type）。
//   UI 格式（带 nodes 数组）不支持自动转换——请用 Save (API Format) 重新导出（报错会提示）。
//
// 注入策略（两段）：
//   ① 占位符优先：工作流里写 %text% / %seed% / %ref_audio% 就替换（对齐主项目 %prompt% 口径）。
//   ② 自动兜底：找不到占位符时，挑 class_type 含 TTS/VoiceClone 且带 text 输入的节点写台词、
//      挑 LoadAudio 节点写参考音频文件名；都没有则保持工作流原样（用其内置默认）。
//
// 参考音频（声音克隆）：POST {base}/upload/image（ComfyUI 该端点可存任意文件到 input/）→ 拿文件名。

export interface VoiceComfyConfig {
  url: string;
  timeoutSeconds?: number;
}

interface ComfyAudioRef { filename: string; subfolder: string; type: string; }

const DEFAULT_TIMEOUT_SECONDS = 180;

/** 解析工作流文本：JSON → 对象；兼容 {workflow} / {workflows:[{workflow}]} 包裹。 */
export function parseVoiceWorkflow(text: string): Record<string, unknown> {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('未配置 ComfyUI 语音工作流（请粘贴工作流 JSON）');
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (_e) {
    throw new Error('ComfyUI 语音工作流不是合法 JSON');
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    if (rec.workflow && typeof rec.workflow === 'object') return rec.workflow as Record<string, unknown>;
    if (Array.isArray(rec.workflows) && rec.workflows.length) {
      const first = rec.workflows[0] as Record<string, unknown>;
      if (first?.workflow && typeof first.workflow === 'object') return first.workflow as Record<string, unknown>;
    }
    return rec;
  }
  throw new Error('ComfyUI 语音工作流结构无法识别');
}

/** 校验是否 API 格式（至少一个节点的值是带 class_type 的对象）。 */
export function isApiFormatWorkflow(wf: Record<string, unknown>): boolean {
  for (const v of Object.values(wf)) {
    if (v && typeof v === 'object' && typeof (v as any).class_type === 'string') return true;
  }
  return false;
}

const TOKEN_RE = /%[A-Za-z0-9_]+%/g;

/** 占位符替换（值可为 string/number；未定义的 token 原样保留）。 */
export function applyVoicePlaceholders(node: unknown, values: Record<string, unknown>): unknown {
  if (typeof node === 'string') {
    const exact = node.match(/^%([A-Za-z0-9_]+)%$/);
    if (exact && exact[1] in values) return values[exact[1]];
    return node.replace(TOKEN_RE, (m) => {
      const key = m.slice(1, -1);
      return key in values ? String(values[key]) : m;
    });
  }
  if (Array.isArray(node)) return node.map(n => applyVoicePlaceholders(n, values));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = applyVoicePlaceholders(v, values);
    }
    return out;
  }
  return node;
}

export interface VoiceWorkflowInject {
  text: string;
  seed?: number;
  /** 参考音频文件名（ComfyUI input/ 内）；空则不覆盖工作流内的 LoadAudio。 */
  refAudio?: string;
}

/**
 * 注入台词 / seed / 参考音频（原地修改 workflow）。
 * 返回是否成功写入台词（false = 工作流里没有可写文本的节点，台词不会生效，调用方应报错）。
 */
export function injectVoiceWorkflow(wf: Record<string, unknown>, inject: VoiceWorkflowInject): boolean {
  const values: Record<string, unknown> = {
    text: inject.text,
    prompt: inject.text,
    positive_prompt: inject.text,
  };
  if (typeof inject.seed === 'number') values.seed = inject.seed;
  if (inject.refAudio) values.ref_audio = inject.refAudio;
  const replaced = applyVoicePlaceholders(wf, values) as Record<string, unknown>;
  // 替换结果写回原对象（保持引用不变，调用方持有的对象即最终工作流）
  for (const k of Object.keys(wf)) delete wf[k];
  Object.assign(wf, replaced);

  // 自动兜底：优先挑 TTS/克隆类节点写台词（只写一个，避免误改展示节点等的 text 输入）
  const nodes = Object.values(wf) as any[];
  const hasTextInput = (n: any): boolean => n && typeof n === 'object' && n.inputs && typeof n.inputs.text === 'string';
  const ttsNodes = nodes.filter(n => hasTextInput(n) && /tts|voice|clone|speech|audio.*dit/i.test(String(n.class_type || '')));
  const textNodes = nodes.filter(hasTextInput);
  const target = ttsNodes[0] || (textNodes.length === 1 ? textNodes[0] : null);
  let textWritten = false;
  if (target) { target.inputs.text = inject.text; textWritten = true; }

  if (inject.refAudio) {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (/^LoadAudio$/i.test(String(node.class_type || '')) && node.inputs && typeof node.inputs.audio === 'string') {
        node.inputs.audio = inject.refAudio;
      }
    }
  }
  return textWritten;
}

/** 从任务 outputs 里取音频产物（SaveAudioMP3/LoadAudio/PreviewAudio 产出在 audio 键）。 */
export function pickComfyAudio(outputs: Record<string, unknown>): ComfyAudioRef | null {
  const candidates: Array<{ ref: ComfyAudioRef; score: number }> = [];
  for (const nodeOut of Object.values(outputs)) {
    if (!nodeOut || typeof nodeOut !== 'object') continue;
    const audios = (nodeOut as any).audio;
    if (Array.isArray(audios)) {
      for (const a of audios) {
        if (!a || typeof a !== 'object') continue;
        const filename = String(a.filename || '');
        if (!filename) continue;
        const subfolder = String(a.subfolder || '');
        const type = String(a.type || '');
        let score = 0;
        if (/\.(mp3|wav|flac|ogg|m4a)$/i.test(filename)) score += 20;
        if (type === 'output') score += 10;
        if (type === 'temp') score -= 5; // 预览降权
        candidates.push({ ref: { filename, subfolder, type }, score });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].ref;
}

function comfyBase(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

function abortError(): Error {
  const e = new Error('语音生成任务已取消');
  e.name = 'AbortError';
  return e;
}

/** 轮询 /history 直到出现音频产物（或报错/超时）。 */
async function waitForAudioHistory(base: string, promptId: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<ComfyAudioRef> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw abortError();
    if (Date.now() > deadline) throw new Error('ComfyUI 语音生成超时，请检查工作流或服务端队列');
    const resp = await fetch(`${base}/history/${promptId}`, { signal });
    if (resp.ok) {
      const payload = await resp.json().catch(() => null);
      const entry = payload && (payload as any)[promptId];
      if (entry) {
        const status = entry.status;
        if (status && Array.isArray(status.messages)) {
          for (const m of status.messages) {
            const text = Array.isArray(m) ? m.map(String).join(' ') : String(m);
            if (/error|exception/i.test(text)) throw new Error('ComfyUI 执行错误: ' + text.slice(0, 240));
          }
        }
        if (entry.outputs && typeof entry.outputs === 'object') {
          const audio = pickComfyAudio(entry.outputs);
          if (audio) return audio;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** /view 取音频字节 → Blob。 */
async function fetchAudioBlob(base: string, ref: ComfyAudioRef, signal?: AbortSignal): Promise<{ blob: Blob; mime: string }> {
  const params = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
  const resp = await fetch(`${base}/view?${params}`, { signal });
  if (!resp.ok) throw new Error(`ComfyUI /view HTTP ${resp.status}`);
  const blob = await resp.blob();
  const mime = blob.type || (/\.wav$/i.test(ref.filename) ? 'audio/wav' : 'audio/mpeg');
  return { blob, mime };
}

/** 提交音频工作流 → 轮询 → 取 Blob（不进 dataURL，直接可入 IndexedDB）。 */
export async function submitComfyAudioWorkflow(
  cfg: VoiceComfyConfig,
  workflow: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ blob: Blob; mime: string; workflowJson: string }> {
  const base = comfyBase(cfg.url);
  if (!base) throw new Error('ComfyUI 未配置地址（设置→功能→语音）');
  const workflowJson = JSON.stringify(workflow);
  const clientId = 'ubp-voice-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const promptResp = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal,
  });
  if (!promptResp.ok) {
    let detail = '';
    try {
      const errPayload = await promptResp.json();
      detail = (errPayload?.error?.message) || errPayload?.error || errPayload?.message || JSON.stringify(errPayload);
    } catch (_e) {
      try { detail = await promptResp.text(); } catch (_e2) { /* ignore */ }
    }
    throw new Error(`ComfyUI /prompt HTTP ${promptResp.status}: ${String(detail).slice(0, 180)}`);
  }
  const promptResult: any = await promptResp.json().catch(() => ({}));
  const promptId: string | undefined = promptResult?.prompt_id;
  if (!promptId) throw new Error('ComfyUI /prompt 未返回 prompt_id');
  const timeoutMs = (cfg.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000;
  const audio = await waitForAudioHistory(base, promptId, signal, timeoutMs);
  const { blob, mime } = await fetchAudioBlob(base, audio, signal);
  return { blob, mime, workflowJson };
}

/** 上传参考音频到 ComfyUI input/（复用 /upload/image 端点，可存任意文件）。返回文件名。 */
export async function uploadComfyAudio(url: string, file: Blob, filename: string, signal?: AbortSignal): Promise<string> {
  const base = comfyBase(url);
  if (!base) throw new Error('ComfyUI 未配置地址');
  const safe = String(filename || 'ref').replace(/[^\w.-]/g, '_').slice(-80);
  const form = new FormData();
  form.append('image', file, safe.endsWith('.wav') || safe.endsWith('.mp3') ? safe : `${safe}.wav`);
  form.append('overwrite', 'true');
  const resp = await fetch(`${base}/upload/image`, { method: 'POST', body: form, signal });
  if (!resp.ok) throw new Error(`ComfyUI 参考音频上传失败 HTTP ${resp.status}`);
  const payload: any = await resp.json().catch(() => ({}));
  const name = payload?.name || payload?.filename || safe;
  const sub = payload?.subfolder ? `${payload.subfolder}/` : '';
  return `${sub}${name}`;
}

/** 解码音频 Blob 的真实时长（ms）；失败返回 undefined（播放时仍有 audio.duration 兜底）。 */
export async function decodeAudioDurationMs(blob: Blob): Promise<number | undefined> {
  try {
    const w = (typeof window !== 'undefined' ? window : globalThis) as any;
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise<number | undefined>((resolve) => {
        const el = new w.Audio();
        el.preload = 'metadata';
        el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : undefined);
        el.onerror = () => resolve(undefined);
        el.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (_e) {
    return undefined;
  }
}
