// ===== 把多段语音拼成一个音频文件（导出通话录音 / 整条回复） =====
// 逐段解码为 44100 单声道，句间留一点静音，再写成 16-bit WAV（处处能放，不需要编码器）。
// 只用已经拿到的音频（不重新合成、不花额度）；纯函数部分（mono/joinClips/encodeWav）可在 Node 测试直调。
// 参照 ST-iPhonie core/audio-join.js 的做法（解耦：解码走宿主 OfflineAudioContext，拼接/编码是纯数学）。

import { hostWindow } from './host-env';

export const JOIN_RATE = 44100;
/** 每段首尾淡入淡出（秒）：拼接处不爆音。 */
const FADE = 0.006;
/** 句间静音（秒）。 */
export const DEFAULT_GAP = 0.45;

/** 解码后的多声道缓冲 → 单声道（各声道取平均）。 */
export function mono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / channels;
  }
  return out;
}

/** 用宿主解码器把一段音频解成单声道 Float32（重采样到 rate）。 */
export async function decodeMono(blob: Blob, rate = JOIN_RATE): Promise<Float32Array> {
  const win = hostWindow() as any;
  const Offline = win?.OfflineAudioContext || win?.webkitOfflineAudioContext;
  if (typeof Offline !== 'function') throw new Error('这个浏览器不支持拼接音频');
  try {
    const ctx = new Offline(1, 1, rate);
    return mono(await ctx.decodeAudioData(await blob.arrayBuffer()));
  } catch (_e) {
    throw new Error('有一段音频读不出来，没法拼接');
  }
}

/** 依次拼接，句间留 gap 秒静音；每段首尾做淡入淡出。 */
export function joinClips(clips: ReadonlyArray<Float32Array>, rate = JOIN_RATE, gap = DEFAULT_GAP): Float32Array {
  const pause = Math.max(0, Math.round(gap * rate));
  const fade = Math.max(1, Math.round(FADE * rate));
  const total = clips.reduce((n, c) => n + c.length, 0) + pause * Math.max(0, clips.length - 1);
  const out = new Float32Array(total);
  let at = 0;
  clips.forEach((clip, k) => {
    const edge = Math.min(fade, Math.floor(clip.length / 2));
    for (let i = 0; i < clip.length; i++) {
      const gain = edge > 0
        ? (i < edge ? i / edge : i >= clip.length - edge ? (clip.length - 1 - i) / edge : 1)
        : 1;
      out[at + i] = clip[i] * gain;
    }
    at += clip.length + (k < clips.length - 1 ? pause : 0);
  });
  return out;
}

/** 16-bit PCM 单声道 WAV（RIFF 头 + 样本）。 */
export function encodeWav(samples: Float32Array, rate = JOIN_RATE): Blob {
  const data = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + data));
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + data, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

/** 多段音频 → 一个 WAV Blob（解码 + 拼接 + 编码）。 */
export async function buildVoiceTrack(blobs: ReadonlyArray<Blob>, gap = DEFAULT_GAP): Promise<Blob> {
  if (!blobs.length) throw new Error('没有可拼接的音频');
  const clips: Float32Array[] = [];
  for (const blob of blobs) clips.push(await decodeMono(blob));
  return encodeWav(joinClips(clips, JOIN_RATE, gap), JOIN_RATE);
}
