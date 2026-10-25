import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { ClientMessage } from './shared/types.js';
import { RoomService } from './rooms.js';
import type { TetrisState } from './shared/types.js';
import { diffTetris, visibleTetris, type VisibleTetris } from './tetris-wire.js';
import { holdTetrisIncoming } from './games/tetris.js';

const send = (ws: WebSocket, value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };

export function createRealtime(rooms: RoomService) {
  const wss = new WebSocketServer({ noServer: true });
  const lastPong = new WeakMap<WebSocket, number>();
  const tetrisSync = new WeakMap<WebSocket, { sent: VisibleTetris; sequence: number; timer?: NodeJS.Timeout }>();
  const replayThrough = new WeakMap<import('./rooms.js').Room, Map<string, number>>();
  const tetrisInputs = new WeakMap<import('./rooms.js').Room, { state: unknown; sequences: Map<string, number> }>();
  const sequences = (room: import('./rooms.js').Room) => {
    let record = tetrisInputs.get(room);
    if (!record || record.state !== room.state) { record = { state: room.state, sequences: new Map() }; tetrisInputs.set(room, record); }
    return record.sequences;
  };
  const inputSequence = (room: import('./rooms.js').Room, id: string) => sequences(room).get(id) ?? 0;
  const finishReplay = (room: import('./rooms.js').Room, id: string) => {
    const pending = replayThrough.get(room)?.get(id);
    if (pending === undefined || inputSequence(room, id) < pending) return;
    replayThrough.get(room)?.delete(id);
    holdTetrisIncoming(room.state as TetrisState, id, false);
  };
  const authority = (room: import('./rooms.js').Room, id: string) => {
    const state = room.state as TetrisState;
    return state.players[id] ? { player: structuredClone(state.players[id]), nextFallAt: state.nextFallAt, serverNow: Date.now(), acknowledged: inputSequence(room, id) } : undefined;
  };
  const full = (room: import('./rooms.js').Room, id: string, client: WebSocket) => {
    const previous = tetrisSync.get(client);
    if (previous?.timer) clearTimeout(previous.timer);
    const snapshot = rooms.snapshot(room, id);
    if (room.game === 'tetris' && (room.state as TetrisState).players) {
      const state = visibleTetris(room.state as TetrisState);
      snapshot.state = state;
      tetrisSync.set(client, { sent: state, sequence: 0 });
      (snapshot as typeof snapshot & { prediction?: unknown }).prediction = authority(room, id);
    } else tetrisSync.delete(client);
    send(client, { type: 'snapshot', payload: snapshot });
  };
  const broadcast = (room: import('./rooms.js').Room) => {
    if (room.game !== 'tetris' || room.status !== 'playing') {
      for (const [id, client] of room.clients) full(room, id, client);
      return;
    }
    const current = visibleTetris(room.state as TetrisState);
    for (const [id, client] of room.clients) {
      const sync = tetrisSync.get(client);
      if (!sync) { full(room, id, client); continue; }
      const isPlayer = Boolean(current.players[id]);
      const opponentIds = Object.keys(current.players).filter(playerId => playerId !== id);
      const clearingIds = Object.keys(current.players).filter(playerId =>
        JSON.stringify(sync.sent.players[playerId]?.clearing) !== JSON.stringify(current.players[playerId]?.clearing));
      const immediateIds = isPlayer ? [id, ...clearingIds.filter(playerId => playerId !== id)] : clearingIds;
      const immediate = diffTetris(sync.sent, current, immediateIds, true);
      if (immediate) {
        send(client, { type: 'tetris.patch', sequence: ++sync.sequence, patch: immediate, authority: isPlayer ? authority(room, id) : undefined });
        for (const playerId of immediateIds) sync.sent.players[playerId] = current.players[playerId];
        for (const key of ['pausedAt', 'pausedPlayerId', 'winnerId', 'draw', 'gameOver'] as const) {
          if (current[key] === undefined) delete sync.sent[key];
          else (sync.sent as unknown as Record<string, unknown>)[key] = current[key];
        }
      }
      if (!diffTetris(sync.sent, current, isPlayer ? opponentIds : Object.keys(current.players))) continue;
      if (!sync.timer) sync.timer = setTimeout(() => {
        sync.timer = undefined;
        if (client.readyState !== WebSocket.OPEN || room.status !== 'playing') return;
        if (client.bufferedAmount > 64 * 1024) { sync.timer = setTimeout(() => { sync.timer = undefined; broadcast(room); }, 250); return; }
        const latest = visibleTetris(room.state as TetrisState);
        const ids = isPlayer ? opponentIds : Object.keys(latest.players);
        const patch = diffTetris(sync.sent, latest, ids);
        if (!patch) return;
        send(client, { type: 'tetris.patch', sequence: ++sync.sequence, patch });
        for (const playerId of ids) sync.sent.players[playerId] = latest.players[playerId];
      }, 250);
    }
  };
  const heartbeat = setInterval(() => { const now = Date.now(); for (const client of wss.clients) { if (now - (lastPong.get(client) ?? 0) > 45_000) client.terminate(); else client.ping(); } }, 15_000);
  let clockScheduled = false, clockClosed = false;
  const gameClock = setInterval(() => {
    if (clockScheduled) return;
    clockScheduled = true;
    setImmediate(() => {
      clockScheduled = false;
      if (clockClosed) return;
      for (const room of rooms.rooms.values()) if (rooms.tick(room)) broadcast(room);
    });
  }, 50);
  wss.on('close', () => { clockClosed = true; clearInterval(heartbeat); clearInterval(gameClock); for (const client of wss.clients) { const timer = tetrisSync.get(client)?.timer; if (timer) clearTimeout(timer); } });
  rooms.onFinish(broadcast);
  wss.on('connection', (ws, request) => {
    const id = new URL(request.url ?? '/', 'http://localhost').pathname.split('/').pop() ?? '';
    const room = rooms.rooms.get(id); if (!room) return ws.close();
    let playerId = '';
    lastPong.set(ws, Date.now());
    ws.on('pong', () => lastPong.set(ws, Date.now()));
    ws.on('message', raw => {
      let message: ClientMessage; try { message = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: '無效訊息' }); }
      if (message.type === 'join') { try { const joined = rooms.addPlayer(room, message.name, message.reconnectToken, message.observer, { identityId: message.identityId, deviceInfo: message.deviceInfo }); playerId = joined.id; const previous = room.clients.get(playerId); room.clients.set(playerId, ws); if (previous && previous !== ws) previous.close(4001, '連線已由新連線取代'); if (room.game === 'tetris' && room.status === 'playing' && (room.state as TetrisState).players[playerId]) { const through = Number.isSafeInteger(message.tetrisPendingThrough) ? message.tetrisPendingThrough! : 0; if (through > inputSequence(room, playerId)) { const pending = replayThrough.get(room) ?? new Map<string, number>(); pending.set(playerId, through); replayThrough.set(room, pending); holdTetrisIncoming(room.state as TetrisState, playerId, true); } else { replayThrough.get(room)?.delete(playerId); holdTetrisIncoming(room.state as TetrisState, playerId, false); } } const member = [...room.players, ...room.spectators].find(player => player.id === playerId); if (joined.reconnected) rooms.addSystemMessage(room, (member?.name ?? '玩家') + ' 已回到房間'); send(ws, { type: 'joined', playerId, reconnectToken: joined.reconnectToken, reconnected: joined.reconnected, role: joined.role }); for (const [memberId, client] of room.clients) full(room, memberId, client); } catch (error) { send(ws, { type: 'error', message: error instanceof Error ? error.message : '無法加入房間' }); } return; }
      if (!playerId) return send(ws, { type: 'error', message: '請先加入房間' });
      const player = [...room.players, ...room.spectators].find(candidate => candidate.id === playerId); if (!player) return;
      try {
        const tetrisAction = room.game === 'tetris' && message.type.startsWith('tetris.');
        const clientSequence = 'clientSequence' in message ? message.clientSequence : undefined;
        const clientTime = 'clientTime' in message ? message.clientTime : undefined;
        const numbered = tetrisAction && Number.isSafeInteger(clientSequence) && (clientSequence as number) > 0;
        if (numbered) {
          const sequence = clientSequence as number;
          const expected = inputSequence(room, playerId) + 1;
          if (sequence < expected) { send(ws, { type: 'tetris.ack', authority: authority(room, playerId) }); return; }
          if (sequence > expected) { send(ws, { type: 'tetris.resend', expected }); return; }
        }
        if (message.type === 'player.rename') rooms.renamePlayer(room, playerId, message.name);
        else if (message.type === 'chat.send') rooms.addMessage(room, player, message.text);
        else if (message.type === 'host.start' && playerId === room.hostId) rooms.start(room, message.config);
        else if (room.status === 'playing') {
          if (numbered && typeof clientTime === 'number' && Number.isFinite(clientTime) && room.game === 'tetris') {
            const now = Date.now();
            const actionAt = Math.max(now - 30_000, Math.min(now, clientTime));
            if ((room.state as TetrisState).nextFallAt < now - 100) rooms.tick(room, actionAt);
            if (room.status !== 'playing') throw new Error('本局已結束');
            rooms.apply(room, playerId, message, actionAt);
          } else rooms.apply(room, playerId, message);
        }
        else throw new Error('遊戲尚未開始或已結束');
        if (numbered) {
          sequences(room).set(playerId, clientSequence as number);
          finishReplay(room, playerId);
          send(ws, { type: 'tetris.ack', authority: authority(room, playerId) });
        }
        if (room.game === 'tetris' && (message.type === 'player.rename' || message.type === 'chat.send' || message.type === 'host.start')) {
          for (const [memberId, client] of room.clients) full(room, memberId, client);
        } else broadcast(room);
      } catch (error) {
        if (room.game === 'tetris' && 'clientSequence' in message && Number.isSafeInteger(message.clientSequence)
          && message.clientSequence === inputSequence(room, playerId) + 1) {
          sequences(room).set(playerId, message.clientSequence as number);
          finishReplay(room, playerId);
          send(ws, { type: 'tetris.ack', rejected: true, authority: authority(room, playerId) });
        }
        send(ws, { type: 'error', message: error instanceof Error ? error.message : '操作失敗' });
      }
    });
    ws.on('close', () => { const timer = tetrisSync.get(ws)?.timer; if (timer) clearTimeout(timer); if (!playerId || room.clients.get(playerId) !== ws || !rooms.rooms.has(room.id)) return; const player = [...room.players, ...room.spectators].find(candidate => candidate.id === playerId); room.clients.delete(playerId); if (player?.connected) { player.connected = false; if (room.game === 'tetris' && room.status === 'playing') { room.disconnectedAt?.set(playerId, Date.now()); if ((room.state as TetrisState).players[playerId]) holdTetrisIncoming(room.state as TetrisState, playerId, true); } rooms.addSystemMessage(room, player.name + ' 已離開房間'); } for (const [memberId, client] of room.clients) full(room, memberId, client); });
  });
  return { upgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) { if (request.url?.startsWith('/ws/')) wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request)); else socket.destroy(); }, close() { clockClosed = true; clearInterval(heartbeat); clearInterval(gameClock); for (const client of wss.clients) client.terminate(); wss.close(); } };
}

export function createChatRealtime(rooms: RoomService) {
  const wss = new WebSocketServer({ noServer: true }); const members = new Map<WebSocket, { id: string; type: string; name: string; memberId: string; order: number }>(); const memberOrders = new Map<string, number>(); let nextMemberOrder = 0;
  const publish = (id: string, type: string, message: unknown) => { for (const [client, channel] of members) if (channel.id === id && channel.type === type) send(client, message); };
  rooms.onSystemMessage(message => publish(message.roomId, 'room', { type: 'chat.message', channel: { id: message.roomId, type: 'room' }, message }));
  const uniqueMemberName = (id: string, type: string, requested: string, memberId: string) => { const base = requested.trim().slice(0, 24) || '訪客'; const used = [...members.values()].filter(member => member.id === id && member.type === type && member.memberId !== memberId).map(member => member.name); if (!used.includes(base)) return base; for (let index = 2; index < 1000; index++) { const candidate = base.slice(0, 20) + ' #' + index; if (!used.includes(candidate)) return candidate; } return base.slice(0, 18) + ' #' + Math.random().toString(36).slice(2, 6); };
  const publishMembers = (id: string, type: string) => publish(id, type, { type: 'chat.members', channel: { id, type }, members: [...members.values()].filter(member => member.id === id && member.type === type).sort((left, right) => left.order - right.order).map(member => ({ id: member.memberId, name: member.name })) });
  wss.on('connection', ws => ws.on('message', raw => { let message: any; try { message = JSON.parse(raw.toString()); } catch { return; } if (message.type === 'chat.join') { const channel = message.channel ?? {}; if (!['platform', 'game', 'room'].includes(channel.type) || !String(channel.id ?? '').match(/^[\w-]{1,64}$/)) return send(ws, { type: 'error', message: '無效頻道' }); const memberId = String(message.memberId ?? '').match(/^[\w-]{8,80}$/) ? String(message.memberId) : 'guest-' + Date.now() + '-' + Math.random(); const key = channel.type + ':' + channel.id + ':' + memberId; const order = memberOrders.get(key) ?? (++nextMemberOrder); memberOrders.set(key, order); for (const [client, member] of members) if (member.id === String(channel.id) && member.type === channel.type && member.memberId === memberId) { members.delete(client); client.close(); } const joined = { id: String(channel.id), type: channel.type, name: String(message.name ?? '訪客').trim().slice(0, 24) || '訪客', memberId, order }; members.set(ws, joined); joined.name = uniqueMemberName(joined.id, joined.type, joined.name, joined.memberId); send(ws, { type: 'chat.history', channel, messages: rooms.channelMessages(joined.id, joined.type) }); return publishMembers(joined.id, joined.type); } if (message.type === 'chat.rename') { const channel = members.get(ws); const name = String(message.name ?? '').trim().slice(0, 24); if (channel && name) { channel.name = uniqueMemberName(channel.id, channel.type, name, channel.memberId); publishMembers(channel.id, channel.type); } return; } if (message.type === 'chat.send') { const channel = members.get(ws); if (!channel) return; const row = rooms.addChannelMessage(channel.id, channel.type, channel.name, String(message.text ?? '')); if (row) publish(channel.id, channel.type, { type: 'chat.message', channel: { id: channel.id, type: channel.type }, message: row }); } }));
  wss.on('connection', ws => ws.on('close', () => { const channel = members.get(ws); members.delete(ws); if (channel) publishMembers(channel.id, channel.type); }));
  return { upgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) { wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request)); } };
}
