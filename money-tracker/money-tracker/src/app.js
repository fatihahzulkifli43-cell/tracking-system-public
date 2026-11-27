"use strict";
const path = require("path");
const express = require("express");
const auth = require("./auth");

/*
  ACCESS CONTROL
  --------------
  • Every /api route except register/login requires a valid session.
  • The user is taken ONLY from the session (req.user.id). No route accepts a
    user id, username or profile id from the browser for data access.
  • Every SQL statement that reads, changes or deletes financial data has
    "WHERE user_id = ?" bound to req.user.id, so one account can never reach
    another account's rows — even with a guessed receipt key.
  • State-changing requests also need the X-Requested-With header and (when the
    browser sends one) a same-origin Origin header: blocks cross-site requests.
*/

const RECEIPT_KEY_RE = /^(\d{4}-(?:0[1-9]|1[0-2]))\|(rhb|maybank|tng|sp|asnb)\|([A-Za-z0-9_-]{1,40})$/;
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];

// Check the file really is the image type it claims (by its first bytes).
function sniffImage(buf){
  if(!buf || buf.length < 12) return null;
  if(buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  if(buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return "image/png";
  if(buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if(buf.slice(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if(buf.slice(4, 8).toString("ascii") === "ftyp"){
    const brand = buf.slice(8, 12).toString("ascii");
    if(/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return brand.startsWith("mif") || brand.startsWith("msf") ? "image/heif" : "image/heic";
  }
  return null;
}

function isLocalRequest(req){
  const h = String(req.hostname || "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function createApp(db, config){
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  const sessions = auth.makeSessionStore(db, config);
  const loginIpLimiter = auth.makeLimiter(30, 15 * 60 * 1000);
  const loginUserLimiter = auth.makeLimiter(8, 15 * 60 * 1000);
  const registerLimiter = auth.makeLimiter(10, 60 * 60 * 1000);
  const passwordLimiter = auth.makeLimiter(8, 15 * 60 * 1000);

  const cleanupTimer = setInterval(function(){ try{ sessions.cleanup(); }catch(e){} }, 60 * 60 * 1000);
  cleanupTimer.unref();

  /* ---------------- prepared statements ---------------- */
  const q = {
    userByName: db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?"),
    userById: db.prepare("SELECT id, username, password_hash, created_at FROM users WHERE id = ?"),
    insertUser: db.prepare("INSERT INTO users (username, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?)"),
    updatePassword: db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?"),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),

    getState: db.prepare("SELECT data, version, updated_at FROM tracker_state WHERE user_id = ?"),
    getStateVersion: db.prepare("SELECT version FROM tracker_state WHERE user_id = ?"),
    insertState: db.prepare("INSERT INTO tracker_state (user_id, data, version, updated_at) VALUES (?, ?, 1, ?)"),
    updateState: db.prepare("UPDATE tracker_state SET data = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ?"),

    listReceipts: db.prepare("SELECT key, size, saved_at FROM receipts WHERE user_id = ?"),
    getReceipt: db.prepare("SELECT mime, size, name, data, saved_at FROM receipts WHERE user_id = ? AND key = ?"),
    receiptBytes: db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM receipts WHERE user_id = ? AND key <> ?"),
    putReceipt: db.prepare(`INSERT INTO receipts (user_id, key, month, account, tx_id, mime, size, name, data, saved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET mime = excluded.mime, size = excluded.size, name = excluded.name,
        data = excluded.data, saved_at = excluded.saved_at`),
    delReceipt: db.prepare("DELETE FROM receipts WHERE user_id = ? AND key = ?"),
    delReceiptsMonth: db.prepare("DELETE FROM receipts WHERE user_id = ? AND month = ?"),
    delReceiptsAll: db.prepare("DELETE FROM receipts WHERE user_id = ?")
  };

  /* ---------------- security headers (every response) ---------------- */
  app.use(function(req, res, next){
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy": "geolocation=(), microphone=(), camera=(self), payment=()",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
        "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    });
    if(req.secure) res.set("Strict-Transport-Security", "max-age=31536000");
    next();
  });

  /* ---------------- HTTPS only (production, except localhost) ---------------- */
  app.use(function(req, res, next){
    if(config.requireHttps && !req.secure && !isLocalRequest(req)){
      return res.status(403).type("text/plain").send("HTTPS is required. See README: run behind an HTTPS reverse proxy.");
    }
    next();
  });

  /* ---------------- static front end (contains no user data) ---------------- */
  app.use(express.static(path.join(__dirname, "..", "public"), {
    index: "index.html",
    setHeaders: function(res){ res.set("Cache-Control", "no-cache"); }
  }));

  /* ---------------- API plumbing ---------------- */
  app.use("/api", function(req, res, next){
    res.set("Cache-Control", "no-store");
    // CSRF protection for anything that changes data
    if(req.method !== "GET" && req.method !== "HEAD"){
      if(req.get("X-Requested-With") !== "MoneyTracker"){
        return res.status(403).json({ error: "csrf", message: "Permintaan ditolak." });
      }
      const origin = req.get("Origin");
      if(origin){
        let ok = false;
        try{ ok = new URL(origin).host === req.get("Host"); }catch(e){ ok = false; }
        if(!ok) return res.status(403).json({ error: "origin", message: "Permintaan dari laman lain ditolak." });
      }
    }
    // resolve session → req.user
    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME];
    const s = sessions.resolve(token);
    if(s) req.user = { id: s.userId, username: s.username, sessionHash: s.tokenHash };
    next();
  });

  function requireUser(req, res, next){
    if(!req.user) return res.status(401).json({ error: "unauthenticated", message: "Sila log masuk." });
    next();
  }

  const json = express.json({ limit: config.maxStateBytes + 64 * 1024 });
  function wrap(fn){ return function(req, res, next){ Promise.resolve(fn(req, res, next)).catch(next); }; }

  /* ================= AUTH ================= */
  app.get("/api/auth/config", function(req, res){
    res.json({ allowRegistration: config.allowRegistration });
  });

  app.post("/api/auth/register", json, wrap(async function(req, res){
    if(!config.allowRegistration) return res.status(403).json({ error: "closed", message: "Pendaftaran akaun baru ditutup." });
    const ip = req.ip;
    if(registerLimiter.blocked(ip)) return res.status(429).json({ error: "rate", message: "Terlalu banyak cubaan. Cuba lagi kemudian." });
    registerLimiter.hit(ip);
    const username = auth.normalizeUsername(req.body && req.body.username);
    const password = req.body && req.body.password;
    const uErr = auth.validateUsername(username);
    if(uErr) return res.status(400).json({ error: "username", message: uErr });
    const pErr = auth.validatePassword(password, username);
    if(pErr) return res.status(400).json({ error: "password", message: pErr });
    if(q.userByName.get(username)) return res.status(409).json({ error: "taken", message: "Nama pengguna sudah digunakan." });
    const hash = await auth.hashPassword(password);
    const now = new Date().toISOString();
    let info;
    try{ info = q.insertUser.run(username, hash, now, now); }
    catch(e){
      if(String(e.code).startsWith("SQLITE_CONSTRAINT")) return res.status(409).json({ error: "taken", message: "Nama pengguna sudah digunakan." });
      throw e;
    }
    const token = sessions.create(info.lastInsertRowid, req.get("User-Agent"));
    auth.setSessionCookie(res, req, token, config);
    res.status(201).json({ username });
  }));

  app.post("/api/auth/login", json, wrap(async function(req, res){
    const username = auth.normalizeUsername(req.body && req.body.username);
    const password = String((req.body && req.body.password) || "");
    const ip = req.ip;
    if(loginIpLimiter.blocked(ip) || loginUserLimiter.blocked(username)){
      return res.status(429).json({ error: "rate", message: "Terlalu banyak cubaan log masuk. Tunggu 15 minit dan cuba lagi." });
    }
    const user = username ? q.userByName.get(username) : null;
    const valid = user ? await auth.verifyPassword(password, user.password_hash)
                       : (await auth.verifyPassword(password, await auth.dummyHash()), false);
    if(!valid){
      loginIpLimiter.hit(ip);
      loginUserLimiter.hit(username);
      return res.status(401).json({ error: "invalid", message: "Nama pengguna atau kata laluan salah." });
    }
    loginUserLimiter.reset(username);
    const token = sessions.create(user.id, req.get("User-Agent"));
    auth.setSessionCookie(res, req, token, config);
    res.json({ username: user.username });
  }));

  app.post("/api/auth/logout", function(req, res){
    if(req.user) sessions.destroy(req.user.sessionHash);
    auth.clearSessionCookie(res, req, config);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", requireUser, function(req, res){
    const u = q.userById.get(req.user.id);
    if(!u) return res.status(401).json({ error: "unauthenticated" });
    res.json({ username: u.username, createdAt: u.created_at });
  });

  app.post("/api/auth/password", requireUser, json, wrap(async function(req, res){
    const key = "pw:" + req.user.id;
    if(passwordLimiter.blocked(key)) return res.status(429).json({ error: "rate", message: "Terlalu banyak cubaan. Cuba lagi kemudian." });
    const u = q.userById.get(req.user.id);
    const current = String((req.body && req.body.currentPassword) || "");
    const next = req.body && req.body.newPassword;
    if(!(await auth.verifyPassword(current, u.password_hash))){
      passwordLimiter.hit(key);
      return res.status(401).json({ error: "invalid", message: "Kata laluan semasa salah." });
    }
    const pErr = auth.validatePassword(next, u.username);
    if(pErr) return res.status(400).json({ error: "password", message: pErr });
    q.updatePassword.run(await auth.hashPassword(next), new Date().toISOString(), u.id);
    sessions.destroyOthers(u.id, req.user.sessionHash); // log out every other device
    res.json({ ok: true });
  }));

  // Permanently delete the account and ALL its data (state, receipts, sessions).
  app.delete("/api/account", requireUser, json, wrap(async function(req, res){
    const key = "pw:" + req.user.id;
    if(passwordLimiter.blocked(key)) return res.status(429).json({ error: "rate", message: "Terlalu banyak cubaan. Cuba lagi kemudian." });
    const u = q.userById.get(req.user.id);
    if(!(await auth.verifyPassword(String((req.body && req.body.password) || ""), u.password_hash))){
      passwordLimiter.hit(key);
      return res.status(401).json({ error: "invalid", message: "Kata laluan salah." });
    }
    q.deleteUser.run(u.id); // ON DELETE CASCADE removes sessions, tracker_state and receipts
    auth.clearSessionCookie(res, req, config);
    res.json({ ok: true });
  }));

  /* ================= TRACKER STATE (own data only) ================= */
  app.get("/api/state", requireUser, function(req, res){
    const row = q.getState.get(req.user.id);
    if(!row) return res.json({ data: null, version: 0, updatedAt: null });
    res.json({ data: JSON.parse(row.data), version: row.version, updatedAt: row.updated_at });
  });

  // Optimistic locking: the client sends the version it last saw. A stale
  // version (e.g. another tab saved meanwhile) gets 409 instead of silently
  // overwriting newer data.
  app.put("/api/state", requireUser, json, function(req, res){
    const body = req.body || {};
    const data = body.data;
    const version = Number(body.version);
    if(!data || typeof data !== "object" || Array.isArray(data) || !data.months || typeof data.months !== "object"){
      return res.status(400).json({ error: "invalid", message: "Format data tidak sah." });
    }
    if(!Number.isInteger(version) || version < 0) return res.status(400).json({ error: "version", message: "Versi tidak sah." });
    const text = JSON.stringify(data);
    if(Buffer.byteLength(text) > config.maxStateBytes) return res.status(413).json({ error: "too_large", message: "Data terlalu besar." });
    const now = new Date().toISOString();
    const result = db.transaction(function(){
      const cur = q.getStateVersion.get(req.user.id);
      if(!cur){
        if(version !== 0) return { conflict: 0 };
        q.insertState.run(req.user.id, text, now);
        return { version: 1 };
      }
      if(cur.version !== version) return { conflict: cur.version };
      q.updateState.run(text, now, req.user.id, version);
      return { version: version + 1 };
    })();
    if(result.conflict !== undefined){
      return res.status(409).json({ error: "conflict", version: result.conflict,
        message: "Data telah dikemas kini di tab/peranti lain. Muat semula untuk dapatkan versi terkini." });
    }
    res.json({ version: result.version, updatedAt: now });
  });

  /* ================= RECEIPTS (own receipts only) ================= */
  function parseKey(req, res){
    const key = String(req.params.key || "");
    const m = key.match(RECEIPT_KEY_RE);
    if(!m){ res.status(400).json({ error: "key", message: "Rujukan resit tidak sah." }); return null; }
    return { key, month: m[1], account: m[2], txId: m[3] };
  }

  app.get("/api/receipts", requireUser, function(req, res){
    const rows = q.listReceipts.all(req.user.id);
    res.json({ receipts: rows.map(function(r){ return { key: r.key, size: r.size, savedAt: r.saved_at }; }) });
  });

  app.get("/api/receipts/:key", requireUser, function(req, res){
    const k = parseKey(req, res); if(!k) return;
    const row = q.getReceipt.get(req.user.id, k.key);
    if(!row) return res.status(404).json({ error: "not_found", message: "Resit tidak dijumpai." });
    res.set({
      "Content-Type": row.mime,
      "Content-Length": String(row.data.length),
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
      "X-Receipt-Saved-At": row.saved_at,
      "X-Receipt-Name": encodeURIComponent(row.name || "receipt")
    });
    res.end(row.data);
  });

  app.put("/api/receipts/:key", requireUser,
    express.raw({ type: function(){ return true; }, limit: config.maxReceiptBytes }),
    function(req, res){
      const k = parseKey(req, res); if(!k) return;
      const buf = req.body;
      if(!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: "empty", message: "Tiada gambar." });
      const sniffed = sniffImage(buf);
      if(!sniffed || IMAGE_TYPES.indexOf(sniffed) === -1){
        return res.status(415).json({ error: "type", message: "Hanya gambar JPEG, PNG, WebP, GIF atau HEIC dibenarkan." });
      }
      const used = q.receiptBytes.get(req.user.id, k.key).total;
      if(used + buf.length > config.receiptQuotaBytes){
        return res.status(413).json({ error: "quota", message: "Ruang simpanan resit akaun ini sudah penuh." });
      }
      let name = "receipt";
      try{ name = decodeURIComponent(String(req.get("X-Receipt-Name") || "receipt")).slice(0, 120); }catch(e){}
      const savedAt = new Date().toISOString();
      q.putReceipt.run(req.user.id, k.key, k.month, k.account, k.txId, sniffed, buf.length, name, buf, savedAt);
      res.json({ key: k.key, size: buf.length, savedAt });
    });

  app.delete("/api/receipts/:key", requireUser, function(req, res){
    const k = parseKey(req, res); if(!k) return;
    q.delReceipt.run(req.user.id, k.key);
    res.json({ ok: true });
  });

  // Bulk delete: ?month=YYYY-MM (Reset/Delete Month) or ?all=1 (Reset All Data)
  app.delete("/api/receipts", requireUser, function(req, res){
    if(req.query.all === "1"){
      const r = q.delReceiptsAll.run(req.user.id);
      return res.json({ deleted: r.changes });
    }
    const month = String(req.query.month || "");
    if(!MONTH_RE.test(month)) return res.status(400).json({ error: "month", message: "Bulan tidak sah." });
    const r = q.delReceiptsMonth.run(req.user.id, month);
    res.json({ deleted: r.changes });
  });

  /* ---------------- fallbacks ---------------- */
  app.use("/api", function(req, res){ res.status(404).json({ error: "not_found" }); });
  // eslint-disable-next-line no-unused-vars
  app.use(function(err, req, res, next){
    if(err && (err.type === "entity.too.large")) return res.status(413).json({ error: "too_large", message: "Fail/data terlalu besar." });
    if(err && (err.type === "entity.parse.failed")) return res.status(400).json({ error: "bad_json", message: "Data tidak sah." });
    console.error(err);
    res.status(500).json({ error: "server", message: "Ralat pelayan." });
  });

  app.locals.sessions = sessions;
  return app;
}

module.exports = { createApp, sniffImage };
