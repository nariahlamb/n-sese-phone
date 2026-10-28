// core/image-gen-error.ts
// 生图失败错误类型：各生图后端（NovelAI / OpenAI 兼容 / ComfyUI / WaveSpeed / 智慧姬 chatu8）与
// 重放层共用的「带可行动指引」错误。
//
// ★为什么单独成模块（E2 依赖环债务）：chatu8-bridge / comfyui-client 都要抛这个错误，
// 而它们本身又被 image-gen 调用 ⇒ 错误类留在 image-gen 里就是
// image-gen ↔ {chatu8-bridge, comfyui-client} 的双向依赖。它是零依赖的叶子，抽出来即可
// **零行为变化**地解开该环（同一个类对象，`instanceof` 与原型链都不变）。
// image-gen 仍再导出该类，既有 `import { ImageGenError } from './image-gen'` 继续可用。

export class ImageGenError extends Error {
  public status?: number;
  constructor(msg: string, status?: number) {
    super(msg);
    this.name = 'ImageGenError';
    this.status = status;
  }
}
