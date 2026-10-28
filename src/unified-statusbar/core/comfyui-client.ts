import { DEFAULT_COMFY_WORKFLOW_JSON, resolveActiveComfyWorkflow } from './portrait-config';
import type { ComfyUiConfig } from './portrait-config';
import { ImageGenError } from './image-gen-error';

// —— 占位符表：token -> values 中的键 ——
// applyPlaceholders 用 values[token] 替换。别名（%positive_prompt% 等）在 buildPlaceholderValues 时预填同值。
export interface ComfyPlaceholderValues {
  prompt: string;
  positive_prompt: string;
  negative_prompt: string;
  seed: number;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  cfg_scale: number;
  sampler_name: string;
  scheduler: string;
  MODEL_NAME: string;
  model: string;
  VAE: string;
  vae: string;
  CLIP_NAME: string;
  clip: string;
  lora: string;
  [key: string]: unknown;
}

const TOKEN_RE = /%[A-Za-z0-9_]+%/g;

// 占位符别名映射：token -> values 中的规范键。
// applyPlaceholders 在 values 中查不到 token 时，回退查别名指向的键。
// 这样即使调用方只传了基础键（如只传 prompt 不传 positive_prompt），别名占位符也能解析。
export const COMFY_PLACEHOLDERS: Record<string, string> = {
  positive_prompt: 'prompt',
  cfg_scale: 'cfg',
  MODEL_NAME: 'model',
  UNET_NAME: 'model',
  UNET: 'model',
  CKPT_NAME: 'model',
  CHECKPOINT_NAME: 'model',
  VAE: 'vae',
  VAE_NAME: 'vae',
  CLIP_NAME: 'clip',
  lora_name: 'lora',
};

function resolveValue(key: string, values: ComfyPlaceholderValues): unknown {
  if (key in values) {
    return values[key];
  }
  const alias = COMFY_PLACEHOLDERS[key];
  if (alias && alias in values) {
    return values[alias];
  }
  // 大小写不敏感回退：%SEED%/%Vae% 等变体也能命中（精确匹配优先，行为不变）
  const lower = key.toLowerCase();
  for (const k of Object.keys(values)) {
    if (k.toLowerCase() === lower) return values[k];
  }
  const aliasLower = COMFY_PLACEHOLDERS[lower] ?? Object.keys(COMFY_PLACEHOLDERS).find((k) => k.toLowerCase() === lower);
  if (aliasLower) {
    const target = COMFY_PLACEHOLDERS[aliasLower];
    if (target in values) return values[target];
  }
  return undefined;
}

function hasResolved(key: string, values: ComfyPlaceholderValues): boolean {
  if (key in values) return true;
  const alias = COMFY_PLACEHOLDERS[key];
  if (alias && alias in values) return true;
  const lower = key.toLowerCase();
  if (Object.keys(values).some((k) => k.toLowerCase() === lower)) return true;
  const aliasKey = COMFY_PLACEHOLDERS[lower] ?? Object.keys(COMFY_PLACEHOLDERS).find((k) => k.toLowerCase() === lower);
  return Boolean(aliasKey && COMFY_PLACEHOLDERS[aliasKey] in values);
}

// 递归替换：值精确等于某 token -> 整体替换（保留类型）；否则字符串内行内替换。
export function applyPlaceholders(node: unknown, values: ComfyPlaceholderValues): unknown {
  return applyInner(node, values);
}

function applyInner(node: unknown, values: ComfyPlaceholderValues): unknown {
  if (typeof node === 'string') {
    const exact = node.match(/^%([A-Za-z0-9_]+)%$/);
    if (exact && hasResolved(exact[1], values)) {
      return resolveValue(exact[1], values);
    }
    return node.replace(TOKEN_RE, (m) => {
      const key = m.slice(1, -1);
      if (hasResolved(key, values)) {
        return String(resolveValue(key, values));
      }
      return m;
    });
  }
  if (Array.isArray(node)) {
    return node.map((item) => applyInner(item, values));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = applyInner(v, values);
    }
    return out;
  }
  return node;
}

// 枚举参数键集：这些值允许留空（设置面板「（留空）」选项）。留空 = 不覆盖该参数，
// 键不进 values → 对应 %token% 占位符原样保留（工作流内固定值不受影响；
// 工作流若仍含对应占位符，占位符字面量原样提交，由服务端校验报错指明字段）。
const COMFY_EMPTY_SKIP_KEYS = ['sampler_name', 'scheduler', 'MODEL_NAME', 'model', 'VAE', 'vae', 'CLIP_NAME', 'clip', 'lora'];

// 「可配置占位符」= 对应设置项可留空的 token（含指向它们的别名，如 %UNET_NAME%→model）。
// 只在对应配置为空时才会残留在已替换的工作流里 → 残留即可判定「参数没配」，可本地提前报错。
const COMFY_CONFIGURABLE_TOKENS: ReadonlySet<string> = (() => {
  const skips = new Set(COMFY_EMPTY_SKIP_KEYS.map((k) => k.toLowerCase()));
  const tokens = new Set(skips);
  for (const [alias, target] of Object.entries(COMFY_PLACEHOLDERS)) {
    if (skips.has(target.toLowerCase())) tokens.add(alias.toLowerCase());
  }
  return tokens;
})();

// 残留占位符 → 设置面板上的参数名（错误文案点名到「该去填哪个框」）
const COMFY_TOKEN_FIELD_LABELS: Record<string, string> = {
  model_name: '模型', model: '模型', unet_name: '模型', unet: '模型', ckpt_name: '模型', checkpoint_name: '模型',
  clip_name: 'CLIP', clip: 'CLIP', vae: 'VAE', vae_name: 'VAE',
  sampler_name: '采样器', scheduler: '调度器', lora: 'LoRA',
};

/** 扫描已替换的工作流，返回残留的「可配置占位符」原始 token（去重，按出现顺序）。
 *  非空配置一律会在 applyPlaceholders 中被替换，故残留 = 该参数留空（工作流又引用了它）。 */
export function collectUnresolvedPlaceholderTokens(workflow: unknown): string[] {
  const strings: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { strings.push(node); return; }
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node && typeof node === 'object') {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };
  walk(workflow);
  const out: string[] = [];
  for (const s of strings) {
    for (const m of s.match(TOKEN_RE) || []) {
      const key = m.slice(1, -1).toLowerCase();
      if (COMFY_CONFIGURABLE_TOKENS.has(key) && !out.includes(m)) out.push(m);
    }
  }
  return out;
}

export function buildPlaceholderValues(config: ComfyUiConfig, promptText: string, negativePrompt: string): ComfyPlaceholderValues {
  const seed = config.seed < 0 ? Math.floor(Math.random() * 4294967296) : config.seed;
  const values: ComfyPlaceholderValues = {
    prompt: promptText,
    positive_prompt: promptText,
    negative_prompt: negativePrompt,
    seed,
    width: config.width,
    height: config.height,
    steps: config.steps,
    cfg: config.cfg,
    cfg_scale: config.cfg,
    sampler_name: config.sampler,
    scheduler: config.scheduler,
    MODEL_NAME: config.model,
    model: config.model,
    VAE: config.vae,
    vae: config.vae,
    CLIP_NAME: config.clip,
    clip: config.clip,
    lora: config.lora ?? '',
  };
  const rec = values as Record<string, unknown>;
  for (const k of COMFY_EMPTY_SKIP_KEYS) {
    if (rec[k] === '') delete rec[k];
  }
  return values;
}

// —— UI 格式工作流 → API 格式 ——
// ComfyUI 工作流 → API prompt 转换（仅静态图，不处理视频节点）。

interface UiNode {
  id: number;
  type: string;
  inputs: Array<{ name: string; link: number | null }> | Record<string, unknown>;
  widgets_values?: unknown[];
  mode?: number; // 0=active, 2=never, 4=bypass
  title?: string;
}
interface UiWorkflow {
  nodes: UiNode[];
  links: Array<[number, number, number, number, number, string]> | unknown[];
}

// widget 顺序由节点的可选 input 定义决定；此处用一个按 class_type 的常用 widget 名序表（覆盖本项目所需节点）
const WIDGET_NAMES_BY_TYPE: Record<string, string[]> = {
  KSampler: ['seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  KSamplerAdvanced: ['add_noise', 'noise_seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise', 'denoise'],
  CheckpointLoaderSimple: ['ckpt_name'],
  CheckpointLoader: ['config_name', 'ckpt_name'],
  UNETLoader: ['unet_name', 'weight_dtype'],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  EmptySD3LatentImage: ['width', 'height', 'batch_size'],
  CLIPTextEncode: ['text'],
  VAEDecode: [],
  VAEDecodeTiled: ['tile_size'],
  VAELoader: ['vae_name'],
  CLIPLoader: ['clip_name', 'type'],
  DualCLIPLoader: ['clip_name1', 'clip_name2', 'type'],
  LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
  SaveImage: ['filename_prefix'],
  PreviewImage: [],
};

const SKIP_TYPES = new Set(['Note', 'note', 'MarkdownNote', 'Markdown', 'Reroute', 'MarkdownNote ', 'PrimitiveNode', 'PrimitiveString', 'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveBoolean']);

// 连接型 input（非 widget）的 slot 顺序表，用于当 node.inputs 为空/对象简写时按 link 表顺序指派 input 名
const LINK_INPUT_NAMES_BY_TYPE: Record<string, string[]> = {
  KSampler: ['model', 'positive', 'negative', 'latent_image'],
  KSamplerAdvanced: ['model', 'positive', 'negative', 'latent_image'],
  CLIPTextEncode: ['clip'],
  VAEDecode: ['samples', 'vae'],
  VAEDecodeTiled: ['samples', 'vae'],
  VAEEncode: ['pixels'],
  SaveImage: ['images'],
  PreviewImage: ['images'],
  LoraLoader: ['model', 'clip'],
};

export function convertUiWorkflowToApi(ui: UiWorkflow, objectInfo?: ComfyObjectSchema | null): Record<string, unknown> {
  const nodes = (ui.nodes || []) as UiNode[];
  const links = (ui.links || []) as any[];

  // —— 守卫：UI 格式工作流含未支持的节点模式时硬失败（spec §9 风险缓解：转换失败抛错并提示）——
  // 本转换器仅支持 active 模式（mode 0/undefined）的直连节点 + Note/Reroute 丢弃。
  // bypass（mode 4）与 Primitive 常量已获支持（见 resolveLinkSource）；不实现 Switch 输入路由——遇到即抛错，避免静默错连下游。
  const offenders: string[] = [];
  for (const n of nodes) {
    // 输入路由 Switch：类型名含 "Switch" 的节点会按条件路由输入，本转换器不支持求值
    if (/\bSwitch\b/.test(n.type)) {
      offenders.push(`节点 #${n.id}（${n.type}）为输入路由 Switch`);
    }
  }
  if (offenders.length > 0) {
    throw new ImageGenError(
      'ComfyUI 工作流含未支持的节点类型（Switch），请改用 API 格式工作流：ComfyUI 设置面板 → 保存格式选 "API Format" 后重新导出。'
      + '\n检测到：' + offenders.join('；'),
    );
  }

  // 链接表：linkId -> [linkId, srcNodeId, srcSlot, dstNodeId, dstSlot, type]
  const linkById = new Map<number, any[]>();
  for (const l of links) {
    if (Array.isArray(l) && typeof l[0] === 'number') linkById.set(l[0], l);
  }

  // —— 统一连线源解析：穿透 Reroute / bypass / Primitive（spec §1.1-1.3）——
  // 返回 { ref }=真实源节点引用；{ value }=Primitive 常量内联；null=无法解析（保持原引用形态，交给预检）。
  const nodesById = new Map<number, UiNode>();
  for (const n of nodes) nodesById.set(n.id, n);
  const isPrimitiveType = (t: string): boolean => t === 'PrimitiveNode' || /^Primitive(Int|Float|Boolean|String)$/.test(t);

  const resolveLinkSource = (
    linkId: number,
    visited: Set<number>,
  ): { ref: [number, number] } | { value: unknown } | null => {
    const l = linkById.get(linkId);
    if (!l) return null;
    const srcId = l[1] as number;
    const srcSlot = l[2] as number;
    if (visited.has(srcId)) {
      throw new ImageGenError(`ComfyUI 工作流连线成环（经过节点 #${srcId}），请检查 Reroute/bypass 链`);
    }
    const src = nodesById.get(srcId);
    if (!src) return { ref: [srcId, srcSlot] }; // 源节点不存在：保留原引用，交给预检报错
    // Reroute：沿唯一输入 link 递归穿透（链式天然覆盖）
    if (src.type === 'Reroute') {
      visited.add(srcId);
      const inLink = Array.isArray(src.inputs)
        ? (src.inputs.find((inp) => inp && typeof inp === 'object' && 'link' in inp && (inp as any).link !== null && (inp as any).link !== undefined) as { link: number } | undefined)
        : undefined;
      if (!inLink) throw new ImageGenError(`节点 #${srcId}（Reroute）没有输入连线，无法穿透`);
      return resolveLinkSource(inLink.link, visited);
    }
    // Primitive：常量内联（widgets_values[0] 是值本体，[1] 是 'fixed' 等控制值不取）
    if (isPrimitiveType(src.type)) {
      const wv = Array.isArray(src.widgets_values) ? src.widgets_values : [];
      return { value: wv[0] };
    }
    // bypass（mode 4）：按连线类型找该节点同类型的输入连线，接过其上游（spec §1.2）
    if (src.mode === 4) {
      visited.add(srcId);
      const wantedType = String(l[5] || '').toLowerCase();
      // 候选输入连线：优先用节点 inputs 数组的 type 字段；缺省回退指向该节点的连线类型
      const candidates: number[] = [];
      if (Array.isArray(src.inputs)) {
        for (const inp of src.inputs) {
          if (!inp || typeof inp !== 'object' || !('link' in inp)) continue;
          const li = (inp as any).link;
          if (li === null || li === undefined || !linkById.has(li)) continue;
          const inpType = String((inp as any).type || '').toLowerCase();
          if (inpType === wantedType || inpType === '*' || wantedType === '*' || !wantedType || !inpType) {
            candidates.push(li as number);
          }
        }
      }
      // inputs 数组无类型信息时，回退：取所有指向该节点的连线
      if (candidates.length === 0) {
        for (const li of linkById.values()) {
          if ((li[3] as number) === srcId) candidates.push(li[0] as number);
        }
      }
      if (candidates.length === 0) {
        throw new ImageGenError(
          `节点 #${srcId}（${src.type}）处于 bypass 模式且无同类型输入连线可透传，请在 ComfyUI 中处理该节点后重新导出，或改用 API 格式导出`,
        );
      }
      return resolveLinkSource(candidates[0], visited);
    }
    return { ref: [srcId, srcSlot] };
  };

  // 活跃节点（mode 0 或 undefined）；mode 2/4 跳过
  const activeNodes = nodes.filter((n) => n.mode === undefined || n.mode === 0);
  const out: Record<string, unknown> = {};
  for (const n of activeNodes) {
    if (SKIP_TYPES.has(n.type)) continue;
    const inputs: Record<string, unknown> = {};
    let inputsWired = false;
    // 输入连接形式 1：数组形式 [{name, link}]（LiteGraph 原生导出）
    if (Array.isArray(n.inputs)) {
      for (const inp of n.inputs) {
        if (inp && typeof inp === 'object' && 'name' in inp && 'link' in inp) {
          const linkId = (inp as any).link;
          if (linkId !== null && linkById.has(linkId)) {
            const resolved = resolveLinkSource(linkId as number, new Set());
            if (resolved && 'value' in resolved) {
              inputs[(inp as any).name] = resolved.value;
              inputsWired = true;
            } else if (resolved && 'ref' in resolved) {
              inputs[(inp as any).name] = resolved.ref;
              inputsWired = true;
            } else {
              const l = linkById.get(linkId as number)!;
              inputs[(inp as any).name] = [l[1], l[2]];
              inputsWired = true;
            }
          }
        }
      }
    }
    // 输入连接形式 2：对象简写 {name: [srcId, srcSlot, type?]}（部分 UI 导出/手写）
    if (!inputsWired && n.inputs && typeof n.inputs === 'object') {
      for (const [k, v] of Object.entries(n.inputs as Record<string, unknown>)) {
        if (Array.isArray(v) && v.length >= 2) {
          inputs[k] = [Number(v[0]), Number(v[1])];
          inputsWired = true;
        }
      }
    }
    // 输入连接形式 3：inputs 为空时按 link 表顺序 + 类型 slot 名表指派（兼容常见连线形式）
    if (!inputsWired) {
      const linkInputNames = LINK_INPUT_NAMES_BY_TYPE[n.type] || [];
      const targeting = links
        .filter((l) => Array.isArray(l) && l[3] === n.id)
        .sort((a, b) => (a[0] as number) - (b[0] as number));
      for (let i = 0; i < targeting.length && i < linkInputNames.length; i++) {
        inputs[linkInputNames[i]] = [targeting[i][1], targeting[i][2]];
      }
    }
    // widget_values 按类名顺序映射到 input 字段。
    // 字段名来源优先级：
    //   1) object_info 真实 input 定义（widgetNames，跳过连接型 input）——字段名永不靠猜；
    //   2) 无 object_info 时回退本地 WIDGET_NAMES_BY_TYPE 查表（标准节点）；
    //   3) 两者皆无 → 保底：占位符 widget 映射到真实 widget 位置 widget_N（依序连续编号，服务端按序消费）。
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
    const oiNames = hasWidgetName(objectInfo) ? objectInfo.widgetNames[n.type] : undefined;
    let names: string[] = oiNames ?? WIDGET_NAMES_BY_TYPE[n.type] ?? [];
    // object_info 已知时，若 widgets_values 比 widget 名多（可能含控制 widget 等），截断到名表长度
    if (oiNames) names = oiNames.slice(0, wv.length);
    let wIdx = 0;
    for (const wName of names) {
      // 跳过 control_after_generate（与 seed 成对的 widget，不进 inputs）
      if (wName === 'control_after_generate') { wIdx++; continue; }
      if (wIdx >= wv.length) break;
      const val = wv[wIdx];
      // 混合格式中 widget_values 末尾可能混入链接引用对象——遇到即止（它们不是 widget 值）
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) break;
      // wired-wins：该字段已被连线解析路径写入（连线引用或 Primitive 内联值）时，连线权威，残留 widget 旧值不覆盖（spec §1.4）
      if (wName in inputs) { wIdx++; continue; }
      inputs[wName] = val;
      wIdx++;
    }
    // 保底（无 object_info 且本地查表无条目）：按序映射到连续 widget_N 字段，
    // 确保 %prompt% 等占位符不因字段名未知而丢失（applyPlaceholders 递归仍能命中），
    // 且编号连续（widget_0、widget_1…），ComfyUI 服务端按序消费这些占位 widget。
    if (names.length === 0 && wv.length > 0) {
      let wi = 0;
      for (let k = 0; k < wv.length; k++) {
        const val = wv[k];
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) break;
        inputs['widget_' + wi] = val;
        wi++;
      }
    }
    out[String(n.id)] = { inputs, class_type: n.type, _meta: { title: n.title || n.type } };
  }

  // —— 悬空引用预检（spec §1.5）：[id, slot] 引用的 id 必须存在于输出，提前本地报错而非提交服务端 ——
  for (const [nodeId, nodeVal] of Object.entries(out)) {
    const inputsOf = (nodeVal as any)?.inputs;
    if (!inputsOf || typeof inputsOf !== 'object') continue;
    for (const [field, val] of Object.entries(inputsOf as Record<string, unknown>)) {
      if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number' && !(String(val[0]) in out)) {
        throw new ImageGenError(
          `节点 #${nodeId}（${(nodeVal as any).class_type}）的 <${field}> 引用了未导出的节点 #${val[0]}（可能为 muted/异常节点），请在 ComfyUI 中检查后重新导出`,
        );
      }
    }
  }
  return out;
}

// —— 工作流解析（接受 API 格式 / UI 格式 / 包装变体 / 空串=默认）——
// objectInfo：可选的 /object_info 元数据，驱动 UI 格式 widgets → 真实字段名映射（杜绝猜字段名）。

export function parseWorkflow(text: string, objectInfo?: ComfyObjectSchema | null): Record<string, unknown> {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    // 空串 -> 默认工作流
    return JSON.parse(DEFAULT_COMFY_WORKFLOW_JSON);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    throw new ImageGenError('ComfyUI 工作流 JSON 解析失败: ' + (e instanceof Error ? e.message : String(e)));
  }
  // 解包 {workflow: ...}
  let unwrapped = obj;
  if (unwrapped && typeof unwrapped === 'object' && 'workflow' in (unwrapped as any)) {
    const w = (unwrapped as any).workflow;
    unwrapped = typeof w === 'string' ? safeJsonParse(w) : w;
  } else if (unwrapped && typeof unwrapped === 'object' && 'workflows' in (unwrapped as any)) {
    // {workflows: [{workflow: ...}]} 取第一个
    const arr = (unwrapped as any).workflows;
    if (Array.isArray(arr) && arr.length && arr[0].workflow) {
      const w = arr[0].workflow;
      unwrapped = typeof w === 'string' ? safeJsonParse(w) : w;
    }
  }
  // UI 格式？含 nodes + links
  if (unwrapped && typeof unwrapped === 'object' && Array.isArray((unwrapped as any).nodes)) {
    return convertUiWorkflowToApi(unwrapped as UiWorkflow, objectInfo);
  }
  if (unwrapped && typeof unwrapped === 'object') {
    return unwrapped as Record<string, unknown>;
  }
  throw new ImageGenError('ComfyUI 工作流格式无法识别（既非 API 格式也非 UI 格式）');
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch (e) {
    throw new ImageGenError('ComfyUI 工作流内嵌 JSON 解析失败: ' + (e instanceof Error ? e.message : String(e)));
  }
}

// —— object_info 元数据（驱动 UI 格式 widgets → 字段名映射，杜绝猜字段名）——
export interface ComfyObjectSchema {
  /** class_type -> 该节点 INPUT_TYPES() 中定义的所有 input 名（required + optional 顺序） */
  inputNames: Record<string, string[]>;
  /** class_type -> 该节点所有 input 名（含连接型），用于反向判断某字段是 widget 还是连线 */
  inputTypes: Record<string, Record<string, unknown>>;
  /** class_type -> widgets 依序对应的 widget 字段名（跳过连接型 input） */
  widgetNames: Record<string, string[]>;
}

function hasWidgetName(objInfo: ComfyObjectSchema | null | undefined): objInfo is ComfyObjectSchema {
  return Boolean(objInfo && typeof objInfo === 'object' && 'widgetNames' in objInfo);
}

/** 从 /object_info payload 提取每 class 的输入名顺序与 widget 名顺序 */
export function buildComfyObjectSchema(payload: unknown): ComfyObjectSchema | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, any>;
  const inputNames: Record<string, string[]> = {};
  const inputTypes: Record<string, Record<string, unknown>> = {};
  const widgetNames: Record<string, string[]> = {};
  for (const [cls, def] of Object.entries(root)) {
    if (!def || typeof def !== 'object') continue;
    const spec = (def as any).input;
    if (!spec || typeof spec !== 'object') continue;
    const names: string[] = [];
    const types: Record<string, unknown> = {};
    for (const group of ['required', 'optional'] as const) {
      const sec = (spec as any)[group];
      if (!sec || typeof sec !== 'object') continue;
      for (const [k, v] of Object.entries(sec)) {
        names.push(k);
        types[k] = v;
      }
    }
    inputNames[cls] = names;
    inputTypes[cls] = types;
    // widget 名顺序 = 依序遍历 input，排除连接型（值为数组且元素是对象、或 /^(model|clip|vae|samples|images|...)$/ 连线输入名）
    const widgets: string[] = [];
    for (const k of names) {
      if (isLinkType(types[k])) continue;
      widgets.push(k);
    }
    widgetNames[cls] = widgets;
  }
  if (Object.keys(inputNames).length === 0) return null;
  return { inputNames, inputTypes, widgetNames };
}

/** 判断某 input 定义是否为连接型（连线输入而非 widget） */
function isLinkType(spec: unknown): boolean {
  if (!Array.isArray(spec)) return true; // 非数组 → 必是连线输入
  // 连接类型定义是单元素数组 [typeName]（如 ['CLIP'] / ['MODEL']）
  if (spec.length === 1 && typeof spec[0] === 'string') return true;
  // widget 定义：枚举 [['a','b'], {tooltip}] 或 [default, {tooltip}]（两元素）→ widget
  return false;
}

// —— 结果选择（启发式挑选可用输出）——
export interface ComfyMediaRef { filename: string; subfolder: string; type: string; }

export function pickComfyMedia(outputs: Record<string, unknown>): ComfyMediaRef | null {
  const candidates: Array<{ ref: ComfyMediaRef; score: number }> = [];
  for (const nodeOut of Object.values(outputs)) {
    if (!nodeOut || typeof nodeOut !== 'object') continue;
    const imgs = (nodeOut as any).images;
    if (Array.isArray(imgs)) {
      for (const img of imgs) {
        if (!img || typeof img !== 'object') continue;
        const filename = String(img.filename || '');
        const subfolder = String(img.subfolder || '');
        const type = String(img.type || '');
        if (type === 'temp' && !/final|combined/i.test(filename)) continue; // temp 预览图降权跳过
        let score = 0;
        if (/final/i.test(filename)) score += 200;
        if (/combined/i.test(filename)) score += 100;
        if (type === 'output') score += 10;
        candidates.push({ ref: { filename, subfolder, type }, score });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].ref;
}

// —— URL 规整 ——
function comfyBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function isRetryableStatus(status: number): boolean {
  return status === 404 || status === 425 || status === 503;
}

// —— /view 拉字节 → dataURL（复用 image-gen 的 dataUrl 逻辑，但避免循环依赖，本地实现简版）——
// 参数名勿用裸 ref：会被 unplugin-auto-import 误注入 import {ref} from 'vue' → 全局 Vue 外部引用
async function fetchViewAsDataUrl(baseUrl: string, mediaRef: ComfyMediaRef, signal?: AbortSignal): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const params = new URLSearchParams({ filename: mediaRef.filename, subfolder: mediaRef.subfolder, type: mediaRef.type });
    const resp = await fetch(`${baseUrl}/view?${params}`, { signal });
    if (resp.ok) {
      const blob = await resp.blob();
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(new ImageGenError('ComfyUI 图片读取失败'));
        r.readAsDataURL(blob);
      });
      return dataUrl;
    }
    if (!isRetryableStatus(resp.status)) {
      throw new ImageGenError(`ComfyUI /view HTTP ${resp.status}`, resp.status);
    }
    lastErr = new ImageGenError(`ComfyUI /view HTTP ${resp.status} (重试 ${attempt + 1}/3)`, resp.status);
    await new Promise((r) => setTimeout(r, 350));
  }
  throw lastErr instanceof Error ? lastErr : new ImageGenError('ComfyUI /view 重试耗尽');
}

// —— 轮询 /history ——
async function waitForHistory(baseUrl: string, promptId: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<ComfyMediaRef> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw imageAbortError();
    if (Date.now() > deadline) throw new ImageGenError('ComfyUI 生成超时，请检查工作流或服务端队列');
    const resp = await fetch(`${baseUrl}/history/${promptId}`, { signal });
    if (resp.ok) {
      const payload = await resp.json().catch(() => null);
      const entry = payload && (payload as any)[promptId];
      if (entry) {
        // 错误状态：status.messages 含 error/exception
        const status = entry.status;
        if (status && Array.isArray(status.messages)) {
          for (const m of status.messages) {
            const text = Array.isArray(m) ? m.map(String).join(' ') : String(m);
            if (/error|exception/i.test(text)) {
              throw new ImageGenError('ComfyUI 执行错误: ' + text.slice(0, 240));
            }
          }
        }
        if (entry.outputs && typeof entry.outputs === 'object') {
          const media = pickComfyMedia(entry.outputs);
          if (media) return media;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// image-gen 未导出 imageAbortError，本地复制（避免改 image-gen 导出面）
function imageAbortError(): Error {
  const e = new Error('图片生成任务已取消');
  e.name = 'AbortError';
  return e;
}

/** 400 校验失败的细节重建：服务端把真正的原因放在 node_errors（逐节点逐字段），
 *  顶层只有一句 "Prompt outputs failed validation"。只取顶层 = 用户无从知道该改哪个字段。 */
function describeComfyPromptFailure(errPayload: unknown): string {
  const payload = (errPayload && typeof errPayload === 'object') ? errPayload as Record<string, any> : {};
  const errObj = payload.error;
  const top = String(
    (errObj && typeof errObj === 'object' ? errObj.message : errObj) || payload.message || '',
  ).trim();
  const lines: string[] = [];
  const nodeErrors = payload.node_errors;
  if (nodeErrors && typeof nodeErrors === 'object') {
    for (const [nodeId, info] of Object.entries(nodeErrors as Record<string, any>)) {
      const classType = String((info as any)?.class_type || '');
      const errs = Array.isArray((info as any)?.errors) ? (info as any).errors : [];
      for (const err of errs) {
        const message = String(err?.message || err?.type || '').trim();
        const details = String(err?.details || '').trim();
        lines.push(`#${nodeId}${classType ? ' ' + classType : ''}: ${message}${details ? ' — ' + details : ''}`);
        if (lines.length >= 4) break;
      }
      if (lines.length >= 4) break;
    }
  }
  if (!lines.length) return top;
  return `${top || 'ComfyUI 校验失败'}（${lines.join('；')}）`;
}

/** 提交最终工作流（API 格式对象）→ 轮询历史 → 拉取图片。正常生成与按档案重绘共用。
 *  onFinal：提交前的最终工作流 JSON 回调（生图档案采集用；可选，不传零影响）。 */
export async function submitComfyWorkflow(
  config: ComfyUiConfig,
  finalWorkflow: Record<string, unknown>,
  signal?: AbortSignal,
  onFinal?: (finalWorkflowJson: string) => void,
): Promise<string> {
  const base = comfyBase(config.url);
  if (!base) throw new ImageGenError('ComfyUI 配置缺失 url');
  try { onFinal?.(JSON.stringify(finalWorkflow)); } catch (_e) { /* 档案采集不阻塞生图 */ }

  const clientId = 'ub-portrait-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const promptResp = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: finalWorkflow, client_id: clientId }),
    signal,
  });
  if (!promptResp.ok) {
    let detail = '';
    try {
      const errPayload = await promptResp.json();
      detail = describeComfyPromptFailure(errPayload) || JSON.stringify(errPayload);
    } catch (_e) {
      try { detail = await promptResp.text(); } catch (_e2) { /* ignore */ }
    }
    throw new ImageGenError(`ComfyUI /prompt HTTP ${promptResp.status}: ${detail.slice(0, 400)}`, promptResp.status);
  }
  const promptResult: any = await promptResp.json().catch(() => ({}));
  const promptId: string | undefined = promptResult?.prompt_id;
  if (!promptId) throw new ImageGenError('ComfyUI /prompt 未返回 prompt_id');

  // 轮询历史
  const media = await waitForHistory(base, promptId, signal, config.timeoutSeconds * 1000);
  // 拉字节
  return fetchViewAsDataUrl(base, media, signal);
}

/** 重绘参数覆盖：把弹窗里改过的 seed/步数/CFG/采样器/调度器/画布尺寸写进最终工作流的
 *  采样器与 Latent 节点（仅覆盖传入的字段；工作流里没有对应 input 时跳过）。原地修改。 */
export function applyComfyParamOverrides(
  workflow: Record<string, unknown>,
  params?: { width?: number; height?: number; seed?: number; steps?: number; cfg?: number; sampler?: string; scheduler?: string },
): void {
  if (!params) return;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const seed = num(params.seed);
  const steps = num(params.steps);
  const cfg = num(params.cfg);
  const width = num(params.width);
  const height = num(params.height);
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object') continue;
    const n = node as Record<string, any>;
    const ct = String(n.class_type || '');
    const inputs = n.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    if (COMFY_SAMPLER_TYPES.has(ct)) {
      if (seed !== undefined) { if ('seed' in inputs) inputs.seed = seed; if ('noise_seed' in inputs) inputs.noise_seed = seed; }
      if (steps !== undefined && 'steps' in inputs) inputs.steps = steps;
      if (cfg !== undefined && 'cfg' in inputs) inputs.cfg = cfg;
      if (params.sampler && 'sampler_name' in inputs) inputs.sampler_name = params.sampler;
      if (params.scheduler && 'scheduler' in inputs) inputs.scheduler = params.scheduler;
    }
    if (/^Empty(SD3)?LatentImage$/.test(ct)) {
      if (width !== undefined && 'width' in inputs) inputs.width = width;
      if (height !== undefined && 'height' in inputs) inputs.height = height;
    }
  }
}

// —— 主函数 ——
// onWorkflow: 占位符替换后的最终工作流 JSON 回调（生图档案采集用；可选，不传零影响）
export async function generateComfyUiImage(
  config: ComfyUiConfig,
  promptText: string,
  negativePrompt: string,
  signal?: AbortSignal,
  onWorkflow?: (finalWorkflowJson: string) => void,
): Promise<string> {
  const base = comfyBase(config.url);
  if (!base) throw new ImageGenError('ComfyUI 配置缺失 url');

  // 0. 拉 object_info（驱动 UI 格式 widgets → 真实字段名映射 + autoInject 字段识别）。
  //    失败不阻断：回退本地查表/保底 widget_N。
  const objectSchema = await fetchComfyObjectSchema(base, signal).catch(() => null);

  // 1. 解析激活工作流
  const active = resolveActiveComfyWorkflow(config.workflows, config.activeWorkflowId);
  // 2. 解析为对象（UI 格式用 objectSchema 映射真实字段名）
  const workflowObj = parseWorkflow(active.workflow, objectSchema);
  // 3. 占位符优先：含 %prompt%/%negative_prompt% 的侧只走占位符替换；
  //    autoInject 只补充无占位符的侧（用 objectSchema 识别自定义节点提示词字段）。
  //    必须在 applyPlaceholders 之前跑——占位符替换后 %token% 已消失，无法再判定「工作流含占位符」。
  autoInjectPrompt(workflowObj, promptText, negativePrompt, objectSchema);
  // 4. 占位符替换
  const values = buildPlaceholderValues(config, promptText, negativePrompt);
  const finalWorkflow = applyPlaceholders(workflowObj, values) as Record<string, unknown>;

  // 4.5 残留占位符预检：与其把 %MODEL_NAME% 这类字面量发给服务端换来一句泛化的
  //     "Prompt outputs failed validation"，不如本地点名是哪个参数没配（省一次无效往返）。
  const unresolved = collectUnresolvedPlaceholderTokens(finalWorkflow);
  if (unresolved.length) {
    const fields = Array.from(new Set(unresolved
      .map((t) => COMFY_TOKEN_FIELD_LABELS[t.slice(1, -1).toLowerCase()])
      .filter(Boolean)));
    throw new ImageGenError(
      `ComfyUI 工作流含未配置的占位符 ${unresolved.join('、')}（对应参数：${fields.join('、')}）——`
      + '请到「统一生图 API → 高级参数」填写后点「保存到预设」再重试；留空＝不覆盖，占位符不会被替换。',
    );
  }

  // 5. 提交 + 轮询 + 取图（提交/轮询逻辑与按档案重绘共用）
  return submitComfyWorkflow(config, finalWorkflow, signal, onWorkflow);
}

// —— object_info 拉取（datalist 渐进增强；失败返回 null）——
export interface ComfyObjectInfo {
  checkpoints: string[];
  unets: string[];
  models: string[];
  samplers: string[];
  schedulers: string[];
  vaes: string[];
  clips: string[];
  loras: string[];
}

let _objectInfoCache: { url: string; ts: number; payload: Record<string, unknown> | null; info: ComfyObjectInfo | null; schema: ComfyObjectSchema | null } | null = null;
const OBJECT_INFO_TTL = 5 * 60 * 1000;

/** 内部：拉取 /object_info payload 并缓存（TTL 5 分钟）；失败返回 null（不抛） */
async function fetchObjectInfoPayload(base: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  if (_objectInfoCache && _objectInfoCache.url === base && Date.now() - _objectInfoCache.ts < OBJECT_INFO_TTL) {
    return _objectInfoCache.payload;
  }
  let payload: Record<string, unknown> | null = null;
  try {
    const resp = await fetch(`${base}/object_info`, { signal });
    if (resp.ok) payload = await resp.json();
  } catch (_e) { /* 失败降级，不抛 */ }
  _objectInfoCache = { url: base, ts: Date.now(), payload, info: null, schema: null };
  return payload;
}

function buildComfyObjectInfoFromPayload(payload: Record<string, unknown>): ComfyObjectInfo | null {
  const collect = (nodeType: string, inputName: string): string[] => {
    const node = (payload as any)?.[nodeType];
    const spec = node?.input?.required?.[inputName] ?? node?.input?.optional?.[inputName];
    if (Array.isArray(spec) && Array.isArray(spec[0])) return spec[0].map(String);
    return [];
  };
  const checkpoints = unique([...collect('CheckpointLoaderSimple', 'ckpt_name'), ...collect('CheckpointLoader', 'ckpt_name')]);
  const unets = unique([...collect('UNETLoader', 'unet_name'), ...collect('UnetLoaderGGUF', 'unet_name')]);
  return {
    checkpoints,
    unets,
    models: unique([...checkpoints, ...unets]),
    samplers: unique([...collect('KSampler', 'sampler_name'), ...collect('KSamplerAdvanced', 'sampler_name')]),
    schedulers: unique([...collect('KSampler', 'scheduler'), ...collect('KSamplerAdvanced', 'scheduler')]),
    vaes: collect('VAELoader', 'vae_name').map(String),
    clips: unique([...collect('CLIPLoader', 'clip_name'), ...collect('DualCLIPLoader', 'clip_name1')]),
    loras: unique([...collect('LoraLoader', 'lora_name'), ...collect('LoraLoaderModelOnly', 'lora_name')]),
  };
}

export async function fetchComfyObjectInfo(url: string, signal?: AbortSignal): Promise<ComfyObjectInfo | null> {
  const base = comfyBase(url);
  if (!base) return null;
  if (_objectInfoCache && _objectInfoCache.url === base && Date.now() - _objectInfoCache.ts < OBJECT_INFO_TTL && _objectInfoCache.info) {
    return _objectInfoCache.info;
  }
  const payload = await fetchObjectInfoPayload(base, signal);
  if (!payload) return null;
  const info = buildComfyObjectInfoFromPayload(payload);
  if (_objectInfoCache && _objectInfoCache.url === base) _objectInfoCache.info = info;
  return info;
}

/** 拉取 /object_info 并构建输入 schema（驱动 UI 格式 widgets 字段名映射，杜绝猜字段名） */
export async function fetchComfyObjectSchema(url: string, signal?: AbortSignal): Promise<ComfyObjectSchema | null> {
  const base = comfyBase(url);
  if (!base) return null;
  if (_objectInfoCache && _objectInfoCache.url === base && Date.now() - _objectInfoCache.ts < OBJECT_INFO_TTL && _objectInfoCache.schema) {
    return _objectInfoCache.schema;
  }
  const payload = await fetchObjectInfoPayload(base, signal);
  if (!payload) return null;
  const schema = buildComfyObjectSchema(payload);
  if (_objectInfoCache && _objectInfoCache.url === base) _objectInfoCache.schema = schema;
  return schema;
}

function unique(arr: string[]): string[] {
  return Array.from(new Set(arr.filter((x) => x)));
}

export function __clearComfyObjectInfoCacheForTests(): void {
  _objectInfoCache = null;
}

// —— 自动提示词注入（无占位符工作流兜底）——
// ComfyUI 编辑器「Save (API Format)」导出的工作流，CLIPTextEncode.text 是硬编码值，
// 不含 %prompt% 占位符。若只走占位符替换，酒馆提示词永远进不了工作流——生成图与提示词无关。
// 规则（正/负向按侧独立）：
//   1) 工作流已含 %prompt%/%positive_prompt% → 正向走占位符，跳过自动注入；
//   2) 工作流已含 %negative_prompt% → 负向走占位符，跳过自动注入；
//   3) 否则按 KSampler 系节点 positive/negative 连线定位 CLIPTextEncode 节点注入酒馆词；
//   4) 无采样器或连线指向非 CLIPTextEncode 时，按标题/节点 id 启发式兜底（negative 优先）。
const COMFY_SAMPLER_TYPES = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']);

function workflowContainsToken(node: unknown, token: string): boolean {
  if (typeof node === 'string') return node.includes(token);
  if (Array.isArray(node)) return node.some((x) => workflowContainsToken(x, token));
  if (node && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).some((v) => workflowContainsToken(v, token));
  }
  return false;
}

function isNegativeNode(node: any, id?: string): boolean {
  const title = String(node?._meta?.title ?? '');
  return /negative|neg\b/i.test(title) || /negative/i.test(String(id ?? ''));
}

/** 从 object_info 判断某 class 是否为「提示词类节点」（含 text/positive/负面/prompt 等提示词字段） */
function classHasPromptField(objectSchema: ComfyObjectSchema | undefined, classType: string): string | null {
  if (!objectSchema) return null;
  const names = objectSchema.inputNames[classType] || [];
  const cands = names.filter((n) => /^(text|positive|负面|negative|prompt|正向|重绘正面词)$/.test(n));
  return cands.length ? cands[0] : null;
}

/** 采样器连线输入名（各采样器 class 通用：positive/negative） */
const SAMPLER_POS_INPUTS = ['positive', 'cond', 'conditioning'];
const SAMPLER_NEG_INPUTS = ['negative', 'uncond'];

export function autoInjectPrompt(workflow: Record<string, unknown>, promptText: string, negativePrompt: string, objectSchema?: ComfyObjectSchema | null): void {
  const nodes = workflow as Record<string, any>;
  const posPlaceholder = workflowContainsToken(workflow, '%prompt%') || workflowContainsToken(workflow, '%positive_prompt%');
  const negPlaceholder = workflowContainsToken(workflow, '%negative_prompt%');

  const injectedNodeIds = new Set<string>();
  let posInjected = false;
  let negInjected = false;

  // 取节点提示词字段名：object_info 优先（真实字段，如自定义节点的 positive/负面），
  // 无 object_info 回退本地已知类型（CLIPTextEncode.text）。
  const promptFieldFor = (classType: string): string | null => {
    const fromSchema = classHasPromptField(objectSchema ?? undefined, classType);
    if (fromSchema) return fromSchema;
    if (classType === 'CLIPTextEncode') return 'text';
    if (classType === 'WeiLinComfyUIPromptToLorasOnly' || classType === 'WeiLinComfyUIPromptToImage') return 'positive';
    return null;
  };

  const injectText = (nodeId: string, text: string, isPos: boolean): boolean => {
    const node = nodes[nodeId];
    if (!node || !node.inputs || typeof node.inputs !== 'object') return false;
    const field = promptFieldFor(node.class_type);
    if (!field) return false;
    // 占位符优先：该节点若含 %token% 占位符，属于占位符注入路径，禁覆盖
    if (/%[A-Za-z0-9_]+%/.test(String(node.inputs[field] ?? ''))) return false;
    node.inputs[field] = text;
    injectedNodeIds.add(nodeId);
    if (isPos) posInjected = true; else negInjected = true;
    return true;
  };
  const resolveLink = (link: unknown): string | null => {
    if (Array.isArray(link) && (typeof link[0] === 'string' || typeof link[0] === 'number')) {
      const id = String(link[0]);
      if (nodes[id]) return id;
    }
    return null;
  };

  // 主路径：采样器连线定位正/负向提示词节点
  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== 'object') continue;
    const ct = node.class_type;
    if (typeof ct !== 'string' || !COMFY_SAMPLER_TYPES.has(ct)) continue;
    if (!posPlaceholder && !posInjected) {
      for (const inputName of SAMPLER_POS_INPUTS) {
        if (node.inputs?.[inputName]) { const id = resolveLink(node.inputs[inputName]); if (id && injectText(id, promptText, true)) break; }
      }
    }
    if (!negPlaceholder && !negInjected) {
      for (const inputName of SAMPLER_NEG_INPUTS) {
        if (node.inputs?.[inputName]) { const id = resolveLink(node.inputs[inputName]); if (id && injectText(id, negativePrompt, false)) break; }
      }
    }
  }

  // 兜底：无采样器连线命中时，按提示词字段/标题启发式找剩余提示词节点。
  // 只处理主路径未覆盖的侧；占位符节点禁覆盖。
  const remaining = Object.entries(nodes).filter(([id, n]) =>
    n && n.inputs && typeof n.inputs === 'object' && !injectedNodeIds.has(id)
    && (() => {
      const f = promptFieldFor(n.class_type);
      if (!f) return false;
      return !/%[A-Za-z0-9_]+%/.test(String(n.inputs[f] ?? ''));
    })(),
  );
  if (!negPlaceholder && !negInjected && remaining.length) {
    const negIdx = remaining.findIndex(([id, n]) => isNegativeNode(n, id) || promptFieldFor(n.class_type) === 'negative');
    const negNode = negIdx >= 0 ? remaining[negIdx] : remaining[0];
    const field = promptFieldFor(negNode[1].class_type)!;
    negNode[1].inputs[field] = negativePrompt;
    injectedNodeIds.add(negNode[0]);
    remaining.splice(negIdx >= 0 ? negIdx : 0, 1);
    negInjected = true;
  }
  if (!posPlaceholder && !posInjected && remaining.length) {
    const field = promptFieldFor(remaining[0][1].class_type)!;
    remaining[0][1].inputs[field] = promptText;
    posInjected = true;
  }
}
