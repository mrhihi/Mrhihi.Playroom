import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceTetris, holdTetrisIncoming, tetrisGame } from '../dist/games/tetris.js';
import { VersusPrediction } from '../dist/browser/versus.js';
import { RoomService } from '../dist/rooms.js';
import { createDatabase } from '../dist/db.js';

const players = [{ id: 'a', name: '甲', connected: true }, { id: 'b', name: '乙', connected: true }];

test('伺服器計時器卡住後補算所有應發生的下落', () => {
  const state = tetrisGame.createState(players, {});
  state.nextFallAt = 1000;
  const initial = state.players.a.active.y;
  assert.equal(advanceTetris(state, 3500), true);
  assert.equal(state.players.a.active.y, initial + 3);
  assert.equal(state.players.b.active.y, initial + 3);
  assert.equal(state.nextFallAt, 4000);
});

test('本地操作立即生效，重連後重播未確認操作並去除已確認操作', () => {
  const state = tetrisGame.createState(players, {});
  state.nextFallAt = Date.now() + 10_000;
  const room = { status: 'playing', state: structuredClone(state) };
  const sent = [];
  let painted = 0;
  const prediction = new VersusPrediction('a', () => room, () => painted++, item => sent.push(item));
  try {
    const original = state.players.a.active.x;
    prediction.sync({ player: structuredClone(state.players.a), nextFallAt: state.nextFallAt, serverNow: Date.now(), acknowledged: 0 }, room.state);
    prediction.connection(false);
    assert.equal(prediction.queue({ type: 'tetris.move', direction: 'right' }), true);
    assert.equal(prediction.player().active.x, original + 1);
    assert.equal(sent[0].clientSequence, 1);
    assert.ok(painted > 0);
    assert.equal(prediction.queue({ type: 'tetris.move', direction: 'left' }), true);
    assert.equal(prediction.player().active.x, original);
    tetrisGame.apply(state, { actorId: 'a', hostId: 'a', players, message: sent[0], now: Date.now() });
    prediction.sync({ player: structuredClone(state.players.a), nextFallAt: state.nextFallAt, serverNow: Date.now(), acknowledged: 1 }, room.state);
    assert.equal(prediction.pendingCount, 1);
    assert.equal(prediction.player().active.x, original);
    prediction.connection(true);
    prediction.resend(2);
    assert.deepEqual(sent.map(item => item.clientSequence), [1, 2, 2]);
  } finally { prediction.close(); }
});

test('相同種子與來襲攻擊產生相同垃圾行', () => {
  const initial = tetrisGame.createState(players, {});
  const left = structuredClone(initial), right = structuredClone(initial);
  for (const state of [left, right]) {
    state.players.a.incoming.push({ lines: 3, fromPlayerId: 'b' });
    tetrisGame.apply(state, { actorId: 'a', hostId: 'a', players, message: { type: 'tetris.hardDrop' }, now: 1000 });
  }
  assert.deepEqual(left.players.a.board, right.players.a.board);
  assert.equal(left.players.a.garbageRandomState, right.players.a.garbageRandomState);
});

test('斷線時保留來襲攻擊，補送操作後的下一次落定才生效', () => {
  const state = tetrisGame.createState(players, {});
  state.players.a.incoming.push({ lines: 2, fromPlayerId: 'b' });
  holdTetrisIncoming(state, 'a', true);
  tetrisGame.apply(state, { actorId: 'a', hostId: 'a', players, message: { type: 'tetris.hardDrop' }, now: 1000 });
  assert.equal(state.players.a.incoming.length, 1);
  assert.equal(state.players.a.board.filter(row => row.includes('G')).length, 0);
  holdTetrisIncoming(state, 'a', false);
  tetrisGame.apply(state, { actorId: 'a', hostId: 'a', players, message: { type: 'tetris.hardDrop' }, now: 2000 });
  assert.equal(state.players.a.incoming.length, 0);
  assert.equal(state.players.a.board.filter(row => row.includes('G')).length, 2);
});

test('真正斷線 30 秒後才依現有規則判負', () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const { room } = rooms.create('tetris', '甲', {});
  rooms.addPlayer(room, '乙');
  room.players.forEach(player => { player.connected = true; });
  rooms.start(room);
  const now = Date.now();
  room.state.nextFallAt = now + 40_000;
  room.players[1].connected = false;
  room.disconnectedAt.set(room.players[1].id, now);
  rooms.tick(room, now + 29_999);
  assert.equal(room.status, 'playing');
  rooms.tick(room, now + 30_000);
  assert.equal(room.status, 'finished');
  assert.equal(room.state.winnerId, room.players[0].id);
});

test('超過 30 秒才重連，即使計時器尚未執行也會判負', () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const { room } = rooms.create('tetris', '甲', {});
  const joined = rooms.addPlayer(room, '乙');
  room.players.forEach(player => { player.connected = true; });
  rooms.start(room);
  room.players[1].connected = false;
  room.disconnectedAt.set(room.players[1].id, Date.now() - 30_001);
  rooms.addPlayer(room, '乙', joined.reconnectToken);
  assert.equal(room.status, 'finished');
  assert.equal(room.state.winnerId, room.players[0].id);
});
