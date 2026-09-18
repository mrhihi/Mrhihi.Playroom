import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import type { GameType } from './shared/types.js';

if (existsSync('.env')) loadEnvFile('.env');

export const config = { port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '0.0.0.0', databaseFile: process.env.DATABASE_FILE ?? 'playroom.sqlite', adminPassword: process.env.ADMIN_PASSWORD ?? '' };
export const supportedGames: GameType[] = ['race', 'old-maid', 'poll'];
