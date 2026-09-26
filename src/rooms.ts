import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { ClientMessage, GameType, Player, PollState, RoomSnapshot } from './shared/types.js';
import type { DatabasePort } from './db.js';
import { getGame } from './games/index.js';

export type Room = RoomSnapshot & {
  clients: Map<string, import('ws').WebSocket>;
  tokens: Map<string, string>;
  passwordHash: string | null;
  spectators: Player[];
  memberRoles: Map<string, 'player' | 'spectator'>;
  gameTimer?: NodeJS.Timeout;
};

const alphabet = '23456789abcdefghijkmnpqrstuvwxyz';
const makeRoomId = () => Array.from(randomBytes(7), byte => alphabet[byte % alphabet.length]).join('');
const hashPassword = (value: string) => scryptSync(value, 'playroom-salt', 32).toString('hex');
const matchesHash = (value: string, expected: string) => {
  const actual = Buffer.from(hashPassword(value), 'hex'), saved = Buffer.from(expected, 'hex');
  return actual.length === saved.length && timingSafeEqual(actual, saved);
};
const uniqueName = (requested: string, used: string[]) => { const base = requested.trim().slice(0, 24) || '玩家'; if (!used.includes(base)) return base; for (let index = 2; index < 1000; index++) { const candidate = base.slice(0, 20) + ' #' + index; if (!used.includes(candidate)) return candidate; } return base.slice(0, 18) + ' #' + randomBytes(2).toString('hex'); };

export class RoomService {
  readonly rooms = new Map<string, Room>();
  private readonly accessTokens = new Map<string, { roomId: string; expires: number }>();
  private readonly finishListeners = new Set<(room: Room) => void>();
  private readonly systemMessageListeners = new Set<(message: { roomId: string; playerName: string; text: string; at: number; id: string }) => void>();

  constructor(private readonly db: DatabasePort) {}

  create(game: GameType, hostName: string, config: Record<string, unknown>, password?: string, hostObserver = false) {
    const id = makeRoomId();
    const hostId = randomUUID();
    const host = { id: hostId, name: uniqueName(hostName, []), connected: false };
    const observerHost = game === 'poll' && hostObserver;
    const room: Room = {
      id,
      game,
      status: 'lobby',
      hostId,
      players: observerHost ? [] : [host],
      spectators: observerHost ? [host] : [],
      memberRoles: new Map([[hostId, observerHost ? 'spectator' : 'player']]),
      config: game === 'tetris' ? { ...config, mode: config.mode === 'solo' ? 'solo' : 'versus', allowSpectators: config.allowSpectators !== false } : config,
      state: {},
      messages: [],
      stateVersion: 0,
      clients: new Map(),
      tokens: new Map(),
      passwordHash: password ? hashPassword(password) : null,
    };

    this.rooms.set(id, room);
    const ownerDeleteToken = randomBytes(32).toString('base64url');
    this.db.saveSession(room, room.passwordHash, hashPassword(ownerDeleteToken));
    return { room, hostId, reconnectToken: this.issueToken(room, hostId), ownerDeleteToken, accessToken: password ? this.grantAccess(id) : '' };
  }

  issueToken(room: Room, playerId: string) {
    const token = randomBytes(18).toString('base64url');
    room.tokens.set(token, playerId);
    return token;
  }

  snapshot(room: Room, viewerId?: string): RoomSnapshot {
    let state = getGame(room.game).publicState(room.state);
    if (room.game === 'poll' && viewerId && room.status === 'playing') {
      const pollState = room.state as PollState;
      const myVoteOptionId = !pollState.revealed ? pollState.votes[viewerId] : undefined;
      if (myVoteOptionId) state = { ...(state as object), myVoteOptionId };
    }
    if (room.game === 'old-maid' && viewerId && room.status === 'playing') {
      const privateState = structuredClone(room.state) as { hands: Record<string, Array<{ joker?: boolean; rank: string; suit: string }>>; lastDraw?: { actorId: string; targetPlayerId: string; cardIndex: number; card: { joker?: boolean; rank: string; suit: string }; at: number } };
      for (const [playerId, hand] of Object.entries(privateState.hands)) if (playerId !== viewerId) for (const card of hand) { card.rank = '?'; card.suit = '🂠'; card.joker = false; }
      if (privateState.lastDraw && privateState.lastDraw.actorId !== viewerId) { privateState.lastDraw.card.rank = '?'; privateState.lastDraw.card.suit = '🂠'; privateState.lastDraw.card.joker = false; }
      state = privateState;
    }
    return {
      id: room.id,
      game: room.game,
      status: room.status,
      hostId: room.hostId,
      players: room.players,
      spectators: room.spectators,
      config: room.config,
      state,
      messages: room.messages,
      stateVersion: room.stateVersion,
    };
  }

  start(room: Room, config: Record<string, unknown> = {}) {
    room.config = { ...room.config, ...config };
    const game = getGame(room.game);
    if (room.game === 'tetris' && room.players.length !== (room.config.mode === 'solo' ? 1 : 2)) throw new Error(room.config.mode === 'solo' ? '單人俄羅斯方塊需要一位玩家才能開始' : '俄羅斯方塊需要兩位玩家才能開始');
    room.state = game.createState(room.players, room.config);
    room.status = 'playing';
    room.stateVersion++;
    this.db.saveEvent(room.id, room.stateVersion, 'game.started', room.config);

    const delay = game.finishDelayMs?.(room.state);
    if (delay) room.gameTimer = setTimeout(() => this.finish(room), delay);
  }

  finish(room: Room) {
    if (room.status !== 'playing') return;
    getGame(room.game).finish?.(room.state);
    room.status = 'finished';
    room.stateVersion++;
    this.db.saveEvent(room.id, room.stateVersion, 'game.finished', room.state);
    this.db.finishSession(this.snapshot(room), this.resultSummary(room));
    for (const listener of this.finishListeners) listener(room);
  }

  resultSummary(room: Room) {
    const state = room.state as Record<string, any>;
    if (room.game === 'race') {
      const runners = state.runners ?? room.players;
      const ranked = state.mode === 'random'
        ? (state.finalRanking ?? []).map((id: string) => runners.find((runner: { id: string }) => runner.id === id)).filter(Boolean)
        : [...runners].sort((a: { id: string }, b: { id: string }) => (state.distances?.[b.id] ?? 0) - (state.distances?.[a.id] ?? 0));
      return { winnerId: ranked[0]?.id, rankings: ranked.map((runner: { id: string; name: string; virtual?: boolean }, index: number) => ({ playerId: runner.id, name: runner.name, virtual: Boolean(runner.virtual), score: state.mode === 'random' ? index + 1 : state.distances?.[runner.id] ?? 0 })) };
    }
    if (room.game === 'poll') return { options: (state.options ?? []).map((option: { id: string; label: string }) => ({ ...option, votes: Object.values(state.votes ?? {}).filter(value => value === option.id).length })) };
    if (room.game === 'tetris') {
      if (state.mode === 'solo') { const player = room.players[0], value = state.players?.[player?.id]; return { playerId: player?.id, playerName: player?.name, score: value?.score ?? 0, lines: value?.lines ?? 0, level: Math.floor((value?.lines ?? 0) / 10) + 1 }; }
      return { winnerId: state.winnerId, winnerName: room.players.find(player => player.id === state.winnerId)?.name, draw: Boolean(state.draw) };
    }
    return { loserId: state.loserId, loserName: room.players.find(player => player.id === state.loserId)?.name };
  }

  addPlayer(room: Room, name: string, token?: string, observer = false) {
    const existingId = token ? room.tokens.get(token) : undefined;
    const id = existingId ?? randomUUID();
    let reconnected = false;

    if (existingId) {
      const player = [...room.players, ...room.spectators].find(candidate => candidate.id === id);
      if (player) { reconnected = !player.connected; player.connected = true; }
    } else {
      const people = [...room.players, ...room.spectators];
      if (room.game === 'poll' && observer) {
        room.spectators.push({ id, name: uniqueName(name, people.map(player => player.name)), connected: true });
        room.memberRoles.set(id, 'spectator');
      } else if (room.game === 'tetris' && (room.status === 'playing' || room.config.mode === 'solo')) {
        if (room.config.allowSpectators === false) throw new Error('本局未開放觀戰');
        room.spectators.push({ id, name: uniqueName(name, people.map(player => player.name)), connected: true });
        room.memberRoles.set(id, 'spectator');
      } else {
        if (room.game === 'tetris' && room.players.length >= 2) throw new Error('俄羅斯方塊大廳僅限兩位玩家');
        room.players.push({ id, name: uniqueName(name, people.map(player => player.name)), connected: true });
        room.memberRoles.set(id, 'player');
      }
    }

    return { id, reconnectToken: existingId ? token! : this.issueToken(room, id), reconnected, role: room.memberRoles.get(id) ?? 'player' };
  }

  renamePlayer(room: Room, playerId: string, name: string) {
    const player = [...room.players, ...room.spectators].find(candidate => candidate.id === playerId);
    const nextName = name.trim().slice(0, 24);
    if (!player || !nextName) throw new Error('暱名不可為空白');
    player.name = uniqueName(nextName, [...room.players, ...room.spectators].filter(candidate => candidate.id !== playerId).map(candidate => candidate.name));
    room.stateVersion++;
    this.db.saveEvent(room.id, room.stateVersion, 'player.rename', { playerId, name: nextName });
  }

  addMessage(room: Room, player: Player, text: string) {
    const row = {
      id: randomUUID(),
      channelId: room.id,
      channelType: 'room',
      playerName: player.name,
      text: text.trim().slice(0, 300),
      at: Date.now(),
    };
    if (!row.text) return;

    room.messages.push({ id: row.id, playerName: row.playerName, text: row.text, at: row.at });
    this.db.saveMessage(row);
  }

  addSystemMessage(room: Room, text: string) {
    const row = this.addChannelMessage(room.id, 'room', '系統', text);
    if (!row) return;
    room.messages.push(row);
    for (const listener of this.systemMessageListeners) listener({ ...row, roomId: room.id });
  }

  apply(room: Room, playerId: string, message: ClientMessage) {
    if (room.memberRoles.get(playerId) === 'spectator') throw new Error('觀眾不能操作遊戲');
    const result = getGame(room.game).apply(room.state, {
      actorId: playerId,
      hostId: room.hostId,
      players: room.players,
      message,
    });

    room.stateVersion++;
    this.db.saveEvent(room.id, room.stateVersion, result.eventType, result.payload);
    if (result.finished) this.finish(room);
  }

  tick(room: Room, now = Date.now()) {
    if (room.status !== 'playing') return false;
    if (room.game === 'tetris') {
      const disconnected = room.players.find(player => !player.connected);
      const state = room.state as { pausedAt?: number; pausedPlayerId?: string; nextFallAt: number; winnerId?: string };
      if (disconnected) {
        if (!state.pausedAt) { state.pausedAt = now; state.pausedPlayerId = disconnected.id; room.stateVersion++; return true; }
        if (now - state.pausedAt >= 30_000) { state.winnerId = room.players.find(player => player.id !== disconnected.id)?.id; this.finish(room); return true; }
        return false;
      }
      if (state.pausedAt) { state.nextFallAt += now - state.pausedAt; delete state.pausedAt; delete state.pausedPlayerId; room.stateVersion++; return true; }
    }
    const result = getGame(room.game).tick?.(room.state, { hostId: room.hostId, players: room.players, now });
    if (!result) return false;
    room.stateVersion++;
    if (result.finished) this.finish(room);
    return true;
  }

  getStored(id: string) { return this.db.getSession(id); }
  restartTetris(id: string, reconnectToken?: string) {
    const room = this.rooms.get(id);
    if (!room || room.game !== 'tetris' || room.status !== 'finished') return 'missing' as const;
    if (!reconnectToken || room.tokens.get(reconnectToken) !== room.hostId) return 'forbidden' as const;
    this.start(room);
    return 'started' as const;
  }
  onFinish(listener: (room: Room) => void) { this.finishListeners.add(listener); return () => this.finishListeners.delete(listener); }
  onSystemMessage(listener: (message: { roomId: string; playerName: string; text: string; at: number; id: string }) => void) { this.systemMessageListeners.add(listener); return () => this.systemMessageListeners.delete(listener); }
  listAll() { return this.db.listSessions(); }
  delete(id: string, reason = '房間已由管理者刪除') {
    const room = this.rooms.get(id);
    if (room) {
      if (room.gameTimer) clearTimeout(room.gameTimer);
      for (const client of room.clients.values()) client.close(1008, reason);
      this.rooms.delete(id);
    }
    this.db.deleteSession(id);
  }
  deleteAsOwner(id: string, token?: string) {
    const session = this.db.getSession(id);
    if (!session) return 'missing' as const;
    if (!token || !session.owner_delete_token_hash || !matchesHash(token, session.owner_delete_token_hash)) return 'forbidden' as const;
    this.delete(id, '房間已由房主刪除');
    return 'deleted' as const;
  }
  history(ids: string[]) { return this.db.getHistory(ids); }
  roomMessages(id: string) { return this.db.getMessages(id, 'room'); }
  events(id: string) { return this.db.getEvents(id); }
  saveTemplate(row: { id: string; game: GameType; config: Record<string, unknown>; shareCode?: string }) { this.db.saveTemplate(row); }
  getTemplate(id: string) { return this.db.getTemplate(id); }
  deleteTemplate(id: string) { return this.db.deleteTemplate(id); }
  channelMessages(id: string, type: string) { return this.db.getMessages(id, type); }
  addChannelMessage(channelId: string, channelType: string, playerName: string, text: string) {
    const clean = text.trim().slice(0, 300); if (!clean) return undefined;
    const row = { id: randomUUID(), channelId, channelType, playerName: playerName.trim().slice(0, 24) || '訪客', text: clean, at: Date.now() };
    this.db.saveMessage(row); return { id: row.id, playerName: row.playerName, text: row.text, at: row.at };
  }
  verifyPassword(id: string, password?: string) {
    const session = this.db.getSession(id);
    if (!session) return undefined;
    if (!session.password_hash) return '';
    if (!password || hashPassword(password) !== session.password_hash) return null;
    const token = randomBytes(18).toString('base64url');
    this.accessTokens.set(token, { roomId: id, expires: Date.now() + 30 * 60_000 });
    return token;
  }
  canReconnect(id: string, token?: string) { const room = this.rooms.get(id); return Boolean(token && room?.tokens.has(token)); }
  canAccess(id: string, token?: string, reconnectToken?: string) {
    const session = this.db.getSession(id);
    if (!session) return false;
    if (!session.password_hash) return true;
    const access = token ? this.accessTokens.get(token) : undefined;
    return Boolean((access && access.roomId === id && access.expires > Date.now()) || this.canReconnect(id, reconnectToken));
  }
  private grantAccess(roomId: string) { const token = randomBytes(18).toString('base64url'); this.accessTokens.set(token, { roomId, expires: Date.now() + 30 * 60_000 }); return token; }
}
