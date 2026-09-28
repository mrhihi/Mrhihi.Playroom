import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { JSDOM } from 'jsdom';
import { createDatabase } from '../dist/db.js';
import { registerHttp } from '../dist/http.js';
import { RoomService } from '../dist/rooms.js';
import { clientScript } from '../dist/ui/client.js';

test('歷程 API 顯示俄羅斯方塊房間的即時狀態', async () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const app = Fastify();
  registerHttp(app, rooms);
  const room = rooms.create('tetris', '局主', {}).room;
  const history = async () => {
    const response = await app.inject('/api/history?localIds=' + room.id);
    assert.equal(response.statusCode, 200);
    return response.json()[0].status;
  };
  assert.equal(await history(), 'lobby');
  rooms.addPlayer(room, '對手');
  rooms.start(room);
  assert.equal(await history(), 'playing');
  room.state.draw = true;
  rooms.finish(room);
  assert.equal(await history(), 'finished');
  await app.close();
});

test('房間清單隨房況更新，標示密碼並排除單人、離線與關閉觀戰房間', async () => {
  const rooms = new RoomService(createDatabase(':memory:'));
  const app = Fastify();
  registerHttp(app, rooms);
  const list = async () => {
    const response = await app.inject('/api/tetris/open-rooms');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    return response.json();
  };
  const open = rooms.create('tetris', '公開局主', {}).room;
  const hidden = rooms.create('tetris', '秘密局主', { attackMode: 'auto' }, 'secret').room;
  const solo = rooms.create('tetris', '單人局主', { mode: 'solo' }).room;
  const offline = rooms.create('tetris', '離線局主', {}).room;
  const closed = rooms.create('tetris', '不開放觀戰', { allowSpectators: false, attackEnabled: false }).room;
  for (const room of [open, hidden, solo, closed]) room.players[0].connected = true;
  assert.deepEqual((await list()).versus.map(row => [row.id, row.hasPassword]), [[open.id, false], [hidden.id, true], [closed.id, false]]);
  assert.deepEqual((await list()).versus.map(row => [row.attackEnabled, row.attackMode]), [[true, 'manual'], [true, 'auto'], [false, 'manual']]);
  assert.deepEqual((await list()).spectate, []);
  rooms.addPlayer(open, '公開對手');
  assert.equal((await list()).versus.some(row => row.id === open.id), false);
  rooms.start(open);
  rooms.addPlayer(open, '觀眾');
  assert.deepEqual((await list()).spectate, [{ id: open.id, players: ['公開局主', '公開對手'], spectatorCount: 1, hasPassword: false, attackEnabled: true, attackMode: 'manual' }]);
  rooms.addPlayer(hidden, '秘密對手');
  rooms.start(hidden);
  assert.deepEqual((await list()).spectate.map(row => [row.id, row.hasPassword, row.attackMode]), [[open.id, false, 'manual'], [hidden.id, true, 'auto']]);
  rooms.addPlayer(closed, '對手');
  rooms.start(closed);
  assert.equal((await list()).spectate.some(row => row.id === closed.id), false);
  open.state.draw = true;
  rooms.finish(open);
  assert.deepEqual((await list()).spectate.map(row => row.id), [hidden.id]);
  hidden.state.draw = true;
  rooms.finish(hidden);
  assert.deepEqual((await list()).spectate, []);
  rooms.delete(closed.id);
  assert.deepEqual((await list()).versus, []);
  assert.equal(offline.players[0].connected, false);
});

test('遊戲大廳頂部顯示可重連的進行中房間', async () => {
  const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/games/tetris', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.localStorage.setItem('playroom:rooms', JSON.stringify(['playing1', 'finished1', 'unknown1']));
  w.localStorage.setItem('playroom:token:playing1', JSON.stringify('reconnect-token'));
  let history = [
    { id: 'playing1', game: 'tetris', status: 'playing' },
    { id: 'finished1', game: 'tetris', status: 'finished' },
    { id: 'unknown1', game: 'tetris', status: 'playing' },
  ];
  w.fetch = async url => ({ ok: true, json: async () => String(url).includes('/api/history') ? history : String(url).includes('/api/tetris/leaderboard') ? { entries: [] } : { versus: [], spectate: [] } });
  w.WebSocket = class { static OPEN = 1; static CLOSED = 3; send() {} close() {} };
  w.eval(clientScript);
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  await settle();
  const entrance = w.document.querySelector('.tetris-active-rooms');
  assert.ok(entrance);
  assert.ok(entrance.compareDocumentPosition(w.document.querySelector('.setup')) & w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(entrance.querySelectorAll('a').length, 1);
  assert.equal(entrance.querySelector('a').getAttribute('href'), '/rooms/playing1');
  assert.match(entrance.textContent, /返回遊戲/);
  history = history.map(item => ({ ...item, status: 'finished' }));
  await w.eval("renderGameLobby('tetris')");
  assert.equal(w.document.querySelector('.tetris-active-rooms'), null);
  w.dispatchEvent(new w.Event('pagehide'));
  w.close();
});

test('大廳分開顯示對戰與觀戰，重新整理可更新內容', async () => {
  const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/games/tetris', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let openRooms = { versus: [{ id: 'room123', players: ['甲'], hasPassword: false, attackEnabled: false }, { id: 'locked123', players: ['丁'], hasPassword: true, attackMode: 'auto' }], spectate: [{ id: 'room456', players: ['乙', '丙'], spectatorCount: 2, hasPassword: true }] };
  let fail = false;
  w.fetch = async url => {
    if (fail && String(url).includes('/api/tetris/open-rooms')) throw Error('offline');
    return { ok: true, json: async () => String(url).includes('/api/history') ? [] : String(url).includes('/api/tetris/leaderboard') ? { entries: [] } : openRooms };
  };
  w.WebSocket = class { static OPEN = 1; static CLOSED = 3; send() {} close() {} };
  w.eval(clientScript);
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  await settle();
  assert.match(w.document.querySelector('[data-open-versus]').textContent, /甲/);
  assert.match(w.document.querySelector('[data-open-spectate]').textContent, /乙 vs 丙/);
  assert.equal(w.document.querySelector('[data-open-versus] a').getAttribute('href'), '/rooms/room123');
  assert.equal(w.document.querySelector('[data-open-spectate] a').getAttribute('href'), '/rooms/room456');
  assert.doesNotMatch(w.document.querySelector('[data-open-versus] a').textContent, /🔒|需要密碼/);
  assert.match(w.document.querySelector('[data-open-versus] a[href="/rooms/locked123"]').textContent, /🔒 需要密碼/);
  assert.match(w.document.querySelector('[data-open-spectate] a').textContent, /🔒 需要密碼/);
  assert.match(w.document.querySelector('[data-open-versus] a').textContent, /不攻擊/);
  assert.match(w.document.querySelector('[data-open-versus] a[href="/rooms/locked123"]').textContent, /自動攻擊/);
  assert.match(w.document.querySelector('[data-open-spectate] a').textContent, /手動攻擊/);
  openRooms = { versus: [], spectate: [] };
  w.document.querySelector('[data-open-rooms-refresh]').click();
  await settle();
  assert.match(w.document.querySelector('[data-open-versus]').textContent, /目前沒有人等待對戰/);
  assert.match(w.document.querySelector('[data-open-spectate]').textContent, /目前沒有開放觀戰/);
  fail = true;
  w.document.querySelector('[data-open-rooms-refresh]').click();
  await settle();
  assert.ok(w.document.querySelector('[data-open-rooms-retry]'));
  fail = false;
  w.document.querySelector('[data-open-rooms-retry]').click();
  await settle();
  assert.match(w.document.querySelector('[data-open-versus]').textContent, /目前沒有人等待對戰/);
  w.dispatchEvent(new w.Event('pagehide'));
  w.close();
});
