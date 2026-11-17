import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const file = process.env.DB_PATH || "./data/tempo.db";
fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT,
  name TEXT,
  tokens TEXT,
  timezone TEXT DEFAULT 'UTC',
  ingest_token TEXT UNIQUE,
  settings TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now'))
);
-- raw location samples (from the open app or a phone automation)
CREATE TABLE IF NOT EXISTS pings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,           -- epoch ms
  lat REAL NOT NULL, lng REAL NOT NULL, acc REAL,
  place_id INTEGER,
  source TEXT
);
CREATE INDEX IF NOT EXISTS pings_user_ts ON pings(user_id, ts);
-- places learned by clustering pings
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT, kind TEXT DEFAULT 'unknown',
  lat REAL NOT NULL, lng REAL NOT NULL, radius REAL DEFAULT 120,
  guessed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
-- local mirror of Google Calendar events (used for learning)
CREATE TABLE IF NOT EXISTS events (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gcal_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  all_day INTEGER DEFAULT 0,
  summary TEXT, location TEXT, description TEXT,
  category TEXT,
  tempo_kind TEXT,
  PRIMARY KEY (user_id, gcal_id)
);
CREATE INDEX IF NOT EXISTS events_user_start ON events(user_id, start_ms);
-- study proposals and what happened to them (the feedback loop)
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  subject TEXT, reason TEXT, score REAL,
  status TEXT DEFAULT 'proposed', -- proposed | accepted | rejected | completed | skipped
  gcal_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

export const json = (s, fallback) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};

export const DEFAULT_SETTINGS = {
  sessionMinutes: 90,
  maxSessionsPerDay: 2,
  bufferMinutes: 15,
  earliestHour: 8,
  latestHour: 23,
  subjects: [],
};

export function getSettings(user) {
  return { ...DEFAULT_SETTINGS, ...json(user.settings, {}) };
}
