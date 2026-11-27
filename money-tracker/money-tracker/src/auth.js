"use strict";
const crypto = require("crypto");
const { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);

/* ============================================================
   PASSWORDS — scrypt (memory-hard), random 16-byte salt per user.
   Stored as: scrypt$N$r$p$saltB64$hashB64
   ============================================================ */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

async function hashPassword(password){
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

async function verifyPassword(password, stored){
  const parts = String(stored || "").split("$");
  if(parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  const actual = await scrypt(String(password).normalize("NFKC"), salt, expected.length,
    { N, r, p, maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Used when the username doesn't exist, so the response time doesn't reveal it.
let dummyHashPromise = null;
function dummyHash(){
  if(!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomBytes(16).toString("hex"));
  return dummyHashPromise;
}

function normalizeUsername(u){ return String(u || "").trim().toLowerCase(); }
function validateUsername(u){
  if(!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(u)){
    return "Nama pengguna mesti 3–32 aksara: huruf, nombor, titik, sengkang atau garis bawah.";
  }
  return null;
}
function validatePassword(pw, username){
  if(typeof pw !== "string" || pw.length < 10) return "Kata laluan mesti sekurang-kurangnya 10 aksara.";
  if(pw.length > 200) return "Kata laluan terlalu panjang (maksimum 200 aksara).";
  if(username && pw.toLowerCase().includes(username)) return "Kata laluan tidak boleh mengandungi nama pengguna.";
  return null;
}

/* ============================================================
   SESSIONS — random 256-bit token in an HttpOnly, SameSite=Strict
   cookie. The database stores only its SHA-256 hash.
   ============================================================ */
const COOKIE_NAME = "mt_session";
const DAY = 24 * 60 * 60 * 1000;

function sha256(s){ return crypto.createHash("sha256").update(s).digest("hex"); }

function parseCookies(header){
  const out = {};
  String(header || "").split(";").forEach(function(part){
    const i = part.indexOf("=");
    if(i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if(k) { try{ out[k] = decodeURIComponent(v); }catch(e){ out[k] = v; } }
  });
  return out;
}

function makeSessionStore(db, config){
  const insert = db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)");
  const lookup = db.prepare(
    "SELECT s.token_hash, s.user_id, s.last_seen, s.expires_at, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?");
  const touch = db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?");
  const del = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const delOthers = db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?");
  const purge = db.prepare("DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?");

  function create(userId, userAgent){
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    insert.run(sha256(token), userId, now, now, now + config.sessionMaxAgeDays * DAY, String(userAgent || "").slice(0, 200));
    return token;
  }

  function resolve(token){
    if(!token || typeof token !== "string" || token.length > 100) return null;
    const hash = sha256(token);
    const row = lookup.get(hash);
    if(!row) return null;
    const now = Date.now();
    if(row.expires_at < now || row.last_seen < now - config.sessionIdleDays * DAY){
      del.run(hash);
      return null;
    }
    if(now - row.last_seen > 5 * 60 * 1000) touch.run(now, hash);
    return { tokenHash: hash, userId: row.user_id, username: row.username };
  }

  function destroy(tokenHash){ del.run(tokenHash); }
  function destroyOthers(userId, keepHash){ delOthers.run(userId, keepHash); }
  function cleanup(){ const now = Date.now(); purge.run(now, now - config.sessionIdleDays * DAY); }

  return { create, resolve, destroy, destroyOthers, cleanup };
}

function setSessionCookie(res, req, token, config){
  const parts = [
    COOKIE_NAME + "=" + token,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=" + Math.floor(config.sessionMaxAgeDays * DAY / 1000)
  ];
  if(config.cookieSecure || req.secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
function clearSessionCookie(res, req, config){
  const parts = [COOKIE_NAME + "=", "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if(config.cookieSecure || req.secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

/* ============================================================
   RATE LIMITING (in memory) — slows down password guessing.
   ============================================================ */
function makeLimiter(max, windowMs){
  const hits = new Map();
  function prune(now){
    for(const [k, v] of hits) if(now - v.start > windowMs) hits.delete(k);
  }
  return {
    blocked(key){
      const v = hits.get(key);
      if(!v) return false;
      if(Date.now() - v.start > windowMs){ hits.delete(key); return false; }
      return v.count >= max;
    },
    hit(key){
      const now = Date.now();
      if(hits.size > 10000) prune(now);
      const v = hits.get(key);
      if(!v || now - v.start > windowMs) hits.set(key, { count: 1, start: now });
      else v.count++;
    },
    reset(key){ hits.delete(key); }
  };
}

module.exports = {
  hashPassword, verifyPassword, dummyHash,
  normalizeUsername, validateUsername, validatePassword,
  makeSessionStore, setSessionCookie, clearSessionCookie, parseCookies, COOKIE_NAME,
  makeLimiter
};
