import { clientScript } from './client.js'; import { styles } from './styles.js';
export const page = () => `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Playroom</title><style>${styles}</style></head><body><main id="app"></main><script type="module">${clientScript}</script></body></html>`;
