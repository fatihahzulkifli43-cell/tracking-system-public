# Money Tracker — private accounts edition (v4)

Your Money Tracker, now with **real user accounts**. Each person registers and logs in, and the
**server** decides what they may see: every read, save, delete and receipt request is checked
against the logged-in account. The tracker itself (commitments, payment logic, linked movements,
RHB/Maybank/ASNB/TNG/ShopeePay, notes, receipts, Excel export) works exactly as before.

---

## Why this needed a server

The previous versions were a single HTML file that stored everything in the browser
(`localStorage` + IndexedDB). That cannot give real privacy:

- Anyone who opens the file in the same browser can read or change **all** of it, including every
  "profile". Hiding buttons doesn't help; the data is readable from the browser's developer tools.
- A password check written in the page's JavaScript can be skipped by editing the page.
- Data on a shared computer or phone stays there for the next person.

So the "profiles" have been replaced by accounts on a small **Node.js + SQLite** server:

| | Before (profiles) | Now (accounts) |
|---|---|---|
| Who decides access | The page itself (can be bypassed) | The server, on every request |
| Where data lives | This browser's storage | Server database, per account |
| Passwords | None | scrypt-hashed, never stored in plain text |
| Switch to another person's data | Yes, one tap | Not possible — no such feature or API |
| Receipts | Browser IndexedDB | Server, readable only by the owner |

---

## Requirements

- **Node.js 20 or newer** (https://nodejs.org). Check with `node --version`.
- About 50 MB of disk space plus room for receipt photos.

## Quick start (on your own computer)

```bash
cd money-tracker
npm install          # installs express + better-sqlite3 (prebuilt for Windows/macOS/Linux)
npm start
```

Open **http://localhost:3000**, choose **Daftar** (register), pick a username and a password
(10+ characters). That's your account.

By default the server only accepts connections from the same computer (`HOST=127.0.0.1`).

---

## Moving your existing data into your account

Your old data is still in the browser where you used the old HTML file. There are two ways to bring it
in. Both include receipt photos.

### A. Same browser (easiest)

Works when the old tracker was used at the same address the new app now uses
(e.g. you served the old file from `http://localhost:3000`).

1. Open the new app in **that browser** and register or log in.
2. A banner says **"Data lama dijumpai dalam browser ini"**. Tap **📥 Import** (or use the account
   menu → *Import data lama*).
3. Each old profile is listed with what it contains (months, commitments, movements, receipts).
   Choose the one that is **yours**, tap **Import**, and confirm.
4. When the import is done, you're offered **"Padam salinan browser"** to remove the old copy from
   this browser. Do this on shared devices once you've checked everything is there.

### B. Export file (if the banner doesn't appear)

Browsers keep storage separate per address. If you opened the old tracker as a file
(`file:///…/Money_Tracker_v3.html`), the new app at `http://…` can't see that data. In that case:

1. Open the **old** `Money_Tracker_v3.html` the way you normally did.
2. Open the browser console (Chrome/Edge **Ctrl+Shift+J**, Mac **Cmd+Option+J**).
3. Paste the contents of **`tools/export-old-data.js`** and press Enter. A file
   `money-tracker-old-data.json` is downloaded (data + receipt photos).
4. In the new app: account menu → *Import data lama* → **📄 Pilih fail backup (.json)**. Choose
   your own profile, then **Import**.
5. Delete the `.json` file afterwards — it contains your private data.

**Safety notes**
- Import only the profile that is **yours**. If family members shared one browser with separate
  profiles, each person logs in to **their own** account and imports **their own** profile.
- The old data is only read, never changed, until you choose to delete it, so you can safely retry.
- If your account already has data, the import asks before replacing it.

---

## Using it with other people (deployment)

To let family members use it from their own phones, run it on an always-on machine (a home server,
a small VPS…) **behind HTTPS**. Passwords and session cookies must never travel over plain HTTP on a
network.

### 1. Run the app

Create `.env` (copy `.env.example`):

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=loopback
DATABASE_PATH=/var/lib/money-tracker/money-tracker.db
ALLOW_REGISTRATION=true
```

In production mode the app refuses non-HTTPS requests (except from localhost) and marks cookies
`Secure`.

### 2. Put HTTPS in front (Caddy example — gets certificates automatically)

`/etc/caddy/Caddyfile`:

```
money.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

(Nginx works too: proxy to `127.0.0.1:3000` and pass `X-Forwarded-Proto`.)

### 3. Keep it running (systemd example)

`/etc/systemd/system/money-tracker.service`:

```ini
[Unit]
Description=Money Tracker
After=network.target

[Service]
User=moneytracker
WorkingDirectory=/opt/money-tracker
ExecStart=/usr/bin/node server.js
Restart=on-failure
UMask=0077

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now money-tracker
```

### 4. Close sign-ups

Once everyone has registered, set `ALLOW_REGISTRATION=false` and restart. Otherwise anyone who can
reach the site can create an account. They still can't see anyone else's data, but they can use
your storage.

---

## Backups

All accounts and receipts are in one SQLite file (`DATABASE_PATH`). Back it up regularly:

```bash
npm run backup                 # → backups/money-tracker-<date>.db (safe while running)
```

Copy backups somewhere else (another disk or cloud storage you control). To restore, stop the
server and replace the database file with a backup.

Each user can also download any month as Excel from the app.

## Forgotten password

There is no email, so recovery is done by whoever runs the server:

```bash
npm run reset-password -- <username>
```

It asks for a new password and logs that account out everywhere.

---

## Security model

**Enforced by the server**

- Every `/api` route (except register and login) requires a valid session.
- The account is taken **only** from the session. No endpoint accepts a user ID, username or
  profile ID for data access, and every database query that touches financial data is limited to
  `WHERE user_id = <session user>`. Asking for another account's receipt returns *not found*.
- Passwords are hashed with **scrypt** (random salt per user) and compared in constant time.
  Wrong-password and unknown-user replies look the same.
- Sessions are random 256-bit tokens in an **HttpOnly, SameSite=Strict** cookie (`Secure` over
  HTTPS). The database stores only a SHA-256 hash of each token. Logins expire after 30 days, or
  14 days unused. Logging out deletes the session on the server. Changing the password logs out
  all other devices.
- **Cross-site request protection:** every change needs a custom header and a same-origin `Origin`.
- **Rate limits** on login (per IP and per username), registration and password checks.
- **Receipts:** only real JPEG/PNG/WebP/GIF/HEIC images are accepted (checked by their content,
  not their name), 8 MB each, 300 MB per account by default. They are served with
  `nosniff` + a sandbox policy.
- **Saving:** a version check stops an old tab or device from silently overwriting newer data;
  the stale tab is told to reload.
- **Page security headers:** strict Content-Security-Policy (no inline scripts), no framing, no
  referrer.
- **Deleting an account** needs the password and removes its tracker data, receipts and sessions.

**In the browser:** the new app writes no financial data to `localStorage` or IndexedDB. Data is
only held in memory while the page is open.

**What this does not cover — be aware**

- Whoever runs the server can read the database file. Data is protected by access control, not
  end-to-end encryption. Keep the server and its backups private (the app sets the database file
  to owner-only, `0600`) and use full-disk encryption if the machine could be stolen.
- There's no two-factor login or email verification.
- Rate limits are kept in memory and reset when the server restarts.
- Behind a proxy, set `TRUST_PROXY` correctly. Otherwise all users appear to come from the proxy's
  address and share the same login rate limit.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Address to listen on |
| `PORT` | `3000` | Port |
| `DATABASE_PATH` | `./data/money-tracker.db` | SQLite file (created automatically) |
| `NODE_ENV` | — | `production` = HTTPS required + Secure cookies |
| `TRUST_PROXY` | off | `loopback` when Caddy/Nginx runs on the same machine |
| `ALLOW_REGISTRATION` | `true` | `false` stops new sign-ups |
| `RECEIPT_QUOTA_MB` | `300` | Receipt storage per account |
| `REQUIRE_HTTPS`, `COOKIE_SECURE` | follow `NODE_ENV` | Override individually if needed |

## Tests

```bash
npm test
```

Runs the access-control tests in `test/api.test.js`:
- login and sessions
- unauthenticated requests are refused
- two accounts can't read or change each other's tracker or receipts (even with the same receipt
  key or a forged user ID)
- cross-site requests are blocked
- out-of-date saves are rejected
- receipt upload checks
- login rate limiting
- changing the password logs out other devices
- HTTPS is enforced in production

## Project layout

```
server.js            start the server
src/config.js        settings (.env)
src/db.js            SQLite schema
src/auth.js          password hashing, sessions, rate limits
src/app.js           API routes + access control + security headers
public/index.html    the tracker page (login screen + app)
public/app.js        tracker logic (unchanged calculations) + server storage + import
public/app.css       styles
scripts/backup.js    online database backup
scripts/reset-password.js  admin password reset
tools/export-old-data.js   console snippet to export data from the old HTML version
test/api.test.js     access-control tests
```

## API (all JSON, all scoped to the logged-in account)

| Method & path | Purpose |
|---|---|
| `POST /api/auth/register` · `login` · `logout` | Account access |
| `GET /api/auth/me` | Current account |
| `POST /api/auth/password` | Change password |
| `DELETE /api/account` | Delete account and all its data (password required) |
| `GET /api/state` · `PUT /api/state` | The tracker data (`PUT` sends the last version seen) |
| `GET /api/receipts` | List own receipt keys |
| `GET` · `PUT` · `DELETE /api/receipts/:key` | One receipt (`YYYY-MM\|account\|txId`) |
| `DELETE /api/receipts?month=YYYY-MM` · `?all=1` | Delete Month / Reset All |
