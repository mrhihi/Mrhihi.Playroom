import type { TetrisPiece, TetrisPlayerState, TetrisState } from '../shared/types.js';
import type { GameModule } from './contract.js';

const W = 10, H = 20, ATTACK_COST_PER_LINE = 4, CLEAR_ANIMATION_MS = 200, LOCK_DELAY_MS = 300, TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
const heldIncoming = new WeakMap<TetrisState, Set<string>>();
export const holdTetrisIncoming = (state: TetrisState, id: string, held: boolean) => {
  let ids = heldIncoming.get(state);
  if (!ids) { ids = new Set(); heldIncoming.set(state, ids); }
  if (held) ids.add(id); else ids.delete(id);
};
const SHAPES: Record<string, number[][][]> = {
  I: [[[0,1],[1,1],[2,1],[3,1]], [[2,0],[2,1],[2,2],[2,3]], [[0,2],[1,2],[2,2],[3,2]], [[1,0],[1,1],[1,2],[1,3]]],
  O: [[[1,0],[2,0],[1,1],[2,1]]],
  T: [[[1,0],[0,1],[1,1],[2,1]], [[1,0],[1,1],[2,1],[1,2]], [[0,1],[1,1],[2,1],[1,2]], [[1,0],[0,1],[1,1],[1,2]]],
  J: [[[0,0],[0,1],[1,1],[2,1]], [[1,0],[2,0],[1,1],[1,2]], [[0,1],[1,1],[2,1],[2,2]], [[1,0],[1,1],[0,2],[1,2]]],
  L: [[[2,0],[0,1],[1,1],[2,1]], [[1,0],[1,1],[1,2],[2,2]], [[0,1],[1,1],[2,1],[0,2]], [[0,0],[1,0],[1,1],[1,2]]],
  S: [[[1,0],[2,0],[0,1],[1,1]], [[1,0],[1,1],[2,1],[2,2]]],
  Z: [[[0,0],[1,0],[1,1],[2,1]], [[2,0],[1,1],[2,1],[1,2]]],
};
const board = () => Array.from({ length: H }, () => Array<string | null>(W).fill(null));
const pieceRandom = (player: TetrisPlayerState) => {
  if (player.pieceRandomState === undefined) return Math.random();
  player.pieceRandomState = (player.pieceRandomState + 0x6D2B79F5) >>> 0;
  let value = player.pieceRandomState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
};
const garbageRandom = (player: TetrisPlayerState) => {
  if (player.garbageRandomState === undefined) return Math.random();
  player.garbageRandomState = (Math.imul(player.garbageRandomState, 1664525) + 1013904223) >>> 0;
  return player.garbageRandomState / 0x100000000;
};
const shuffle = <T>(items: T[], random: () => number) => { const copy = [...items]; for (let i = copy.length - 1; i; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; };
const cells = (piece: TetrisPiece) => SHAPES[piece.type][piece.rotation % SHAPES[piece.type].length].map(([x, y]) => [piece.x + x, piece.y + y] as const);
const valid = (player: TetrisPlayerState, piece: TetrisPiece) => cells(piece).every(([x, y]) => x >= 0 && x < W && y < H && (y < 0 || !player.board[y][x]));
const interval = (state: TetrisState) => { const level = Math.max(...Object.values(state.players).map(p => Math.floor(p.lines / 10) + 1)); return Math.max(50, 1000 * (0.8 - .007 * (level - 1)) ** (level - 1)); };
const refill = (player: TetrisPlayerState) => { while (player.next.length < 4) { if (!player.bag.length) player.bag = shuffle(TYPES, () => pieceRandom(player)); player.next.push(player.bag.pop()!); } };
const spawn = (player: TetrisPlayerState) => { player.swapUsed = false; delete player.lockAt; delete player.selfClearRows; refill(player); player.active = { type: player.next.shift()!, rotation: 0, x: 3, y: -1 }; refill(player); if (!valid(player, player.active)) player.lost = true; };
const queueAttack = (state: TetrisState, id: string, lines: number) => {
  const player = state.players[id]; let left = lines;
  for (const incoming of player.incoming) { const used = Math.min(left, incoming.lines); incoming.lines -= used; left -= used; if (!left) break; }
  player.incoming = player.incoming.filter(item => item.lines > 0);
  if (left) { const opponent = Object.keys(state.players).find(other => other !== id); if (opponent) state.players[opponent].incoming.push({ lines: left, fromPlayerId: id }); }
};
const autoQueueAttack = (state: TetrisState, id: string) => {
  if (state.mode !== 'versus' || state.attackEnabled === false || state.attackMode !== 'auto') return;
  const player = state.players[id];
  while (player.attackQueue.length < 4) {
    if (!player.autoFirstAttackQueued) {
      if (player.attackPoints < 16) break;
      player.attackPoints -= 16;
      player.attackQueue.push(4);
      player.autoFirstAttackQueued = true;
    } else {
      const lines = Math.min(4, Math.floor(player.attackPoints / ATTACK_COST_PER_LINE));
      if (lines < 2) break;
      player.attackPoints -= lines * ATTACK_COST_PER_LINE;
      player.attackQueue.push(lines);
    }
  }
};
const releaseAttack = (state: TetrisState, id: string) => { if (state.mode !== 'versus' || state.attackEnabled === false) return; const player = state.players[id]; const lines = player.attackQueue.shift(); if (lines) queueAttack(state, id, lines); autoQueueAttack(state, id); };
const addGarbage = (player: TetrisPlayerState, lines: number) => {
  for (let i = 0; i < lines; i++) {
    if (player.board[0].some(Boolean)) player.lost = true;
    const gap = Math.floor(garbageRandom(player) * W);
    player.board.shift();
    player.board.push(Array.from({ length: W }, (_, x) => x === gap ? null : 'G'));
  }
};
const collapseRows = (player: TetrisPlayerState, selected: number[]) => {
  const rows = new Set(selected);
  player.board = player.board.filter((_, index) => !rows.has(index));
  while (player.board.length < H) player.board.unshift(Array<string | null>(W).fill(null));
};
const settlePiece = (state: TetrisState, id: string) => {
  const player = state.players[id];
  if (state.mode === 'versus' && player.incoming.length && !heldIncoming.get(state)?.has(id)) {
    const lines = player.incoming.reduce((sum, item) => sum + item.lines, 0);
    player.incoming = [];
    addGarbage(player, lines);
  }
  if (!player.lost) spawn(player);
  resolveLoss(state);
};
const finishNaturalClear = (state: TetrisState, id: string, cleared: number, now: number) => {
  const player = state.players[id];
  const level = Math.floor(player.lines / 10) + 1;
  player.lines += cleared;
  if (state.mode === 'solo') player.score += ([0, 100, 300, 500, 800][cleared] ?? 0) * level;
  else player.attackPoints += ([0, 0, 1, 2, 4][cleared] ?? 0);
  const requested = player.selfClearRows;
  if (requested) {
    delete player.selfClearRows;
    const rows = player.board.flatMap((row, index) => row.some(Boolean) ? [index] : []).reverse().slice(0, requested);
    player.attackPoints += (requested - rows.length) * ATTACK_COST_PER_LINE;
    autoQueueAttack(state, id);
    if (rows.length) { player.clearing = { rows, endsAt: now + CLEAR_ANIMATION_MS, kind: 'self' }; return; }
  }
  autoQueueAttack(state, id);
  settlePiece(state, id);
};
const finishLock = (state: TetrisState, id: string, now: number) => {
  const player = state.players[id], phase = player.clearing!, rows = phase.rows;
  collapseRows(player, rows);
  delete player.clearing;
  if (phase.kind === 'self') settlePiece(state, id);
  else finishNaturalClear(state, id, rows.length, now);
};
const lock = (state: TetrisState, id: string, now: number) => {
  const player = state.players[id];
  for (const [x, y] of cells(player.active)) {
    if (y < 0) {
      player.lost = true;
      resolveLoss(state);
      return;
    }
    player.board[y][x] = player.active.type;
  }
  const rows = player.board.flatMap((row, index) => row.every(Boolean) ? [index] : []);
  if (rows.length) player.clearing = { rows, endsAt: now + CLEAR_ANIMATION_MS };
  else finishNaturalClear(state, id, 0, now);
};
const down = (state: TetrisState, id: string, now: number) => {
  const player = state.players[id]; if (player.lost || player.clearing) return;
  const next = { ...player.active, y: player.active.y + 1 };
  if (valid(player, next)) { player.active = next; player.lockAt = valid(player, { ...next, y: next.y + 1 }) ? undefined : now + LOCK_DELAY_MS; releaseAttack(state, id); }
  else if (player.lockAt !== undefined && now >= player.lockAt) lock(state, id, now);
  else if (player.lockAt === undefined) player.lockAt = now + LOCK_DELAY_MS;
};
const resolveLoss = (state: TetrisState) => {
  const lost = Object.entries(state.players).filter(([, player]) => player.lost).map(([id]) => id);
  if (!lost.length) return;
  if (state.mode === 'solo') { state.gameOver = true; return; }
  if (lost.length === 2) state.draw = true;
  else state.winnerId = Object.keys(state.players).find(id => id !== lost[0]);
};

/** Advance every due game event in time order. Pass one id for local prediction. */
export const advanceTetris = (state: TetrisState, now: number, onlyPlayerId?: string) => {
  if (state.winnerId || state.draw || state.gameOver || state.pausedAt) return false;
  const ids = onlyPlayerId ? [onlyPlayerId] : Object.keys(state.players);
  let changed = false;
  for (let steps = 0; steps < 2000; steps++) {
    let due = state.nextFallAt;
    for (const id of ids) {
      const player = state.players[id];
      if (!player || player.lost) continue;
      if (player.clearing) due = Math.min(due, player.clearing.endsAt);
      else if (player.lockAt !== undefined) due = Math.min(due, player.lockAt);
    }
    if (due > now) break;
    for (const id of ids) {
      const player = state.players[id];
      if (player?.clearing && player.clearing.endsAt <= due) { finishLock(state, id, due); changed = true; }
    }
    for (const id of ids) {
      const player = state.players[id];
      if (player && !player.lost && !player.clearing && player.lockAt !== undefined && player.lockAt <= due) { lock(state, id, due); changed = true; }
    }
    if (state.nextFallAt <= due) {
      if (!state.winnerId && !state.draw && !state.gameOver) for (const id of ids) if (state.players[id]) down(state, id, due);
      state.nextFallAt = due + interval(state);
      changed = true;
    }
    if (state.winnerId || state.draw || state.gameOver) break;
  }
  return changed;
};

export const tetrisGame: GameModule<TetrisState> = {
  type: 'tetris',
  createState(players, config) {
    const mode = config.mode === 'solo' ? 'solo' : 'versus';
    if (players.length !== (mode === 'solo' ? 1 : 2)) throw new Error(mode === 'solo' ? '單人俄羅斯方塊需要一位玩家' : '俄羅斯方塊需要剛好兩位玩家');
    const state: TetrisState = { mode, ...(mode === 'versus' ? { attackEnabled: config.attackEnabled !== false, attackMode: config.attackMode === 'auto' ? 'auto' as const : 'manual' as const } : {}), players: {}, nextFallAt: Date.now() + 1000 };
    const pieceRandomState = mode === 'versus' ? Math.floor(Math.random() * 0x100000000) : undefined;
    for (const player of players) { const value: TetrisPlayerState = { board: board(), active: { type: 'T', rotation: 0, x: 3, y: -1 }, next: [], bag: [], ...(pieceRandomState === undefined ? {} : { pieceRandomState, garbageRandomState: Math.floor(Math.random() * 0x100000000) }), lines: 0, score: 0, attackPoints: 0, attackQueue: [], incoming: [] }; state.players[player.id] = value; spawn(value); }
    return state;
  },
  apply(state, { actorId, message, now = Date.now() }) {
    const player = state.players[actorId]; if (!player || player.lost || state.winnerId || state.draw || state.gameOver) throw new Error('目前不能操作');
    if (message.type === 'tetris.surrender') { player.lost = true; resolveLoss(state); return { eventType: 'tetris.surrender', payload: { playerId: actorId }, finished: true }; }
    if (message.type === 'tetris.attack') { if (state.mode === 'solo') throw new Error('單人模式沒有攻擊'); if (state.attackEnabled === false) throw new Error('本局未開啟攻擊'); if (state.attackMode === 'auto') throw new Error('自動攻擊模式不能手動攻擊'); const lines = Math.floor(message.lines); if (lines < 1 || lines > 4) throw new Error('攻擊必須為 1 到 4 排'); if (player.attackQueue.length >= 4) throw new Error('攻擊佇列已滿'); const cost = lines * ATTACK_COST_PER_LINE; if (player.attackPoints < cost) throw new Error('攻擊點數不足'); player.attackPoints -= cost; player.attackQueue.push(lines); return { eventType: 'tetris.attackQueued', payload: { playerId: actorId, lines } }; }
    if (message.type === 'tetris.selfClear') { if (state.mode !== 'versus') throw new Error('單人模式不能使用自清'); if (!Number.isInteger(message.lines) || message.lines < 1 || message.lines > 4) throw new Error('自清必須為 1 到 4 排'); if (player.selfClearRows || player.clearing) throw new Error('目前方塊已預約自清或正在消行'); const cost = message.lines * ATTACK_COST_PER_LINE; if (player.attackPoints < cost) throw new Error('攻擊點數不足'); player.attackPoints -= cost; player.selfClearRows = message.lines; return { eventType: 'tetris.selfClearQueued', payload: { playerId: actorId, lines: message.lines } }; }
    if (player.clearing) return { eventType: message.type, payload: { playerId: actorId } };
    if (message.type === 'tetris.move') { if (message.direction === 'down') down(state, actorId, now); else { const next = { ...player.active, x: player.active.x + (message.direction === 'left' ? -1 : 1) }; if (valid(player, next)) { player.active = next; if (valid(player, { ...next, y: next.y + 1 })) delete player.lockAt; } } }
    else if (message.type === 'tetris.swap') {
      const candidate = { ...player.active, type: player.next[0], rotation: 0 };
      if (!player.swapUsed && valid(player, candidate)) {
        player.next[0] = player.active.type;
        player.active = candidate;
        player.swapUsed = true;
        if (valid(player, { ...candidate, y: candidate.y + 1 })) delete player.lockAt;
      }
    }
    else if (message.type === 'tetris.rotate') { const rotations = SHAPES[player.active.type].length; const candidate = { ...player.active, rotation: (player.active.rotation + 1) % rotations }; for (const kick of [0, -1, 1, -2, 2]) { const next = { ...candidate, x: candidate.x + kick }; if (valid(player, next)) { player.active = next; if (valid(player, { ...next, y: next.y + 1 })) delete player.lockAt; break; } } }
    else if (message.type === 'tetris.hardDrop') { let next = { ...player.active }; while (valid(player, { ...next, y: next.y + 1 })) next = { ...next, y: next.y + 1 }; player.active = next; releaseAttack(state, actorId); lock(state, actorId, now); }
    else throw new Error('無效的俄羅斯方塊操作');
    return { eventType: message.type, payload: { playerId: actorId }, finished: Boolean(state.winnerId || state.draw || state.gameOver) };
  },
  tick(state, { now }) {
    const changed = advanceTetris(state, now);
    return changed ? { eventType: 'tetris.tick', payload: {}, finished: Boolean(state.winnerId || state.draw || state.gameOver) } : undefined;
  },
  publicState(state) { return structuredClone(state); },
};
