import type { TetrisPiece, TetrisPlayerState, TetrisState } from '../shared/types.js';
import type { GameModule } from './contract.js';

const W = 10, H = 20, ATTACK_COST_PER_LINE = 4, TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
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
  if (left) { const opponent = Object.keys(state.players).find(other => other !== id)!; state.players[opponent].incoming.push({ lines: left, fromPlayerId: id }); }
};
const releaseAttack = (state: TetrisState, id: string) => { if (state.mode !== 'versus') return; const player = state.players[id]; const lines = player.attackQueue.shift(); if (lines) queueAttack(state, id, lines); };
const addGarbage = (player: TetrisPlayerState, lines: number) => {
  for (let i = 0; i < lines; i++) {
    if (player.board[0].some(Boolean)) player.lost = true;
    const gap = Math.floor(Math.random() * W);
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
  if (state.mode === 'versus' && player.incoming.length) {
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
    if (rows.length) { player.clearing = { rows, endsAt: now + 150, kind: 'self' }; return; }
  }
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
  if (rows.length) player.clearing = { rows, endsAt: now + 150 };
  else finishNaturalClear(state, id, 0, now);
};
const down = (state: TetrisState, id: string, now: number) => {
  const player = state.players[id]; if (player.lost || player.clearing) return;
  const next = { ...player.active, y: player.active.y + 1 };
  if (valid(player, next)) { player.active = next; releaseAttack(state, id); if (!valid(player, { ...next, y: next.y + 1 })) lock(state, id, now); }
  else lock(state, id, now);
};
const resolveLoss = (state: TetrisState) => {
  const lost = Object.entries(state.players).filter(([, player]) => player.lost).map(([id]) => id);
  if (!lost.length) return;
  if (state.mode === 'solo') { state.gameOver = true; return; }
  if (lost.length === 2) state.draw = true;
  else state.winnerId = Object.keys(state.players).find(id => id !== lost[0]);
};

export const tetrisGame: GameModule<TetrisState> = {
  type: 'tetris',
  createState(players, config) {
    const mode = config.mode === 'solo' ? 'solo' : 'versus';
    if (players.length !== (mode === 'solo' ? 1 : 2)) throw new Error(mode === 'solo' ? '單人俄羅斯方塊需要一位玩家' : '俄羅斯方塊需要剛好兩位玩家');
    const state: TetrisState = { mode, players: {}, nextFallAt: Date.now() + 1000 };
    const pieceRandomState = mode === 'versus' ? Math.floor(Math.random() * 0x100000000) : undefined;
    for (const player of players) { const value: TetrisPlayerState = { board: board(), active: { type: 'T', rotation: 0, x: 3, y: -1 }, next: [], bag: [], ...(pieceRandomState === undefined ? {} : { pieceRandomState }), lines: 0, score: 0, attackPoints: 0, attackQueue: [], incoming: [] }; state.players[player.id] = value; spawn(value); }
    return state;
  },
  apply(state, { actorId, message, now = Date.now() }) {
    const player = state.players[actorId]; if (!player || player.lost || state.winnerId || state.draw || state.gameOver) throw new Error('目前不能操作');
    if (message.type === 'tetris.surrender') { player.lost = true; resolveLoss(state); return { eventType: 'tetris.surrender', payload: { playerId: actorId }, finished: true }; }
    if (message.type === 'tetris.attack') { if (state.mode === 'solo') throw new Error('單人模式沒有攻擊'); const lines = Math.floor(message.lines); if (lines < 1 || lines > 4) throw new Error('攻擊必須為 1 到 4 排'); if (player.attackQueue.length >= 4) throw new Error('攻擊佇列已滿'); const cost = lines * ATTACK_COST_PER_LINE; if (player.attackPoints < cost) throw new Error('攻擊點數不足'); player.attackPoints -= cost; player.attackQueue.push(lines); return { eventType: 'tetris.attackQueued', payload: { playerId: actorId, lines } }; }
    if (message.type === 'tetris.selfClear') { if (state.mode !== 'versus') throw new Error('單人模式不能使用自清'); if (!Number.isInteger(message.lines) || message.lines < 1 || message.lines > 4) throw new Error('自清必須為 1 到 4 排'); if (player.selfClearRows || player.clearing) throw new Error('目前方塊已預約自清或正在消行'); const cost = message.lines * ATTACK_COST_PER_LINE; if (player.attackPoints < cost) throw new Error('攻擊點數不足'); player.attackPoints -= cost; player.selfClearRows = message.lines; return { eventType: 'tetris.selfClearQueued', payload: { playerId: actorId, lines: message.lines } }; }
    if (player.clearing) return { eventType: message.type, payload: { playerId: actorId } };
    if (message.type === 'tetris.move') { if (message.direction === 'down') down(state, actorId, now); else { const next = { ...player.active, x: player.active.x + (message.direction === 'left' ? -1 : 1) }; if (valid(player, next)) player.active = next; } }
    else if (message.type === 'tetris.swap') {
      const candidate = { ...player.active, type: player.next[0], rotation: 0 };
      if (!player.swapUsed && valid(player, candidate)) {
        player.next[0] = player.active.type;
        player.active = candidate;
        player.swapUsed = true;
      }
    }
    else if (message.type === 'tetris.rotate') { const rotations = SHAPES[player.active.type].length; const candidate = { ...player.active, rotation: (player.active.rotation + 1) % rotations }; for (const kick of [0, -1, 1, -2, 2]) { const next = { ...candidate, x: candidate.x + kick }; if (valid(player, next)) { player.active = next; break; } } }
    else if (message.type === 'tetris.hardDrop') { let next = { ...player.active }; while (valid(player, { ...next, y: next.y + 1 })) next = { ...next, y: next.y + 1 }; player.active = next; releaseAttack(state, actorId); lock(state, actorId, now); }
    else throw new Error('無效的俄羅斯方塊操作');
    return { eventType: message.type, payload: { playerId: actorId }, finished: Boolean(state.winnerId || state.draw || state.gameOver) };
  },
  tick(state, { now }) {
    if (state.winnerId || state.draw || state.gameOver || state.pausedAt) return;
    let changed = false;
    for (const [id, player] of Object.entries(state.players)) if (player.clearing && now >= player.clearing.endsAt) { finishLock(state, id, now); changed = true; }
    if (!state.winnerId && !state.draw && !state.gameOver && now >= state.nextFallAt) { for (const id of Object.keys(state.players)) down(state, id, now); state.nextFallAt = now + interval(state); changed = true; }
    return changed ? { eventType: 'tetris.tick', payload: {}, finished: Boolean(state.winnerId || state.draw || state.gameOver) } : undefined;
  },
  publicState(state) { return structuredClone(state); },
};
