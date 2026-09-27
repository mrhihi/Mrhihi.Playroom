import { SoloSession, soloSaveSchema, type SoloSave } from '../shared/solo.js';
import type { ClientMessage } from '../shared/types.js';
const SAVE = 'playroom:tetris:solo:v1', QUEUE = 'playroom:tetris:solo:pending';
interface Helpers {
  root: HTMLElement; esc: (s: unknown) => string; withBasePath: (s: string) => string;
  boardHtml: (p: unknown, active: unknown, ghost: boolean) => string;
  preview: (s: string) => string; notice: (s: string) => void;
}
const read = (key: string) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
const secret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
let retrying: Promise<void> | undefined;
export function retryPending(h: Helpers, fallback?: SoloSave): Promise<void> {
  if (retrying) return retrying;
  retrying = (async () => {
    const pending = read(QUEUE) || {};
    if (fallback) pending[fallback.submissionId] = fallback;
    for (const raw of Object.values(pending)) {
      const parsed = soloSaveSchema.safeParse(raw);
      if (!parsed.success || !parsed.data.state.gameOver) continue;
      const save = parsed.data;
      try {
        const response = await fetch(h.withBasePath('/api/tetris/solo-results'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ submissionId: save.submissionId, ownerDeleteToken: save.ownerDeleteToken, name: save.name, password: save.password, elapsedMs: save.elapsedMs, state: save.state }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        try {
        const ids = read('playroom:rooms') || [];
        localStorage.setItem('playroom:rooms', JSON.stringify([data.roomId, ...ids.filter((id: string) => id !== data.roomId)].slice(0, 40)));
        localStorage.setItem('playroom:owner:' + data.roomId, save.ownerDeleteToken);
        localStorage.setItem('playroom:access:' + data.roomId, JSON.stringify(data.accessToken));
        const current = read(SAVE);
        if (current?.submissionId === save.submissionId) localStorage.setItem(SAVE, JSON.stringify({ ...current, uploadedId: data.roomId, password: '' }));
        const queue = read(QUEUE) || {}; delete queue[save.submissionId]; localStorage.setItem(QUEUE, JSON.stringify(queue));
        } catch { h.notice('結果已上傳，但無法儲存本機紀錄與刪除憑證，請保存結果連結。'); }
        window.dispatchEvent(new CustomEvent('solo-uploaded', { detail: { submissionId: save.submissionId, roomId: data.roomId } }));
      } catch (error) { h.notice('結果尚未上傳：' + (error instanceof Error ? error.message : '請稍後重試')); }
    }
  })().finally(() => { retrying = undefined; });
  return retrying;
}
export async function mountSolo(h: Helpers, start?: { name: string; password: string }) {
  h.root.innerHTML = '<main class="shell"><section class="card"><p>載入單人遊戲…</p></section></main>';
  if (!navigator.locks) { h.root.innerHTML = '<main class="shell"><section class="card"><p>此瀏覽器不支援安全續玩，請使用新版瀏覽器並透過 HTTPS 或 localhost 開啟。</p></section></main>'; return; }
  await navigator.locks.request('playroom:tetris:solo', { ifAvailable: true }, async lock => {
    if (!lock) { h.root.innerHTML = '<main class="shell"><section class="card"><a href="'+h.withBasePath('/games/tetris')+'">← 回大廳</a><p>另一個分頁正在遊玩，請回到原分頁；關閉原分頁後可重新整理此頁。</p></section></main>'; return; }
    const raw = read(SAVE), parsed = soloSaveSchema.safeParse(raw);
    if (raw && !parsed.success) h.notice('存檔損壞或版本不相容，請重新開始。');
    if (start && parsed.success && !parsed.data.state.gameOver && !confirm('已有未完成遊戲，確定取代並開新局？')) start = undefined;
    if (!start && !parsed.success) {
      h.root.innerHTML = '<main class="shell"><section class="card"><a href="'+h.withBasePath('/games/tetris')+'">← 回大廳開新局</a><p>沒有可續玩的單人遊戲。</p></section></main>'; return;
    }
    const session = start ? SoloSession.create(start.name, start.password, crypto.randomUUID(), secret()) : new SoloSession(parsed.success ? parsed.data : {} as SoloSave);
    session.paused = !start || document.hidden || !document.hasFocus();
    let storageFailed = false, last = performance.now(), held: string | undefined, delay: ReturnType<typeof setTimeout> | undefined, repeat: ReturnType<typeof setInterval> | undefined, uploading = false;
    const persist = () => { try { localStorage.setItem(SAVE, JSON.stringify(session.save)); } catch { storageFailed = true; } };
    const stop = () => { clearTimeout(delay); clearInterval(repeat); held = undefined; };
    const ghost = () => read('playroom:tetris:ghost') === true;
    const side = () => read('playroom:tetris:controls-side') === 'left' ? 'left' : 'right';
    const render = () => {
      const s = session.save, p = s.state.players.solo, ended = s.state.gameOver;
      document.body.classList.toggle('tetris-mobile-playing', !ended);
      h.root.innerHTML = '<main class="shell"><section class="card tetris-shell local-solo"><header><h1>🧱 TETRIS 單人挑戰</h1><a href="'+h.withBasePath('/games/tetris')+'">← 回大廳</a><p>分數 '+p.score+' · 消行 '+p.lines+' · 等級 '+(Math.floor(p.lines/10)+1)+'</p></header>'+
        (storageFailed ? '<p role="alert">無法保存續玩資料，關閉或重新整理將遺失進度。</p>' : '')+
        (ended ? '<div class="result"><h2>挑戰結束</h2><p>本機運算成績</p><p>'+ (s.uploadedId ? '結果已上傳' : uploading ? '結果上傳中…' : '結果尚未上傳，可稍後重試')+'</p>'+(s.uploadedId ? '<a href="'+h.withBasePath('/results/'+s.uploadedId)+'">查看／分享結果</a>' : '<button data-solo-action="retry">重試上傳</button>')+'<button data-solo-action="new">再玩一局</button></div>' :
        '<div class="tetris-players solo"><section class="tetris-player you"><div class="tetris-touch-controls controls-'+side()+'"><div class="tetris-control-rail"><div class="tetris-settings-controls"><button data-solo-action="pause">'+(session.paused?'繼續':'暫停')+'</button><button data-solo-action="ghost">投影 '+(ghost()?'開':'關')+'</button><button data-solo-action="side">按鍵靠'+(side()==='left'?'右':'左')+'</button></div><div class="tetris-control-lower"><aside class="tetris-rail-preview">'+h.preview(p.next[0])+'</aside><div class="tetris-touch-side">'+[['rotate','↑','旋轉'],['left','←','左移'],['right','→','右移'],['drop','空白','直接落下'],['down','↓','下移']].map(([c,label,n])=>'<button data-solo-control="'+c+'" aria-label="'+n+'">'+label+'<small>'+n+'</small></button>').join('')+'</div></div></div><div class="tetris-touch-board">'+h.boardHtml(p,p.active,ghost())+'</div></div></section></div>'+
        (session.paused ? '<div class="solo-pause" role="dialog" aria-label="遊戲已暫停"><h2>已暫停</h2><button data-solo-action="pause">繼續遊戲</button><a href="'+h.withBasePath('/games/tetris')+'">回大廳</a></div>' : '') )+'</section></main>';
    };
    const upload = async () => {
      if (!session.save.state.gameOver || session.save.uploadedId || uploading) return;
      uploading = true;
      try { const queue = read(QUEUE) || {}; queue[session.save.submissionId] = session.save; localStorage.setItem(QUEUE, JSON.stringify(queue)); }
      catch { storageFailed = true; h.notice('無法保存待傳結果，請保持此頁開啟並重試。'); }
      render(); await retryPending(h, session.save); uploading = false; render();
    };
    const changed = () => { persist(); render(); if (session.save.state.gameOver) { stop(); void upload(); } };
    const sync = () => { const now = performance.now(); const changed = session.advance(now-last); last=now; return changed; };
    const pause = () => { if (session.save.state.gameOver) return; sync(); session.paused=true; stop(); changed(); };
    const control = (c: string) => {
      if (session.paused || session.save.state.gameOver) return;
      sync();
      const message: ClientMessage = c === 'left' || c === 'right' || c === 'down' ? { type: 'tetris.move', direction: c } : c === 'rotate' ? { type: 'tetris.rotate' } : { type: 'tetris.hardDrop' };
      session.apply(message); changed();
    };
    const togglePause = () => { if (session.save.state.gameOver || document.hidden) return; if (session.paused) { last=performance.now(); session.paused=false; changed(); } else pause(); };
    const click = (e: Event) => {
      const action = (e.target as Element).closest<HTMLElement>('[data-solo-action]')?.dataset.soloAction;
      if (action === 'pause') togglePause();
      if (action === 'retry') void upload();
      if (action === 'new') { try { sessionStorage.setItem('playroom:tetris:solo:start', JSON.stringify({ name: session.save.name, password: '' })); location.href=h.withBasePath('/games/tetris/solo'); } catch { h.notice('無法儲存開局設定，請回大廳開新局。'); } }
      if (action === 'ghost' || action === 'side') { stop(); try { localStorage.setItem(action === 'ghost' ? 'playroom:tetris:ghost' : 'playroom:tetris:controls-side', JSON.stringify(action === 'ghost' ? !ghost() : side()==='left'?'right':'left')); } catch { h.notice('無法儲存操作設定'); } render(); }
    };
    const key = (e: KeyboardEvent) => {
      if ((e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable]')) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase()==='p' || e.key==='Escape') { e.preventDefault(); if (!e.repeat) togglePause(); return; }
      const c = ({ArrowLeft:'left',ArrowRight:'right',ArrowDown:'down',ArrowUp:'rotate',' ':'drop'} as Record<string,string>)[e.key];
      if (c) { e.preventDefault(); control(c); }
    };
    const pointer = (e: PointerEvent) => {
      const c = (e.target as Element).closest<HTMLElement>('[data-solo-control]')?.dataset.soloControl;
      if (!c || e.button!==0 || session.paused) return;
      e.preventDefault(); stop(); held=c; document.body.setPointerCapture(e.pointerId); control(c);
      if (['left','right','down'].includes(c) && !session.save.state.gameOver) delay=setTimeout(()=> { if(held===c) repeat=setInterval(()=>control(c),75); },260);
    };
    const visible = () => { if(document.hidden) pause(); };
    const uploaded = (e: Event) => { const d=(e as CustomEvent).detail; if(d.submissionId===session.save.submissionId) { session.save.uploadedId=d.roomId; session.save.password=''; persist(); render(); } };
    h.root.addEventListener('click',click); document.addEventListener('keydown',key);
    document.body.addEventListener('pointerdown',pointer); for(const n of ['pointerup','pointercancel','lostpointercapture']) document.body.addEventListener(n,stop);
    window.addEventListener('blur',pause); document.addEventListener('visibilitychange',visible); window.addEventListener('solo-uploaded',uploaded);
    const online = () => { void upload(); };
    window.addEventListener('online',online);
    persist(); render(); if(session.save.state.gameOver) void upload();
    const timer=setInterval(()=> { if(sync()) changed(); },50);
    await new Promise<void>(resolve=>window.addEventListener('pagehide',()=> { pause(); persist(); stop(); clearInterval(timer); resolve(); },{once:true}));
    h.root.removeEventListener('click',click); document.removeEventListener('keydown',key); document.body.removeEventListener('pointerdown',pointer);
    for(const n of ['pointerup','pointercancel','lostpointercapture']) document.body.removeEventListener(n,stop);
    window.removeEventListener('blur',pause); document.removeEventListener('visibilitychange',visible); window.removeEventListener('solo-uploaded',uploaded); window.removeEventListener('online',online);
  });
}
