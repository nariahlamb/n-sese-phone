// ===== 统一状态栏外部存储 · 确定性编码与校验 =====

import { isRecord } from './type-guards';

function normalizeJson(value: any, inArray = false): any {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map(item => {
      const normalized = normalizeJson(item, true);
      return normalized === undefined ? null : normalized;
    });
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = normalizeJson(value[key], false);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return inArray ? null : undefined;
}

/** 与 JSON.stringify 语义一致，并递归固定对象键顺序。 */
export function stableStringify(value: unknown): string {
  const normalized = normalizeJson(value);
  const serialized = JSON.stringify(normalized);
  return serialized === undefined ? '' : serialized;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

// ===== SHA-256 结果 memo（读取层加速提案 A，2026-09-15）=====
// 锚点派生（activeStoryReplayAnchors/selectedMessageAnchor 等）对同一消息身份串
// 反复求哈希：每次 readStoryFeature 都全聊天重扫一遍。memo 让重复输入 O(1) 命中。
// 上限 4096：500 楼聊天 ≈ 750 个锚点身份串，256 会在单次扫描内自逐出（恰在最需要
// 的长聊天场景失效）；条目 ~130B，峰值 ~0.5MB 可接受。纯函数 memo：同输入恒同输出。
const SHA256_MEMO_MAX = 4096;
// O35(十一轮)：memo 的本职是锚点身份串（~百字节级，重复计算才是它要消灭的成本）。
// 超大 key（病态长消息文本等）单条即可把账本撑到 MB 级——4096 条的条目上限对字节量
// 完全无感，直接绕过计算更便宜。
const SHA256_MEMO_KEY_MAX = 65536;
const sha256Memo = new Map<string, string>();
let sha256MemoHits = 0;
let sha256MemoComputed = 0;

/** 测试钩子：memo 命中统计（生产零消费）。 */
export function __sha256MemoStatsForTests(): { hits: number; computed: number; size: number } {
  return { hits: sha256MemoHits, computed: sha256MemoComputed, size: sha256Memo.size };
}

/** 同步纯 JS SHA-256；不依赖 secure-context 下才可靠提供的 crypto.subtle。结果按输入串 memo。 */
export function sha256Hex(value: string): string {
  const key = String(value);
  if (key.length > SHA256_MEMO_KEY_MAX) return computeSha256Hex(key);
  const cached = sha256Memo.get(key);
  if (cached !== undefined) {
    sha256MemoHits += 1;
    // LRU：命中重插到末尾，保持「最近使用」序
    sha256Memo.delete(key);
    sha256Memo.set(key, cached);
    return cached;
  }
  sha256MemoComputed += 1;
  const digest = computeSha256Hex(key);
  if (sha256Memo.size >= SHA256_MEMO_MAX) {
    const oldest = sha256Memo.keys().next().value;
    if (oldest !== undefined) sha256Memo.delete(oldest);
  }
  sha256Memo.set(key, digest);
  return digest;
}

function computeSha256Hex(value: string): string {
  const input = new TextEncoder().encode(String(value));
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high);
  view.setUint32(paddedLength - 4, low);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = words[i - 15];
      const w2 = words[i - 2];
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }

    let a = hash[0], b = hash[1], c = hash[2], d = hash[3];
    let e = hash[4], f = hash[5], g = hash[6], h7 = hash[7]; // 工作变量名勿用裸 h（unplugin-auto-import 误注入 import {h} from vue）
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h7 + sum1 + choice + SHA256_K[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h7 = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h7) >>> 0;
  }

  return Array.from(hash, word => word.toString(16).padStart(8, '0')).join('');
}

// O35(十一轮)：整份信封/备份快照的校验和**绕过 memo**。信封每次提交都带新
// revision/updatedAt（atomic-envelope-store 写入），序列化结果永不重复 ⇒ memo 在这条
// 路径上永不命中，只会把整份存档文本当死 key 永久驻留（长局数百次提交 × 每条 MB 级
// = 数十至数百 MB 死字符串，移动端「玩久了闪退」的头号机制嫌疑）。校验和每次本就是
// 全新计算，memo 零收益；锚点身份串等小输入仍走 memo（读取层加速语义不变）。
export function checksumValue(value: unknown): string {
  return computeSha256Hex(stableStringify(value));
}

/** 信封校验通过判定（U47 单源：atomic-envelope-store 与 story-backup-store 原各持逐字同构一份）。 */
export function checksumOk(value: unknown): value is Record<string, unknown> & { checksum: string } {
  if (!isRecord(value) || typeof (value as Record<string, unknown>).checksum !== 'string') return false;
  const { checksum, ...payload } = value as Record<string, unknown> & { checksum: string };
  return checksum === checksumValue(payload);
}

/** 文件名只需要短身份；保留 96 bit SHA-256 前缀。 */
export function chatHash(chatKey: string): string {
  return sha256Hex(String(chatKey || '')).slice(0, 24);
}

export function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

