import { randomUUID } from 'node:crypto';
import type { OldMaidCard, OldMaidState } from '../shared/types.js';
import type { GameModule } from './contract.js';

const shuffleDurationMs = 900;

export function shuffleHand<T>(items: T[], random = Math.random) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function activePlayerIds(state: OldMaidState, players: { id: string }[]) {
  return players.map(player => player.id).filter(id => (state.hands[id]?.length ?? 0) > 0);
}

function ensureShuffleState(state: OldMaidState) {
  if (!state.shuffledPlayerIds) state.shuffledPlayerIds = [];
  if (!state.discardedCounts) state.discardedCounts = {};
}

function createDeck(maxRank: number): OldMaidCard[] {
  const ranks = Array.from({ length: Math.min(13, Math.max(1, Math.floor(maxRank))) }, (_, index) => String(index + 1));
  const suits = ['♠', '♥', '♦', '♣'];
  const cards: OldMaidCard[] = ranks.flatMap(rank => suits.map(suit => ({ id: randomUUID(), rank, suit })));
  cards.push({ id: randomUUID(), rank: 'JOKER', suit: '🃏', joker: true });
  return cards.sort(() => Math.random() - 0.5);
}

export function removePairs(hand: OldMaidCard[]) {
  const groups = new Map<string, OldMaidCard[]>();
  for (const card of hand) {
    const key = card.joker ? card.id : card.rank;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  return [...groups.values()].filter(group => group.length % 2).map(group => group[group.length - 1]).sort(() => Math.random() - 0.5);
}

export const oldMaidGame: GameModule<OldMaidState> = {
  type: 'old-maid',
  createState(players, config) {
    const hands: Record<string, OldMaidCard[]> = Object.fromEntries(players.map(player => [player.id, []]));
    const discardedCounts: Record<string, number> = Object.fromEntries(players.map(player => [player.id, 0]));
    if (players.length < 2) throw new Error('抽鬼牌至少需要兩位玩家');
    for (const [index, card] of createDeck(Number(config.maxRank ?? 13)).entries()) hands[players[index % players.length].id].push(card);
    for (const id of Object.keys(hands)) { const originalCount = hands[id].length; hands[id] = removePairs(hands[id]); discardedCounts[id] = originalCount - hands[id].length; }
    return { hands, eliminated: [], discardedCounts, turnPlayerId: players[0]?.id, shuffledPlayerIds: [] };
  },
  apply(state, { actorId, players, message }) {
    ensureShuffleState(state);
    const now = Date.now();
    if (state.shuffle?.endsAt && state.shuffle.endsAt > now) throw new Error('正在洗牌，請稍候');
    if (message.type === 'oldMaid.shuffle') {
      if (state.loserId) throw new Error('遊戲已結束，不能洗牌');
      if (!state.hands[actorId]?.length) throw new Error('沒有手牌可洗');
      if (state.shuffledPlayerIds?.includes(actorId)) throw new Error('上次抽牌後已洗過牌，請等待下一次抽牌');
      state.hands[actorId] = shuffleHand(state.hands[actorId]);
      state.shuffledPlayerIds = [...(state.shuffledPlayerIds ?? []), actorId];
      if (state.focus?.targetPlayerId === actorId) state.focus = undefined;
      if (state.tease?.playerId === actorId) state.tease = undefined;
      state.shuffle = { playerId: actorId, at: now, endsAt: now + shuffleDurationMs };
      return { eventType: 'oldMaid.shuffle', payload: { playerId: actorId, at: now, endsAt: now + shuffleDurationMs } };
    }
    if (message.type === 'oldMaid.focus') {
      if (state.turnPlayerId !== actorId || state.loserId) throw new Error('現在不能選牌');
      if (message.targetPlayerId === undefined || message.cardIndex === undefined) {
        state.focus = undefined;
        return { eventType: 'oldMaid.focus', payload: { playerId: actorId, cleared: true } };
      }
      if (actorId === message.targetPlayerId) throw new Error('不能選自己的牌');
      const target = state.hands[message.targetPlayerId] ?? [];
      if (!target[message.cardIndex]) throw new Error('牌不存在');
      state.focus = { actorId, targetPlayerId: message.targetPlayerId, cardIndex: message.cardIndex, at: now };
      return { eventType: 'oldMaid.focus', payload: { playerId: actorId, targetPlayerId: message.targetPlayerId, cardIndex: message.cardIndex } };
    }
    if (message.type === 'oldMaid.tease') {
      if (state.turnPlayerId === actorId || state.loserId) throw new Error('請在其他玩家抽牌時使用誘餌');
      if (!state.hands[actorId]?.[message.cardIndex]) throw new Error('牌不存在');
      state.tease = { playerId: actorId, cardIndex: message.cardIndex, at: now };
      return { eventType: 'oldMaid.tease', payload: { playerId: actorId, cardIndex: message.cardIndex } };
    }
    if (message.type !== 'oldMaid.draw') throw new Error('無效的抽鬼牌操作');
    if (state.turnPlayerId !== actorId || actorId === message.targetPlayerId) throw new Error('現在不能抽這張牌');
    const target = state.hands[message.targetPlayerId] ?? [];
    const card = target[message.cardIndex];
    if (!card) throw new Error('牌不存在');
    target.splice(message.cardIndex, 1);
    state.tease = undefined;
    state.focus = undefined;
    state.lastDraw = { actorId, targetPlayerId: message.targetPlayerId, cardIndex: message.cardIndex, card: structuredClone(card), at: now };
    state.hands[actorId].push(card);
    const handCountBeforePairs = state.hands[actorId].length;
    state.hands[actorId] = removePairs(state.hands[actorId]);
    state.discardedCounts[actorId] = (state.discardedCounts[actorId] ?? 0) + handCountBeforePairs - state.hands[actorId].length;
    state.shuffledPlayerIds = [];
    if (!state.hands[actorId].length && !state.eliminated.includes(actorId)) state.eliminated.push(actorId);
    const active = activePlayerIds(state, players);
    if (active.length <= 1) { state.loserId = active[0]; state.turnPlayerId = undefined; }
    else {
      const actorIndex = players.findIndex(player => player.id === actorId);
      state.turnPlayerId = Array.from({ length: players.length - 1 }, (_, offset) => players[(actorIndex + offset + 1) % players.length].id).find(id => active.includes(id));
    }
    return { eventType: 'oldMaid.draw', payload: { playerId: actorId, targetPlayerId: message.targetPlayerId, cardIndex: message.cardIndex }, finished: Boolean(state.loserId) };
  },
  publicState(state) {
    const copy = structuredClone(state);
    if (!copy.hands) return copy;
    for (const hand of Object.values(copy.hands)) for (const card of hand) { card.rank = '?'; card.suit = '🂠'; card.joker = false; }
    return copy;
  },
};
