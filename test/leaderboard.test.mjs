import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { JSDOM } from 'jsdom';
import { createDatabase } from '../dist/db.js';
import { RoomService } from '../dist/rooms.js';
import { registerHttp } from '../dist/http.js';
import { SoloSession } from '../dist/shared/solo.js';
import { clientScript } from '../dist/ui/client.js';
const submission=(name,score,lines=0,password='')=>{
 const session=SoloSession.create(name,password,randomUUID(),'ab'.repeat(32));session.paused=false;
 session.save.state.players.solo.score=score;session.save.state.players.solo.lines=lines;
 session.apply({type:'tetris.surrender'});const {version,uploadedId,...data}=session.save;return data;
};
test('排行榜 API 分榜、排序、限額、去重與隱私',async()=>{
 const db=createDatabase(':memory:'),rooms=new RoomService(db),app=Fastify();registerHttp(app,rooms);
 assert.equal((await app.inject('/api/tetris/leaderboard?mode=invalid')).statusCode,400);
 const payload=submission('同名',999,2);rooms.submitSoloResult(payload);rooms.submitSoloResult(payload);
 rooms.submitSoloResult(submission('同名',999,3));rooms.submitSoloResult(submission('秘密',9999,0,'secret'));
 assert.equal(db.getTetrisLeaderboard('solo').length,2);
 assert.equal(db.getTetrisLeaderboard('solo').find(entry=>entry.lines===2).playerId,payload.submissionId);
 assert.equal(new Set(db.getTetrisLeaderboard('solo').map(entry=>entry.playerId)).size,2);
 assert.equal(db.getTetrisLeaderboard('solo')[0].lines,3);
 for(let i=0;i<25;i++)rooms.submitSoloResult(submission('玩家'+i,i));
 const response=(await app.inject('/api/tetris/leaderboard?mode=solo')).json();assert.equal(response.entries.length,20);assert.equal(response.entries[0].rank,1);
 assert.ok(!response.entries.some(e=>e.name==='秘密'));
 assert.equal(db.getTetrisLeaderboard('versus').length,0);
 const pending=rooms.create('tetris','尚未完成',{mode:'solo'});assert.equal(db.getTetrisLeaderboard('solo').length,20);
 rooms.delete(pending.room.id);await app.close();
});
test('對戰雙方勝負、平手、同房重開與刪除',()=>{
 const db=createDatabase(':memory:'),rooms=new RoomService(db);
 const {room,reconnectToken}=rooms.create('tetris','甲',{});const other=rooms.addPlayer(room,'乙');rooms.start(room);
 room.state.players[room.hostId].score=100;room.state.players[other.id].score=200;room.state.winnerId=room.hostId;rooms.finish(room);rooms.finish(room);
 let entries=db.getTetrisLeaderboard('versus');assert.equal(entries.length,2);assert.equal(entries[0].playerId,other.id);assert.equal(entries[1].playerId,room.hostId);assert.equal(entries[0].name,'乙');assert.equal(entries[0].outcome,'loss');assert.equal(entries[0].opponent,'甲');assert.equal(entries[1].outcome,'win');
 assert.equal(JSON.parse(db.getSession(room.id).result).rankings.length,2);
 rooms.restartTetris(room.id,reconnectToken);room.state.draw=true;rooms.finish(room);
 entries=db.getTetrisLeaderboard('versus');assert.equal(entries.length,4);assert.equal(entries.filter(e=>e.playerId===other.id).length,2);assert.equal(entries.filter(e=>e.outcome==='draw').length,2);
 const hidden=rooms.create('tetris','秘密',{},'secret').room;rooms.addPlayer(hidden,'秘密乙');rooms.start(hidden);hidden.state.draw=true;rooms.finish(hidden);assert.equal(db.getTetrisLeaderboard('versus').length,4);
 rooms.delete(room.id);assert.equal(db.getTetrisLeaderboard('versus').length,0);
});
test('舊單人回填一次，持久化且刪除後不復活',()=>{
 const file=join(mkdtempSync(join(tmpdir(),'playroom-ranking-')),'data.sqlite');
 const db=createDatabase(file);const state=SoloSession.create('舊玩家','',randomUUID(),'ab'.repeat(32)).save.state;
 db.saveSession({id:'legacy',game:'tetris',hostId:'solo',config:{mode:'solo'},status:'finished',state,players:[],messages:[],stateVersion:0},null,'owner');
 const raw=new Database(file);raw.prepare('UPDATE sessions SET result=?,final_state=? WHERE id=?').run(JSON.stringify({playerId:'solo',playerName:'舊玩家'}),JSON.stringify(state),'legacy');raw.prepare('DELETE FROM data_migrations').run();raw.close();
 const upgraded=createDatabase(file);assert.equal(upgraded.getTetrisLeaderboard('solo').length,1);assert.equal(upgraded.getTetrisLeaderboard('solo')[0].playerId,'legacy:legacy');
 assert.equal(createDatabase(file).getTetrisLeaderboard('solo').length,1);
 upgraded.deleteSession('legacy');assert.equal(createDatabase(file).getTetrisLeaderboard('solo').length,0);
});
test('大廳分頁、空榜、重試與暱名安全顯示',async()=>{
 const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;
 w.eval(clientScript+'\nwindow.root=root;');w.eval("root.innerHTML=tetrisLeaderboardHtml()");let failure=false,calls=[];
 w.fetch=async url=>{calls.push(url);if(failure)throw Error('offline');return {ok:true,json:async()=>({entries:url.includes('versus')?[]:[{rank:1,identityId:'12345678-aaaa',name:'<img src=x onerror=alert(1)>',score:100,lines:2,level:1,finishedAt:0,roomId:'abcdefg'}]})}};
 w.eval('mountTetrisLeaderboard()');const settle=()=>new Promise(r=>setTimeout(r,5));await settle();
 assert.equal(w.document.querySelector('.leaderboard-content img'),null);assert.match(w.document.querySelector('.leaderboard-content').textContent,/<img/);
 w.document.querySelector('[data-ranking-mode="versus"]').click();await settle();assert.match(w.document.querySelector('.leaderboard-content').textContent,/尚無對戰/);
 assert.equal(w.document.querySelector('[data-ranking-mode="versus"]').getAttribute('aria-pressed'),'true');
 failure=true;w.document.querySelector('[data-ranking-refresh]').click();await settle();assert.ok(w.document.querySelector('[data-ranking-retry]'));
 failure=false;w.document.querySelector('[data-ranking-retry]').click();await settle();assert.match(w.document.querySelector('.leaderboard-content').textContent,/尚無對戰/);
 assert.equal(w.document.querySelector('.leaderboard-content').getAttribute('aria-busy'),'false');assert.equal(calls.length,4);w.close();
});

test('排行短碼碰撞、同一身分與完整識別碼安全顯示',()=>{
 const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;
 w.eval(clientScript+'\nwindow.identity=tetrisPlayerIdentity;');
 const entries=[{identityId:'12345678-aaaa'},{identityId:'12345678-bbbb'},{identityId:'12345678-aaaa'}];
 w.document.querySelector('#app').innerHTML=w.identity(entries[0],entries);
 const summary=w.document.querySelector('summary');assert.equal(summary.textContent,'#12345678-a');assert.equal(summary.title,entries[0].identityId);
 assert.equal(w.document.querySelector('small').textContent,entries[0].identityId);
 w.document.querySelector('#app').innerHTML=w.identity(entries[0],[entries[0],entries[2]]);assert.equal(w.document.querySelector('summary').textContent,'#12345678');
 const unsafe={identityId:'<img src=x onerror=alert(1)>'};w.document.querySelector('#app').innerHTML=w.identity(unsafe,[unsafe]);assert.equal(w.document.querySelector('img'),null);assert.equal(w.document.querySelector('summary').title,unsafe.identityId);
 w.close();
});
