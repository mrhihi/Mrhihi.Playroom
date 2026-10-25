import type { DeviceInfo } from '../shared/identity.js';
/** Standalone functions are also embedded in the inline main client. */
export function browserIdentity(): string {
  const key = 'playroom:player-id';
  try {
    const saved = localStorage.getItem(key);
    if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved)) return saved;
  } catch { /* Continue with an in-memory identity if storage is unavailable. */ }
  const shared = window as Window & { __playroomIdentity?: string };
  const id = shared.__playroomIdentity ?? crypto.randomUUID();
  shared.__playroomIdentity = id;
  try { localStorage.setItem(key, id); } catch { /* The game can still run. */ }
  return id;
}
export function detectDevice(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> = navigator): DeviceInfo {
  const ua = nav.userAgent;
  const ipad = /iPad/i.test(ua) || /Mac/i.test(nav.platform) && nav.maxTouchPoints > 1;
  const os = /iPhone|iPod|iPad/i.test(ua) || ipad ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Windows/i.test(ua) ? 'Windows' : /CrOS/i.test(ua) ? 'ChromeOS' : /Macintosh|Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'unknown';
  const deviceType = ipad || /Tablet/i.test(ua) || os === 'Android' && !/Mobile/i.test(ua) ? 'tablet' : /iPhone|iPod|Mobile/i.test(ua) ? 'phone' : os === 'unknown' ? 'unknown' : 'desktop';
  const browser = /SamsungBrowser\//i.test(ua) ? 'Samsung Internet' : /Edg(?:e|A|iOS)?\//i.test(ua) ? 'Edge' : /OPR\/|OPiOS\//i.test(ua) ? 'Opera' : /Firefox\/|FxiOS\//i.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//i.test(ua) ? 'Chrome' : /Safari\//i.test(ua) ? 'Safari' : 'unknown';
  return { deviceType, os, browser };
}
