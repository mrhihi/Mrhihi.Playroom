import type { RaceState } from '../shared/types.js';
import type { GameModule } from './contract.js';

export const raceGame: GameModule<RaceState> = {
  type: 'race',
  createState(players, config) {
    const durationMs = Math.max(5_000, Math.floor(Number(config.durationMs ?? 15_000)));
    const startsAt = Date.now() + 3_000;
    return {
      startsAt,
      distance: Math.max(20, Math.floor(Number(config.distance ?? 100))),
      durationMs,
      endsAt: startsAt + durationMs,
      distances: Object.fromEntries(players.map(player => [player.id, 0])),
    };
  },
  apply(state, { actorId, message }) {
    if (message.type !== 'race.clickBatch') throw new Error('無效的賽跑操作');
    if (Date.now() < state.startsAt) throw new Error('尚未鳴槍，請等待發令');
    if (Date.now() >= state.endsAt) throw new Error('比賽已結束');
    const count = Math.min(Math.max(0, Math.floor(message.count)), 100);
    state.distances[actorId] = (state.distances[actorId] ?? 0) + count;
    return {
      eventType: 'race.clickBatch',
      payload: { playerId: actorId, count },
      finished: state.distances[actorId] >= state.distance,
    };
  },
  publicState(state) { return structuredClone(state); },
  finishDelayMs(state) { return Math.max(0, state.endsAt - Date.now()); },
  finish(state) { state.finishedAt = Date.now(); },
};
