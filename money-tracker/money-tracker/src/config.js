"use strict";
const path = require("path");
const fs = require("fs");

// Minimal .env loader (no dependency). Real environment variables win.
function loadDotEnv(file){
  try{
    const text = fs.readFileSync(file, "utf8");
    for(const line of text.split(/\r?\n/)){
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if(!m || line.trim().startsWith("#")) continue;
      if(process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }catch(e){ /* no .env file is fine */ }
}
loadDotEnv(path.join(__dirname, "..", ".env"));

const env = process.env;
const production = env.NODE_ENV === "production";

function trustProxySetting(v){
  if(v === undefined || v === "" || v === "false") return false;
  if(v === "true") return true;
  if(/^\d+$/.test(v)) return Number(v);
  return v; // e.g. "loopback"
}

module.exports = {
  host: env.HOST || "127.0.0.1",
  port: Number(env.PORT) || 3000,
  dbPath: path.resolve(env.DATABASE_PATH || path.join(__dirname, "..", "data", "money-tracker.db")),
  production,
  trustProxy: trustProxySetting(env.TRUST_PROXY),
  allowRegistration: env.ALLOW_REGISTRATION !== "false",
  // Refuse non-HTTPS requests (except from localhost) in production
  requireHttps: env.REQUIRE_HTTPS ? env.REQUIRE_HTTPS === "true" : production,
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : production,
  sessionMaxAgeDays: 30,   // absolute lifetime of a login
  sessionIdleDays: 14,     // logged out after this long without use
  receiptQuotaBytes: (Number(env.RECEIPT_QUOTA_MB) || 300) * 1024 * 1024,
  maxReceiptBytes: 8 * 1024 * 1024,
  maxStateBytes: 4 * 1024 * 1024
};
