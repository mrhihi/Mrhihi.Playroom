import { readFileSync } from 'node:fs';

export type AdsenseSnippets = { head: string; unit: string };

export function loadAdsense(env: NodeJS.ProcessEnv = process.env): AdsenseSnippets | null {
  if (env.NODE_ENV !== 'production' || env.ADSENSE_ENABLED !== '1') return null;

  const readSnippet = (path: string | undefined, name: string) => {
    if (!path?.trim()) throw new Error(`${name} must point to a private AdSense snippet file`);
    const snippet = readFileSync(path, 'utf8');
    if (!snippet.trim()) throw new Error(`${name} is empty`);
    return snippet;
  };

  return {
    head: readSnippet(env.ADSENSE_HEAD_FILE, 'ADSENSE_HEAD_FILE'),
    unit: readSnippet(env.ADSENSE_UNIT_FILE, 'ADSENSE_UNIT_FILE'),
  };
}

export function isAdsensePage(pathname: string): boolean {
  return pathname === '/' || /^\/games\/(race|old-maid|poll|tetris)\/?$/.test(pathname);
}
