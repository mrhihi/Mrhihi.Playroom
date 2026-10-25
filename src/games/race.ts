import type { RaceCompletion, RaceRunner, RaceState, RaceTimelinePoint } from '../shared/types.js';
import type { GameModule } from './contract.js';

const cleanVirtualRunners = (value: unknown, players: RaceRunner[]) => {
  const requested = Array.isArray(value) ? value.slice(0, 20) : [];
  const used = players.map(player => player.name);
  return requested.map((item, index) => {
    const raw = typeof item === 'string' ? item : typeof item === 'object' && item ? (item as { name?: unknown }).name : '';
    const base = String(raw ?? '').trim().slice(0, 24) || `虛擬跑者 ${index + 1}`;
    let name = base, suffix = 2;
    while (used.includes(name)) name = `${base.slice(0, 20)} #${suffix++}`;
    used.push(name);
    return { id: `virtual-${index + 1}`, name, virtual: true };
  });
};

const seededRandom = (seed: number) => {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ result >>> 15, result | 1);
    result ^= result + Math.imul(result ^ result >>> 7, result | 61);
    return ((result ^ result >>> 14) >>> 0) / 2 ** 32;
  };
};

const shuffle = <T>(items: T[], random = Math.random) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
};

const hasLeadChange = (timeline: RaceTimelinePoint[], runners: RaceRunner[], distance: number) => {
  let previous = '';
  for (const point of timeline.slice(1)) {
    if (runners.some(runner => point.distances[runner.id] >= distance)) break;
    const leader = [...runners].sort((left, right) => (point.distances[right.id] ?? 0) - (point.distances[left.id] ?? 0))[0]?.id ?? '';
    if (previous && leader !== previous) return true;
    previous = leader;
  }
  return false;
};

const stepPower = (maxRun: number, random: () => number) => {
  const upperBound = random() < 0.3 ? maxRun * 2 : maxRun;
  return 1 + Math.floor(random() * upperBound);
};

const makeRandomTimeline = (runners: RaceRunner[], distance: number, durationMs: number, seed: number) => {
  const rounds = Math.max(6, Math.round(durationMs / 750));
  const maxRun = Math.max(1, Math.floor(distance / (rounds * 0.65)));
  const ids = runners.map(runner => runner.id);
  const random = seededRandom(seed);
  for (let attempt = 0; attempt < 24; attempt++) {
    const timeline: RaceTimelinePoint[] = [{ offsetMs: 0, distances: Object.fromEntries(ids.map(id => [id, 0])) }];
    let distances = { ...timeline[0].distances };
    const completion: Record<string, RaceCompletion> = {};
    const finalRanking: string[] = [];
    for (let round = 1; ; round++) {
      const next: Record<string, number> = { ...distances };
      const onTrack = ids.filter(id => distances[id] < distance);
      for (const id of onTrack) next[id] = Math.min(distance, next[id] + stepPower(maxRun, random));
      const lastOne = shuffle(onTrack.filter(id => next[id] < distance), random).sort((left, right) => next[left] - next[right])[0];
      if (lastOne && next[lastOne] / distance > 0.3 && random() < 0.65) {
        for (let boost = 0; boost < 2 && next[lastOne] < distance; boost++) next[lastOne] = Math.min(distance, next[lastOne] + stepPower(maxRun, random));
      }
      const newlyFinished = onTrack.filter(id => next[id] >= distance);
      distances = next;
      const offsetMs = Math.round(round * durationMs / rounds);
      timeline.push({ offsetMs, distances: { ...distances } });
      for (const id of shuffle(newlyFinished, random)) {
        completion[id] = { offsetMs, order: finalRanking.length + 1 };
        finalRanking.push(id);
      }
      if (finalRanking.length === ids.length) {
        const staggeredFinishes = new Set(Object.values(completion).map(entry => entry.offsetMs)).size > 1;
        if (runners.length < 2 || (staggeredFinishes && hasLeadChange(timeline, runners, distance))) return { timeline, completion, finalRanking };
        break;
      }
    }
  }
  throw new Error('無法建立具有領先變化的隨機賽程');
};

export const raceGame: GameModule<RaceState> = {
  type: 'race',
  createState(players, config) {
    const durationMs = Math.max(5_000, Math.floor(Number(config.durationMs ?? 15_000)));
    const startsAt = Date.now() + 3_000;
    const mode = config.mode === 'random' ? 'random' : 'manual';
    const humanRunners = (mode === 'random' && config.includeHost === false ? players.slice(1) : players).map(player => ({ id: player.id, name: player.name }));
    const runners = mode === 'random' ? [...humanRunners, ...cleanVirtualRunners(config.virtualRunners, humanRunners)] : humanRunners;
    if (!runners.length) throw new Error('請至少加入一位參賽者或虛擬跑者');
    const distance = Math.max(20, Math.floor(Number(config.distance ?? 100)));
    const randomSeed = Math.floor(Math.random() * 2 ** 31);
    const randomRace = mode === 'random' ? makeRandomTimeline(runners, distance, durationMs, randomSeed) : undefined;
    const actualDurationMs = randomRace?.timeline.at(-1)?.offsetMs ?? durationMs;
    return {
      startsAt,
      distance,
      durationMs,
      endsAt: startsAt + actualDurationMs,
      distances: Object.fromEntries(players.map(player => [player.id, 0])),
      mode,
      runners,
      ...(randomRace ? { randomSeed, randomTimeline: randomRace.timeline, completion: randomRace.completion, finalRanking: randomRace.finalRanking, targetEndsAt: startsAt + durationMs } : {}),
    };
  },
  apply(state, { actorId, message }) {
    if (message.type !== 'race.clickBatch') throw new Error('無效的賽跑操作');
    if (state.mode === 'random') throw new Error('隨機排名模式不支援手動衝刺');
    if (Date.now() < state.startsAt) throw new Error('尚未鳴槍，請等待發令');
    const count = Math.min(Math.max(0, Math.floor(message.count)), 100);
    const previous = state.distances[actorId] ?? 0;
    state.distances[actorId] = Math.min(state.distance, previous + count);
    if (state.distances[actorId] >= state.distance && previous < state.distance) {
      const completion = state.completion ??= {};
      completion[actorId] = { offsetMs: Math.max(0, Date.now() - state.startsAt), order: Object.keys(completion).length + 1 };
    }
    return {
      eventType: 'race.clickBatch',
      payload: { playerId: actorId, count },
      finished: (state.runners ?? []).every(runner => (state.distances[runner.id] ?? 0) >= state.distance),
    };
  },
  publicState(state) { return structuredClone(state); },
  finishDelayMs(state) { return state.mode === 'random' ? Math.max(0, state.endsAt - Date.now()) : 0; },
  finish(state) {
    state.finishedAt = Date.now();
  },
};
