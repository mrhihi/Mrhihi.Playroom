import type { GameType } from '../shared/types.js';
import type { GameModule } from './contract.js';
import { oldMaidGame } from './old-maid.js';
import { pollGame } from './poll.js';
import { raceGame } from './race.js';

const games: Record<GameType, GameModule<any>> = { race: raceGame, 'old-maid': oldMaidGame, poll: pollGame };
export const getGame = (type: GameType) => games[type];
