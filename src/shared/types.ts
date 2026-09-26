export type GameType = 'race' | 'old-maid' | 'poll' | 'tetris';
export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface Player { id: string; name: string; connected: boolean; score?: number; }
export interface RoomSnapshot {
  id: string; game: GameType; status: RoomStatus; hostId: string;
  players: Player[]; config: Record<string, unknown>; state: unknown;
  spectators?: Player[];
  messages: { id: string; playerName: string; text: string; at: number }[];
  stateVersion: number;
}

export type ClientMessage =
  | { type: 'join'; name: string; password?: string; reconnectToken?: string; observer?: boolean }
  | { type: 'player.rename'; name: string }
  | { type: 'host.start'; config?: Record<string, unknown> }
  | { type: 'race.clickBatch'; count: number; clientSequence: number }
  | { type: 'oldMaid.draw'; targetPlayerId: string; cardIndex: number }
  | { type: 'oldMaid.tease'; cardIndex: number }
  | { type: 'oldMaid.focus'; targetPlayerId?: string; cardIndex?: number }
  | { type: 'oldMaid.shuffle' }
  | { type: 'poll.vote'; optionId: string }
  | { type: 'poll.reveal' }
  | { type: 'poll.clearHistory' }
  | { type: 'poll.nextRound'; question: string; options?: PollOption[] }
  | { type: 'tetris.move'; direction: 'left' | 'right' | 'down' }
  | { type: 'tetris.rotate' }
  | { type: 'tetris.hardDrop' }
  | { type: 'tetris.attack'; lines: number }
  | { type: 'chat.send'; text: string };

export interface RaceState {
  startsAt: number;
  distance: number;
  durationMs: number;
  endsAt: number;
  distances: Record<string, number>;
  mode?: 'manual' | 'random';
  runners?: RaceRunner[];
  finalRanking?: string[];
  randomSeed?: number;
  randomTimeline?: RaceTimelinePoint[];
  completion?: Record<string, RaceCompletion>;
  targetEndsAt?: number;
  finishedAt?: number;
}
export interface RaceRunner { id: string; name: string; virtual?: boolean; }
export interface RaceTimelinePoint { offsetMs: number; distances: Record<string, number>; }
export interface RaceCompletion { offsetMs: number; order: number; }
export interface OldMaidCard { id: string; rank: string; suit: string; joker?: boolean; }
export interface OldMaidState { turnPlayerId?: string; hands: Record<string, OldMaidCard[]>; eliminated: string[]; discardedCounts: Record<string, number>; loserId?: string; lastDraw?: { actorId: string; targetPlayerId: string; cardIndex: number; card: OldMaidCard; at: number }; tease?: { playerId: string; cardIndex: number; at: number }; focus?: { actorId: string; targetPlayerId: string; cardIndex: number; at: number }; shuffledPlayerIds?: string[]; shuffle?: { playerId: string; at: number; endsAt: number }; }
export type PollMode = 'standard' | 'scrum';
export interface PollOption { id: string; label: string; point?: number | null; }
export interface PollRoundHistory {
  round: number;
  question: string;
  options: PollOption[];
  players: { playerId: string; name: string; optionId?: string }[];
  revealedAt: number;
}
export interface PollState {
  mode: PollMode;
  revealed: boolean;
  votes: Record<string, string>;
  /** Included only in an unrevealed snapshot for the player who cast this vote. */
  myVoteOptionId?: string;
  voteSequence: number;
  lastVote?: { playerId: string; sequence: number; revealedAction?: 'added' | 'changed'; revealedActionAt?: number };
  options: PollOption[];
  question: string;
  round: number;
  history: PollRoundHistory[];
}

export type TetrisCell = string | null;
export interface TetrisPiece { type: string; rotation: number; x: number; y: number; }
export interface TetrisPendingGarbage { lines: number; dueAt: number; fromPlayerId: string; }
export interface TetrisPlayerState {
  board: TetrisCell[][];
  active: TetrisPiece;
  next: string[];
  bag: string[];
  lines: number;
  score: number;
  attackPoints: number;
  attackQueue: number[];
  incoming: TetrisPendingGarbage[];
  lockAt?: number;
  lost?: boolean;
}
export interface TetrisState {
  mode: 'solo' | 'versus';
  players: Record<string, TetrisPlayerState>;
  nextFallAt: number;
  pausedAt?: number;
  pausedPlayerId?: string;
  winnerId?: string;
  draw?: boolean;
  gameOver?: boolean;
}
