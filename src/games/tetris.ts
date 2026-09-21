import type { TetrisPiece, TetrisPlayerState, TetrisState } from '../shared/types.js';
import type { GameModule } from './contract.js';

const W = 10, H = 20, TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
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
const shuffle = <T>(items: T[]) => { const copy = [...items]; for (let i = copy.length - 1; i; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; };
const cells = (piece: TetrisPiece) => SHAPES[piece.type][piece.rotation % SHAPES[piece.type].length].map(([x, y]) => [piece.x + x, piece.y + y] as const);
const valid = (player: TetrisPlayerState, piece: TetrisPiece) => cells(piece).every(([x, y]) => x >= 0 && x < W && y < H && (y < 0 || !player.board[y][x]));
const interval = (state: TetrisState) => { const level = Math.max(...Object.values(state.players).map(p => Math.floor(p.lines / 10) + 1)); return Math.max(50, 1000 * (0.8 - .007 * (level - 1)) ** (level - 1)); };
const refill = (player: TetrisPlayerState) => { while (player.next.length < 4) { if (!player.bag.length) player.bag = shuffle(TYPES); player.next.push(player.bag.pop()!); } };
const spawn = (player: TetrisPlayerState) => { player.lockAt = undefined; refill(player); player.active = { type: player.next.shift()!, rotation: 0, x: 3, y: -1 }; refill(player); if (!valid(player, player.active)) player.lost = true; };
const queueAttack = (state: TetrisState, id: string, lines: number, now: number) => {
  const player = state.players[id]; let left = lines;
  for (const incoming of player.incoming.sort((a, b) => a.dueAt - b.dueAt)) { const used = Math.min(left, incoming.lines); incoming.lines -= used; left -= used; if (!left) break; }
  player.incoming = player.incoming.filter(item => item.lines > 0);
  if (left) { const opponent = Object.keys(state.players).find(other => other !== id)!; state.players[opponent].incoming.push({ lines: left, dueAt: now + 1500, fromPlayerId: id }); }
};
const releaseAttack = (state: TetrisState, id: string, now: number) => { const player = state.players[id]; const lines = player.attackQueue.shift(); if (lines) queueAttack(state, id, lines, now); };
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
  const cleared = player.board.filter(row => row.every(Boolean)).length;
  player.board = player.board.filter(row => !row.every(Boolean));
  while (player.board.length < H) player.board.unshift(Array<string | null>(W).fill(null));
  player.lines += cleared; player.attackPoints += cleared; spawn(player);
  resolveLoss(state);
};
const down = (state: TetrisState, id: string, now: number) => {
  const player = state.players[id]; if (player.lost) return;
  const next = { ...player.active, y: player.active.y + 1 };
  if (valid(player, next)) { player.active = next; player.lockAt = undefined; releaseAttack(state, id, now); }
  else if (player.lockAt && now >= player.lockAt) lock(state, id, now);
  else player.lockAt = now + 500;
};
const addGarbage = (player: TetrisPlayerState, lines: number) => {
  for (let i = 0; i < lines; i++) {
    // Garbage pushing an occupied top row out of the playfield is a top-out,
    // not a row that may silently disappear.
    if (player.board[0].some(Boolean)) player.lost = true;
    const gap = Math.floor(Math.random() * W);
    player.board.shift();
    player.board.push(Array.from({ length: W }, (_, x) => x === gap ? null : 'G'));
    player.active.y--;
  }
  // A piece may temporarily touch the ceiling while it is still movable. Only
  // a block actually pushed out of the board (checked above) is a top-out.
  if (!valid(player, player.active)) player.lost = true;
};
const resolveLoss = (state: TetrisState) => { const lost = Object.entries(state.players).filter(([, player]) => player.lost).map(([id]) => id); if (lost.length === 2) state.draw = true; else if (lost.length === 1) state.winnerId = Object.keys(state.players).find(id => id !== lost[0]); };

export const tetrisGame: GameModule<TetrisState> = {
  type: 'tetris',
  createState(players) {
    if (players.length !== 2) throw new Error('俄羅斯方塊需要剛好兩位玩家');
    const state: TetrisState = { players: {}, nextFallAt: Date.now() + 1000 };
    for (const player of players) { const value: TetrisPlayerState = { board: board(), active: { type: 'T', rotation: 0, x: 3, y: -1 }, next: [], bag: [], lines: 0, attackPoints: 0, attackQueue: [], incoming: [] }; state.players[player.id] = value; spawn(value); }
    return state;
  },
  apply(state, { actorId, message }) {
    const player = state.players[actorId]; if (!player || player.lost || state.winnerId || state.draw) throw new Error('目前不能操作');
    const now = Date.now();
    if (message.type === 'tetris.attack') { const lines = Math.floor(message.lines); if (lines < 1 || lines > 4) throw new Error('攻擊必須為 1 到 4 排'); if (player.attackQueue.length >= 4) throw new Error('攻擊佇列已滿'); if (player.attackPoints < lines) throw new Error('攻擊點數不足'); player.attackPoints -= lines; player.attackQueue.push(lines); return { eventType: 'tetris.attackQueued', payload: { playerId: actorId, lines } }; }
    if (message.type === 'tetris.move') { if (message.direction === 'down') down(state, actorId, now); else { const next = { ...player.active, x: player.active.x + (message.direction === 'left' ? -1 : 1) }; if (valid(player, next)) { player.active = next; if (valid(player, { ...next, y: next.y + 1 })) player.lockAt = undefined; } } }
    else if (message.type === 'tetris.rotate') { const rotations = SHAPES[player.active.type].length; const candidate = { ...player.active, rotation: (player.active.rotation + 1) % rotations }; for (const kick of [0, -1, 1, -2, 2]) { const next = { ...candidate, x: candidate.x + kick }; if (valid(player, next)) { player.active = next; if (valid(player, { ...next, y: next.y + 1 })) player.lockAt = undefined; break; } } }
    else if (message.type === 'tetris.hardDrop') { let next = { ...player.active }; while (valid(player, { ...next, y: next.y + 1 })) next = { ...next, y: next.y + 1 }; player.active = next; releaseAttack(state, actorId, now); lock(state, actorId, now); }
    else throw new Error('無效的俄羅斯方塊操作');
    return { eventType: message.type, payload: { playerId: actorId }, finished: Boolean(state.winnerId || state.draw) };
  },
  tick(state, { now }) {
    if (state.winnerId || state.draw || state.pausedAt) return;
    let changed = false;
    for (const player of Object.values(state.players)) { const due = player.incoming.filter(item => item.dueAt <= now); if (due.length) { player.incoming = player.incoming.filter(item => item.dueAt > now); addGarbage(player, due.reduce((sum, item) => sum + item.lines, 0)); changed = true; } }
    resolveLoss(state);
    for (const [id, player] of Object.entries(state.players)) if (player.lockAt && now >= player.lockAt) { lock(state, id, now); changed = true; }
    if (!state.winnerId && !state.draw && now >= state.nextFallAt) { for (const id of Object.keys(state.players)) down(state, id, now); state.nextFallAt = now + interval(state); changed = true; }
    return changed ? { eventType: 'tetris.tick', payload: {}, finished: Boolean(state.winnerId || state.draw) } : undefined;
  },
  publicState(state) { return structuredClone(state); },
};
