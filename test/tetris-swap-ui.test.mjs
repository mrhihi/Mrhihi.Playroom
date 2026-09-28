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
