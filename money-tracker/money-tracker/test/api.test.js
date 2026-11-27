"use strict";
// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("../src/db");
const { createApp } = require("../src/app");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(20, 1)]);

function setup(overrides){
  const config = Object.assign({
    trustProxy: false, allowRegistration: true, requireHttps: false, cookieSecure: false,
    sessionMaxAgeDays: 30, sessionIdleDays: 14, receiptQuotaBytes: 1024 * 1024,
    maxReceiptBytes: 512 * 1024, maxStateBytes: 256 * 1024
  }, overrides || {});
  const db = openDb(":memory:");
  const app = createApp(db, config);
  return new Promise(function(resolve){
    const server = app.listen(0, "127.0.0.1", function(){
      const base = "http://127.0.0.1:" + server.address().port;
      resolve({ db, server, base, close: function(){ server.close(); db.close(); } });
    });
  });
}

// tiny cookie-keeping client
function client(base){
  let cookie = "";
  async function call(method, path, body, opts){
    opts = opts || {};
    const headers = Object.assign({}, opts.headers);
    if(cookie && !opts.noCookie) headers.Cookie = cookie;
    if(method !== "GET" && !opts.noCsrf) headers["X-Requested-With"] = "MoneyTracker";
    let payload;
    if(Buffer.isBuffer(body)){ payload = body; headers["Content-Type"] = opts.type || "image/png"; }
    else if(body !== undefined){ payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
    const res = await fetch(base + path, { method, headers, body: payload });
    const sc = res.headers.get("set-cookie");
    if(sc){ const m = sc.match(/mt_session=([^;]*)/); if(m) cookie = m[1] ? "mt_session=" + m[1] : ""; }
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers, setCookie: sc };
  }
  return { call, get cookie(){ return cookie; }, set cookie(v){ cookie = v; } };
}

const stateA = { schemaVersion: 2, selectedMonth: "2026-11", months: { "2026-11": { income: 5000, expenses: [{ id: "exp1", name: "Rent A", amount: 1200, paid: false }] } } };
const stateB = { schemaVersion: 2, selectedMonth: "2026-11", months: { "2026-11": { income: 777, expenses: [{ id: "exp1", name: "Rent B", amount: 10, paid: true }] } } };

test("registration, login, sessions and password storage", async function(){
  const env = await setup();
  try{
    const a = client(env.base);
    let r = await a.call("POST", "/api/auth/register", { username: "Aisyah", password: "short" });
    assert.equal(r.status, 400);
    r = await a.call("POST", "/api/auth/register", { username: "Aisyah", password: "correct horse battery" });
    assert.equal(r.status, 201);
    assert.equal(r.data.username, "aisyah");
    assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /SameSite=Strict/);
    r = await a.call("GET", "/api/auth/me"); assert.equal(r.status, 200); assert.equal(r.data.username, "aisyah");

    // duplicate (case-insensitive)
    const x = client(env.base);
    r = await x.call("POST", "/api/auth/register", { username: "AISYAH", password: "another long password" });
    assert.equal(r.status, 409);

    // password is hashed, not stored in plain text; token stored only as hash
    const row = env.db.prepare("SELECT password_hash FROM users WHERE username = 'aisyah'").get();
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes("correct horse"));
    const token = a.cookie.split("=")[1];
    assert.equal(env.db.prepare("SELECT COUNT(*) c FROM sessions WHERE token_hash = ?").get(token).c, 0);

    // wrong password / unknown user give the same answer
    const b = client(env.base);
    const w1 = await b.call("POST", "/api/auth/login", { username: "aisyah", password: "wrong password!!" });
    const w2 = await b.call("POST", "/api/auth/login", { username: "nobody", password: "wrong password!!" });
    assert.equal(w1.status, 401); assert.equal(w2.status, 401);
    assert.deepEqual(w1.data, w2.data);

    r = await b.call("POST", "/api/auth/login", { username: "aisyah", password: "correct horse battery" });
    assert.equal(r.status, 200);
    // logout kills the session server-side
    const stolen = b.cookie;
    await b.call("POST", "/api/auth/logout");
    const replay = client(env.base); replay.cookie = stolen;
    r = await replay.call("GET", "/api/state"); assert.equal(r.status, 401);
  }finally{ env.close(); }
});

test("unauthenticated requests get nothing", async function(){
  const env = await setup();
  try{
    const anon = client(env.base);
    for(const [m, p] of [["GET", "/api/state"], ["PUT", "/api/state"], ["GET", "/api/receipts"], ["GET", "/api/receipts/2026-11|rhb|wd1"],
                         ["DELETE", "/api/receipts?all=1"], ["GET", "/api/auth/me"], ["DELETE", "/api/account"]]){
      const r = await anon.call(m, p, m === "PUT" ? { data: stateA, version: 0 } : undefined);
      assert.equal(r.status, 401, m + " " + p);
    }
    const forged = client(env.base); forged.cookie = "mt_session=forgedtoken123";
    assert.equal((await forged.call("GET", "/api/state")).status, 401);
  }finally{ env.close(); }
});

test("each account only ever sees and changes its own data", async function(){
  const env = await setup();
  try{
    const a = client(env.base), b = client(env.base);
    await a.call("POST", "/api/auth/register", { username: "usera", password: "password-of-user-a" });
    await b.call("POST", "/api/auth/register", { username: "userb", password: "password-of-user-b" });

    assert.equal((await a.call("PUT", "/api/state", { data: stateA, version: 0 })).status, 200);
    assert.equal((await b.call("PUT", "/api/state", { data: stateB, version: 0 })).status, 200);

    let r = await a.call("GET", "/api/state");
    assert.equal(r.data.data.months["2026-11"].expenses[0].name, "Rent A");
    r = await b.call("GET", "/api/state");
    assert.equal(r.data.data.months["2026-11"].expenses[0].name, "Rent B");

    // Attempts to address another user's data via the request are ignored
    r = await b.call("GET", "/api/state?user=1&userId=1&username=usera");
    assert.equal(r.data.data.months["2026-11"].income, 777);
    r = await b.call("PUT", "/api/state", { data: stateA, version: 1, userId: 1, username: "usera" });
    assert.equal(r.status, 200); // it updated B's own document…
    r = await a.call("GET", "/api/state");
    assert.equal(r.data.data.months["2026-11"].expenses[0].name, "Rent A"); // …A is untouched

    // Same receipt key in both accounts: never crosses over
    const key = encodeURIComponent("2026-11|rhb|wd1");
    assert.equal((await a.call("PUT", "/api/receipts/" + key, PNG, { type: "image/png" })).status, 200);
    r = await b.call("GET", "/api/receipts/" + key); assert.equal(r.status, 404);
    r = await b.call("GET", "/api/receipts"); assert.equal(r.data.receipts.length, 0);
    assert.equal((await b.call("PUT", "/api/receipts/" + key, JPG, { type: "image/jpeg" })).status, 200);
    r = await a.call("GET", "/api/receipts/" + key);
    assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png"); assert.ok(r.data.equals(PNG));
    r = await b.call("GET", "/api/receipts/" + key);
    assert.equal(r.headers.get("content-type"), "image/jpeg");

    // B deleting (single, month, all) only removes B's receipts
    await b.call("DELETE", "/api/receipts/" + key);
    await b.call("DELETE", "/api/receipts?month=2026-11");
    await b.call("DELETE", "/api/receipts?all=1");
    r = await a.call("GET", "/api/receipts"); assert.equal(r.data.receipts.length, 1);

    // Account deletion removes only that account's rows
    r = await b.call("DELETE", "/api/account", { password: "wrong" }); assert.equal(r.status, 401);
    r = await b.call("DELETE", "/api/account", { password: "password-of-user-b" }); assert.equal(r.status, 200);
    assert.equal(env.db.prepare("SELECT COUNT(*) c FROM tracker_state").get().c, 1);
    assert.equal(env.db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id = 2").get().c, 0);
    r = await a.call("GET", "/api/state"); assert.equal(r.data.data.months["2026-11"].income, 5000);
    r = await b.call("GET", "/api/state"); assert.equal(r.status, 401);
  }finally{ env.close(); }
});

test("cross-site request protection", async function(){
  const env = await setup();
  try{
    const a = client(env.base);
    await a.call("POST", "/api/auth/register", { username: "csrfuser", password: "csrf-user-password" });
    let r = await a.call("PUT", "/api/state", { data: stateA, version: 0 }, { noCsrf: true });
    assert.equal(r.status, 403);
    r = await a.call("PUT", "/api/state", { data: stateA, version: 0 }, { headers: { Origin: "https://evil.example" } });
    assert.equal(r.status, 403);
    r = await a.call("DELETE", "/api/receipts?all=1", undefined, { headers: { Origin: "https://evil.example" } });
    assert.equal(r.status, 403);
    r = await a.call("PUT", "/api/state", { data: stateA, version: 0 }, { headers: { Origin: env.base } });
    assert.equal(r.status, 200);
  }finally{ env.close(); }
});

test("stale writes are rejected instead of overwriting newer data", async function(){
  const env = await setup();
  try{
    const a = client(env.base);
    await a.call("POST", "/api/auth/register", { username: "tabs", password: "second-window-pass" });
    assert.equal((await a.call("PUT", "/api/state", { data: stateA, version: 0 })).data.version, 1);
    assert.equal((await a.call("PUT", "/api/state", { data: stateA, version: 1 })).data.version, 2);
    const r = await a.call("PUT", "/api/state", { data: stateB, version: 1 });
    assert.equal(r.status, 409); assert.equal(r.data.version, 2);
    assert.equal((await a.call("PUT", "/api/state", { data: { nope: 1 }, version: 2 })).status, 400);
  }finally{ env.close(); }
});

test("receipt upload validation", async function(){
  const env = await setup();
  try{
    const a = client(env.base);
    await a.call("POST", "/api/auth/register", { username: "uploader", password: "camera-roll-secret" });
    // HTML pretending to be an image is refused
    let r = await a.call("PUT", "/api/receipts/" + encodeURIComponent("2026-11|rhb|wd1"), Buffer.from("<html><script>alert(1)</script></html>"), { type: "image/png" });
    assert.equal(r.status, 415);
    r = await a.call("PUT", "/api/receipts/" + encodeURIComponent("../../etc|rhb|1"), PNG); assert.equal(r.status, 400);
    r = await a.call("PUT", "/api/receipts/" + encodeURIComponent("2026-11|other|1"), PNG); assert.equal(r.status, 400);
    r = await a.call("PUT", "/api/receipts/" + encodeURIComponent("2026-11|rhb|big"), Buffer.concat([PNG, Buffer.alloc(600 * 1024)]));
    assert.equal(r.status, 413);
    r = await a.call("PUT", "/api/receipts/" + encodeURIComponent("2026-11|rhb|ok1"), PNG);
    assert.equal(r.status, 200);
    r = await a.call("GET", "/api/receipts/" + encodeURIComponent("2026-11|rhb|ok1"));
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-security-policy"), /sandbox/);
  }finally{ env.close(); }
});

test("login rate limiting", async function(){
  const env = await setup();
  try{
    const a = client(env.base);
    await a.call("POST", "/api/auth/register", { username: "target", password: "target-password-1" });
    const atk = client(env.base);
    let last;
    for(let i = 0; i < 9; i++) last = await atk.call("POST", "/api/auth/login", { username: "target", password: "guess-" + i + "-xxxx" });
    assert.equal(last.status, 429);
    // even the right password is refused while locked
    const r = await atk.call("POST", "/api/auth/login", { username: "target", password: "target-password-1" });
    assert.equal(r.status, 429);
  }finally{ env.close(); }
});

test("password change logs out other devices; registration can be closed", async function(){
  const env = await setup();
  try{
    const a1 = client(env.base), a2 = client(env.base);
    await a1.call("POST", "/api/auth/register", { username: "changer", password: "first-password-1" });
    await a2.call("POST", "/api/auth/login", { username: "changer", password: "first-password-1" });
    let r = await a1.call("POST", "/api/auth/password", { currentPassword: "nope-nope-nope", newPassword: "second-password-2" });
    assert.equal(r.status, 401);
    r = await a1.call("POST", "/api/auth/password", { currentPassword: "first-password-1", newPassword: "second-password-2" });
    assert.equal(r.status, 200);
    assert.equal((await a1.call("GET", "/api/auth/me")).status, 200);
    assert.equal((await a2.call("GET", "/api/auth/me")).status, 401);
  }finally{ env.close(); }
  const closed = await setup({ allowRegistration: false });
  try{
    const r = await client(closed.base).call("POST", "/api/auth/register", { username: "late", password: "late-password-1" });
    assert.equal(r.status, 403);
  }finally{ closed.close(); }
});

test("HTTPS is enforced in production mode for non-local hosts", async function(){
  const env = await setup({ requireHttps: true });
  try{
    const http = require("http");
    const status = await new Promise(function(resolve, reject){
      const req = http.request(env.base + "/api/auth/config", { headers: { Host: "money.example.com" } }, function(res){ res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 403);
    const local = await fetch(env.base + "/api/auth/config");
    assert.equal(local.status, 200);
  }finally{ env.close(); }
});
