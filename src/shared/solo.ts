import { z } from 'zod';
import { tetrisGame } from '../games/tetris.js';
import type { ClientMessage, TetrisState } from './types.js';
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const piece = z.enum(['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
export const soloStateSchema = z.object({
  mode: z.literal('solo'),
  players: z.object({ solo: z.object({
    board: z.array(z.array(piece.nullable()).length(10)).length(20),
    active: z.object({ type: piece, rotation: z.number().int().min(0).max(3), x: z.number().int().min(-4).max(9), y: z.number().int().min(-4).max(19) }),
    next: z.array(piece).length(4), bag: z.array(piece).max(7),
    lines: integer, score: integer, attackPoints: z.literal(0),
    attackQueue: z.array(z.never()).length(0), incoming: z.array(z.never()).length(0),
    lockAt: integer.optional(), lost: z.boolean().optional(),
  }).strict() }).strict(),
  // Gravity intervals become fractional as the level increases. Existing
  // saves retain that precision, so accept the game's actual clock values.
  nextFallAt: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER), gameOver: z.boolean().optional(),
}).strict();
export const soloResultSchema = z.object({
  submissionId: z.string().uuid(), ownerDeleteToken: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().trim().min(1).max(24), password: z.string().max(128).default(''),
  elapsedMs: integer, state: soloStateSchema,
}).strict().refine(v => v.state.gameOver === true && v.state.players.solo.lost === true, '遊戲尚未結束');
export const soloSaveSchema = z.object({
  version: z.literal(1), submissionId: z.string().uuid(), ownerDeleteToken: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(24), password: z.string().max(128), elapsedMs: integer,
  state: soloStateSchema, uploadedId: z.string().optional(),
}).strict();
export type SoloSave = z.infer<typeof soloSaveSchema>;

/** A clock which never advances while paused, independent of wall-clock time. */
export class SoloSession {
  paused = true;
  constructor(public save: SoloSave) {}
  static create(name: string, password: string, submissionId: string, ownerDeleteToken: string) {
    const state = tetrisGame.createState([{ id: 'solo', name, connected: true }], { mode: 'solo' });
    state.nextFallAt = 1000;
    return new SoloSession({ version: 1, submissionId, ownerDeleteToken, name, password, elapsedMs: 0, state: soloStateSchema.parse(state) });
  }
  advance(ms: number) {
    if (this.paused || this.save.state.gameOver) return false;
    this.save.elapsedMs += Math.max(0, Math.round(ms));
    return Boolean(tetrisGame.tick!(this.save.state as TetrisState, { hostId: 'solo', players: [], now: this.save.elapsedMs }));
  }
  apply(message: ClientMessage) {
    if (this.paused || this.save.state.gameOver) return false;
    tetrisGame.apply(this.save.state as TetrisState, { actorId: 'solo', hostId: 'solo', players: [], message, now: this.save.elapsedMs });
    return true;
  }
}
