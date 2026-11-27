"use strict";
// Admin tool (run on the server): set a new password for an account and log
// out all of its devices. There is no email reset, so this is the recovery path.
// Usage: npm run reset-password -- <username>
const readline = require("readline");
const config = require("../src/config");
const { openDb } = require("../src/db");
const auth = require("../src/auth");

const username = auth.normalizeUsername(process.argv[2]);
if(!username){ console.error("Usage: npm run reset-password -- <username>"); process.exit(1); }
const db = openDb(config.dbPath);
const user = db.prepare("SELECT id, username FROM users WHERE username = ?").get(username);
if(!user){ console.error("No such account: " + username); process.exit(1); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.stdoutMuted = true;
rl._writeToOutput = function(s){ if(!rl.stdoutMuted || /\n/.test(s)) rl.output.write(s); };
process.stdout.write("New password for " + user.username + ": ");
rl.question("", async function(pw){
  rl.close();
  process.stdout.write("\n");
  const err = auth.validatePassword(pw, user.username);
  if(err){ console.error(err); process.exit(1); }
  db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?")
    .run(await auth.hashPassword(pw), new Date().toISOString(), user.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  console.log("Password changed and all sessions logged out for " + user.username + ".");
  db.close();
});
