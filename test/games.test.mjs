import assert from 'node:assert/strict';
import test from 'node:test';
import { raceGame } from '../dist/games/race.js';
import { pollGame } from '../dist/games/poll.js';
import { oldMaidGame, removePairs } from '../dist/games/old-maid.js';

const players = [
  { id: 'host', name: '局主', connected: true },
  { id: 'guest', name: '玩家', connected: true },
];

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

test('Scrum 估點允許數字與 ?，未開牌前不公開選擇', () => {
  const state = pollGame.createState(players, { mode: 'scrum', options: [{ id: 'small', label: '小', point: 3 }, { id: 'unknown', label: '不確定', point: '?' }] });
  assert.deepEqual(state.options.map(option => option.point), [3, null]);
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.vote', optionId: 'small' } });
  const publicState = pollGame.publicState(state);
  assert.deepEqual(publicState.votes, {});
  assert.equal(publicState.submittedCount, 1);
  pollGame.apply(state, { actorId: 'host', hostId: 'host', players, message: { type: 'poll.reveal' } });
  assert.equal(state.history[0].options[1].point, null);
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

test('等待抽牌的玩家可標記自己的手牌作為誘餌', () => {
  const state = { hands: { host: [{ id: 'h', rank: '1', suit: '♠' }], guest: [{ id: 'g', rank: '2', suit: '♥' }] }, eliminated: [], turnPlayerId: 'host' };
  oldMaidGame.apply(state, { actorId: 'guest', hostId: 'host', players, message: { type: 'oldMaid.tease', cardIndex: 0 } });
  assert.equal(state.tease.playerId, 'guest');
  assert.equal(state.tease.cardIndex, 0);
});
