import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { buildSync } from 'esbuild';
import { SoloSession } from '../dist/shared/solo.js';
import { randomUUID } from 'node:crypto';
const source=buildSync({entryPoints:['src/ui/solo.ts'],bundle:true,format:'iife',globalName:'SoloUI',platform:'browser',write:false}).outputFiles[0].text;
const wait=()=>new Promise(r=>setTimeout(r,20));
function environment() {
  const dom=new JSDOM('<main id="app"></main>',{url:'http://localhost/games/tetris/solo',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window; w.document.hasFocus=()=>true;
  let locked=false;
  Object.defineProperty(w.navigator,'locks',{value:{request:async(_name,_options,callback)=>{if(locked)return callback(null);locked=true;try{return await callback({});}finally{locked=false;}}}});
  w.confirm=()=>true;
  w.eval(source+'\nwindow.SoloUI=SoloUI;');
  const requests=[];
  w.fetch=async(url,options)=>{requests.push({url,options});throw new Error('offline');};
  const h={root:w.document.querySelector('#app'),esc:s=>String(s),withBasePath:s=>'/prefix'+s,boardHtml:()=>'<div class="tetris-board"></div>',preview:()=>'<div class="tetris-next"></div>',notice:()=>{}};
  return {w,h,dom,requests};
}
const saved=w=>JSON.parse(w.localStorage.getItem('playroom:tetris:solo:v1'));

test('本地頁操作不傳網路；快捷鍵、失焦與重新整理保持暫停',async()=>{
  const {w,h,dom,requests}=environment();
  const mounted=w.SoloUI.mountSolo(h,{name:'測試',password:''});await wait();
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  const x=saved(w).state.players.solo.active.x;assert.equal(x,2);assert.equal(requests.length,0);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'p',bubbles:true}));
  assert.ok(h.root.querySelector('[role="dialog"]'));
  const before=w.localStorage.getItem('playroom:tetris:solo:v1');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  await wait();assert.equal(w.localStorage.getItem('playroom:tetris:solo:v1'),before);
  h.root.querySelector('.solo-pause button').click();assert.equal(h.root.querySelector('[role="dialog"]'),null);
  w.dispatchEvent(new w.Event('blur'));assert.ok(h.root.querySelector('[role="dialog"]'));
  w.dispatchEvent(new w.Event('pagehide'));await mounted;
  const resumed=w.SoloUI.mountSolo(h);await wait();assert.ok(h.root.querySelector('[role="dialog"]'),h.root.textContent+' '+JSON.stringify(saved(w)));
  assert.equal(saved(w).state.players.solo.active.x,x);assert.equal(requests.length,0);
  w.dispatchEvent(new w.Event('pagehide'));await resumed;dom.window.close();
});

test('第二分頁拒絕取得同一局操作權；輸入框不攔截快捷鍵',async()=>{
  const {w,h,dom}=environment();const mounted=w.SoloUI.mountSolo(h,{name:'測試',password:''});await wait();
  const other=w.document.createElement('div');await w.SoloUI.mountSolo({...h,root:other});assert.match(other.textContent,/另一個分頁/);
  const input=w.document.createElement('input');h.root.append(input);
  input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'p',bubbles:true}));assert.equal(h.root.querySelector('[role="dialog"]'),null);
  w.dispatchEvent(new w.Event('pagehide'));await mounted;dom.window.close();
});

test('斷網結果保留並可重試，上傳成功保存憑證與分享連結',async()=>{
  const {w,h,dom,requests}=environment();
  const s=SoloSession.create('玩家','secret',randomUUID(),'ab'.repeat(32));s.paused=false;s.apply({type:'tetris.surrender'});
  w.localStorage.setItem('playroom:tetris:solo:v1',JSON.stringify(s.save));
  const mounted=w.SoloUI.mountSolo(h);await wait();
  assert.equal(requests.length,1);assert.match(h.root.textContent,/尚未上傳/);
  assert.ok(JSON.parse(w.localStorage.getItem('playroom:tetris:solo:pending'))[s.save.submissionId]);
  w.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({roomId:'abcd234',accessToken:'access'})};};
  h.root.querySelector('[data-solo-action="retry"]').click();await wait();
  assert.equal(saved(w).uploadedId,'abcd234');assert.equal(saved(w).password,'');
  assert.equal(w.localStorage.getItem('playroom:owner:abcd234'),s.save.ownerDeleteToken);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('playroom:tetris:solo:pending')),{});
  assert.ok(h.root.querySelector('a[href="/prefix/results/abcd234"]'));
  assert.equal(requests[1].url,'/prefix/api/tetris/solo-results');
  w.dispatchEvent(new w.Event('pagehide'));await mounted;dom.window.close();
});

test('存檔損壞提示重開，儲存失敗仍可在本次頁面遊玩並上傳',async()=>{
  const {w,h,dom,requests}=environment();
  w.localStorage.setItem('playroom:tetris:solo:v1','{"version":99}');
  await w.SoloUI.mountSolo(h);assert.match(h.root.textContent,/沒有可續玩/);
  const original=w.Storage.prototype.setItem;
  w.Storage.prototype.setItem=function(){throw new Error('quota');};
  const mounted=w.SoloUI.mountSolo(h,{name:'玩家',password:''});await wait();
  assert.match(h.root.textContent,/無法保存/);
  // Repeated hard drops eventually top out; storage failures must not disable play.
  for(let i=0;i<40&&!h.root.querySelector('.result');i++) w.document.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:' ',bubbles:true}));
  await wait();assert.ok(h.root.querySelector('.result'));assert.ok(requests.length>0);
  w.Storage.prototype.setItem=original;
  w.dispatchEvent(new w.Event('pagehide'));await mounted;dom.window.close();
});
