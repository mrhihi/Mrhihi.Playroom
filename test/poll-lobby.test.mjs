import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { clientScript } from '../dist/ui/client.js';

const bootstrapFreeScript=clientScript.split('\n').filter(line=>!line.startsWith("if(path[0]===")).join('\n');
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
async function mount({history=[],templates={},ids=Object.keys(templates),handler}={}){
 const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/games/poll',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,requests=[];
 w.localStorage.setItem('playroom:templates',JSON.stringify(ids));
 w.localStorage.setItem('playroom:rooms',JSON.stringify([...history.map(item=>item.id),'other-game']));
 w.confirm=()=>true;
 w.fetch=async(url,options={})=>{
  const method=options.method||'GET',body=options.body?JSON.parse(options.body):undefined;requests.push({url,method,body,headers:options.headers});
  const custom=handler?.(url,options,body);if(custom!==undefined)return await custom;
  let data={};
  if(url.startsWith('/api/history'))data=history;
  if(url.startsWith('/api/templates/')&&method==='GET')data=templates[url.split('/').at(-1)];
  if(url==='/api/templates'&&method==='POST'){data={id:'saved',game:'poll',config:body.config};templates.saved=data;}
  if(method==='DELETE'&&url.startsWith('/api/templates/')){delete templates[url.split('/').at(-1)];return {ok:true,status:204,json:()=>{throw Error('204 has no body')}};}
  if(data===undefined)return {ok:false,status:404,json:async()=>({error:'找不到範本'})};
  return {ok:true,status:200,json:async()=>data};
 };
 w.eval(bootstrapFreeScript+'\nopenChat=()=>{};navigate=url=>{window.destination=url};window.ready=renderGameLobby("poll");');
 await w.ready;await settle();
 const doc=w.document;
 const fill=(selector,value)=>{const node=doc.querySelector(selector);const detail=node.closest('details');if(detail)detail.open=true;node.value=value;node.dispatchEvent(new w.Event('input',{bubbles:true}));return node;};
 const click=selector=>doc.querySelector(selector).click();
 const mode=value=>click('[name="poll-mode-choice"][value="'+value+'"]');
 const submit=()=>doc.querySelector('#poll-create-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 return {w,doc,requests,fill,click,mode,submit,close:()=>w.close()};
}
function complete(ui){ui.fill('#poll-question','第一題');ui.fill('#poll-name','局主');ui.fill('#poll-answer-0','同意');ui.fill('#poll-answer-1','不同意');}

test('投票大廳模式卡片保留各自草稿，常用點數可取消覆蓋且不動其他欄位',async()=>{
 const ui=await mount();const {doc,fill,mode,click,w}=ui;try{
  complete(ui);fill('#poll-password','room-secret');
  assert.equal(doc.querySelector('#poll-common-points').hidden,true);
  mode('scrum');assert.equal(doc.querySelector('#poll-answer-0').value,'');
  click('[data-poll-action="common-points"]');
  assert.equal(doc.querySelectorAll('.poll-lobby-answer').length,9);
  assert.equal(doc.querySelector('#poll-answer-editor').open,false);
  assert.deepEqual([...doc.querySelectorAll('#poll-answer-preview>span')].map(node=>node.textContent),['0','1','2','3','5','8','13','21','?']);
  assert.equal(doc.querySelector('#poll-point-8').value,'?');
  fill('#poll-point-0','0.5');mode('standard');assert.equal(doc.querySelector('#poll-answer-0').value,'同意');
  mode('scrum');assert.equal(doc.querySelector('#poll-point-0').value,'0.5');
  w.confirm=()=>false;click('[data-poll-action="common-points"]');assert.equal(doc.querySelector('#poll-point-0').value,'0.5');
  assert.equal(doc.querySelector('#poll-question').value,'第一題');assert.equal(doc.querySelector('#poll-password').value,'room-secret');
  assert.equal(doc.querySelectorAll('#poll-create').length,1);
 }finally{ui.close()}
});
test('開局與儲存範本使用相同答項驗證，開局另須題目與暱稱，錯誤就近呈現',async()=>{
 const ui=await mount();const {doc,fill,mode,click,submit,requests}=ui;try{
  submit();assert.equal(doc.activeElement.id,'poll-question');assert.match(doc.querySelector('#poll-question-error').textContent,/填寫/);
  complete(ui);mode('scrum');fill('#poll-answer-0','小');fill('#poll-answer-1','大');fill('#poll-point-0','Infinity');
  doc.querySelector('#poll-answer-editor').open=false;
  submit();assert.equal(doc.activeElement.id,'poll-point-0');assert.equal(doc.querySelector('#poll-answer-editor').open,true);assert.match(doc.querySelector('#poll-point-error-0').textContent,/有限數字/);
  click('[data-poll-action="save-template"]');await settle();assert.equal(requests.some(r=>r.method==='POST'),false);
  fill('#poll-point-0','3');fill('#poll-point-1','?');fill('#poll-question','');fill('#poll-name','');
  click('[data-poll-action="save-template"]');await settle();
  const saved=requests.find(r=>r.method==='POST');assert.equal(saved.url,'/api/templates');assert.equal(saved.body.config.options[1].point,null);assert.equal('question' in saved.body.config,false);
  submit();assert.equal(doc.activeElement.id,'poll-question');
 }finally{ui.close()}
});
test('建立期間阻止重複提交，失敗保留全部設定，成功傳送觀察者身分並保存重連資訊',async()=>{
 let finish;
 const ui=await mount({handler:(url,options)=>url==='/api/rooms'?new Promise(resolve=>finish=resolve):undefined});
 const {doc,fill,click,submit,requests,w}=ui;try{
  complete(ui);fill('#poll-password','secret');click('[name="poll-role"][value="observer"]');
  submit();submit();assert.equal(requests.filter(r=>r.url==='/api/rooms').length,1);assert.equal(doc.querySelector('#poll-create').disabled,true);
  finish({ok:false,status:503,json:async()=>({error:'暫時無法建立'})});await settle();
  assert.match(doc.querySelector('#poll-create-error').textContent,/暫時/);assert.equal(doc.querySelector('#poll-create').disabled,false);
  assert.equal(doc.querySelector('#poll-password').value,'secret');assert.equal(doc.querySelector('#poll-answer-0').value,'同意');
  submit();const posted=requests.filter(r=>r.url==='/api/rooms').at(-1).body;
  assert.equal(posted.observer,true);assert.equal(posted.config.hostObserver,true);assert.equal(posted.config.question,'第一題');
  finish({ok:true,status:201,json:async()=>({roomId:'newroom',reconnectToken:'token',ownerDeleteToken:'owner',accessToken:'access',url:'/rooms/newroom'})});await settle();
  assert.equal(w.destination,'/rooms/newroom');assert.equal(w.localStorage.getItem('playroom:owner:newroom'),'owner');assert.equal(JSON.parse(w.localStorage.getItem('playroom:token:newroom')),'token');
 }finally{ui.close()}
});
test('範本顯示內容摘要且過濾其他遊戲，套用僅更換模式及答項，刪除處理 204',async()=>{
 const templates={scrum:{id:'scrum',game:'poll',config:{mode:'scrum',options:[{label:'小',point:3},{label:'待討論',point:null}]}},race:{id:'race',game:'race',config:{}}};
 const ui=await mount({templates,ids:['scrum','race','missing']});const {doc,fill,click,requests}=ui;try{
  assert.equal(doc.querySelectorAll('.poll-template-item').length,1);assert.match(doc.querySelector('.poll-template-item').textContent,/小 \(3\)/);
  assert.match(doc.querySelector('#poll-template-list').textContent,/部分範本/);
  complete(ui);fill('#poll-password','secret');click('[name="poll-role"][value="observer"]');
  click('[data-poll-action="apply-template"]');
  assert.equal(doc.querySelector('[value="scrum"]').checked,true);assert.equal(doc.querySelector('#poll-point-0').value,'3');
  assert.equal(doc.querySelector('#poll-question').value,'第一題');assert.equal(doc.querySelector('#poll-name').value,'局主');assert.equal(doc.querySelector('#poll-password').value,'secret');assert.equal(doc.querySelector('[value="observer"]').checked,true);
  click('[data-poll-action="delete-template"]');await settle();assert.equal(doc.querySelectorAll('.poll-template-item').length,0);assert.ok(requests.find(r=>r.method==='DELETE'));
  assert.equal(doc.querySelector('#poll-point-0').value,'3');
 }finally{ui.close()}
});
test('最近房間排序、分頁展開與清除本機清單，不清除表單或其他遊戲資料',async()=>{
 const history=Array.from({length:7},(_,i)=>({id:'room00'+i,game:'poll',status:i===6?'finished':'playing',createdAt:1000+i}));
 const ui=await mount({history});const {doc,fill,click,w,requests}=ui;try{
  complete(ui);fill('#poll-question','保留草稿');
  assert.match(doc.querySelector('.poll-recent-item strong').textContent,/room006/);
  assert.match(doc.querySelector('.poll-recent-item a b').textContent,/查看結果/);
  assert.equal(doc.querySelectorAll('#poll-recent-body>.poll-recent-item').length,5);assert.equal(doc.querySelector('.poll-more-rooms').open,false);
  w.localStorage.setItem('playroom:owner:room006','owner');await w.eval('pollLobbyLoadHistory(document.querySelector(".poll-lobby"))');
  click('[data-poll-action="delete-room"]');await settle();assert.equal(doc.querySelector('#poll-question').value,'保留草稿');
  assert.equal(requests.find(r=>r.method==='DELETE').headers['x-room-owner'],'owner');assert.equal(doc.querySelectorAll('.poll-recent-item').length,6);
  click('[data-poll-action="clear-recent"]');assert.equal(doc.querySelectorAll('.poll-recent-item').length,0);assert.equal(doc.querySelector('#poll-question').value,'保留草稿');
  assert.deepEqual(JSON.parse(w.localStorage.getItem('playroom:rooms')),['other-game']);assert.equal(requests.filter(r=>r.method==='DELETE').length,1);
 }finally{ui.close()}
});
test('歷程載入失敗顯示重試，仍可開局；非投票大廳維持原本畫面',async()=>{
 const ui=await mount({handler:url=>url.startsWith('/api/history')?Promise.reject(Error('offline')):undefined});try{
  assert.ok(ui.doc.querySelector('[data-poll-action="reload-history"]'));complete(ui);assert.equal(ui.doc.querySelector('#poll-create').disabled,false);
  await ui.w.eval('renderGameLobby("old-maid")');assert.equal(ui.doc.querySelector('.poll-lobby'),null);assert.ok(ui.doc.querySelector('[data-action="create"][data-game="old-maid"]'));
 }finally{ui.close()}
});

test('投票大廳初次造訪收合聊天室，保留使用者明確的開關偏好',async()=>{
 const ui=await mount();try{
  ui.w.eval('drawChat()');assert.equal(ui.doc.querySelector('#chat-panel').classList.contains('closed'),true);
  assert.equal(ui.w.localStorage.getItem('playroom:chat-closed'),null);
  ui.w.localStorage.setItem('playroom:chat-closed','0');ui.w.eval('drawChat()');assert.equal(ui.doc.querySelector('#chat-panel').classList.contains('closed'),false);
  ui.w.localStorage.setItem('playroom:chat-closed','1');ui.w.eval('drawChat()');assert.equal(ui.doc.querySelector('#chat-panel').classList.contains('closed'),true);
 }finally{ui.close()}
});
