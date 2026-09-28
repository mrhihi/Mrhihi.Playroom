import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { JSDOM } from 'jsdom';
import { createDatabase } from '../dist/db.js';
import { RoomService } from '../dist/rooms.js';
import { createRealtime } from '../dist/realtime.js';
import { tetrisGame } from '../dist/games/tetris.js';
import { visibleTetris, diffTetris } from '../dist/tetris-wire.js';
import { clientScript } from '../dist/ui/client.js';
import { styles } from '../dist/ui/styles.js';

const players = [{ id: 'host', name: '甲', connected: true }, { id: 'guest', name: '乙', connected: true }];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (promise, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timeout: ' + label)), 2000);
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

test('對戰差異只含變動欄位與棋盤列，不傳袋內方塊', () => {
  const state = tetrisGame.createState(players, {}), before = visibleTetris(state);
  state.players.guest.active.x++;
  state.players.guest.board[19][0] = 'I';
  const patch = diffTetris(before, visibleTetris(state), ['guest']);
  assert.deepEqual(Object.keys(patch.players.guest).sort(), ['active', 'boardRows']);
  assert.equal(patch.players.guest.boardRows.length, 1);
  assert.equal(patch.players.guest.boardRows[0][0], 19);
  assert.equal(JSON.stringify(patch).includes('bag'), false);
  assert.equal(JSON.stringify(before).includes('pieceRandomState'), false);
  assert.equal(diffTetris(before, visibleTetris(state), ['host']), undefined);
});

test('自清預約與動畫階段會送進對戰差異更新', () => {
  const state = tetrisGame.createState(players, {}), before = visibleTetris(state);
  state.players.host.selfClearRows = 2;
  const reserved = visibleTetris(state), patch = diffTetris(before, reserved, ['host']);
  assert.equal(patch.players.host.selfClearRows, 2);
  delete state.players.host.selfClearRows;
  state.players.host.clearing = { rows: [19], endsAt: Date.now() + 200, kind: 'self' };
  const clearing = diffTetris(reserved, visibleTetris(state), ['host']);
  assert.equal(clearing.players.host.selfClearRows, null);
  assert.equal(clearing.players.host.clearing.kind, 'self');
});

const painted = board => [...board.children].flatMap((cell, index) => /piece-[I-TZ]/.test(cell.className) ? [index] : []);
function viewer(id, state, config = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(clientScript + '\nopenChat=()=>{};class MockSocket{static OPEN=1;readyState=1;send(){}close(){}};window.WebSocket=MockSocket;connectRoom("test");window.deliver=message=>socket.onmessage({data:JSON.stringify(message)})');
  w.deliver({ type: 'joined', playerId: id, reconnectToken: 'token' });
  w.deliver({ type: 'snapshot', payload: { id: 'test', game: 'tetris', status: 'playing', hostId: 'host', config: { mode: 'versus', ...config }, players, spectators: id === 'viewer' ? [{ id, name: '觀眾', connected: true }] : [], state: visibleTetris(state) } });
  return w;
}

test('對戰左右鍵長按自行連續送出移動，放開後停止', async () => {
  const w = viewer('host', tetrisGame.createState(players, {}));
  try {
  w.eval('window.sentMoves=[];WebSocket.prototype.send=message=>sentMoves.push(JSON.parse(message))');
  const press = key => w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true }));
  const release = key => w.document.body.dispatchEvent(new w.KeyboardEvent('keyup', { key, bubbles: true }));
  press('ArrowLeft');
  assert.equal(w.sentMoves.length, 1);
  press('ArrowLeft');
  assert.equal(w.sentMoves.length, 1);
  await delay(155);
  assert.ok(w.sentMoves.length >= 2);
  assert.ok(w.sentMoves.every(message => message.type === 'tetris.move' && message.direction === 'left'));
  release('ArrowLeft');
  const stopped = w.sentMoves.length;
  await delay(80);
  assert.equal(w.sentMoves.length, stopped);
  press('ArrowRight');
  assert.equal(w.sentMoves.at(-1).direction, 'right');
  w.dispatchEvent(new w.Event('blur'));
  const blurred = w.sentMoves.length;
  await delay(150);
  assert.equal(w.sentMoves.length, blurred);
  } finally { w.close(); }
});

test('對戰觸控左右長按快速連續送出移動，放開後停止', async () => {
  const w = viewer('host', tetrisGame.createState(players, {}));
  try {
    w.eval('window.sentMoves=[];WebSocket.prototype.send=message=>sentMoves.push(JSON.parse(message))');
    w.document.body.setPointerCapture = () => {};
    w.document.body.hasPointerCapture = () => false;
    const pointer = (target, type) => {
      const event = new w.Event(type, { bubbles: true });
      Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 1 } });
      target.dispatchEvent(event);
    };
    pointer(w.document.querySelector('[data-tetris-control="right"]'), 'pointerdown');
    assert.equal(w.sentMoves.length, 1);
    await delay(155);
    assert.ok(w.sentMoves.length >= 2);
    assert.ok(w.sentMoves.every(message => message.type === 'tetris.move' && message.direction === 'right'));
    pointer(w.document.body, 'pointerup');
    const stopped = w.sentMoves.length;
    await delay(80);
    assert.equal(w.sentMoves.length, stopped);
  } finally { w.close(); }
});

test('雙方集氣依玩家分開更新，滿格門檻符合攻擊模式', () => {
  for (const [config, goal] of [[{}, 4], [{ attackEnabled: false }, 4], [{ attackMode: 'auto' }, 16]]) {
    for (const id of ['host', 'guest', 'viewer']) {
      const state = tetrisGame.createState(players, config);
      state.players.host.attackPoints = goal - 1;
      state.players.guest.attackPoints = 1;
      const w = viewer(id, state, config);
      const charge = playerId => w.document.querySelector('.tetris-charge[data-player-id="' + playerId + '"]');
      assert.equal(charge('host').getAttribute('aria-valuenow'), String(goal - 1));
      assert.equal(charge('host').getAttribute('aria-valuemax'), String(goal));
      assert.equal(charge('guest').getAttribute('aria-valuenow'), '1');
      assert.equal(charge('host').textContent, '');
      const before = visibleTetris(state), after = structuredClone(state);
      after.players.host.attackPoints = goal;
      w.deliver({ type: 'tetris.patch', sequence: 1, patch: diffTetris(before, visibleTetris(after), ['host']) });
      assert.equal(charge('host').querySelector('i').style.width, '100%');
      assert.equal(charge('guest').getAttribute('aria-valuenow'), '1');
      const next = structuredClone(after);
      next.players.guest.attackPoints = 0;
      w.deliver({ type: 'tetris.patch', sequence: 2, patch: diffTetris(visibleTetris(after), visibleTetris(next), ['guest']) });
      assert.equal(charge('host').getAttribute('aria-valuenow'), String(goal));
      assert.equal(charge('guest').querySelector('i').style.width, '0%');
      w.close();
    }
  }
});

test('自動首攻狀態同步後，集氣門檻改為八點', () => {
  const state = tetrisGame.createState(players, { attackMode: 'auto' });
  const w = viewer('host', state, { attackMode: 'auto' });
  const before = visibleTetris(state);
  state.players.host.autoFirstAttackQueued = true;
  state.players.host.attackQueue.push(4);
  const patch = diffTetris(before, visibleTetris(state), ['host']);
  assert.equal(patch.players.host.autoFirstAttackQueued, true);
  w.deliver({ type: 'tetris.patch', sequence: 1, patch });
  assert.equal(w.document.querySelector('.tetris-charge[data-player-id="host"]').getAttribute('aria-valuemax'), '8');
  assert.equal(w.document.querySelector('.tetris-charge[data-player-id="guest"]').getAttribute('aria-valuemax'), '16');
  w.close();
});

test('對戰資訊只顯示圖示與數字，投降按鈕位於右上角', () => {
  const state = tetrisGame.createState(players, { attackMode: 'auto' });
  const w = viewer('host', state, { attackMode: 'auto' });
  const style = w.document.createElement('style'); style.textContent = styles; w.document.head.append(style);
  try {
    const stats = w.document.querySelector('.tetris-side-stats section[data-player-id="host"] .tetris-stat-list');
    assert.equal(stats.querySelectorAll('.tetris-stat').length, 4);
    assert.equal(stats.textContent.includes('消行'), false);
    assert.equal(stats.textContent.includes('攻擊點'), false);
    assert.equal(w.document.querySelector('.tetris-rule'), null);
    assert.equal(w.document.querySelector('#tetris-sync-status'), null);
    assert.equal(w.document.querySelector('.tetris-charge').textContent, '');
    const surrender = w.document.querySelector('.tetris-surrender');
    assert.equal(surrender.parentElement, w.document.querySelector('.tetris-shell>header'));
    assert.equal(w.getComputedStyle(surrender).position, 'absolute');
    assert.equal(w.getComputedStyle(surrender).right, '8px');
  } finally { w.close(); }
});

test('雙方自己的更新只移動自己的大棋盤與預覽，對手更新只移動小棋盤', () => {
  for (const id of ['host', 'guest']) {
    const state = tetrisGame.createState(players, {}), w = viewer(id, state);
    const ownBoard = w.document.querySelector('.tetris-touch-board>.tetris-board');
    const opponentBoard = w.document.querySelector('.tetris-rail-opponent .tetris-board');
    const ownControl = w.document.querySelector('.tetris-player.you [data-tetris-control="left"]');
    const ownPreview = w.document.querySelector('.tetris-rail-preview .tetris-next');
    assert.ok(ownBoard && opponentBoard && ownPreview);
    const ownBefore = painted(ownBoard), opponentBefore = painted(opponentBoard), previewBefore = ownPreview.innerHTML;
    const before = visibleTetris(state), after = structuredClone(state);
    after.players[id].active.x++;
    after.players[id].next[0] = after.players[id].next[0] === 'I' ? 'O' : 'I';
    w.deliver({ type: 'tetris.patch', sequence: 1, patch: diffTetris(before, visibleTetris(after), [id]) });
    assert.notDeepEqual(painted(ownBoard), ownBefore);
    assert.deepEqual(painted(opponentBoard), opponentBefore);
    assert.notEqual(w.document.querySelector('.tetris-rail-preview .tetris-next').innerHTML, previewBefore);
    assert.equal(w.document.querySelector('.tetris-player.you [data-tetris-control="left"]'), ownControl);
    const other = id === 'host' ? 'guest' : 'host', next = structuredClone(after);
    next.players[other].active.x++;
    next.players[other].board[19][0] = 'I';
    const ownAfter = painted(ownBoard);
    w.deliver({ type: 'tetris.patch', sequence: 2, patch: diffTetris(visibleTetris(after), visibleTetris(next), [other]) });
    assert.deepEqual(painted(ownBoard), ownAfter);
    assert.notDeepEqual(painted(opponentBoard), opponentBefore);
    assert.match(opponentBoard.children[190].className, /piece-I/);
    w.close();
  }
});

test('觀眾的兩個棋盤依玩家身分各自更新', () => {
  const state = tetrisGame.createState(players, {}), w = viewer('viewer', state);
  const boards = w.document.querySelectorAll('.tetris-players>.tetris-player .tetris-board');
  assert.equal(boards.length, 2);
  const before = visibleTetris(state), after = structuredClone(state), first = painted(boards[0]), second = painted(boards[1]);
  after.players.host.active.x++;
  w.deliver({ type: 'tetris.patch', sequence: 1, patch: diffTetris(before, visibleTetris(after), ['host']) });
  assert.notDeepEqual(painted(boards[0]), first);
  assert.deepEqual(painted(boards[1]), second);
  const next = structuredClone(after);
  next.players.guest.active.x++;
  w.deliver({ type: 'tetris.patch', sequence: 2, patch: diffTetris(visibleTetris(after), visibleTetris(next), ['guest']) });
  assert.notDeepEqual(painted(boards[1]), second);
  w.close();
});

test('自己、對手與觀眾都能看到消行動畫階段', () => {
  for (const id of ['host', 'guest', 'viewer']) {
    const state = tetrisGame.createState(players, {}), w = viewer(id, state);
    const board = id === 'host' ? w.document.querySelector('.tetris-touch-board>.tetris-board')
      : id === 'guest' ? w.document.querySelector('.tetris-rail-opponent .tetris-board')
      : w.document.querySelector('.tetris-players>.tetris-player .tetris-board');
    const before = visibleTetris(state), clearing = structuredClone(state);
    clearing.players.host.board[19].fill('I');
    clearing.players.host.clearing = { rows: [19], endsAt: Date.now() + 200 };
    w.deliver({ type: 'tetris.patch', sequence: 1, patch: diffTetris(before, visibleTetris(clearing), ['host']) });
    assert.equal(board.querySelectorAll('.tetris-cell.clearing').length, 10);
    const cleared = structuredClone(clearing);
    cleared.players.host.board[19].fill(null);
    delete cleared.players.host.clearing;
    w.deliver({ type: 'tetris.patch', sequence: 2, patch: diffTetris(visibleTetris(clearing), visibleTetris(cleared), ['host']) });
    assert.equal(board.querySelectorAll('.tetris-cell.clearing').length, 0);
    w.close();
  }
});

test('被攻擊方在方塊落定前看見精簡來襲數字，取消後歸零', () => {
  const state = tetrisGame.createState(players, {}), w = viewer('host', state);
  const ownBoard = w.document.querySelector('.tetris-player.you .tetris-touch-board');
  assert.equal(ownBoard.querySelector('.tetris-incoming-warning'), null);
  const before = visibleTetris(state), attacked = structuredClone(state);
  attacked.players.host.incoming.push({ lines: 2, fromPlayerId: 'guest' });
  w.deliver({ type: 'tetris.patch', sequence: 1, patch: diffTetris(before, visibleTetris(attacked), ['host']) });
  const indicator = w.document.querySelector('.tetris-side-stats section[data-player-id="host"] .tetris-stat.incoming');
  assert.equal(indicator.querySelector('strong').textContent, '2');
  assert.match(indicator.getAttribute('aria-label'), /落定後生效/);
  assert.equal(indicator.classList.contains('is-active'), true);
  assert.equal(ownBoard.querySelector('.tetris-incoming-warning'), null);
  const canceled = structuredClone(attacked);
  canceled.players.host.incoming = [];
  w.deliver({ type: 'tetris.patch', sequence: 2, patch: diffTetris(visibleTetris(attacked), visibleTetris(canceled), ['host']) });
  const clearedIndicator = w.document.querySelector('.tetris-side-stats section[data-player-id="host"] .tetris-stat.incoming');
  assert.equal(clearedIndicator.querySelector('strong').textContent, '0');
  assert.equal(clearedIndicator.classList.contains('is-active'), false);
  w.close();
});

test('攻擊按鈕每排需要四點並顯示成本', () => {
  const state = tetrisGame.createState(players, {}), w = viewer('host', state);
  const one = w.document.querySelector('[data-action="tetris-attack"][data-lines="1"]');
  const two = w.document.querySelector('[data-action="tetris-attack"][data-lines="2"]');
  assert.match(one.textContent, /4 點/);
  assert.match(two.textContent, /8 點/);
  assert.equal(one.disabled, true);
  const before = visibleTetris(state), seven = structuredClone(state);
  seven.players.host.attackPoints = 7;
  w.deliver({ type: 'tetris.patch', sequence: 1, patch: diffTetris(before, visibleTetris(seven), ['host']) });
  assert.equal(one.disabled, false);
  assert.equal(two.disabled, true);
  const eight = structuredClone(seven);
  eight.players.host.attackPoints = 8;
  w.deliver({ type: 'tetris.patch', sequence: 2, patch: diffTetris(visibleTetris(seven), visibleTetris(eight), ['host']) });
  assert.equal(two.disabled, false);
  w.close();
});

test('對戰斷線期間仍照遊戲時間完成消行與鎖定', () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const { room } = rooms.create('tetris', '甲', {});
  rooms.addPlayer(room, '乙');
  room.players.forEach(player => { player.connected = true; });
  rooms.start(room);
  const state = room.state, first = state.players[room.players[0].id];
  first.clearing = { rows: [19], endsAt: 1150 };
  const second = state.players[room.players[1].id];
  second.lockAt = 1500;
  room.players[1].connected = false;
  rooms.tick(room, 1000);
  assert.equal(first.clearing.endsAt, 1150);
  assert.equal(second.lockAt, 1500);
  rooms.tick(room, 1600);
  assert.equal(first.clearing, undefined);
  assert.equal(second.lost, true);
  assert.equal(room.state.pausedAt, undefined);
  assert.equal(room.status, 'finished');
});

test('自己即時收到差異，對手 250 毫秒內收到合併結果', async () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const { room, reconnectToken } = rooms.create('tetris', '甲', {});
  const realtime = createRealtime(rooms);
  const server = createServer();
  server.on('upgrade', (request, socket, head) => realtime.upgrade(request, socket, head));
  const sockets = [], messages = [[], []];
  try {
    server.listen(0, '127.0.0.1');
    await within(once(server, 'listening'), 'server listen');
    const url = `ws://127.0.0.1:${server.address().port}/ws/${room.id}`;
    for (let index = 0; index < 2; index++) {
      const socket = new WebSocket(url); sockets.push(socket);
      socket.on('message', raw => messages[index].push(JSON.parse(raw.toString())));
      await within(once(socket, 'open'), 'socket open');
      socket.send(JSON.stringify({ type: 'join', name: index ? '乙' : '甲', ...(index ? {} : { reconnectToken }) }));
      await delay(25);
      assert.equal(messages[index].some(message => message.type === 'error'), false);
      assert.equal(messages[index].findLast(message => message.type === 'snapshot').payload.status, 'lobby');
    }
    sockets[0].send(JSON.stringify({ type: 'host.start' }));
    await delay(40);
    const initial = messages[1].findLast(message => message.type === 'snapshot');
    const guestToken = messages[1].find(message => message.type === 'joined').reconnectToken;
    assert.equal(initial.payload.status, 'playing');
    assert.equal('bag' in initial.payload.state.players[room.hostId], false);
    assert.ok(Array.isArray(initial.payload.prediction.player.bag));
    assert.equal(initial.payload.prediction.acknowledged, 0);
    messages[0].length = 0; messages[1].length = 0;
    for (let index = 0; index < 3; index++) sockets[0].send(JSON.stringify({ type: 'tetris.move', direction: 'right' }));
    await delay(90);
    assert.equal(messages[0].filter(message => message.type === 'tetris.patch').length, 3);
    assert.equal(messages[1].filter(message => message.type === 'tetris.patch').length, 0);
    await delay(220);
    const patches = messages[1].filter(message => message.type === 'tetris.patch');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].patch.players[room.hostId].active.x, initial.payload.state.players[room.hostId].active.x + 3);
    assert.ok(JSON.stringify(patches[0]).length < JSON.stringify(initial).length / 4);
    sockets[1].close();
    await within(once(sockets[1], 'close'), 'guest disconnect');
    await delay(70);
    assert.equal(room.state.pausedAt, undefined);
    assert.ok(room.disconnectedAt.has(room.players[1].id));
    messages[1].length = 0;
    const replacement = new WebSocket(url); sockets.push(replacement);
    replacement.on('message', raw => messages[1].push(JSON.parse(raw.toString())));
    await within(once(replacement, 'open'), 'guest reconnect');
    replacement.send(JSON.stringify({ type: 'join', name: '乙', reconnectToken: guestToken }));
    await delay(100);
    const restored = messages[1].find(message => message.type === 'snapshot' && message.payload.status === 'playing');
    assert.equal(restored.payload.state.players[room.hostId].active.x, initial.payload.state.players[room.hostId].active.x + 3);
    assert.equal(room.state.pausedAt, undefined);
    assert.equal(room.disconnectedAt.has(room.players[1].id), false);
    const spectatorMessages = []; messages[2] = spectatorMessages;
    const spectator = new WebSocket(url); sockets.push(spectator);
    spectator.on('message', raw => spectatorMessages.push(JSON.parse(raw.toString())));
    await within(once(spectator, 'open'), 'spectator open');
    spectator.send(JSON.stringify({ type: 'join', name: '觀眾' }));
    await delay(30);
    assert.equal(spectatorMessages.findLast(message => message.type === 'snapshot').payload.spectators.length, 1);
    messages.forEach(items => { items.length = 0; });
    sockets[0].send(JSON.stringify({ type: 'tetris.move', direction: 'left' }));
    await delay(80);
    assert.equal(messages[0].filter(message => message.type === 'tetris.patch').length, 1);
    assert.equal(spectatorMessages.filter(message => message.type === 'tetris.patch').length, 0);
    await delay(220);
    assert.equal(spectatorMessages.filter(message => message.type === 'tetris.patch').length, 1);
    const beforeNumbered = room.state.players[room.hostId].active.x;
    const numbered = JSON.stringify({ type: 'tetris.move', direction: 'right', clientSequence: 1, clientTime: Date.now() });
    sockets[0].send(numbered);
    sockets[0].send(numbered);
    await delay(70);
    assert.equal(room.state.players[room.hostId].active.x, beforeNumbered + 1);
    assert.equal(messages[0].filter(message => message.type === 'tetris.ack').length, 2);
    assert.equal(messages[0].findLast(message => message.type === 'tetris.ack').authority.acknowledged, 1);
    sockets[0].send(JSON.stringify({ type: 'tetris.attack', lines: 99, clientSequence: 2 }));
    await delay(25);
    assert.equal(messages[0].findLast(message => message.type === 'tetris.ack').rejected, true);
    sockets[0].send(JSON.stringify({ type: 'tetris.move', direction: 'left', clientSequence: 3 }));
    await delay(40);
    assert.equal(room.state.players[room.hostId].active.x, beforeNumbered);
    assert.equal(messages[0].findLast(message => message.type === 'tetris.ack').authority.acknowledged, 3);
    sockets[0].close();
    await within(once(sockets[0], 'close'), 'host disconnect');
    room.state.players[room.hostId].incoming.push({ lines: 1, fromPlayerId: room.players[1].id });
    const hostReplacement = new WebSocket(url); sockets.push(hostReplacement);
    hostReplacement.on('message', raw => messages[0].push(JSON.parse(raw.toString())));
    await within(once(hostReplacement, 'open'), 'host reconnect');
    hostReplacement.send(JSON.stringify({ type: 'join', name: '甲', reconnectToken, tetrisPendingThrough: 4 }));
    await delay(35);
    hostReplacement.send(JSON.stringify({ type: 'tetris.hardDrop', clientSequence: 4 }));
    await delay(35);
    assert.equal(room.state.players[room.hostId].incoming.length, 1);
    hostReplacement.send(JSON.stringify({ type: 'tetris.hardDrop', clientSequence: 5 }));
    await delay(35);
    assert.equal(room.state.players[room.hostId].incoming.length, 0);
  } finally {
    realtime.close();
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections();
    server.close();
  }
});
