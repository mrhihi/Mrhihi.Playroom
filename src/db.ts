import Database from 'better-sqlite3';
import type { GameType, RoomSnapshot } from './shared/types.js';
export type StoredSession = { id: string; game: GameType; host_id: string; password_hash: string | null; owner_delete_token_hash: string | null; config: string; status: string; created_at: number; finished_at: number | null; result: string | null; final_state: string | null };
export type TetrisLeaderboardEntry = { id: string; roomId: string; playerId: string; mode: 'solo' | 'versus'; name: string; score: number; lines: number; level: number; outcome: 'win' | 'loss' | 'draw' | null; opponent: string | null; finishedAt: number };
export type StoredMessage = { id: string; channel_id: string; channel_type: string; player_name: string; text: string; created_at: number };
export function createDatabase(file: string) {
  const db = new Database(file); db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, game TEXT, host_id TEXT, password_hash TEXT, config TEXT, status TEXT, created_at INTEGER, result TEXT);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, version INTEGER, type TEXT, payload TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT, player_name TEXT, text TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS game_templates (id TEXT PRIMARY KEY, game TEXT NOT NULL, config TEXT NOT NULL, created_at INTEGER NOT NULL, share_code TEXT UNIQUE);`);
  const sessionColumns = new Set((db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(row => row.name));
  for (const [name, type] of [['finished_at', 'INTEGER'], ['final_state', 'TEXT'], ['owner_delete_token_hash', 'TEXT']] as const) if (!sessionColumns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  const messageColumns = new Set((db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(row => row.name));
  for (const [name, type] of [['channel_id', 'TEXT'], ['channel_type', 'TEXT']] as const) if (!messageColumns.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
  db.exec("UPDATE messages SET channel_id=COALESCE(channel_id,session_id), channel_type=COALESCE(channel_type,'room')");
  db.exec(`CREATE TABLE IF NOT EXISTS solo_submissions (submission_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS solo_submission_session ON solo_submissions(session_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS tetris_scores (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, mode TEXT NOT NULL, name TEXT NOT NULL,
    score INTEGER NOT NULL, lines INTEGER NOT NULL, level INTEGER NOT NULL,
    outcome TEXT, opponent TEXT, finished_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS tetris_scores_ranking ON tetris_scores(mode,score DESC,lines DESC,finished_at,id);
    CREATE INDEX IF NOT EXISTS tetris_scores_room ON tetris_scores(room_id);
    CREATE TABLE IF NOT EXISTS data_migrations (id TEXT PRIMARY KEY);`);
  const insertScore = db.prepare('INSERT OR IGNORE INTO tetris_scores VALUES(?,?,?,?,?,?,?,?,?,?)');
  const saveScores = (room: RoomSnapshot, passwordHash: string | null, finishedAt: number) => {
    if (room.game !== 'tetris' || room.status !== 'finished' || passwordHash) return;
    const state = room.state as import('./shared/types.js').TetrisState;
    if (state.mode !== 'solo' && state.mode !== 'versus') return;
    for (const player of room.players) {
      const value = state.players?.[player.id];
      if (!value || !Number.isSafeInteger(value.score) || value.score < 0 || !Number.isSafeInteger(value.lines) || value.lines < 0) continue;
      const outcome = state.mode === 'solo' ? null : state.draw ? 'draw' : state.winnerId === player.id ? 'win' : 'loss';
      insertScore.run(JSON.stringify([room.id, room.stateVersion, player.id]), room.id, state.mode, player.name, value.score, value.lines, Math.floor(value.lines / 10) + 1, outcome, state.mode === 'versus' ? room.players.find(other => other.id !== player.id)?.name ?? null : null, finishedAt);
    }
  };
  db.transaction(() => {
    if (db.prepare('SELECT id FROM data_migrations WHERE id=?').get('tetris-solo-ranking-v1')) return;
    const rows = db.prepare("SELECT * FROM sessions WHERE game='tetris' AND status='finished' AND password_hash IS NULL").all() as StoredSession[];
    for (const row of rows) {
      try {
        const result = JSON.parse(row.result ?? 'null'), state = JSON.parse(row.final_state ?? 'null');
        if (state?.mode !== 'solo' || typeof result?.playerName !== 'string' || typeof result?.playerId !== 'string') continue;
        saveScores({ id: row.id, game: 'tetris', status: 'finished', hostId: row.host_id, players: [{ id: result.playerId, name: result.playerName, connected: false }], config: {}, state, messages: [], stateVersion: 0 }, null, row.finished_at ?? row.created_at);
      } catch { /* Ignore incomplete legacy results. */ }
    }
    db.prepare('INSERT INTO data_migrations VALUES(?)').run('tetris-solo-ranking-v1');
  })();
  return {
    getSoloSubmission(id: string) { return db.prepare('SELECT session_id,owner_hash FROM solo_submissions WHERE submission_id=?').get(id) as { session_id: string; owner_hash: string } | undefined; },
    saveSoloResult(submissionId: string, room: RoomSnapshot, passwordHash: string | null, ownerHash: string, result: unknown) {
      db.transaction(() => {
        const now = Date.now();
        db.prepare('INSERT INTO sessions(id,game,host_id,password_hash,owner_delete_token_hash,config,status,created_at,result,finished_at,final_state) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(room.id, 'tetris', room.hostId, passwordHash, ownerHash, JSON.stringify(room.config), 'finished', now, JSON.stringify(result), now, JSON.stringify(room.state));
        saveScores(room, passwordHash, now);
        db.prepare('INSERT INTO solo_submissions VALUES(?,?,?)').run(submissionId, room.id, ownerHash);
        db.prepare('INSERT INTO events(session_id,version,type,payload,created_at) VALUES(?,?,?,?,?)').run(room.id, 1, 'game.started', JSON.stringify(room.config), now);
      })();
    },
    saveSession(room: RoomSnapshot, passwordHash: string | null, ownerDeleteTokenHash: string) { db.prepare('INSERT INTO sessions(id,game,host_id,password_hash,owner_delete_token_hash,config,status,created_at,result,finished_at,final_state) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(room.id, room.game, room.hostId, passwordHash, ownerDeleteTokenHash, JSON.stringify(room.config), room.status, Date.now(), null, null, null); },
    finishSession(room: RoomSnapshot, result: unknown) {
      db.transaction(() => {
        const now = Date.now();
        db.prepare('UPDATE sessions SET status=?, finished_at=?, result=?, final_state=?, config=? WHERE id=?').run('finished', now, JSON.stringify(result), JSON.stringify(room.state), JSON.stringify(room.config), room.id);
        const session = db.prepare('SELECT password_hash FROM sessions WHERE id=?').get(room.id) as { password_hash: string | null } | undefined;
        if (session) saveScores(room, session.password_hash, now);
      })();
    },
    getTetrisLeaderboard(mode: 'solo' | 'versus') {
      return db.prepare(`SELECT t.id,t.room_id AS roomId,(SELECT submission_id FROM solo_submissions WHERE session_id=t.room_id LIMIT 1) AS submissionId,t.mode,t.name,t.score,t.lines,t.level,t.outcome,t.opponent,t.finished_at AS finishedAt
        FROM tetris_scores t JOIN sessions s ON s.id=t.room_id WHERE t.mode=? AND s.password_hash IS NULL
        ORDER BY t.score DESC,t.lines DESC,t.finished_at ASC,t.id ASC LIMIT 20`).all(mode).map(value => {
        const row = value as Omit<TetrisLeaderboardEntry, 'playerId'> & { submissionId: string | null };
        const { submissionId, ...entry } = row;
        let playerId = '';
        try { const parts: unknown = JSON.parse(entry.id); if (Array.isArray(parts) && typeof parts[2] === 'string') playerId = parts[2]; } catch { /* Legacy entries may not contain a player id. */ }
        return { ...entry, playerId: submissionId ?? (playerId && playerId !== 'solo' ? playerId : 'legacy:' + entry.roomId) };
      }) as TetrisLeaderboardEntry[];
    },
    getSession(id: string) { return db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as StoredSession | undefined; },
    getHistory(ids: string[]) { if (!ids.length) return [] as StoredSession[]; return db.prepare(`SELECT * FROM sessions WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY COALESCE(finished_at,created_at) DESC`).all(...ids) as StoredSession[]; },
    listSessions() { return db.prepare("SELECT s.id, s.game, s.status, s.created_at, s.finished_at, COALESCE(MAX(e.created_at), s.created_at) AS last_played_at, COUNT(CASE WHEN e.type = 'game.started' THEN 1 END) AS play_count FROM sessions s LEFT JOIN events e ON e.session_id=s.id GROUP BY s.id ORDER BY last_played_at DESC").all() as Array<{ id: string; game: GameType; status: string; created_at: number; finished_at: number | null; last_played_at: number; play_count: number }>; },
    deleteSession(id: string) { const transaction = db.transaction(() => { db.prepare('DELETE FROM tetris_scores WHERE room_id=?').run(id); db.prepare('DELETE FROM events WHERE session_id=?').run(id); db.prepare("DELETE FROM messages WHERE channel_id=? AND channel_type='room'").run(id); db.prepare('DELETE FROM sessions WHERE id=?').run(id); }); transaction(); },
    saveEvent(roomId: string, version: number, type: string, payload: unknown) { db.prepare('INSERT INTO events(session_id,version,type,payload,created_at) VALUES(?,?,?,?,?)').run(roomId, version, type, JSON.stringify(payload), Date.now()); },
    getEvents(roomId: string) { return db.prepare('SELECT version,type,payload,created_at FROM events WHERE session_id=? ORDER BY id').all(roomId); },
    saveMessage(row: { id: string; channelId: string; channelType: string; playerName: string; text: string; at: number }) { db.prepare('INSERT INTO messages(id,session_id,channel_id,channel_type,player_name,text,created_at) VALUES(?,?,?,?,?,?,?)').run(row.id, row.channelId, row.channelId, row.channelType, row.playerName, row.text, row.at); },
    getMessages(channelId: string, channelType = 'room', limit = 100) { return db.prepare('SELECT id,channel_id,channel_type,player_name,text,created_at FROM messages WHERE channel_id=? AND channel_type=? ORDER BY created_at DESC LIMIT ?').all(channelId, channelType, limit).reverse() as StoredMessage[]; },
    saveTemplate(row: { id: string; game: GameType; config: Record<string, unknown>; shareCode?: string }) { db.prepare('INSERT INTO game_templates VALUES(?,?,?,?,?)').run(row.id, row.game, JSON.stringify(row.config), Date.now(), row.shareCode ?? null); },
    getTemplate(id: string) { return db.prepare('SELECT * FROM game_templates WHERE id=? OR share_code=?').get(id, id) as { id: string; game: GameType; config: string; created_at: number; share_code: string | null } | undefined; },
    deleteTemplate(id: string) { return db.prepare('DELETE FROM game_templates WHERE id=?').run(id).changes > 0; },
  };
}
export type DatabasePort = ReturnType<typeof createDatabase>;
