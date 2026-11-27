"use strict";
// Safe online backup of the database (works while the server is running).
// Usage: npm run backup            -> backups/money-tracker-YYYY-MM-DD-HHMM.db
//        node scripts/backup.js out.db
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const config = require("../src/config");

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const out = path.resolve(process.argv[2] || path.join(__dirname, "..", "backups", "money-tracker-" + stamp + ".db"));
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
db.backup(out).then(function(){
  try{ fs.chmodSync(out, 0o600); }catch(e){}
  console.log("Backup written: " + out);
  db.close();
}).catch(function(err){ console.error("Backup failed:", err.message); process.exit(1); });
