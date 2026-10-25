import { config } from '../config.js'; import { clientScript } from './client.js'; import { styles, soloStyles } from './styles.js';
import { isAdsensePage, type AdsenseSnippets } from './adsense.js';
export const page = (pathname = '/', adsense: AdsenseSnippets | null = null) => {
  const snippets = adsense && isAdsensePage(pathname) ? adsense : null;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Playroom</title><style>${styles}${soloStyles}</style>${snippets?.head ?? ''}</head><body><main id="app"></main>${snippets ? `<aside class="adsense-placement">${snippets.unit}</aside>` : ''}<script>window.__PLAYROOM_BASE_PATH__=${JSON.stringify(config.basePath)}</script><script type="module">${clientScript}</script></body></html>`;
};
