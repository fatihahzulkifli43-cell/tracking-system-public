"use strict";
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  password_changed_at TEXT NOT NULL
);

-- Only a SHA-256 hash of each session token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- One tracker document per user (same structure the app always used).
CREATE TABLE IF NOT EXISTS tracker_state (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Receipt images, owned by a user. Key = "YYYY-MM|account|txId" (unique per user).
CREATE TABLE IF NOT EXISTS receipts (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  month     TEXT NOT NULL,
  account   TEXT NOT NULL,
  tx_id     TEXT NOT NULL,
  mime      TEXT NOT NULL,
  size      INTEGER NOT NULL,
  name      TEXT,
  data      BLOB NOT NULL,
  saved_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS receipts_user_month ON receipts(user_id, month);
`;

function openDb(file){
  if(file !== ":memory:"){
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  if(file !== ":memory:"){
    try{ fs.chmodSync(file, 0o600); }catch(e){ /* not supported on this OS */ }
  }
  return db;
}

module.exports = { openDb };
