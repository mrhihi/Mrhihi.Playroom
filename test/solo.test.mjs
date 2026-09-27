import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { SoloSession, soloSaveSchema } from '../dist/shared/solo.js';
import { createDatabase } from '../dist/db.js';
import { RoomService } from '../dist/rooms.js';
import { registerHttp } from '../dist/http.js';
const create = () => SoloSession.create('測試玩家', '', randomUUID(), 'ab'.repeat(32));
const body = s => { const { version, uploadedId, ...data } = s.save; return data; };

test('本地暫停凍結操作、重力與落地鎖定，續玩保留剩餘時間', () => {
  const s = create(); s.paused = false;
  const p = s.save.state.players.solo;
  p.active = { type: 'O', rotation: 0, x: 3, y: 18 };
  s.apply({ type: 'tetris.move', direction: 'down' });
  assert.equal(p.lockAt, 500);
  s.advance(200); s.paused = true;
  const before = JSON.stringify(s.save);
  assert.equal(s.apply({ type: 'tetris.hardDrop' }), false);
  assert.equal(s.advance(100_000), false);
  assert.equal(JSON.stringify(s.save), before);
  const restored = new SoloSession(soloSaveSchema.parse(JSON.parse(before)));
  assert.equal(restored.paused, true);
  restored.paused = false; restored.advance(299);
  assert.equal(restored.save.state.players.solo.board[19][4], null);
  restored.advance(1);
  assert.equal(restored.save.state.players.solo.board[19][4], 'O');
});

test('本地單人沿用消行計分且結束後拒絕操作', () => {
  const s = create(); s.paused = false;
  const p = s.save.state.players.solo;
  p.active = { type: 'O', rotation: 0, x: -1, y: 17 };
  for (const y of [18,19]) for(let x=2;x<10;x++) p.board[y][x]='I';
  s.apply({ type:'tetris.hardDrop' });
  assert.equal(p.score,300); assert.equal(p.lines,2);
  s.apply({type:'tetris.surrender'});
  assert.equal(s.save.state.gameOver,true);
  assert.equal(s.apply({type:'tetris.rotate'}),false);
});

test('結果提交持久去重、密碼保護、刪除且不建立活動房間', async () => {
  const db=createDatabase(':memory:'), rooms=new RoomService(db), app=Fastify(); registerHttp(app,rooms);
  const s=create(); s.save.password='test-password'; s.paused=false; s.apply({type:'tetris.surrender'});
  const send = payload => app.inject({ method:'POST', url:'/api/tetris/solo-results', payload });
  const first=await send(body(s)); assert.equal(first.statusCode,201);
  const result=first.json(); assert.equal(rooms.rooms.size,0);
  assert.equal(JSON.parse(db.getSession(result.roomId).result).source,'local');
  assert.equal(rooms.canAccess(result.roomId,''),false);
  assert.equal(rooms.canAccess(result.roomId,result.accessToken),true);
  const restarted=new RoomService(db);
  assert.equal(restarted.submitSoloResult(body(s)).roomId,result.roomId);
  assert.equal((await send({...body(s),ownerDeleteToken:'cd'.repeat(32)})).statusCode,409);
  assert.equal(rooms.deleteAsOwner(result.roomId,s.save.ownerDeleteToken),'deleted');
  assert.equal((await send(body(s))).statusCode,409);
  assert.equal(db.listSessions().length,0);
  await app.close();
});

test('升級後含小數下落時間的存檔可續玩並上傳結果', async () => {
  const app=Fastify(); registerHttp(app,new RoomService(createDatabase(':memory:')));
  try {
    const s=create(); s.paused=false;
    s.save.state.players.solo.lines=20;
    s.save.state.players.solo.score=1000;
    s.advance(1000);
    assert.equal(Number.isInteger(s.save.state.nextFallAt),false);
    const restored=new SoloSession(soloSaveSchema.parse(JSON.parse(JSON.stringify(s.save))));
    restored.paused=false;
    restored.apply({type:'tetris.surrender'});
    const response=await app.inject({method:'POST',url:'/api/tetris/solo-results',payload:body(restored)});
    assert.equal(response.statusCode,201,response.body);
    const result=await app.inject('/api/results/'+response.json().roomId);
    assert.equal(result.json().result.score,1000);
  } finally { await app.close(); }
});

test('結果 API 拒絕未結束、雙人、錯誤棋盤與負數分數', async () => {
  const app=Fastify(); registerHttp(app,new RoomService(createDatabase(':memory:')));
  const s=create();
  const send=payload=>app.inject({method:'POST',url:'/api/tetris/solo-results',payload});
  assert.equal((await send(body(s))).statusCode,400);
  s.paused=false;s.apply({type:'tetris.surrender'});
  for(const change of [v=>v.state.mode='versus',v=>v.state.players.solo.score=-1,v=>v.state.players.solo.board.pop(),v=>v.state.players.solo.board[0][0]='G',v=>v.state.players.extra=v.state.players.solo]) {
    const invalid=structuredClone(body(s));change(invalid);assert.equal((await send(invalid)).statusCode,400);
  }
  assert.equal((await app.inject({method:'POST',url:'/api/tetris/solo-results',payload:{text:'x'.repeat(17000)}})).statusCode,413);
  const asset=await app.inject('/assets/tetris-solo.js');assert.equal(asset.statusCode,200);assert.match(asset.headers['content-type'],/javascript/);
  await app.close();
});

test('交換狀態可持久保存，舊存檔缺少欄位仍可恢復',()=>{
  const s=create();delete s.save.state.players.solo.swapUsed;
  const legacy=soloSaveSchema.parse(s.save);const restored=new SoloSession(legacy);restored.paused=false;
  restored.apply({type:'tetris.swap'});assert.equal(restored.save.state.players.solo.swapUsed,true);
  const saved=soloSaveSchema.parse(restored.save);assert.equal(saved.state.players.solo.swapUsed,true);
});
