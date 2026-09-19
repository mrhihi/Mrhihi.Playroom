import Database from 'better-sqlite3';
import type { GameType, RoomSnapshot } from './shared/types.js';
export type StoredSession = { id: string; game: GameType; host_id: string; password_hash: string | null; owner_delete_token_hash: string | null; config: string; status: string; created_at: number; finished_at: number | null; result: string | null; final_state: string | null };
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
  return {
    saveSession(room: RoomSnapshot, passwordHash: string | null, ownerDeleteTokenHash: string) { db.prepare('INSERT INTO sessions(id,game,host_id,password_hash,owner_delete_token_hash,config,status,created_at,result,finished_at,final_state) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(room.id, room.game, room.hostId, passwordHash, ownerDeleteTokenHash, JSON.stringify(room.config), room.status, Date.now(), null, null, null); },
    finishSession(room: RoomSnapshot, result: unknown) { db.prepare('UPDATE sessions SET status=?, finished_at=?, result=?, final_state=? WHERE id=?').run('finished', Date.now(), JSON.stringify(result), JSON.stringify(room.state), room.id); },
    getSession(id: string) { return db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as StoredSession | undefined; },
    getHistory(ids: string[]) { if (!ids.length) return [] as StoredSession[]; return db.prepare(`SELECT * FROM sessions WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY COALESCE(finished_at,created_at) DESC`).all(...ids) as StoredSession[]; },
    listSessions() { return db.prepare("SELECT s.id, s.game, s.status, s.created_at, s.finished_at, COALESCE(MAX(e.created_at), s.created_at) AS last_played_at, COUNT(CASE WHEN e.type = 'game.started' THEN 1 END) AS play_count FROM sessions s LEFT JOIN events e ON e.session_id=s.id GROUP BY s.id ORDER BY last_played_at DESC").all() as Array<{ id: string; game: GameType; status: string; created_at: number; finished_at: number | null; last_played_at: number; play_count: number }>; },
    deleteSession(id: string) { const transaction = db.transaction(() => { db.prepare('DELETE FROM events WHERE session_id=?').run(id); db.prepare("DELETE FROM messages WHERE channel_id=? AND channel_type='room'").run(id); db.prepare('DELETE FROM sessions WHERE id=?').run(id); }); transaction(); },
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
