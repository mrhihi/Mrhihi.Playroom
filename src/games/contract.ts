import type { ClientMessage, GameType, Player } from '../shared/types.js';

export interface GameActionContext {
  actorId: string;
  hostId: string;
  players: Player[];
  message: ClientMessage;
}

export interface GameActionResult {
  eventType: string;
  payload: unknown;
  finished?: boolean;
}

export interface GameModule<State> {
  readonly type: GameType;
  createState(players: Player[], config: Record<string, unknown>): State;
  apply(state: State, context: GameActionContext): GameActionResult;
  publicState(state: State): unknown;
  finishDelayMs?(state: State): number;
  finish?(state: State): void;
  tick?(state: State, context: Omit<GameActionContext, 'actorId' | 'message'> & { now: number }): GameActionResult | undefined;
}
