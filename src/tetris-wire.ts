import type { TetrisCell, TetrisPlayerState, TetrisState } from './shared/types.js';

export type VisiblePlayer = Pick<TetrisPlayerState, 'board' | 'active' | 'next' | 'lines' | 'score' | 'attackPoints' | 'attackQueue' | 'incoming'> & {
  swapUsed?: boolean; lost?: boolean; clearing?: TetrisPlayerState['clearing']; selfClearRows?: number;
};
export type VisibleTetris = Pick<TetrisState, 'mode'> & {
  players: Record<string, VisiblePlayer>;
  pausedAt?: number; pausedPlayerId?: string; winnerId?: string; draw?: boolean; gameOver?: boolean;
};
export type PlayerPatch = Partial<Omit<VisiblePlayer, 'board'>> & { boardRows?: [number, TetrisCell[]][] };
export type TetrisPatch = { players: Record<string, PlayerPatch>; state?: Record<string, unknown> };

const playerFields = ['active', 'next', 'lines', 'score', 'attackPoints', 'attackQueue', 'incoming', 'swapUsed', 'lost', 'clearing', 'selfClearRows'] as const;
const stateFields = ['pausedAt', 'pausedPlayerId', 'winnerId', 'draw', 'gameOver'] as const;

export function visibleTetris(state: TetrisState): VisibleTetris {
  const players: Record<string, VisiblePlayer> = {};
  for (const [id, player] of Object.entries(state.players)) {
    players[id] = {
      board: player.board.map(row => [...row]), active: { ...player.active }, next: [...player.next],
      lines: player.lines, score: player.score, attackPoints: player.attackPoints,
      attackQueue: [...player.attackQueue], incoming: player.incoming.map(item => ({ ...item })),
      ...(player.swapUsed === undefined ? {} : { swapUsed: player.swapUsed }),
      ...(player.lost === undefined ? {} : { lost: player.lost }),
      ...(player.clearing === undefined ? {} : { clearing: { rows: [...player.clearing.rows], endsAt: player.clearing.endsAt, ...(player.clearing.kind ? { kind: player.clearing.kind } : {}) } }),
      ...(player.selfClearRows === undefined ? {} : { selfClearRows: player.selfClearRows }),
    };
  }
  return { mode: state.mode, players, ...Object.fromEntries(stateFields.filter(key => state[key] !== undefined).map(key => [key, state[key]])) };
}

export function diffTetris(before: VisibleTetris, after: VisibleTetris, ids: string[], includeState = false): TetrisPatch | undefined {
  const patch: TetrisPatch = { players: {} };
  for (const id of ids) {
    const oldPlayer = before.players[id], player = after.players[id];
    if (!player) continue;
    const changes: PlayerPatch = {};
    if (!oldPlayer) {
      changes.boardRows = player.board.map((row, index) => [index, row]);
      for (const field of playerFields) (changes as Record<string, unknown>)[field] = player[field] ?? null;
    } else {
      const rows: [number, TetrisCell[]][] = [];
      player.board.forEach((row, index) => { if (row.some((cell, x) => cell !== oldPlayer.board[index]?.[x])) rows.push([index, row]); });
      if (rows.length) changes.boardRows = rows;
      for (const field of playerFields) if (JSON.stringify(player[field]) !== JSON.stringify(oldPlayer[field])) (changes as Record<string, unknown>)[field] = player[field] ?? null;
    }
    if (Object.keys(changes).length) patch.players[id] = changes;
  }
  if (includeState) {
    const state: Record<string, unknown> = {};
    for (const field of stateFields) if (before[field] !== after[field]) state[field] = after[field] ?? null;
    if (Object.keys(state).length) patch.state = state;
  }
  return Object.keys(patch.players).length || patch.state ? patch : undefined;
}
