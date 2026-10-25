import assert from 'node:assert/strict';
import test from 'node:test';
import { oldMaidGame, removePairs, nextOldMaidPlayerId } from '../dist/games/old-maid.js';
const players = ['A','B','C','D'].map(id => ({id,name:id,connected:true}));
const card = (id, rank=id) => ({id,rank,suit:'♠',...(rank==='JOKER'?{joker:true}:{})});
const state = hands => ({hands,eliminated:[],discardedCounts:{},winnerIds:[],turnPlayerId:'A'});
const draw = (s, actorId, targetPlayerId, ps=players) => oldMaidGame.apply(s,{actorId,players:ps,hostId:'A',message:{type:'oldMaid.draw',targetPlayerId,cardIndex:0}});
test('only the next occupied seat can be drawn or focused, without mutating on rejection',()=>{
 const s=state({A:[card('a')],B:[card('b')],C:[card('c')],D:[card('j','JOKER')]});
 const before=structuredClone(s);
 assert.throws(()=>draw(s,'A','C'),/下一位/);assert.deepEqual(s,before);
 assert.throws(()=>oldMaidGame.apply(s,{actorId:'A',players,hostId:'A',message:{type:'oldMaid.focus',targetPlayerId:'C',cardIndex:0}}),/下一位/);
 draw(s,'A','B');assert.equal(s.turnPlayerId,'C'); // B safely leaves after its last card is drawn
 assert.deepEqual(s.winnerIds,['B']);assert.deepEqual(s.eliminated,['B']);
 assert.equal(nextOldMaidPlayerId(s,players,'D'),'A');
});
test('normal turns pass to the target when it still holds cards',()=>{
 const s=state({A:[card('a')],B:[card('b'),card('b2')],C:[card('c')],D:[]});
 draw(s,'A','B');assert.equal(s.turnPlayerId,'B');assert.equal(nextOldMaidPlayerId(s,players,'C'),'A');
});
test('simultaneous exits tie and later exits do not replace winners',()=>{
 const s=state({A:[card('a','1')],B:[card('b','1')],C:[card('c','2')],D:[card('d','2'),card('j','JOKER')]});
 draw(s,'A','B');assert.deepEqual(s.winnerIds,['A','B']);assert.equal(s.turnPlayerId,'C');
 const result=draw(s,'C','D');assert.equal(result.finished,true);assert.equal(s.loserId,'D');assert.equal(s.turnPlayerId,undefined);assert.deepEqual(s.winnerIds,['A','B']);
 assert.throws(()=>draw(s,'D','A')); 
});
test('pair removal preserves survivor order and removes all four of a rank',()=>{
 const cards=[card('a','1'),card('x','2'),card('b','1'),card('c','1'),card('j','JOKER'),card('d','1'),card('y','3')];
 assert.deepEqual(removePairs(cards).map(c=>c.id),['x','j','y']);
});
test('all new games use 53 cards regardless of old maxRank setting',()=>{
 for(let n=2;n<=8;n++){
 const ps=Array.from({length:n},(_,i)=>({id:String(i),name:String(i),connected:true}));
 const s=oldMaidGame.createState(ps,{maxRank:1});
 const counts=ps.map(p=>s.hands[p.id].length+s.discardedCounts[p.id]);
 assert.equal(counts.reduce((a,b)=>a+b,0),53);assert.ok(Math.max(...counts)-Math.min(...counts)<=1);
 assert.equal(Object.values(s.hands).flat().filter(c=>c.joker).length,1);
 assert.deepEqual(s.eliminated,ps.filter(p=>!s.hands[p.id].length).map(p=>p.id));
 if(!s.loserId)assert.ok(s.hands[s.turnPlayerId].length);
 }
});

import { createDeck } from '../dist/games/old-maid.js';
import { createDatabase } from '../dist/db.js';
import { RoomService } from '../dist/rooms.js';
import { clientScript } from '../dist/ui/client.js';
import { JSDOM } from 'jsdom';

test('the deck has every rank and suit exactly once plus one joker',()=>{
 const deck=createDeck();assert.equal(deck.length,53);assert.equal(new Set(deck.map(c=>c.id)).size,53);
 for(let rank=1;rank<=13;rank++)assert.deepEqual(deck.filter(c=>c.rank===String(rank)).map(c=>c.suit).sort(),['♠','♥','♦','♣'].sort());
});

test('initial simultaneous exits finish the room immediately and persist tied winners',t=>{
 // Arrange nine pairs for each of A and B, eight pairs and the joker for C.
 const hands=[Array.from({length:18},(_,i)=>i),Array.from({length:18},(_,i)=>18+i),Array.from({length:17},(_,i)=>36+i)];
 const desired=[];for(let i=0;i<18;i++)for(const hand of hands)if(i<hand.length)desired.push(hand[i]);
 const current=Array.from({length:53},(_,i)=>i),randoms=[];
 for(let i=52;i>0;i--){const j=current.indexOf(desired[i]);randoms.push((j+0.5)/(i+1));[current[i],current[j]]=[current[j],current[i]];}
 const db=createDatabase(':memory:'),rooms=new RoomService(db),{room,hostId}=rooms.create('old-maid','A',{maxRank:1});
 const b=rooms.addPlayer(room,'B'),c=rooms.addPlayer(room,'C');
 t.mock.method(Math,'random',()=>randoms.shift()??0);
 rooms.start(room);
 assert.equal(room.status,'finished');assert.equal(room.state.loserId,c.id);assert.deepEqual(room.state.winnerIds,[hostId,b.id]);assert.equal(room.state.turnPlayerId,undefined);
 assert.deepEqual(rooms.resultSummary(room).winnerNames,['A','B']);
 const stored=db.getSession(room.id);assert.equal(stored.status,'finished');assert.match(JSON.stringify(stored),/winnerNames/);
});

function ui(t){
 const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/games/old-maid',runScripts:'outside-only',pretendToBeVisual:true});
 t.after(()=>dom.window.close());const w=dom.window;
 w.fetch=async()=>({ok:true,json:async()=>({rooms:[],templates:[]})});
 w.eval(clientScript.replace(/^if\(path\[0\].*$/m,'')+'\nopenChat=()=>{};window.oldmaidTest={set(value,id){room=value;me=id;socket={readyState:1,send:data=>window.sent.push(JSON.parse(data))};renderRoom()},render:()=>renderRoom(),settings:()=>settings("old-maid"),results};');w.sent=[];
 return w;
}
test('mouse and keyboard are restricted to the next occupied seat; shuffle and reveal remain available',t=>{
 const w=ui(t),s=state({A:[card('a')],B:[card('b'),card('b2')],C:[card('j','JOKER')],D:[]});
 const room={id:'test',game:'old-maid',status:'playing',players,config:{maxRank:1},state:s};
 w.oldmaidTest.set(room,'A');const doc=w.document;
 assert.equal(doc.querySelector('.eyebrow').textContent,'OLD MAID · 53 張');
 assert.match(doc.querySelector('.oldmaid-matchup .drawer').textContent,/抽牌者A（你）/);
 assert.match(doc.querySelector('.oldmaid-matchup .target').textContent,/被抽牌者B/);
 assert.ok(doc.querySelector('.my-hand.oldmaid-drawer .oldmaid-role.drawer'));
 assert.match(doc.querySelector('.opponent.oldmaid-target h3').textContent,/B.*被抽牌/);
 assert.ok(!w.oldmaidTest.settings().includes('max-rank'));
 assert.equal(doc.querySelectorAll('[data-action="oldmaid-draw"]').length,2);
 assert.ok([...doc.querySelectorAll('[data-action="oldmaid-draw"]')].every(b=>b.dataset.target==='B'));
 doc.querySelector('[data-action="oldmaid-draw"]').click();assert.equal(w.sent.at(-1).targetPlayerId,'B');
 doc.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(w.sent.at(-1).targetPlayerId,'B');
 const count=w.sent.length;doc.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'2',bubbles:true}));assert.equal(w.sent.length,count);
 s.focus={actorId:'A',targetPlayerId:'B',cardIndex:1};w.oldmaidTest.render();
 doc.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.deepEqual(JSON.parse(JSON.stringify(w.sent.at(-1))),{type:'oldMaid.draw',targetPlayerId:'B',cardIndex:1});
 doc.querySelector('[data-action="oldmaid-shuffle"]').click();assert.equal(w.sent.at(-1).type,'oldMaid.shuffle');
 s.lastDraw={actorId:'A',targetPlayerId:'B',cardIndex:0,card:card('b'),at:Date.now()};w.oldmaidTest.render();assert.ok(doc.querySelector('.draw-reveal'));doc.querySelector('.draw-reveal').click();assert.equal(doc.querySelector('.draw-reveal'),null);
 s.turnPlayerId='B';w.oldmaidTest.render();assert.equal(doc.querySelector('.my-hand.oldmaid-drawer'),null);assert.match(doc.querySelector('.opponent.oldmaid-drawer h3').textContent,/B.*正在抽牌/);assert.match(doc.querySelector('.opponent.oldmaid-target h3').textContent,/C.*被抽牌/);doc.querySelector('[data-action="oldmaid-tease"]').click();assert.equal(w.sent.at(-1).type,'oldMaid.tease');
 s.winnerIds=['D'];s.eliminated=['D'];w.oldmaidTest.render();assert.match(doc.querySelector('.oldmaid-seats').textContent,/D（獲勝）/);
});
test('results display winners and support historical loser-only results',async t=>{
 const w=ui(t);let result={winnerNames:['A','B'],loserName:'C'};
 w.fetch=async()=>({ok:true,json:async()=>({game:'old-maid',result,messages:[]})});
 await w.oldmaidTest.results('test');assert.match(w.document.querySelector('.safe-note').textContent,/A、B/);
 result={loserName:'C'};await w.oldmaidTest.results('old');assert.equal(w.document.querySelector('.loser-name').textContent,'C');
});
