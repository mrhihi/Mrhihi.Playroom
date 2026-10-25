import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import Fastify from 'fastify';
import { browserIdentity, detectDevice } from '../dist/ui/identity.js';
import { clientScript } from '../dist/ui/client.js';
import { createDatabase } from '../dist/db.js';
import { RoomService } from '../dist/rooms.js';
import { registerHttp } from '../dist/http.js';
import { SoloSession } from '../dist/shared/solo.js';
const phone={deviceType:'phone',os:'iOS',browser:'Safari'};
const desktop={deviceType:'desktop',os:'Windows',browser:'Edge'};
const payload=(identityId)=>{
 const session=SoloSession.create('玩家','',randomUUID(),'ab'.repeat(32));session.paused=false;session.apply({type:'tetris.surrender'});
 const {version,...data}=session.save;return {...data,identityId,deviceInfo:phone};
};
test('裝置分類與瀏覽器辨識優先順序',()=>{
 const cases=[
 ['Mozilla iPhone Mobile Safari/605','iPhone',0,phone],
 ['Mozilla Macintosh Safari/605','MacIntel',5,{...phone,deviceType:'tablet'}],
 ['Android Mobile Chrome/130 SamsungBrowser/25','Linux',0,{deviceType:'phone',os:'Android',browser:'Samsung Internet'}],
 ['Android Chrome/130','Linux',0,{deviceType:'tablet',os:'Android',browser:'Chrome'}],
 ['Windows Chrome/130 Safari/537 Edg/130','Win32',0,desktop],
 ['iPhone Mobile CriOS/130 Safari/605','iPhone',0,{...phone,browser:'Chrome'}],
 ['iPhone Mobile FxiOS/130 Safari/605','iPhone',0,{...phone,browser:'Firefox'}],
 ['Windows Chrome/130 OPR/110','Win32',0,{...desktop,browser:'Opera'}],
 ['CrOS Chrome/130','Linux',0,{deviceType:'desktop',os:'ChromeOS',browser:'Chrome'}],
 ['', '',0,{deviceType:'unknown',os:'unknown',browser:'unknown'}],
 ];
 for(const [userAgent,platform,maxTouchPoints,expected] of cases) assert.deepEqual(detectDevice({userAgent,platform,maxTouchPoints}),expected);
});
test('同瀏覽器跨頁共用 ID，改名不變且不同瀏覽器不同',()=>{
 const a=new JSDOM('<div id="app"></div>',{url:'http://localhost/',runScripts:'outside-only'});
 const b=new JSDOM('',{url:'http://localhost/',runScripts:'outside-only'});
 a.window.eval(clientScript+'\nwindow.getIdentity=browserIdentity;');
 b.window.eval('window.getIdentity='+browserIdentity.toString());
 const id=a.window.getIdentity();a.window.localStorage.setItem('playroom:name','改名');
 assert.equal(a.window.getIdentity(),id);
 a.window.eval('window.soloIdentity='+browserIdentity.toString());assert.equal(a.window.soloIdentity(),id);
 assert.notEqual(b.window.getIdentity(),id);a.window.close();b.window.close();
});
test('單人跨局固定身分、舊紀錄不推測，API 驗證裝置',async()=>{
 const db=createDatabase(':memory:'),rooms=new RoomService(db),app=Fastify();registerHttp(app,rooms);
 const id=randomUUID(),first=payload(id);rooms.submitSoloResult(first);rooms.submitSoloResult(first);rooms.submitSoloResult({...payload(id),name:'改名'});
 const entries=(await app.inject('/api/tetris/leaderboard?mode=solo')).json().entries;
 assert.equal(entries.length,2);assert.ok(entries.every(e=>e.identityId===id));assert.deepEqual(entries[0].deviceInfo,phone);
 const legacy=payload(undefined);delete legacy.deviceInfo;rooms.submitSoloResult(legacy);
 assert.equal(db.getTetrisLeaderboard('solo')[2].identityId,null);assert.equal(db.getTetrisLeaderboard('solo')[2].deviceInfo,null);
 assert.equal((await app.inject({method:'POST',url:'/api/tetris/solo-results',payload:{...payload(id),deviceInfo:{...phone,os:'fake'}}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/api/rooms',payload:{game:'tetris',name:'甲',identityId:'invalid'}})).statusCode,400);
 await app.close();
});
test('對戰每局擷取最近裝置，重連不覆寫身分及本局裝置',()=>{
 const db=createDatabase(':memory:'),rooms=new RoomService(db),id=randomUUID();
 const {room,reconnectToken}=rooms.create('tetris','甲',{},'',false,{identityId:id,deviceInfo:phone});
 const other=rooms.addPlayer(room,'乙',undefined,false,{identityId:randomUUID(),deviceInfo:desktop});rooms.start(room);
 rooms.addPlayer(room,'甲',reconnectToken,false,{identityId:randomUUID(),deviceInfo:desktop});
 room.state.draw=true;rooms.finish(room);
 let mine=db.getTetrisLeaderboard('versus').find(e=>e.playerId===room.hostId);assert.equal(mine.identityId,id);assert.deepEqual(mine.deviceInfo,phone);
 assert.deepEqual(db.getTetrisLeaderboard('versus').find(e=>e.playerId===other.id).deviceInfo,desktop);
 rooms.restartTetris(room.id,reconnectToken);room.state.draw=true;rooms.finish(room);
 const devices=db.getTetrisLeaderboard('versus').filter(e=>e.identityId===id).map(e=>e.deviceInfo);
 assert.equal(devices.length,2);assert.ok(devices.some(d=>d.deviceType==='desktop'));assert.ok(devices.some(d=>d.deviceType==='phone'));
 const another=rooms.create('tetris','甲',{},'',false,{identityId:id,deviceInfo:desktop});assert.equal(another.room.players[0].identityId,id);
});
test('排行榜裝置與歷史資訊可讀並安全顯示',()=>{
 const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;
 w.eval(clientScript+'\nwindow.label=tetrisDeviceLabel;window.identity=tetrisPlayerIdentity;');
 assert.equal(w.label(phone),'手機 · iOS · Safari');assert.equal(w.label(null),'未記錄');assert.match(w.identity({identityId:null},[]),/舊紀錄/);
 assert.ok(!w.label({...phone,os:'<img>'}).includes('<img>'));w.close();
});

test('舊資料庫加欄位不改動成績且可重複啟動',()=>{
 const file=join(mkdtempSync(join(tmpdir(),'playroom-identity-')),'db.sqlite'),raw=new Database(file);
 raw.exec(`CREATE TABLE tetris_scores(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,mode TEXT NOT NULL,name TEXT NOT NULL,score INTEGER NOT NULL,lines INTEGER NOT NULL,level INTEGER NOT NULL,outcome TEXT,opponent TEXT,finished_at INTEGER NOT NULL);
 INSERT INTO tetris_scores VALUES('old-score','oldroom','solo','舊玩家',100,2,1,NULL,NULL,1);`);
 raw.close();const db=createDatabase(file);
 db.saveSession({id:'oldroom',game:'tetris',hostId:'solo',config:{},status:'finished',state:{},players:[],messages:[],stateVersion:0},null,'owner');
 for(const database of [db,createDatabase(file)]){const [entry]=database.getTetrisLeaderboard('solo');assert.equal(entry.score,100);assert.equal(entry.identityId,null);assert.equal(entry.deviceInfo,null);}
});
