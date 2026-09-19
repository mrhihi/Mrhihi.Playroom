import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { ClientMessage } from './shared/types.js';
import { RoomService } from './rooms.js';

const send = (ws: WebSocket, value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };

export function createRealtime(rooms: RoomService) {
  const wss = new WebSocketServer({ noServer: true });
  const lastPong = new WeakMap<WebSocket, number>();
  const heartbeat = setInterval(() => { const now = Date.now(); for (const client of wss.clients) { if (now - (lastPong.get(client) ?? 0) > 45_000) client.terminate(); else client.ping(); } }, 15_000);
  wss.on('close', () => clearInterval(heartbeat));
  rooms.onFinish(room => { for (const [playerId, client] of room.clients) send(client, { type: 'snapshot', payload: rooms.snapshot(room, playerId) }); });
  wss.on('connection', (ws, request) => {
    const id = new URL(request.url ?? '/', 'http://localhost').pathname.split('/').pop() ?? '';
    const room = rooms.rooms.get(id); if (!room) return ws.close();
    let playerId = '';
    lastPong.set(ws, Date.now());
    ws.on('pong', () => lastPong.set(ws, Date.now()));
    const broadcast = () => { for (const [id, client] of room.clients) send(client, { type: 'snapshot', payload: rooms.snapshot(room, id) }); };
    ws.on('message', raw => {
      let message: ClientMessage; try { message = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: '無效訊息' }); }
      if (message.type === 'join') { const joined = rooms.addPlayer(room, message.name, message.reconnectToken); playerId = joined.id; const previous = room.clients.get(playerId); room.clients.set(playerId, ws); if (previous && previous !== ws) previous.close(4001, '連線已由新連線取代'); if (joined.reconnected) rooms.addSystemMessage(room, room.players.find(player => player.id === playerId)?.name + ' 已回到房間'); send(ws, { type: 'joined', playerId, reconnectToken: joined.reconnectToken, reconnected: joined.reconnected }); broadcast(); return; }
      if (!playerId) return send(ws, { type: 'error', message: '請先加入房間' });
      const player = room.players.find(candidate => candidate.id === playerId); if (!player) return;
      try {
        if (message.type === 'player.rename') rooms.renamePlayer(room, playerId, message.name);
        else if (message.type === 'chat.send') rooms.addMessage(room, player, message.text);
        else if (message.type === 'host.start' && playerId === room.hostId) rooms.start(room, message.config);
        else if (room.status === 'playing') rooms.apply(room, playerId, message);
        else throw new Error('遊戲尚未開始或已結束');
        broadcast();
      } catch (error) { send(ws, { type: 'error', message: error instanceof Error ? error.message : '操作失敗' }); }
    });
    ws.on('close', () => { if (!playerId || room.clients.get(playerId) !== ws || !rooms.rooms.has(room.id)) return; const player = room.players.find(candidate => candidate.id === playerId); room.clients.delete(playerId); if (player?.connected) { player.connected = false; rooms.addSystemMessage(room, player.name + ' 已離開房間'); } broadcast(); });
  });
  return { upgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) { if (request.url?.startsWith('/ws/')) wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request)); else socket.destroy(); } };
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
