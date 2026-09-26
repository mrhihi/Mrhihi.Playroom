import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { raceGame } from '../dist/games/race.js';
import { pollGame } from '../dist/games/poll.js';
import { oldMaidGame, removePairs, shuffleHand } from '../dist/games/old-maid.js';
import { tetrisGame } from '../dist/games/tetris.js';
import { clientScript } from '../dist/ui/client.js';
import { createDatabase } from '../dist/db.js';
import { RoomService } from '../dist/rooms.js';

const players = [
  { id: 'host', name: '局主', connected: true },
  { id: 'guest', name: '玩家', connected: true },
];

test('內嵌瀏覽器腳本可正確解析', () => {
  assert.doesNotThrow(() => new Function(clientScript));
  assert.match(clientScript, /pollRoundView=function\(entry,mode,recentVote\)/);
  assert.match(clientScript, /poll-answer-updated/);
});

test('俄羅斯方塊限制兩人開局，開局後可依設定加入觀眾', () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const { room } = rooms.create('tetris', '局主', { allowSpectators: true });
  const guest = rooms.addPlayer(room, '玩家');
  assert.throws(() => rooms.addPlayer(room, '第三位'), /僅限兩位/);
  rooms.start(room);
  const viewer = rooms.addPlayer(room, '觀眾');
  assert.equal(viewer.role, 'spectator');
  assert.equal(room.spectators.length, 1);
  assert.throws(() => rooms.apply(room, viewer.id, { type: 'tetris.rotate' }), /觀眾/);
  assert.equal(room.players[1].id, guest.id);
});

test('單人俄羅斯方塊可由局主開始，其他加入者只能觀戰', () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const { room } = rooms.create('tetris', '局主', { mode: 'solo', allowSpectators: true });
  rooms.start(room);
  const viewer = rooms.addPlayer(room, '觀眾');
  assert.equal(room.status, 'playing');
  assert.equal(room.players.length, 1);
  assert.equal(viewer.role, 'spectator');
  assert.throws(() => rooms.apply(room, viewer.id, { type: 'tetris.rotate' }), /觀眾/);
});

test('單人俄羅斯方塊依消行前等級計分，且不允許攻擊', () => {
  const state = tetrisGame.createState([players[0]], { mode: 'solo' });
  const player = state.players.host;
  player.active = { type: 'O', rotation: 0, x: -1, y: 17 };
  for (const y of [18, 19]) for (let x = 2; x < 10; x++) player.board[y][x] = 'G';
  tetrisGame.apply(state, { actorId: 'host', hostId: 'host', players: [players[0]], message: { type: 'tetris.hardDrop' } });
  assert.equal(player.lines, 2);
  assert.equal(player.score, 300);
  assert.throws(() => tetrisGame.apply(state, { actorId: 'host', hostId: 'host', players: [players[0]], message: { type: 'tetris.attack', lines: 1 } }), /沒有攻擊/);
});

test('單人俄羅斯方塊頂出棋盤會標記本局結束', () => {
  const state = tetrisGame.createState([players[0]], { mode: 'solo' });
  state.players.host.active = { type: 'T', rotation: 0, x: 3, y: -1 };
  for (let x = 3; x <= 5; x++) state.players.host.board[1][x] = 'G';
  tetrisGame.apply(state, { actorId: 'host', hostId: 'host', players: [players[0]], message: { type: 'tetris.move', direction: 'down' } });
  const result = tetrisGame.tick(state, { hostId: 'host', players: [players[0]], now: Date.now() + 600 });
  assert.equal(result.finished, true);
  assert.equal(state.gameOver, true);
  assert.equal(state.winnerId, undefined);
});

test('單人俄羅斯方塊頂出棋盤後結束並保存成績', () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const { room } = rooms.create('tetris', '局主', { mode: 'solo' });
  rooms.start(room);
  room.state.players[room.hostId].active = { type: 'T', rotation: 0, x: 3, y: -1 };
  for (let x = 3; x <= 5; x++) room.state.players[room.hostId].board[1][x] = 'G';
  rooms.apply(room, room.hostId, { type: 'tetris.move', direction: 'down' });
  rooms.tick(room, Date.now() + 600);
  assert.equal(room.status, 'finished');
  assert.equal(room.state.gameOver, true);
  assert.deepEqual(rooms.resultSummary(room), { playerId: room.hostId, playerName: '局主', score: 0, lines: 0, level: 1 });
});

test('投票觀察者不會列入投票者，也不能投票', () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const { room } = rooms.create('poll', '局主', { options: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }] }, undefined, true);
  const voter = rooms.addPlayer(room, '投票者');
  const observer = rooms.addPlayer(room, '觀察者', undefined, true);
  assert.equal(room.players.length, 1);
  assert.equal(room.spectators.length, 2);
  rooms.start(room);
  rooms.apply(room, voter.id, { type: 'poll.vote', optionId: 'yes' });
  assert.equal(room.state.revealed, true);
  assert.throws(() => rooms.apply(room, observer.id, { type: 'poll.vote', optionId: 'no' }), /觀眾/);
});

test('俄羅斯方塊結束後局主可用原房間重開，其他人不可重開', () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const { room, reconnectToken } = rooms.create('tetris', '局主', {});
  rooms.addPlayer(room, '玩家');
  rooms.start(room);
  rooms.finish(room);
  assert.equal(rooms.restartTetris(room.id, 'wrong-token'), 'forbidden');
  assert.equal(rooms.restartTetris(room.id, reconnectToken), 'started');
  assert.equal(room.status, 'playing');
  assert.equal(Object.keys(room.state.players).length, 2);
});

test('俄羅斯方塊攻擊會先抵銷最早來襲垃圾，且每次下移只釋放一筆', () => {
  const state = tetrisGame.createState(players, {});
  state.players.host.attackPoints = 4;
  state.players.host.incoming.push({ lines: 2, dueAt: Date.now() + 1000, fromPlayerId: 'guest' });
  tetrisGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'tetris.attack', lines: 3 } });
  assert.deepEqual(state.players.host.attackQueue, [3]);
  tetrisGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'tetris.move', direction: 'down' } });
  assert.equal(state.players.host.attackQueue.length, 0);
  assert.equal(state.players.host.incoming.length, 0);
  assert.equal(state.players.guest.incoming[0].lines, 1);
});

test('俄羅斯方塊攻擊佇列最多四筆，硬降只釋放一筆', () => {
  const state = tetrisGame.createState(players, {});
  state.players.host.attackPoints = 5;
  for (let i = 0; i < 4; i++) tetrisGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'tetris.attack', lines: 1 } });
  assert.throws(() => tetrisGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'tetris.attack', lines: 1 } }), /佇列已滿/);
  tetrisGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'tetris.hardDrop' } });
  assert.equal(state.players.host.attackQueue.length, 3);
});

test('垃圾列推掉已佔用的最上排時，俄羅斯方塊會正常結束', () => {
  const state = tetrisGame.createState(players, {});
  state.players.host.board[0][0] = 'T';
  state.players.host.incoming.push({ lines: 1, dueAt: Date.now() - 1, fromPlayerId: 'guest' });
  const result = tetrisGame.tick(state, { hostId: 'host', players, now: Date.now() });
  assert.equal(result.finished, true);
  assert.equal(state.winnerId, 'guest');
});

test('活動方塊暫時貼頂但尚未推出棋盤時，俄羅斯方塊不會判負', () => {
  const state = tetrisGame.createState(players, {});
  state.players.host.active.y = 0;
  state.players.host.incoming.push({ lines: 1, dueAt: Date.now() - 1, fromPlayerId: 'guest' });
  const result = tetrisGame.tick(state, { hostId: 'host', players, now: Date.now() });
  assert.equal(result.finished, false);
  assert.equal(state.players.host.lost, undefined);
});

test('活動方塊鎖定時超出棋盤頂端會立刻結算對手勝利', () => {
  const state = tetrisGame.createState(players, {});
  state.players.host.active = { type: 'T', rotation: 0, x: 3, y: -1 };
  for (let x = 3; x <= 5; x++) state.players.host.board[1][x] = 'G';
  tetrisGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'tetris.move', direction: 'down' } });
  const result = tetrisGame.tick(state, { hostId: 'host', players, now: Date.now() + 600 });
  assert.equal(result.finished, true);
  assert.equal(state.winnerId, 'guest');
});

test('玩家以 reconnect token 回到原身分，並保留系統離線通知', () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const { room } = rooms.create('poll', '局主', { question: '測試', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  const joined = rooms.addPlayer(room, '玩家');
  rooms.addSystemMessage(room, '玩家 已離開房間');
  room.players.find(player => player.id === joined.id).connected = false;
  const resumed = rooms.addPlayer(room, '不同名稱不應覆蓋', joined.reconnectToken);
  assert.equal(resumed.id, joined.id);
  assert.equal(resumed.reconnected, true);
  assert.equal(room.players.find(player => player.id === joined.id).connected, true);
  assert.equal(rooms.channelMessages(room.id, 'room')[0].text, '玩家 已離開房間');
});

test('未開牌投票快照只會揭露觀看者自己的選擇', () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const { room } = rooms.create('poll', '局主', { question: '測試', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  const guest = rooms.addPlayer(room, '玩家');
  for (const player of room.players) player.connected = true;
  rooms.start(room);
  rooms.apply(room, room.hostId, { type: 'poll.vote', optionId: 'a' });

  const hostState = rooms.snapshot(room, room.hostId).state;
  const guestState = rooms.snapshot(room, guest.id).state;
  assert.deepEqual(hostState.votes, {});
  assert.equal(hostState.myVoteOptionId, 'a');
  assert.deepEqual(guestState.votes, {});
  assert.equal(guestState.myVoteOptionId, undefined);
});

test('房主刪除憑證可在重新開啟資料庫後永久刪除自己的房間與資料', () => {
  const directory = mkdtempSync(join(tmpdir(), 'playroom-owner-delete-'));
  const file = join(directory, 'playroom.sqlite');
  try {
    const first = new RoomService(createDatabase(file));
    const { room, ownerDeleteToken } = first.create('poll', '局主', { question: '測試', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
    first.start(room);
    first.addMessage(room, room.players[0], '要刪除的訊息');
    assert.equal(first.deleteAsOwner(room.id, 'not-the-owner'), 'forbidden');
    assert.ok(first.getStored(room.id));

    const restarted = new RoomService(createDatabase(file));
    assert.equal(restarted.deleteAsOwner(room.id, ownerDeleteToken), 'deleted');
    assert.equal(restarted.getStored(room.id), undefined);
    assert.deepEqual(restarted.events(room.id), []);
    assert.deepEqual(restarted.roomMessages(room.id), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('賽跑在鳴槍前禁止點擊，鳴槍後會累積批次點擊並將完成者鎖定在終點', () => {
  const state = raceGame.createState(players, { distance: 100 });
  assert.throws(() => raceGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'race.clickBatch', count: 1, clientSequence: 1 } }), /尚未鳴槍/);
  state.startsAt = Date.now() - 1;
  state.endsAt = Date.now() + 5_000;
  const result = raceGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'race.clickBatch', count: 300, clientSequence: 1 } });
  assert.equal(state.distances.host, 100);
  assert.equal(result.finished, false);
});

test('手動賽跑會等所有跑者各自過線才結束', () => {
  const state = raceGame.createState(players, { distance: 100, durationMs: 5_000 });
  state.startsAt = Date.now() - 6_000;
  state.endsAt = Date.now() - 1;
  const first = raceGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'race.clickBatch', count: 100, clientSequence: 1 } });
  assert.equal(state.distances.host, 100);
  assert.equal(first.finished, false);
  const last = raceGame.apply(state, { actorId: 'guest', hostId: 'host', players, message: { type: 'race.clickBatch', count: 100, clientSequence: 2 } });
  assert.equal(state.distances.guest, 100);
  assert.equal(last.finished, true);
});

test('隨機排名會納入虛擬跑者並建立不重複的最終名次', () => {
  const state = raceGame.createState(players, { mode: 'random', virtualRunners: [{ name: '機器人' }, { name: '局主' }] });
  assert.equal(state.runners.length, 4);
  assert.ok(state.runners.every(runner => state.randomTimeline[0].distances[runner.id] === 0));
  assert.ok(state.runners.every(runner => state.randomTimeline.every((point, index, all) => index === 0 || point.distances[runner.id] >= all[index - 1].distances[runner.id])));
  assert.ok(state.runners.every(runner => state.randomTimeline.at(-1).distances[runner.id] === state.distance));
  assert.ok(state.runners.every(runner => {
    const completedAt = state.completion[runner.id].offsetMs;
    return state.randomTimeline.filter(point => point.offsetMs >= completedAt).every(point => point.distances[runner.id] === state.distance);
  }));
  assert.ok(new Set(Object.values(state.completion).map(completion => completion.offsetMs)).size > 1);
  const preFinishPoints = state.randomTimeline.slice(1).filter(point => state.runners.every(runner => point.distances[runner.id] < state.distance));
  const leaders = preFinishPoints.map(point => [...state.runners].sort((left, right) => point.distances[right.id] - point.distances[left.id])[0].id);
  assert.ok(new Set(leaders).size > 1);
  assert.equal(new Set(state.finalRanking).size, 4);
  assert.deepEqual([...state.finalRanking].sort(), [...state.runners.map(runner => runner.id)].sort());
  assert.deepEqual(state.finalRanking, [...state.runners].sort((left, right) => state.completion[left.id].order - state.completion[right.id].order).map(runner => runner.id));
  const rankingBeforeFinish = [...state.finalRanking];
  raceGame.finish(state);
  assert.deepEqual(state.finalRanking, rankingBeforeFinish);
  assert.equal(state.endsAt, state.startsAt + state.randomTimeline.at(-1).offsetMs);
  assert.ok(state.runners.some(runner => runner.name === '局主 #2' && runner.virtual));
  state.startsAt = Date.now() - 1;
  assert.throws(() => raceGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'race.clickBatch', count: 1, clientSequence: 1 } }), /不支援手動衝刺/);
});

test('隨機排名可讓開局者只觀賽，但至少須有其他參賽者', () => {
  const state = raceGame.createState(players, { mode: 'random', includeHost: false, virtualRunners: [{ name: '小藍' }] });
  assert.deepEqual(state.runners.map(runner => runner.name), ['玩家', '小藍']);
  assert.throws(() => raceGame.createState([players[0]], { mode: 'random', includeHost: false }), /至少加入一位/);
});

test('投票在所有連線玩家投完時自動公開，且只有局主可強制公開', () => {
  const state = pollGame.createState(players, { options: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }] });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'yes' } });
  assert.equal(state.revealed, false);
  pollGame.apply(state, { actorId: 'guest', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'no' } });
  assert.equal(state.revealed, true);
  assert.throws(() => pollGame.apply(pollGame.createState(players, { options: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }] }), { actorId: 'guest', hostId: 'host', players, message: { type: 'poll.reveal' } }), /只有局主/);
});

test('投票公開後局主可沿用或替換答項快速開啟下一題', () => {
  const state = pollGame.createState(players, { question: '第一題', options: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }] });
  state.revealed = true;
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.nextRound', question: '第二題' } });
  assert.equal(state.question, '第二題');
  assert.equal(state.revealed, false);
  assert.deepEqual(state.options.map(option => option.label), ['是', '否']);
  assert.deepEqual(state.votes, {});
  assert.equal(state.history.length, 0);
});

test('投票最少需要兩個答項，並在開牌時保留每位玩家的選擇歷程', () => {
  assert.throws(() => pollGame.createState(players, { options: [{ id: 'only', label: '唯一' }] }), /至少需要兩個答項/);
  const state = pollGame.createState(players, { question: '第一題', options: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }] });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'yes' } });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.reveal' } });
  assert.deepEqual(state.history[0].players, [{ playerId: 'host', name: '局主', optionId: 'yes' }, { playerId: 'guest', name: '玩家', optionId: undefined }]);
});

test('Scrum 估點允許數字與 ?，未開牌前只公開已投票者身分', () => {
  const state = pollGame.createState(players, { mode: 'scrum', options: [{ id: 'small', label: '小', point: 3 }, { id: 'unknown', label: '不確定', point: '?' }] });
  assert.deepEqual(state.options.map(option => option.point), [3, null]);
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'small' } });
  const publicState = pollGame.publicState(state);
  assert.deepEqual(publicState.votes, {});
  assert.equal(publicState.submittedCount, 1);
  assert.deepEqual(publicState.submittedPlayerIds, ['host']);
  assert.equal('host' in publicState.votes, false);
  assert.deepEqual(publicState.lastVote, { playerId: 'host', sequence: 1 });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.reveal' } });
  assert.equal(state.history[0].options[1].point, null);
});

test('Scrum 開牌後可補投或調整估點，並同步更新公開歷程', () => {
  const state = pollGame.createState(players, { mode: 'scrum', options: [{ id: 'small', label: '小', point: 3 }, { id: 'large', label: '大', point: 8 }] });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'small' } });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.reveal' } });
  const revealedAt = state.history[0].revealedAt;
  pollGame.apply(state, { actorId: 'guest', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'large' } });
  assert.equal(state.lastVote.revealedAction, 'added');
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'large' } });
  assert.equal(state.lastVote.revealedAction, 'changed');
  assert.deepEqual(state.votes, { host: 'large', guest: 'large' });
  assert.equal(state.history[0].revealedAt, revealedAt);
  assert.deepEqual(state.history[0].players.map(player => player.optionId), ['large', 'large']);
});

test('一般投票開牌後仍不可改選', () => {
  const state = pollGame.createState(players, { options: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }] });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'yes' } });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.reveal' } });
  assert.throws(() => pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'no' } }), /投票已結束/);
});

test('投票改選會覆寫原答案，不增加投票人數', () => {
  const state = pollGame.createState(players, { options: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }] });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'yes' } });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'no' } });
  const publicState = pollGame.publicState(state);
  assert.equal(publicState.submittedCount, 1);
  assert.deepEqual(publicState.submittedPlayerIds, ['host']);
  assert.deepEqual(publicState.lastVote, { playerId: 'host', sequence: 2 });
  pollGame.apply(state, { actorId: 'guest', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'yes' } });
  assert.equal(state.revealed, true);
  assert.deepEqual(state.votes, { host: 'no', guest: 'yes' });
  assert.equal(state.history[0].players.find(player => player.playerId === 'host').optionId, 'no');
});

test('投票在尚未開始時可安全建立公開快照', () => {
  assert.deepEqual(pollGame.publicState({}), {});
});

test('只有局主可清除過往投票題目歷程', () => {
  const state = pollGame.createState(players, { options: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }] });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'yes' } });
  pollGame.apply(state, { actorId: 'guest', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'no' } });
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.nextRound', question: '下一題' } });
  assert.equal(state.history.length, 1);
  assert.throws(() => pollGame.apply(state, { actorId: 'guest', hostId: 'host', players, message: { type: 'poll.clearHistory' } }), /只有局主/);
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.clearHistory' } });
  assert.deepEqual(state.history, []);
});

test('抽鬼牌只會留下無法配對的牌，並保留鬼牌', () => {
  const cards = [
    { id: 'a1', rank: 'A', suit: '♠' },
    { id: 'a2', rank: 'A', suit: '♥' },
    { id: 'joker', rank: 'JOKER', suit: '🃏', joker: true },
  ];
  assert.deepEqual(removePairs(cards).map(card => card.id), ['joker']);
});

test('抽鬼牌依 1 到 n 建立牌組，每個點數固定使用四種花色與一張鬼牌', () => {
  const state = oldMaidGame.createState(players, { maxRank: 3 });
  const cards = Object.values(state.hands).flat();
  assert.ok(cards.every(card => card.joker || ['1', '2', '3'].includes(card.rank)));
  assert.ok(cards.some(card => card.joker));
});

test('抽鬼牌在尚未開始時可安全建立公開快照', () => {
  assert.deepEqual(oldMaidGame.publicState({}), {});
});

test('抽鬼牌會記錄抽中的牌，供抽牌者顯示翻牌效果', () => {
  const state = { hands: { host: [{ id: 'h', rank: '1', suit: '♠' }], guest: [{ id: 'g', rank: '2', suit: '♥' }, { id: 'joker', rank: 'JOKER', suit: '🃏', joker: true }] }, eliminated: [], turnPlayerId: 'host' };
  oldMaidGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'oldMaid.draw', targetPlayerId: 'guest', cardIndex: 0 } });
  assert.equal(state.lastDraw.card.rank, '2');
  assert.equal(state.lastDraw.targetPlayerId, 'guest');
});

test('抽鬼牌會累計每位玩家自動消除的配對牌張數', () => {
  const state = { hands: { host: [{ id: 'h', rank: '1', suit: '♠' }], guest: [{ id: 'g', rank: '1', suit: '♥' }, { id: 'joker', rank: 'JOKER', suit: '🃏', joker: true }] }, eliminated: [], discardedCounts: { host: 2, guest: 0 }, turnPlayerId: 'host' };
  oldMaidGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'oldMaid.draw', targetPlayerId: 'guest', cardIndex: 0 } });
  assert.equal(state.discardedCounts.host, 4);
  assert.equal(state.hands.host.length, 0);
});

test('抽牌者可同步鎖定對手的牌，抽取後會清除鎖定', () => {
  const state = { hands: { host: [{ id: 'h', rank: '1', suit: '♠' }], guest: [{ id: 'g', rank: '2', suit: '♥' }, { id: 'joker', rank: 'JOKER', suit: '🃏', joker: true }] }, eliminated: [], turnPlayerId: 'host' };
  oldMaidGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'oldMaid.focus', targetPlayerId: 'guest', cardIndex: 1 } });
  assert.deepEqual(state.focus && { actorId: state.focus.actorId, targetPlayerId: state.focus.targetPlayerId, cardIndex: state.focus.cardIndex }, { actorId: 'host', targetPlayerId: 'guest', cardIndex: 1 });
  assert.throws(() => oldMaidGame.apply(state, { actorId: 'guest', hostId: 'host', players, message: { type: 'oldMaid.focus', targetPlayerId: 'host', cardIndex: 0 } }), /現在不能選牌/);
  assert.throws(() => oldMaidGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'oldMaid.focus', targetPlayerId: 'host', cardIndex: 0 } }), /不能選自己的牌/);
  oldMaidGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'oldMaid.draw', targetPlayerId: 'guest', cardIndex: 0 } });
  assert.equal(state.focus, undefined);
});

test('等待抽牌的玩家可標記自己的手牌作為誘餌', () => {
  const state = { hands: { host: [{ id: 'h', rank: '1', suit: '♠' }], guest: [{ id: 'g', rank: '2', suit: '♥' }] }, eliminated: [], turnPlayerId: 'host' };
  oldMaidGame.apply(state, { actorId: 'guest', hostId: 'host', players, message: { type: 'oldMaid.tease', cardIndex: 0 } });
  assert.equal(state.tease.playerId, 'guest');
  assert.equal(state.tease.cardIndex, 0);
});

test('抽鬼牌每次抽牌前每位玩家只能洗一次，且洗牌會清除相關標記', () => {
  const state = { hands: { host: [{ id: 'h1', rank: '1', suit: '♠' }, { id: 'h2', rank: '2', suit: '♥' }], guest: [{ id: 'g1', rank: '3', suit: '♣' }] }, eliminated: [], turnPlayerId: 'host', focus: { actorId: 'guest', targetPlayerId: 'host', cardIndex: 1, at: 1 }, tease: { playerId: 'host', cardIndex: 0, at: 1 } };
  oldMaidGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'oldMaid.shuffle' } });
  assert.deepEqual(state.hands.host.map(card => card.id).sort(), ['h1', 'h2']);
  assert.deepEqual(state.shuffledPlayerIds, ['host']);
  assert.equal(state.focus, undefined);
  assert.equal(state.tease, undefined);
  assert.throws(() => oldMaidGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'oldMaid.shuffle' } }), /正在洗牌/);
  state.shuffle.endsAt = Date.now() - 1;
  assert.throws(() => oldMaidGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'oldMaid.shuffle' } }), /上次抽牌後已洗過牌/);
});

test('抽鬼牌每次成功抽牌後重置所有人的洗牌額度', () => {
  const state = { hands: { host: [{ id: 'h', rank: '1', suit: '♠' }], guest: [{ id: 'g1', rank: '2', suit: '♥' }, { id: 'g2', rank: '3', suit: '♣' }] }, eliminated: [], turnPlayerId: 'host', shuffledPlayerIds: ['host', 'guest'] };
  oldMaidGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'oldMaid.draw', targetPlayerId: 'guest', cardIndex: 0 } });
  assert.deepEqual(state.shuffledPlayerIds, []);
});

test('洗牌使用 Fisher–Yates 並可提供可預期的亂數來源', () => {
  assert.deepEqual(shuffleHand(['a', 'b', 'c'], () => 0), ['b', 'c', 'a']);
});
