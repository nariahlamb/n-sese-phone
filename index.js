import { createExtension } from './runtime/extension.js';
import { config } from './runtime/config.js';

const key = '__' + config.id.replaceAll('-', '_') + '_extension';
if (!window[key]) {
  const base = new URL('./', import.meta.url);
  const extension = createExtension(window, config, {
    loadModule: () => import(new URL('dist/index.js', base).href),
    readTemplate: async () => {
      const response = await fetch(new URL('dist/statusbar.html', base));
      if (!response.ok) throw new Error('无法读取状态栏模板（HTTP ' + response.status + '）');
      return response.text();
    },
  });
  window[key] = extension;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void extension.start(), { once: true });
  else void extension.start();
}
