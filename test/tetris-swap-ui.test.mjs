import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { clientScript } from '../dist/ui/client.js';
import { tetrisGame } from '../dist/games/tetris.js';

test('連線預覽和 C 鍵送出交換，暫停與觀眾不可操作',()=>{
  const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;
  const players=[{id:'host',name:'甲',connected:true},{id:'guest',name:'乙',connected:true}];
  w.fixture={id:'test',game:'tetris',status:'playing',hostId:'host',config:{},players,state:tetrisGame.createState(players,{})};w.sent=[];
  w.eval(clientScript+'\nopenChat=()=>{};room=window.fixture;me="host";socket={readyState:WebSocket.OPEN,send:message=>window.sent.push(JSON.parse(message))};window.paint=()=>renderRoom();window.viewer=()=>{me="viewer";renderRoom()};renderRoom();');
  const key=(value,options={})=>w.document.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:value,bubbles:true,...options}));
  w.document.querySelector('[data-action="tetris-swap"]').click();key('C');key('c',{repeat:true});key('c',{altKey:true});
  assert.deepEqual(w.sent.map(m=>m.type),['tetris.swap','tetris.swap']);
  const editable=w.document.createElement('div');editable.setAttribute('contenteditable','true');w.document.body.append(editable);editable.dispatchEvent(new w.KeyboardEvent('keydown',{key:'c',bubbles:true}));assert.equal(w.sent.length,2);
  w.fixture.state.players.host.swapUsed=true;w.paint();assert.equal(w.document.querySelector('[data-action="tetris-swap"]').disabled,true);key('c');assert.equal(w.sent.length,2);
  w.fixture.state.players.host.swapUsed=false;w.fixture.state.pausedAt=100;w.paint();key('c');assert.equal(w.document.querySelector('[data-action="tetris-swap"]').disabled,true);assert.equal(w.sent.length,2);
  assert.equal(w.document.body.classList.contains('tetris-mobile-playing'),true);
  assert.equal(w.document.body.classList.contains('tetris-mobile-paused'),true);
  assert.ok(w.document.querySelector('.tetris-control-rail .tetris-rail-opponent'));
  assert.equal(w.document.querySelectorAll('[data-tetris-control]:disabled').length,5);
  delete w.fixture.state.pausedAt;w.paint();
  assert.equal(w.document.body.classList.contains('tetris-mobile-paused'),false);
  assert.equal(w.document.querySelectorAll('[data-tetris-control]:disabled').length,0);
  w.viewer();key('c');assert.equal(w.document.querySelector('[data-action="tetris-swap"]'),null);assert.equal(w.sent.length,2);
  w.close();
});

test('八個對戰按鈕對應 1～4 攻擊與 QWER 自清',()=>{
  const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;
  const players=[{id:'host',name:'甲',connected:true},{id:'guest',name:'乙',connected:true}];
  w.fixture={id:'test',game:'tetris',status:'playing',hostId:'host',config:{},players,state:tetrisGame.createState(players,{})};w.sent=[];
  w.fixture.state.players.host.attackPoints=16;
  w.eval(clientScript+'\nopenChat=()=>{};room=window.fixture;me="host";socket={readyState:WebSocket.OPEN,send:message=>window.sent.push(JSON.parse(message))};window.paint=()=>renderRoom();renderRoom();');
  try {
  const buttons=[...w.document.querySelectorAll('.tetris-player.you .tetris-attacks button')];
  assert.equal(buttons.length,8);
  assert.deepEqual(buttons.map(button=>button.dataset.action),[...Array(4).fill('tetris-attack'),...Array(4).fill('tetris-self-clear')]);
  const key=value=>w.document.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:value,bubbles:true}));
  for(const value of ['1','2','3','4','q','W','e','R']) key(value);
  assert.deepEqual(w.sent.map(message=>[message.type,message.lines]),[
    ...[1,2,3,4].map(lines=>['tetris.attack',lines]),
    ...[1,2,3,4].map(lines=>['tetris.selfClear',lines]),
  ]);
  w.sent.length=0;
  w.fixture.state.players.host.selfClearRows=2;w.paint();
  assert.equal(w.document.querySelectorAll('[data-action="tetris-self-clear"]:disabled').length,4);
  assert.equal(w.document.querySelectorAll('[data-action="tetris-attack"]:disabled').length,0);
  key('q');assert.equal(w.sent.length,0);
  delete w.fixture.state.players.host.selfClearRows;w.fixture.state.players.host.attackPoints=4;w.paint();
  assert.equal(w.document.querySelector('[data-action="tetris-self-clear"][data-lines="1"]').disabled,false);
  assert.equal(w.document.querySelector('[data-action="tetris-self-clear"][data-lines="2"]').disabled,true);
  w.document.querySelector('[data-action="tetris-self-clear"][data-lines="1"]').click();
  assert.equal(JSON.stringify(w.sent),JSON.stringify([{type:'tetris.selfClear',lines:1}]));
  } finally { w.close(); }
});

test('自動與不攻擊對戰顯示集氣但只保留自清操作',()=>{
  const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;
  const players=[{id:'host',name:'甲',connected:true},{id:'guest',name:'乙',connected:true}];
  w.fixture={id:'test',game:'tetris',status:'playing',hostId:'host',config:{attackEnabled:true,attackMode:'auto'},players,state:tetrisGame.createState(players,{attackMode:'auto'})};w.sent=[];
  w.fixture.state.players.host.attackPoints=12;
  w.eval(clientScript+'\nopenChat=()=>{};room=window.fixture;me="host";socket={readyState:WebSocket.OPEN,send:message=>window.sent.push(JSON.parse(message))};window.paint=()=>renderRoom();renderRoom();');
  try {
    assert.equal(w.document.querySelectorAll('[data-action="tetris-attack"]').length,0);
    assert.equal(w.document.querySelectorAll('[data-action="tetris-self-clear"]').length,4);
    assert.equal(w.document.querySelector('.tetris-charge').getAttribute('aria-valuenow'),'12');
    assert.equal(w.document.querySelector('.tetris-charge').getAttribute('aria-valuemax'),'16');
    w.document.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'1',bubbles:true}));
    assert.equal(w.sent.length,0);
    w.fixture.config.attackEnabled=false;w.fixture.state.attackEnabled=false;w.paint();
    assert.equal(w.document.querySelectorAll('[data-action="tetris-attack"]').length,0);
    assert.equal(w.document.querySelector('.tetris-rule'),null);
    assert.equal(w.document.querySelector('.tetris-charge').getAttribute('aria-valuemax'),'4');
  } finally {w.close()}
});
