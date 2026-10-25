import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { clientScript } from '../dist/ui/client.js';
import { RoomService } from '../dist/rooms.js';
import { createDatabase } from '../dist/db.js';

function fixture(mode='scrum',revealed=false){
 const options=[{id:'small',label:'小工作',point:3},{id:'large',label:'較大工作',point:8},{id:'unknown',label:'需要討論',point:null}];
 const players=[{id:'host',name:'局主',connected:true},{id:'guest',name:'夥伴',connected:false}];
 const entry={round:2,question:'本題',options,players:players.map(p=>({playerId:p.id,name:p.name,optionId:p.id==='host'?'small':'unknown'}))};
 return {id:'poll-test',game:'poll',status:'playing',hostId:'host',config:{},players,spectators:[{id:'observer',name:'觀察者',connected:true}],state:{mode,question:'本題',round:2,options,revealed,votes:revealed?{host:'small',guest:'unknown'}:{},myVoteOptionId:revealed?undefined:'small',submittedPlayerIds:['host'],submittedCount:1,history:revealed?[{...entry,round:1,question:'舊題'},entry]:[]}};
}
function mount(room=fixture(),viewer='host'){
 const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;
 w.fixture=room;w.sent=[];
 w.eval(clientScript+'\nopenChat=()=>{};room=window.fixture;me='+JSON.stringify(viewer)+';socket={readyState:WebSocket.OPEN,send:message=>window.sent.push(JSON.parse(message))};window.paint=()=>renderRoom();renderRoom();');
 return {w,doc:w.document,close:()=>w.close()};
}
test('投票區以點數和選取狀態呈現，進度分組且離線不掩蓋投票狀態',()=>{
 const {w,doc,close}=mount();try{
  assert.equal(doc.querySelector('.poll-vote strong').textContent,'3');
  assert.equal(doc.querySelector('[data-option="small"]').getAttribute('aria-pressed'),'true');
  assert.match(doc.querySelector('.poll-count').textContent,/1 \/ 共 2/);
  assert.match(doc.querySelector('.poll-progress .poll-status-list').textContent,/夥伴等待投票 · 離線/);
  assert.equal(doc.querySelector('.players'),null);
  assert.ok(doc.querySelector('.poll-progress').compareDocumentPosition(doc.querySelector('.poll-secondary')) & w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(doc.querySelector('#poll-observers').open,false);
  doc.querySelector('[data-option="large"]').click();
  assert.equal(w.sent[0].type,'poll.vote');assert.equal(w.sent[0].optionId,'large');
  doc.querySelector('[data-action="reveal"]').click();assert.equal(w.sent[1].type,'poll.reveal');
  w.fixture.state.submittedPlayerIds.push('guest');w.paint();
  assert.match(doc.querySelector('.poll-progress .poll-status-list').textContent,/夥伴✓ 已投票 · 離線/);
 }finally{close()}
});
test('開牌優先顯示本題分布與數字統計，歷程不重複本題且調整估點後收合',()=>{
 const {w,doc,close}=mount(fixture('scrum',true));try{
  assert.equal(doc.querySelector('.poll-main').firstElementChild.classList.contains('poll-current-result'),true);
  assert.equal(doc.querySelector('.point-summary b').textContent,'3.00');
  assert.equal(doc.querySelectorAll('#poll-past .poll-past-round').length,1);
  assert.match(doc.querySelector('#poll-past summary').textContent,/1 題/);
  assert.equal(doc.querySelector('#poll-next').open,false);
  assert.equal(doc.querySelector('#poll-next-options').open,false);
  const edit=doc.querySelector('#poll-edit-vote');edit.open=true;
  doc.querySelector('[data-option="large"]').click();assert.equal(edit.open,false);
  assert.equal(w.sent[0].optionId,'large');w.paint();assert.equal(doc.querySelector('#poll-edit-vote').open,false);
 }finally{close()}
});
test('即時更新保留下一題草稿、增刪答項、展開狀態與游標，新題重設',()=>{
 const {w,doc,close}=mount(fixture('scrum',true));try{
  doc.querySelector('#poll-next').open=true;doc.querySelector('#poll-next-options').open=true;
  doc.querySelector('#poll-past').open=true;
  doc.querySelector('[data-action="add-option"]').click();
  const labels=doc.querySelectorAll('.next-round .option');labels[0].value='修改答項';labels[3].value='新增答項';
  const question=doc.querySelector('#next-question');question.value='草稿下一題';question.focus();question.setSelectionRange(2,4);
  w.fixture.state.lastVote={playerId:'guest',sequence:9};w.paint();
  assert.equal(doc.querySelector('#next-question').value,'草稿下一題');
  assert.equal(doc.activeElement.id,'next-question');assert.equal(doc.activeElement.selectionStart,2);assert.equal(doc.activeElement.selectionEnd,4);
  assert.equal(doc.querySelectorAll('.next-round .option').length,4);
  assert.equal(doc.querySelector('.next-round .option').value,'修改答項');
  assert.equal(doc.querySelector('#poll-next-options').open,true);assert.equal(doc.querySelector('#poll-past').open,true);
  doc.querySelector('[data-action="next-round"]').click();
  assert.equal(w.sent[0].question,'草稿下一題');assert.equal(w.sent[0].options.length,4);
  w.fixture.state.round=3;w.paint();assert.equal(doc.querySelector('#next-question').value,'');assert.equal(doc.querySelector('#poll-next').open,false);
 }finally{close()}
});
test('一般投票開牌後無改選，觀察者無投票卡，只有局主能管理題目',()=>{
 for(const [mode,revealed,viewer] of [['standard',true,'guest'],['scrum',false,'observer'],['scrum',true,'observer']]){
  const {doc,close}=mount(fixture(mode,revealed),viewer);try{
   assert.equal(doc.querySelector('[data-action="vote"]'),null);
   assert.equal(doc.querySelector('[data-action="reveal"]'),null);
   assert.equal(doc.querySelector('#poll-next'),null);
  }finally{close()}
 }
 const room=fixture();room.hostId='observer';const {doc,close}=mount(room,'observer');try{
  assert.ok(doc.querySelector('[data-action="reveal"]'));assert.equal(doc.querySelector('[data-action="vote"]'),null);
 }finally{close()}
});
test('觀察者局主可開下一題並清除過往歷程，其他觀察者不得管理',()=>{
 const db=createDatabase(':memory:'),rooms=new RoomService(db);
 const {room}=rooms.create('poll','局主',{mode:'scrum',options:[{id:'a',label:'小',point:3},{id:'b',label:'大',point:8}]},undefined,true);
 rooms.addPlayer(room,'玩家');const observer=rooms.addPlayer(room,'旁觀',undefined,true);rooms.start(room);
 rooms.apply(room,room.hostId,{type:'poll.reveal'});
 rooms.apply(room,room.hostId,{type:'poll.nextRound',question:'第二題'});
 rooms.apply(room,room.hostId,{type:'poll.reveal'});
 assert.equal(room.state.history.length,2);
 assert.throws(()=>rooms.apply(room,observer.id,{type:'poll.clearHistory'}),/觀眾/);
 assert.throws(()=>rooms.apply(room,observer.id,{type:'poll.nextRound',question:'第三題'}),/觀眾/);
 rooms.apply(room,room.hostId,{type:'poll.clearHistory'});assert.equal(room.state.history.length,1);
 assert.equal(room.state.history[0].round,2);
});
