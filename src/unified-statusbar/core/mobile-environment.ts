// 手机轻量模式：仅在窄屏（<=600px，或 <=768px 且无鼠标）、移动设备 UA 或纯粗指针无鼠标设备上启用。
// 桌面端 TauriTavern（含分屏窗口）或带鼠标的宽屏 PC 不误判为手机。
// 仅承载环境/颜色/坐标的纯计算；不要在拖拽或滚动高频路径读取 computed style。

export function isMobileLiteEnvironment(win?: Window): boolean {
  const w = win ?? (typeof window !== 'undefined' ? window : undefined);
  if (!w) return false;
  try {
    const width = Number(w.innerWidth) || 0;
    if (width > 0 && width <= 600) return true;
    const ua = String(w.navigator?.userAgent || '');
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    const coarse = w.matchMedia?.('(pointer: coarse)').matches === true;
    const fine = w.matchMedia?.('(any-pointer: fine)').matches === true;
    if (coarse && !fine) return true;
    return width > 0 && width <= 768 && !fine;
  } catch (_e) {
    return false;
  }
}

/** 将主题变量解析成 rgba() 可复用的 RGB 通道；无法解析时由调用方使用安全回退。 */
export function cssColorChannels(color: string): string | null {
  const value = color.trim();
  const hex = value.match(/^#([\da-f]{3,8})$/i)?.[1];
  if (hex && (hex.length === 3 || hex.length === 4 || hex.length === 6 || hex.length === 8)) {
    const full = hex.length <= 4
      ? hex.slice(0, 3).split('').map(ch => ch + ch).join('')
      : hex.slice(0, 6);
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)).join(',');
  }
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/i);
  if (!rgb) return null;
  const channels = rgb.slice(1, 4).map(Number);
  return channels.every(n => Number.isFinite(n) && n >= 0 && n <= 255)
    ? channels.map(Math.round).join(',')
    : null;
}
