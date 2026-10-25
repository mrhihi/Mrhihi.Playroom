import { randomUUID } from 'node:crypto';
import type { OldMaidCard, OldMaidState } from '../shared/types.js';
import type { GameModule } from './contract.js';

// Keep the shared shuffle state visible long enough for remote clients to receive
// the update and see that the hand has actually been rearranged.
const shuffleDurationMs = 1_500;

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

export function nextOldMaidPlayerId(state: OldMaidState, players: { id: string }[], actorId: string) {
  const index = players.findIndex(player => player.id === actorId);
  if (index < 0) return undefined;
  for (let offset = 1; offset < players.length; offset++) {
    const id = players[(index + offset) % players.length].id;
    if (state.hands[id]?.length) return id;
  }
  return undefined;
}

function updateExits(state: OldMaidState, players: { id: string }[]) {
  const newlySafe = players.map(player => player.id).filter(id => !state.hands[id]?.length && !state.eliminated.includes(id));
  if (!state.winnerIds?.length && !state.eliminated.length && newlySafe.length) state.winnerIds = [...newlySafe];
  state.eliminated.push(...newlySafe);
  const active = activePlayerIds(state, players);
  if (active.length === 1 && state.hands[active[0]].length === 1 && state.hands[active[0]][0].joker) {
    state.loserId = active[0];
    state.turnPlayerId = undefined;
  }
}

function ensureShuffleState(state: OldMaidState) {
  if (!state.shuffledPlayerIds) state.shuffledPlayerIds = [];
  if (!state.discardedCounts) state.discardedCounts = {};
}

export function createDeck(): OldMaidCard[] {
  const ranks = Array.from({ length: 13 }, (_, index) => String(index + 1));
  const suits = ['♠', '♥', '♦', '♣'];
  const cards: OldMaidCard[] = ranks.flatMap(rank => suits.map(suit => ({ id: randomUUID(), rank, suit })));
  cards.push({ id: randomUUID(), rank: 'JOKER', suit: '🃏', joker: true });
  return shuffleHand(cards);
}

export function removePairs(hand: OldMaidCard[]) {
  const groups = new Map<string, OldMaidCard[]>();
  for (const card of hand) {
    const key = card.joker ? card.id : card.rank;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  const survivors = new Set([...groups.values()].filter(group => group.length % 2).map(group => group[group.length - 1]));
  return hand.filter(card => survivors.has(card));
}

export const oldMaidGame: GameModule<OldMaidState> = {
  type: 'old-maid',
  createState(players) {
    const hands: Record<string, OldMaidCard[]> = Object.fromEntries(players.map(player => [player.id, []]));
    const discardedCounts: Record<string, number> = Object.fromEntries(players.map(player => [player.id, 0]));
    if (players.length < 2) throw new Error('抽鬼牌至少需要兩位玩家');
    for (const [index, card] of createDeck().entries()) hands[players[index % players.length].id].push(card);
    for (const id of Object.keys(hands)) { const originalCount = hands[id].length; hands[id] = removePairs(hands[id]); discardedCounts[id] = originalCount - hands[id].length; }
    const state: OldMaidState = { hands, eliminated: [], winnerIds: [], discardedCounts, shuffledPlayerIds: [] };
    updateExits(state, players);
    if (!state.loserId) state.turnPlayerId = activePlayerIds(state, players)[0];
    return state;
  },
  apply(state, { actorId, players, message }) {
    if (state.loserId) throw new Error('遊戲已結束');
    const now = Date.now();
    if (state.shuffle?.endsAt && state.shuffle.endsAt > now) throw new Error('正在洗牌，請稍候');
    if (message.type === 'oldMaid.shuffle') {
      if (!state.hands[actorId]?.length) throw new Error('沒有手牌可洗');
      if (state.shuffledPlayerIds?.includes(actorId)) throw new Error('上次抽牌後已洗過牌，請等待下一次抽牌');
      ensureShuffleState(state);
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
      if (!state.hands[actorId]?.length || message.targetPlayerId !== nextOldMaidPlayerId(state, players, actorId)) throw new Error('只能從下一位仍有手牌的玩家抽牌');
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
    if (!state.hands[actorId]?.length || message.targetPlayerId !== nextOldMaidPlayerId(state, players, actorId)) throw new Error('只能從下一位仍有手牌的玩家抽牌');
    const target = state.hands[message.targetPlayerId] ?? [];
    const card = target[message.cardIndex];
    if (!card) throw new Error('牌不存在');
    ensureShuffleState(state);
    target.splice(message.cardIndex, 1);
    state.tease = undefined;
    state.focus = undefined;
    state.lastDraw = { actorId, targetPlayerId: message.targetPlayerId, cardIndex: message.cardIndex, card: structuredClone(card), at: now };
    state.hands[actorId].push(card);
    const handCountBeforePairs = state.hands[actorId].length;
    state.hands[actorId] = removePairs(state.hands[actorId]);
    state.discardedCounts[actorId] = (state.discardedCounts[actorId] ?? 0) + handCountBeforePairs - state.hands[actorId].length;
    state.shuffledPlayerIds = [];
    updateExits(state, players);
    if (!state.loserId) state.turnPlayerId = nextOldMaidPlayerId(state, players, actorId);
    return { eventType: 'oldMaid.draw', payload: { playerId: actorId, targetPlayerId: message.targetPlayerId, cardIndex: message.cardIndex }, finished: Boolean(state.loserId) };
  },
  publicState(state) {
    const copy = structuredClone(state);
    if (!copy.hands) return copy;
    for (const hand of Object.values(copy.hands)) for (const card of hand) { card.rank = '?'; card.suit = '🂠'; card.joker = false; }
    return copy;
  },
};
