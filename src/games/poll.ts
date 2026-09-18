import type { PollMode, PollOption, PollRoundHistory, PollState } from '../shared/types.js';
import type { GameModule } from './contract.js';

const normalizeOptions = (value: unknown, mode: PollMode): PollOption[] => {
  if (!Array.isArray(value)) throw new Error('至少需要兩個答項');
  const options = value.map((raw, index) => {
    const option = raw as Partial<PollOption>;
    const rawPoint = (raw as { point?: unknown }).point;
    const id = String(option.id ?? `o${index}`).slice(0, 40);
    const label = String(option.label ?? '').trim().slice(0, 80);
    let point: number | null | undefined;
    if (mode === 'scrum') {
      if (rawPoint === '?' || rawPoint === null || rawPoint === undefined || String(rawPoint).trim() === '?') point = null;
      else {
        point = Number(rawPoint);
        if (!Number.isFinite(point)) throw new Error('Story Point 必須是數字或 ?');
      }
    }
    return mode === 'scrum' ? { id, label, point } : { id, label };
  }).filter(option => option.id && option.label);
  if (options.length < 2) throw new Error('至少需要兩個答項');
  if (new Set(options.map(option => option.id)).size !== options.length) throw new Error('答項代碼不可重複');
  return options;
};

const archiveRound = (state: PollState, players: { id: string; name: string }[]): PollRoundHistory => ({
  round: state.round,
  question: state.question,
  options: structuredClone(state.options),
  players: players.map(player => ({ playerId: player.id, name: player.name, optionId: state.votes[player.id] })),
  revealedAt: Date.now(),
});

const reveal = (state: PollState, players: { id: string; name: string }[]) => {
  if (state.revealed) return;
  state.revealed = true;
  state.history.push(archiveRound(state, players));
};

export const pollGame: GameModule<PollState> = {
  type: 'poll',
  createState(_players, config) {
    const mode: PollMode = config.mode === 'scrum' ? 'scrum' : 'standard';
    return { mode, revealed: false, votes: {}, options: normalizeOptions(config.options, mode), question: String(config.question ?? '你怎麼選？').trim().slice(0, 160) || '你怎麼選？', round: 1, history: [] };
  },
  apply(state, { actorId, hostId, players, message }) {
    if (message.type === 'poll.nextRound') {
      if (actorId !== hostId) throw new Error('只有局主可以開啟下一題');
      if (!state.revealed) throw new Error('請先公開目前題目的結果');
      const options = normalizeOptions(message.options ?? state.options, state.mode);
      state.question = String(message.question).trim().slice(0, 160) || '你怎麼選？';
      state.options = options; state.votes = {}; state.revealed = false; state.round++;
      return { eventType: 'poll.nextRound', payload: { question: state.question, options, round: state.round } };
    }
    if (message.type === 'poll.reveal') {
      if (actorId !== hostId) throw new Error('只有局主可以公開結果');
      reveal(state, players);
      return { eventType: 'poll.reveal', payload: {} };
    }
    if (message.type === 'poll.clearHistory') {
      if (actorId !== hostId) throw new Error('只有局主可以清除題目歷程');
      state.history = state.revealed ? state.history.slice(-1) : [];
      return { eventType: 'poll.clearHistory', payload: { retainedCurrentRound: state.revealed } };
    }
    if (message.type !== 'poll.vote') throw new Error('無效的投票操作');
    if (state.revealed || !state.options.some(option => option.id === message.optionId)) throw new Error('投票已結束或選項無效');
    state.votes[actorId] = message.optionId;
    if (Object.keys(state.votes).length >= players.filter(player => player.connected).length) reveal(state, players);
    return { eventType: 'poll.vote', payload: { playerId: actorId, optionId: message.optionId } };
  },
  publicState(state) {
    const publicState = structuredClone(state);
    if (!Array.isArray(publicState.options) || !publicState.votes) return publicState;
    if (!publicState.revealed) {
      const submittedCount = Object.keys(publicState.votes).length;
      publicState.votes = {};
      return { ...publicState, submittedCount };
    }
    return publicState;
  },
};
