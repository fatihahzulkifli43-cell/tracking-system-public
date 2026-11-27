(function(){
  "use strict";

  /* ============================================================
     CONSTANTS
     ============================================================ */
  var SCHEMA_VERSION = 2;
  var ACTIVE_MONTH_COUNT = 7;
  var DEFAULT_FIRST_MONTH = "2026-11";

  var MONTH_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  var MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function isMonthKey(k){ return typeof k === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(k); }
  function monthMeta(key){
    var y = parseInt(key.slice(0, 4), 10), m = parseInt(key.slice(5, 7), 10);
    return { key: key, label: MONTH_LONG[m - 1] + " " + y, short: MONTH_SHORT[m - 1] + " " + y };
  }
  function pad2(n){ return (n < 10 ? "0" : "") + n; }
  function nextMonthKey(key){
    var y = parseInt(key.slice(0, 4), 10), m = parseInt(key.slice(5, 7), 10) + 1;
    if(m > 12){ m = 1; y++; }
    return y + "-" + pad2(m);
  }
  function defaultMonthKeys(){
    var keys = [DEFAULT_FIRST_MONTH];
    while(keys.length < ACTIVE_MONTH_COUNT) keys.push(nextMonthKey(keys[keys.length - 1]));
    return keys;
  }
  function todayISO(){
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  // Commitment due date: "YYYY-MM-DD" string or null. Display only — never
  // used in any balance or payment calculation.
  function isDueDate(v){ return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v); }
  function daysBetween(fromIso, toIso){
    var a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
    var b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
    return Math.round((b - a) / 86400000);
  }
  function formatDueDate(iso){
    if(!isDueDate(iso)) return "";
    return parseInt(iso.slice(8, 10), 10) + " " + MONTH_SHORT[parseInt(iso.slice(5, 7), 10) - 1] + " " + iso.slice(0, 4);
  }

  // Active months are now derived from the saved data (state.months keys,
  // sorted) instead of a fixed list, so a deleted month stays deleted and the
  // new month survives a refresh. Format of each month object is unchanged.
  var MONTHS = [];
  function refreshMonths(){
    MONTHS = Object.keys(state.months).filter(isMonthKey).sort().map(monthMeta);
  }
  function currentMeta(){ return monthMeta(state.selectedMonth); }

  // Every account that has a movement log. Order = order linked payments are
  // applied against an expense when working out how much of it is paid.
  var MOVE_ACCOUNTS = [
    { key: "rhb",     name: "RHB",              listKey: "rhbWithdrawals",   idPrefix: "wd"   },
    { key: "maybank", name: "Maybank",          listKey: "maybankMovements", idPrefix: "mb"   },
    { key: "tng",     name: "TNG Go+",          listKey: "tngEntries",       idPrefix: "tng"  },
    { key: "sp",      name: "ShopeePay Money+", listKey: "spEntries",        idPrefix: "sp"   },
    { key: "asnb",    name: "ASNB",             listKey: "asnbEntries",      idPrefix: "asnb" }
  ];
  function moveAccount(key){
    for(var i = 0; i < MOVE_ACCOUNTS.length; i++) if(MOVE_ACCOUNTS[i].key === key) return MOVE_ACCOUNTS[i];
    return null;
  }

  var MOVE_UI = {
    rhb:     { listId: "rhbWithdrawalList",   emptyId: "emptyRhbWithdrawals",   defaultDir: "out",
               placeholder: "Keterangan (cth: bayar sewa, pindah ke Maybank)",
               dirOptions: [{ value: "out", text: "⬇️ Keluar" }, { value: "in", text: "⬆️ Masuk" }] },
    maybank: { listId: "maybankMovementList", emptyId: "emptyMaybankMovements", defaultDir: "in", noLink: true,
               placeholder: "Keterangan (cth: gaji, makan, pindahan dari RHB)",
               dirOptions: [{ value: "in", text: "➕ Masuk" }, { value: "out", text: "➖ Keluar" }] },
    asnb:    { listId: "asnbList", emptyId: "emptyAsnb", defaultDir: "in", noLink: true,
               placeholder: "Keterangan (cth: simpanan bulanan, pengeluaran)",
               dirOptions: [{ value: "in", text: "⬆️ Masuk" }, { value: "out", text: "⬇️ Keluar" }] },
    tng:     { listId: "tngList",  emptyId: "emptyTng",  defaultDir: "in", noLink: true,
               placeholder: "Keterangan (cth: reload, tol, parking)",
               dirOptions: [{ value: "in", text: "⬆️ Masuk" }, { value: "out", text: "⬇️ Keluar" }] },
    sp:      { listId: "spList",   emptyId: "emptySp",   defaultDir: "in", noLink: true,
               placeholder: "Keterangan (cth: top-up, tabung kecemasan)",
               dirOptions: [{ value: "in", text: "⬆️ Masuk" }, { value: "out", text: "⬇️ Keluar" }] }
  };

  // Only RHB movements can be linked to an expense.
  function canLink(accountKey){ return !(MOVE_UI[accountKey] && MOVE_UI[accountKey].noLink); }
  var LINK_ACCOUNTS = MOVE_ACCOUNTS.filter(function(a){ return canLink(a.key); });

  /* ============================================================
     STATE
     ============================================================ */
  var state = null; // { schemaVersion, selectedMonth, counters, months: { "YYYY-MM": monthObject } }
  // ID counters only ever go up (also across Reset), so a transaction ID is
  // never reused — receipts are keyed by month + account + transaction ID.
  var counters = { exp: 1, wd: 1, mb: 1, asnb: 1, tng: 1, sp: 1 };
  var pendingResetAction = null;
  var pendingExtraAction = null;

  function emptyMonth(){
    return { income: 0, expenses: [], rhbWithdrawals: [], maybankMovements: [], maybankCurrentBalance: null, rhbCurrentBalance: null, notes: "", asnbEntries: [], asnbCurrentBalance: null, tngEntries: [], tngCurrentBalance: null, spEntries: [], spCurrentBalance: null };
  }

  function defaultState(keys){
    keys = keys || defaultMonthKeys();
    var months = {};
    keys.forEach(function(k){ months[k] = emptyMonth(); });
    return { schemaVersion: SCHEMA_VERSION, selectedMonth: keys[0], months: months, tickLinkedV2: true };
  }

  function newId(prefix){
    var id = prefix + counters[prefix];
    counters[prefix]++;
    return id;
  }

  /* ============================================================
     PERSISTENCE
     ============================================================ */
  function normalizeMovements(list, defaultDir, expenses){
    list.forEach(function(x){
      if(typeof x.amount !== "number" || isNaN(x.amount)) x.amount = 0;
      if(typeof x.name !== "string") x.name = "";
      if(x.direction !== "in" && x.direction !== "out") x.direction = defaultDir;
      if(typeof x.linkedExpenseId !== "string" || !x.linkedExpenseId) x.linkedExpenseId = null;
      // drop stale links pointing at expenses that no longer exist
      if(x.linkedExpenseId && !expenses.some(function(e){ return e.id === x.linkedExpenseId; })){
        x.linkedExpenseId = null;
      }
    });
  }

  function maxIdNumber(list, current){
    var max = current;
    list.forEach(function(x){
      var n = parseInt(String(x.id).replace(/[^0-9]/g, ""), 10);
      if(!isNaN(n) && n > max) max = n;
    });
    return max;
  }

  // Normalises one profile's tracker data (same rules as before). Throws if
  // the data can't be used, so the caller shows an error instead of wiping it.
  // Also sets the global ID counters for this data.
  function normalizeState(parsed){
    if(!parsed || typeof parsed !== "object" || typeof parsed.months !== "object" || !parsed.months){
      throw new Error("Format data tidak dikenali (tiada data bulan).");
    }
    {
      // Active months = the month keys saved in the data. Old data has exactly
      // Nov 2026 – May 2027, so nothing changes for existing users.
      var keys = Object.keys(parsed.months).filter(isMonthKey).sort();
      if(keys.length === 0){
        defaultMonthKeys().forEach(function(k){ parsed.months[k] = emptyMonth(); });
        keys = defaultMonthKeys();
      }
      while(keys.length < ACTIVE_MONTH_COUNT){
        var nk = nextMonthKey(keys[keys.length - 1]);
        parsed.months[nk] = emptyMonth();
        keys.push(nk);
      }

      keys.forEach(function(k){
        if(!parsed.months[k] || typeof parsed.months[k] !== "object") parsed.months[k] = emptyMonth();
        var mo = parsed.months[k];
        if(typeof mo.income !== "number" || isNaN(mo.income)) mo.income = 0;
        // The RHB Emergency/Buffer allocation has been retired (emergency fund
        // now lives in ShopeePay Money+ / TNG Go+). An old saved "buffer" value
        // is left untouched in storage but is no longer read anywhere.
        if(!Array.isArray(mo.expenses)) mo.expenses = [];
        mo.expenses.forEach(function(e){
          if(typeof e.paid !== "boolean") e.paid = false;
          if(typeof e.name !== "string") e.name = "";
          if(typeof e.amount !== "number" || isNaN(e.amount)) e.amount = 0;
          // Optional due date (additive field). Older commitments simply have
          // none; the existing "date" (date logged) is left untouched.
          if(!isDueDate(e.dueDate)) e.dueDate = null;
        });
        if(!Array.isArray(mo.rhbWithdrawals)) mo.rhbWithdrawals = [];
        mo.rhbWithdrawals.forEach(function(w){
          // RHB now has a single pocket. Old "emergency" movements were still
          // real bank movements, so they are kept and folded into the RHB
          // (Expenses) pocket; the original pocket is remembered in legacyPocket.
          if(w.pocket === "emergency") w.legacyPocket = "emergency";
          w.pocket = "expenses";
        });
        normalizeMovements(mo.rhbWithdrawals, "out", mo.expenses);

        if(!Array.isArray(mo.maybankMovements)) mo.maybankMovements = [];
        // One-time migration: old "Income Luar" entries were money coming into
        // Maybank, so they become incoming (Masuk) Maybank movements. Nothing is lost.
        if(Array.isArray(mo.maybankExtraIncome)){
          mo.maybankExtraIncome.forEach(function(x, i){
            mo.maybankMovements.push({
              id: (typeof x.id === "string" && x.id) ? x.id : ("ext" + (i + 1)),
              name: typeof x.name === "string" ? x.name : "",
              amount: Number(x.amount),
              direction: "in"
            });
          });
        }
        delete mo.maybankExtraIncome;
        normalizeMovements(mo.maybankMovements, "in", mo.expenses);
        // Maybank movements are not linked to expenses
        mo.maybankMovements.forEach(function(x){ x.linkedExpenseId = null; });

        ["maybankCurrentBalance", "rhbCurrentBalance", "asnbCurrentBalance", "tngCurrentBalance", "spCurrentBalance"].forEach(function(bk){
          if(typeof mo[bk] !== "number" || isNaN(mo[bk])) mo[bk] = null;
        });
        if(typeof mo.notes !== "string") mo.notes = "";
        ["asnbEntries", "tngEntries", "spEntries"].forEach(function(lk){
          if(!Array.isArray(mo[lk])) mo[lk] = [];
          normalizeMovements(mo[lk], "in", mo.expenses);
        });
      });

      // One-time compatibility step for the new tick meaning. Before, a tick on
      // a LINKED expense was ignored (and couldn't be changed in the UI). So
      // that old data keeps exactly the same totals, such stale ticks are
      // cleared once; the old value is kept in legacyLinkedPaidTick.
      if(!parsed.tickLinkedV2){
        keys.forEach(function(k){
          var mo = parsed.months[k];
          var linkedIds = {};
          MOVE_ACCOUNTS.forEach(function(a){
            if(!canLink(a.key)) return;
            mo[a.listKey].forEach(function(x){ if(x.linkedExpenseId) linkedIds[x.linkedExpenseId] = true; });
          });
          mo.expenses.forEach(function(e){
            if(e.paid && linkedIds[e.id]){ e.legacyLinkedPaidTick = true; e.paid = false; }
          });
        });
        parsed.tickLinkedV2 = true;
      }

      if(!parsed.selectedMonth || !isMonthKey(parsed.selectedMonth) || !parsed.months[parsed.selectedMonth]){
        parsed.selectedMonth = keys[0];
      }

      // ID counters: never lower than any ID already used (or previously saved)
      var saved = (parsed.counters && typeof parsed.counters === "object") ? parsed.counters : {};
      var c = { exp: 0, wd: 0, mb: 0, asnb: 0, tng: 0, sp: 0 };
      Object.keys(parsed.months).forEach(function(k){
        var mo = parsed.months[k];
        if(!mo || typeof mo !== "object") return;
        c.exp  = maxIdNumber(mo.expenses || [], c.exp);
        c.wd   = maxIdNumber(mo.rhbWithdrawals || [], c.wd);
        c.mb   = maxIdNumber(mo.maybankMovements || [], c.mb);
        c.asnb = maxIdNumber(mo.asnbEntries || [], c.asnb);
        c.tng  = maxIdNumber(mo.tngEntries || [], c.tng);
        c.sp   = maxIdNumber(mo.spEntries || [], c.sp);
      });
      Object.keys(counters).forEach(function(p){
        var s = Number(saved[p]);
        counters[p] = Math.max(c[p] + 1, isNaN(s) ? 1 : s);
      });

      // every record needs a stable string ID (receipts are keyed by it)
      keys.forEach(function(k){
        var mo = parsed.months[k];
        mo.expenses.forEach(function(e){ if(typeof e.id !== "string" || !e.id) e.id = newId("exp"); });
        MOVE_ACCOUNTS.forEach(function(a){
          mo[a.listKey].forEach(function(x){ if(typeof x.id !== "string" || !x.id) x.id = newId(a.idPrefix); });
        });
      });

      parsed.schemaVersion = SCHEMA_VERSION;
      return parsed;
    }
  }

  /* ============================================================
     SERVER STORAGE — the tracker document lives on the server, in the
     logged-in account only. Nothing financial is written to localStorage.
       GET /api/state  → { data, version }
       PUT /api/state  ← { data, version }   (409 if another tab/device saved first)
     Edits are batched (600 ms) and flushed when the page is hidden/closed.
     ============================================================ */
  var currentUser = null;      // { username }
  var serverVersion = 0;
  var sync = { dirty: false, inFlight: false, again: false, timer: null, retryTimer: null, blocked: true };

  function api(method, path, opts){
    opts = opts || {};
    var headers = Object.assign({ "X-Requested-With": "MoneyTracker" }, opts.headers || {});
    var body;
    if(opts.json !== undefined){ headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
    else if(opts.bodyText !== undefined){ headers["Content-Type"] = "application/json"; body = opts.bodyText; }
    else if(opts.body !== undefined){ headers["Content-Type"] = opts.type || "application/octet-stream"; body = opts.body; }
    return fetch(path, { method: method, headers: headers, body: body, credentials: "same-origin", keepalive: !!opts.keepalive, cache: "no-store" })
      .then(function(res){
        var ct = res.headers.get("Content-Type") || "";
        var parse = ct.indexOf("json") !== -1 ? res.json().catch(function(){ return null; }) : Promise.resolve(null);
        return parse.then(function(data){
          if(!res.ok){
            var e = new Error((data && data.message) || ("Ralat pelayan (" + res.status + ")."));
            e.status = res.status; e.data = data;
            throw e;
          }
          return data;
        });
      }, function(netErr){
        var e = new Error("Tiada sambungan ke pelayan.");
        e.status = 0; e.cause = netErr;
        throw e;
      });
  }

  function setSaveStatus(kind, text){
    var el = document.getElementById("saveIndicator");
    if(saveTimer) clearTimeout(saveTimer);
    el.classList.remove("saving", "error");
    if(kind === "saving"){ el.textContent = "Menyimpan…"; el.classList.add("show", "saving"); return; }
    if(kind === "error"){ el.textContent = text || "⚠️ Belum disimpan"; el.classList.add("show", "error"); return; }
    el.textContent = "✓ Saved";
    el.classList.add("show");
    saveTimer = setTimeout(function(){ el.classList.remove("show"); }, 1200);
  }

  var saveTimer = null;
  function saveState(){
    // Never write while data failed to load, after a conflict, or when logged out
    if(sync.blocked || !state || !currentUser) return;
    state.schemaVersion = SCHEMA_VERSION;
    state.counters = counters;
    sync.dirty = true;
    setSaveStatus("saving");
    if(sync.timer) clearTimeout(sync.timer);
    sync.timer = setTimeout(pushState, 600);
  }

  function pushState(opts){
    opts = opts || {};
    if(sync.timer){ clearTimeout(sync.timer); sync.timer = null; }
    if(sync.blocked || !sync.dirty || !state) return Promise.resolve();
    if(sync.inFlight){ sync.again = true; return Promise.resolve(); }
    sync.dirty = false;
    sync.inFlight = true;
    var bodyText = JSON.stringify({ data: state, version: serverVersion });
    return api("PUT", "/api/state", { bodyText: bodyText, keepalive: !!opts.keepalive && bodyText.length < 60000 })
      .then(function(r){
        serverVersion = r.version;
        if(!sync.dirty) setSaveStatus("saved");
      })
      .catch(function(err){
        sync.dirty = true;
        handleSyncError(err);
      })
      .then(function(){
        sync.inFlight = false;
        if(sync.again){ sync.again = false; if(sync.dirty && !sync.blocked) pushState(); }
      });
  }

  function handleSyncError(err){
    if(err.status === 409){
      sync.blocked = true;
      setSaveStatus("error", "⚠️ Tak disimpan");
      showSyncBanner("Data akaun ini telah dikemas kini di tab atau peranti lain. Perubahan terakhir di sini belum disimpan. Muat semula untuk dapatkan data terkini.");
    } else if(err.status === 401){
      sync.blocked = true;
      setSaveStatus("error", "⚠️ Sesi tamat");
      showSyncBanner("Sesi log masuk telah tamat. Perubahan terakhir di sini belum disimpan. Log masuk semula untuk teruskan.");
    } else if(err.status === 413 || err.status === 400){
      setSaveStatus("error");
      showError("Data tak dapat disimpan", err);
    } else {
      // network / server hiccup: keep the edit and retry
      setSaveStatus("error", "⚠️ Belum disimpan — cuba semula…");
      if(sync.retryTimer) clearTimeout(sync.retryTimer);
      sync.retryTimer = setTimeout(function(){ if(sync.dirty) pushState(); }, 5000);
    }
  }

  function showSyncBanner(msg){
    var b = document.getElementById("syncBanner");
    document.getElementById("syncBannerMsg").textContent = msg;
    b.hidden = false;
  }

  function flushPendingEdits(opts){
    var a = document.activeElement;
    if(a && a !== document.body && typeof a.blur === "function") a.blur(); // fires pending change events
    if(sync.dirty) return pushState(opts);
    return Promise.resolve();
  }

  /* ---------- load-error panel (never shows an empty tracker instead) ---------- */
  var loadErrorRaw = null;
  function enterLoadError(err, raw){
    sync.blocked = true;
    state = null;
    loadErrorRaw = raw || null;
    document.body.classList.add("load-error");
    document.getElementById("loadErrorPanel").hidden = false;
    document.getElementById("loadErrorMsg").textContent = (err && err.message) ? err.message : String(err);
    document.getElementById("loadErrorDownload").hidden = !raw;
    console.error(err);
  }
  function downloadBlob(blob, filename){
    var a = document.createElement("a");
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 4000);
  }
  function downloadRawBackup(){
    if(!loadErrorRaw) return;
    downloadBlob(new Blob([JSON.stringify(loadErrorRaw, null, 2)], { type: "application/json" }),
      "Money_Tracker_" + (currentUser ? currentUser.username + "_" : "") + "raw_" + todayISO() + ".json");
  }

  /* ============================================================
     LOGIN / REGISTER
     ============================================================ */
  var authMode = "login";
  function showAuthScreen(allowRegistration){
    document.body.classList.add("auth-required");
    document.getElementById("authScreen").hidden = false;
    document.getElementById("authTabRegister").hidden = !allowRegistration;
    setAuthMode("login");
    setTimeout(function(){ document.getElementById("authUsername").focus(); }, 0);
  }
  function setAuthMode(mode){
    authMode = mode;
    var reg = mode === "register";
    document.getElementById("authTabLogin").classList.toggle("active", !reg);
    document.getElementById("authTabRegister").classList.toggle("active", reg);
    document.getElementById("authConfirmWrap").hidden = !reg;
    document.getElementById("authHint").hidden = !reg;
    document.getElementById("authPassword").autocomplete = reg ? "new-password" : "current-password";
    document.getElementById("authSubmit").textContent = reg ? "Daftar akaun" : "Log masuk";
    document.getElementById("authError").textContent = "";
  }
  function wireAuthEvents(){
    document.getElementById("authTabLogin").addEventListener("click", function(){ setAuthMode("login"); });
    document.getElementById("authTabRegister").addEventListener("click", function(){ setAuthMode("register"); });
    document.getElementById("authForm").addEventListener("submit", function(e){
      e.preventDefault();
      var u = document.getElementById("authUsername").value.trim();
      var p = document.getElementById("authPassword").value;
      var errEl = document.getElementById("authError");
      errEl.textContent = "";
      if(authMode === "register" && p !== document.getElementById("authConfirm").value){
        errEl.textContent = "Kata laluan tidak sepadan.";
        return;
      }
      var btn = document.getElementById("authSubmit");
      btn.disabled = true;
      api("POST", authMode === "register" ? "/api/auth/register" : "/api/auth/login", { json: { username: u, password: p } })
        .then(function(){ location.reload(); }) // fresh page = nothing from a previous user stays in memory
        .catch(function(err){ errEl.textContent = err.message; btn.disabled = false; });
    });
  }

  /* ============================================================
     ACCOUNT MENU — only the logged-in account; no switching to others
     ============================================================ */
  function renderAccountHeader(){
    var name = currentUser ? currentUser.username : "";
    document.getElementById("accountName").textContent = name;
    document.getElementById("accountAvatar").textContent = (Array.from(name)[0] || "?").toUpperCase();
    document.getElementById("accountBtn").title = "Log masuk sebagai " + name;
    document.getElementById("accountSheetUser").textContent = name;
    document.title = "Money Tracker — " + name;
  }
  function openAccountSheet(){
    flushPendingEdits();
    ["pwForm", "deleteAccountForm"].forEach(function(id){ document.getElementById(id).hidden = true; });
    document.getElementById("accountMsg").textContent = "";
    renderImportSources();
    document.getElementById("accountOverlay").classList.add("show");
  }
  function closeAccountSheet(){ document.getElementById("accountOverlay").classList.remove("show"); }

  function logout(){
    return flushPendingEdits().then(function(){
      return api("POST", "/api/auth/logout").catch(function(){});
    }).then(function(){ location.reload(); });
  }

  function wireAccountEvents(){
    document.getElementById("accountBtn").addEventListener("click", openAccountSheet);
    document.getElementById("accountCloseBtn").addEventListener("click", closeAccountSheet);
    document.getElementById("accountOverlay").addEventListener("click", function(e){
      if(e.target === document.getElementById("accountOverlay")) closeAccountSheet();
    });
    document.getElementById("logoutBtn").addEventListener("click", logout);
    document.getElementById("syncBannerReload").addEventListener("click", function(){ location.reload(); });
    document.getElementById("loadErrorDownload").addEventListener("click", downloadRawBackup);
    document.getElementById("loadErrorRetry").addEventListener("click", function(){ location.reload(); });
    document.getElementById("loadErrorLogout").addEventListener("click", logout);

    var msg = document.getElementById("accountMsg");
    document.getElementById("pwToggle").addEventListener("click", function(){
      var f = document.getElementById("pwForm"); f.hidden = !f.hidden;
      document.getElementById("deleteAccountForm").hidden = true;
      if(!f.hidden) document.getElementById("pwCurrent").focus();
    });
    document.getElementById("pwForm").addEventListener("submit", function(e){
      e.preventDefault();
      var cur = document.getElementById("pwCurrent").value, n1 = document.getElementById("pwNew").value, n2 = document.getElementById("pwNew2").value;
      msg.className = "account-msg";
      if(n1 !== n2){ msg.textContent = "Kata laluan baru tidak sepadan."; msg.classList.add("bad"); return; }
      api("POST", "/api/auth/password", { json: { currentPassword: cur, newPassword: n1 } }).then(function(){
        msg.textContent = "✓ Kata laluan ditukar. Peranti lain telah dilog keluar.";
        msg.classList.add("good");
        document.getElementById("pwForm").reset();
        document.getElementById("pwForm").hidden = true;
      }).catch(function(err){ msg.textContent = err.message; msg.classList.add("bad"); });
    });

    document.getElementById("deleteAccountToggle").addEventListener("click", function(){
      var f = document.getElementById("deleteAccountForm"); f.hidden = !f.hidden;
      document.getElementById("pwForm").hidden = true;
      if(!f.hidden) document.getElementById("deletePassword").focus();
    });
    document.getElementById("deleteAccountForm").addEventListener("submit", function(e){
      e.preventDefault();
      var pw = document.getElementById("deletePassword").value;
      msg.className = "account-msg";
      openModal(
        "Padam akaun \"" + currentUser.username + "\"?",
        "Akaun ini dan SEMUA datanya — income, commitments, pergerakan, baki, catatan dan gambar resit — akan dipadam terus dari pelayan. Tindakan ini tak boleh diundur.\n\nTip: Download Excel dahulu untuk simpanan.",
        function(){
          sync.blocked = true;
          api("DELETE", "/api/account", { json: { password: pw } })
            .then(function(){ location.reload(); })
            .catch(function(err){ sync.blocked = false; msg.textContent = err.message; msg.classList.add("bad"); });
        },
        { confirmText: "Padam Akaun" }
      );
    });

    document.getElementById("importFile").addEventListener("change", function(e){
      var file = e.target.files && e.target.files[0];
      e.target.value = "";
      if(!file) return;
      file.text().then(function(text){
        var obj = JSON.parse(text);
        var sources = LegacyImport.sourcesFromObject(obj, "Fail: " + file.name);
        if(!sources.length) throw new Error("Tiada data Money Tracker dalam fail ini.");
        importExtraSources = sources;
        renderImportSources();
      }).catch(function(err){ showError("Fail tak dapat dibaca", err); });
    });
    document.getElementById("importWipe").addEventListener("click", function(){
      openModal(
        "Padam data lama dari browser ini?",
        "Salinan data Money Tracker versi lama (simpanan browser dan gambar resit tempatan) akan dipadam dari browser ini sahaja.\n\nData dalam akaun anda di pelayan TIDAK terjejas. Pastikan anda sudah import data yang anda perlukan.",
        function(){
          LegacyImport.wipeLocal().then(function(){
            importExtraSources = [];
            renderImportSources();
            document.getElementById("importBanner").hidden = true;
          });
        },
        { confirmText: "Padam data lama" }
      );
    });
    document.getElementById("importBannerOpen").addEventListener("click", openAccountSheet);
    document.getElementById("importBannerDismiss").addEventListener("click", function(){
      document.getElementById("importBanner").hidden = true;
      try{ sessionStorage.setItem("mt_import_banner_dismissed", "1"); }catch(e){}
    });
  }

  /* ============================================================
     MIGRATION — import data from the old browser-only versions into the
     logged-in account. Old data is only READ here; it is removed from the
     browser only if the user explicitly chooses to after a successful import.
     Sources understood:
       • profile version:  moneyTracker_profiles + moneyTracker_profile_<id>
       • original version: moneyTrackerData_v1
       • a raw backup .json downloaded from the profile version, or a single
         tracker document { months: {...} }
     Receipts come from the old IndexedDB "moneyTrackerReceipts" (browser only).
     ============================================================ */
  var LegacyImport = (function(){
    var KEY_RE = /^(\d{4}-(?:0[1-9]|1[0-2]))\|(rhb|maybank|tng|sp|asnb)\|([A-Za-z0-9_-]{1,40})$/;
    var IDB_NAME = "moneyTrackerReceipts";

    function summarize(data){
      var months = 0, exp = 0, mv = 0;
      Object.keys((data && data.months) || {}).forEach(function(k){
        var m = data.months[k] || {};
        var any = (Number(m.income) || 0) !== 0 || (m.notes || "") !== "";
        exp += (m.expenses || []).length;
        ["rhbWithdrawals", "maybankMovements", "asnbEntries", "tngEntries", "spEntries", "maybankExtraIncome"].forEach(function(lk){
          mv += (m[lk] || []).length; if((m[lk] || []).length) any = true;
        });
        if((m.expenses || []).length) any = true;
        if(any) months++;
      });
      return months + " bulan berisi · " + exp + " commitments · " + mv + " pergerakan";
    }

    function sourcesFromObject(obj, origin){
      var out = [];
      if(!obj || typeof obj !== "object") return out;
      function get(k){
        var v = obj[k];
        if(typeof v === "string") return v;
        if(v && typeof v === "object") return JSON.stringify(v);
        return null;
      }
      var regRaw = get("moneyTracker_profiles");
      if(regRaw){
        try{
          var reg = JSON.parse(regRaw);
          (reg.profiles || []).forEach(function(p){
            if(!p || typeof p.id !== "string") return;
            var raw = get("moneyTracker_profile_" + p.id);
            if(!raw) return;
            out.push({ id: "p:" + p.id, name: String(p.name || p.id), raw: raw, origin: origin,
              receiptNs: typeof p.receiptNs === "string" ? p.receiptNs : (p.id === "default" ? "" : p.id) });
          });
        }catch(e){ /* fall through to the original key */ }
      }
      if(!out.length){
        var legacy = get("moneyTrackerData_v1");
        if(legacy) out.push({ id: "legacy", name: "Data asal (sebelum profil)", raw: legacy, receiptNs: "", origin: origin });
      }
      if(!out.length && obj.months && typeof obj.months === "object"){
        out.push({ id: "doc", name: "Data tracker", raw: JSON.stringify(obj), receiptNs: null, origin: origin });
      }
      out.forEach(function(s){
        try{ s.data = JSON.parse(s.raw); s.summary = summarize(s.data); if(!s.data || typeof s.data.months !== "object") throw new Error("tiada data bulan"); }
        catch(e){ s.error = "Data rosak: " + e.message; }
        // receipts included in an exported file (tools/export-old-data.js)
        if(Array.isArray(obj.__receipts) && s.receiptNs !== null){
          s.fileReceipts = obj.__receipts.map(function(r){
            return r && typeof r.data === "string" ? { key: bareKey(r.key, s.receiptNs), rec: r } : { key: null };
          }).filter(function(x){ return x.key; });
        }
      });
      return out;
    }

    function localDump(){
      var dump = {};
      try{
        for(var i = 0; i < localStorage.length; i++){
          var k = localStorage.key(i);
          if(/^moneyTracker/.test(k)) dump[k] = localStorage.getItem(k);
        }
      }catch(e){ /* storage unavailable */ }
      return dump;
    }
    function localSources(){
      return sourcesFromObject(localDump(), "Browser ini").map(function(s){ s.fromBrowser = true; return s; });
    }
    function hasLocalData(){ return localSources().some(function(s){ return !s.error; }); }

    // Open the old receipts DB without creating it if it doesn't exist.
    function openIdb(){
      return new Promise(function(resolve){
        if(!window.indexedDB) return resolve(null);
        var check = indexedDB.databases
          ? indexedDB.databases().then(function(l){ return l.some(function(d){ return d.name === IDB_NAME; }); })
          : Promise.resolve(true);
        check.then(function(exists){
          if(!exists) return resolve(null);
          var req;
          try{ req = indexedDB.open(IDB_NAME); }catch(e){ return resolve(null); }
          req.onupgradeneeded = function(){ try{ req.transaction.abort(); }catch(e){} };
          req.onsuccess = function(){
            var db = req.result;
            if(!db.objectStoreNames.contains("receipts")){ db.close(); resolve(null); } else resolve(db);
          };
          req.onerror = function(){ resolve(null); };
          req.onblocked = function(){ resolve(null); };
        }, function(){ resolve(null); });
      });
    }
    function bareKey(k, ns){
      k = String(k);
      var bare = null;
      if(ns){ if(k.indexOf(ns + "|") === 0) bare = k.slice(ns.length + 1); }
      else if(KEY_RE.test(k)) bare = k;
      return bare && KEY_RE.test(bare) ? bare : null;
    }
    function receiptKeys(ns){
      if(ns === null || ns === undefined) return Promise.resolve([]);
      return openIdb().then(function(db){
        if(!db) return [];
        return new Promise(function(resolve){
          var t = db.transaction("receipts", "readonly");
          var req = t.objectStore("receipts").getAllKeys();
          req.onsuccess = function(){ resolve((req.result || []).map(function(k){ return { raw: k, key: bareKey(k, ns) }; }).filter(function(x){ return x.key; })); };
          t.oncomplete = function(){ db.close(); };
          t.onerror = function(){ db.close(); resolve([]); };
        });
      });
    }
    function readReceipt(rawKey){
      return openIdb().then(function(db){
        if(!db) return null;
        return new Promise(function(resolve, reject){
          var t = db.transaction("receipts", "readonly");
          var req = t.objectStore("receipts").get(rawKey);
          req.onsuccess = function(){ resolve(req.result || null); };
          t.oncomplete = function(){ db.close(); };
          t.onerror = function(){ db.close(); reject(t.error); };
        });
      });
    }
    function hasLocalTraces(){
      return Object.keys(localDump()).length > 0;
    }
    // Remove the OLD local copies (localStorage keys + receipts DB) from this browser.
    function wipeLocal(){
      Object.keys(localDump()).forEach(function(k){ try{ localStorage.removeItem(k); }catch(e){} });
      return new Promise(function(resolve){
        if(!window.indexedDB) return resolve();
        var req = indexedDB.deleteDatabase(IDB_NAME);
        req.onsuccess = req.onerror = req.onblocked = function(){ resolve(); };
      });
    }
    return { sourcesFromObject: sourcesFromObject, localSources: localSources, hasLocalData: hasLocalData,
             receiptKeys: receiptKeys, readReceipt: readReceipt, hasLocalTraces: hasLocalTraces, wipeLocal: wipeLocal };
  })();

  var importExtraSources = [];
  function accountHasData(){
    if(Object.keys(Receipts.allKeys()).length) return true;
    if(!state) return false;
    return Object.keys(state.months).some(function(k){
      var m = state.months[k];
      if((Number(m.income) || 0) !== 0 || (m.notes || "") !== "") return true;
      if(m.expenses.length) return true;
      if(MOVE_ACCOUNTS.some(function(a){ return (m[a.listKey] || []).length; })) return true;
      return ["maybankCurrentBalance", "rhbCurrentBalance", "asnbCurrentBalance", "tngCurrentBalance", "spCurrentBalance"]
        .some(function(b){ return typeof m[b] === "number"; });
    });
  }

  function renderImportSources(){
    var wrap = document.getElementById("importList");
    wrap.innerHTML = "";
    var sources = LegacyImport.localSources().concat(importExtraSources);
    document.getElementById("importEmpty").hidden = sources.length > 0;
    document.getElementById("importWipe").hidden = !LegacyImport.hasLocalTraces();
    sources.forEach(function(s){
      var row = document.createElement("div");
      row.className = "import-row";
      var info = document.createElement("div");
      info.className = "import-info";
      var nm = document.createElement("div"); nm.className = "import-name"; nm.textContent = s.name;
      var meta = document.createElement("div"); meta.className = "import-meta";
      meta.textContent = s.origin + " · " + (s.error || s.summary);
      info.appendChild(nm); info.appendChild(meta);
      row.appendChild(info);
      if(!s.error){
        if(s.fromBrowser){
          LegacyImport.receiptKeys(s.receiptNs).then(function(list){
            s.receiptCount = list.length;
            meta.textContent += " · " + list.length + " resit";
          });
        } else if(s.fileReceipts){
          meta.textContent += " · " + s.fileReceipts.length + " resit";
        } else {
          meta.textContent += " · tanpa resit";
        }
        var btn = document.createElement("button");
        btn.type = "button"; btn.className = "profile-mini primary"; btn.textContent = "Import";
        btn.addEventListener("click", function(){ confirmImport(s); });
        row.appendChild(btn);
      }
      wrap.appendChild(row);
    });
  }

  function confirmImport(s){
    var replace = accountHasData();
    openModal(
      "Import \"" + s.name + "\" ke akaun " + currentUser.username + "?",
      (replace
        ? "⚠️ Akaun ini sudah ada data. Import akan MENGGANTIKAN semua data tracker dan gambar resit dalam akaun \"" + currentUser.username + "\" dengan data ini.\n\n"
        : "Data ini akan disalin ke akaun \"" + currentUser.username + "\".\n\n") +
        "Pastikan ini memang data anda. Data asal dalam browser tidak diubah — anda boleh memadamnya selepas import berjaya.",
      function(){ runImport(s, replace); },
      { confirmText: replace ? "Ganti & Import" : "Import" }
    );
  }

  function setImportStatus(text){
    var el = document.getElementById("importStatus");
    el.hidden = !text;
    el.textContent = text || "";
  }

  function runImport(s, replace){
    sync.blocked = true; // nothing else is saved while importing
    if(sync.timer) clearTimeout(sync.timer);
    var data;
    try{
      data = normalizeState(JSON.parse(s.raw)); // same rules as loading; also upgrades old formats
      data.counters = Object.assign({}, counters);
      data.schemaVersion = SCHEMA_VERSION;
    }catch(err){
      sync.blocked = false;
      showError("Data tak dapat diimport", err);
      return;
    }
    var ok = 0, failed = 0;
    setImportStatus("Menyimpan data tracker…");
    api("GET", "/api/state")
      .then(function(r){ return api("PUT", "/api/state", { json: { data: data, version: r.version } }); })
      .then(function(){ return replace ? Receipts.clearAll() : null; })
      .then(function(){
        if(s.fromBrowser) return LegacyImport.receiptKeys(s.receiptNs).then(function(l){
          return l.map(function(it){ return { key: it.key, load: function(){ return LegacyImport.readReceipt(it.raw); } }; });
        });
        return (s.fileReceipts || []).map(function(it){
          return { key: it.key, load: function(){
            var bin = atob(it.rec.data), bytes = new Uint8Array(bin.length);
            for(var b = 0; b < bin.length; b++) bytes[b] = bin.charCodeAt(b);
            return Promise.resolve({ data: bytes.buffer, type: it.rec.type, name: it.rec.name });
          } };
        });
      })
      .then(function(list){
        var chain = Promise.resolve();
        list.forEach(function(item, i){
          chain = chain.then(function(){
            setImportStatus("Memuat naik resit " + (i + 1) + "/" + list.length + "…");
            return item.load().then(function(rec){
              if(!rec || !rec.data) throw new Error("kosong");
              return api("PUT", "/api/receipts/" + encodeURIComponent(item.key), {
                body: new Blob([rec.data], { type: rec.type || "image/jpeg" }), type: rec.type || "image/jpeg",
                headers: { "X-Receipt-Name": encodeURIComponent(rec.name || "receipt") }
              });
            }).then(function(){ ok++; }, function(err){ failed++; console.warn("Receipt not imported", item.key, err); });
          });
        });
        return chain;
      })
      .then(function(){
        setImportStatus("");
        return loadAccountData();
      })
      .then(function(){
        closeAccountSheet();
        var msg = "\"" + s.name + "\" telah diimport ke akaun " + currentUser.username + "." +
          (s.fromBrowser || s.fileReceipts ? "\n" + ok + " gambar resit dimuat naik" + (failed ? " (" + failed + " gagal)." : ".") : "") +
          (s.fromBrowser ? "\n\nSalinan lama masih ada dalam browser ini. Padam sekarang? Disyorkan jika browser/peranti ini dikongsi dengan orang lain." : "");
        if(s.fromBrowser){
          openModal("✓ Import selesai", msg, function(){
            LegacyImport.wipeLocal().then(function(){ document.getElementById("importBanner").hidden = true; });
          }, { confirmText: "Padam salinan browser", cancelText: "Simpan dulu" });
        } else {
          openModal("✓ Import selesai", msg + "\n\nPadamkan fail backup .json itu selepas ini — ia mengandungi data peribadi anda.", null, { hideConfirm: true, cancelText: "OK" });
        }
        document.getElementById("importBanner").hidden = true;
      })
      .catch(function(err){
        setImportStatus("");
        showError("Import gagal", err);
        loadAccountData(); // show whatever the server now has, and unblock saving
      });
  }

  function maybeShowImportBanner(){
    var dismissed = false;
    try{ dismissed = sessionStorage.getItem("mt_import_banner_dismissed") === "1"; }catch(e){}
    document.getElementById("importBanner").hidden = dismissed || accountHasData() || !LegacyImport.hasLocalData();
  }

  function resetCounters(){ Object.keys(counters).forEach(function(k){ counters[k] = 1; }); }

  // Load this account's tracker from the server and show it.
  function loadAccountData(){
    return api("GET", "/api/state").then(function(r){
      var st;
      if(!r.data){ resetCounters(); st = defaultState(); }
      else {
        try{ st = normalizeState(r.data); }
        catch(err){ enterLoadError(new Error("Data akaun tak dapat dibuka: " + err.message), r.data); return; }
      }
      state = st;
      serverVersion = r.version;
      sync.dirty = false;
      sync.blocked = false;
      document.body.classList.remove("load-error");
      document.getElementById("loadErrorPanel").hidden = true;
      renderAll();
      return Receipts.init().then(refreshReceiptControls).catch(function(err){ console.warn(err); });
    }, function(err){
      if(err.status === 401){ location.reload(); return; }
      enterLoadError(err);
    });
  }

  function wireLifecycle(){
    window.addEventListener("pagehide", function(){ if(sync.dirty) pushState({ keepalive: true }); });
    document.addEventListener("visibilitychange", function(){
      if(document.visibilityState === "hidden" && sync.dirty) pushState({ keepalive: true });
    });
    window.addEventListener("beforeunload", function(e){
      if(sync.dirty || sync.inFlight){ e.preventDefault(); e.returnValue = ""; }
    });
  }

  function showSaved(){ setSaveStatus("saved"); }

  /* ============================================================
     FORMATTING
     ============================================================ */
  function formatRM(amount){
    var n = Number(amount);
    if(isNaN(n)) n = 0;
    var negative = n < 0;
    n = Math.abs(n);
    var formatted = n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (negative ? "-RM" : "RM") + formatted;
  }
  function num(v){ var n = Number(v); return isNaN(n) ? 0 : n; }
  function r2(n){ return Math.round(n * 100) / 100; }

  /* ============================================================
     CALCULATION LOGIC
     ============================================================ */

  // Works out, for every expense, how much is paid and from where.
  //  • An expense LINKED to one or more movements (any account) is paid by
  //    exactly what those movements add up to (Keluar minus Masuk per account,
  //    never below zero), capped at the expense amount. Anything above the
  //    amount is reported as an overpayment warning and NOT counted as paid.
  //  • The paid tick means "this expense is fully paid". It only ever counts
  //    the part NOT already covered by linked movements:
  //        manual (tick) portion = expense amount − linked payments (≥ 0)
  //    so linked + tick can never exceed the expense amount, and a payment is
  //    never counted twice. With no links, ticking = the whole amount (as
  //    before). Unticking removes only the manual portion; links still count.
  //    The manual portion is assumed to come out of the RHB reserve.
  function calcExpenses(monthData){
    var linkNet = {};   // expenseId -> { accountKey: net out }
    var linkMoves = {}; // expenseId -> [ { account, id, name, amount, direction } ]
    MOVE_ACCOUNTS.forEach(function(a){
      if(!canLink(a.key)) return; // links on non-RHB accounts are ignored
      (monthData[a.listKey] || []).forEach(function(m){
        if(!m.linkedExpenseId) return;
        var id = m.linkedExpenseId;
        if(!linkNet[id]) linkNet[id] = {};
        var amt = num(m.amount);
        linkNet[id][a.key] = (linkNet[id][a.key] || 0) + (m.direction === "in" ? -amt : amt);
        (linkMoves[id] = linkMoves[id] || []).push({ account: a.key, id: m.id, name: m.name, amount: amt, direction: m.direction });
      });
    });

    var info = {};
    var t = { total: 0, paid: 0, outstanding: 0, paidTick: 0, overpaid: 0, paidCount: 0, byAccount: {} };
    MOVE_ACCOUNTS.forEach(function(a){ t.byAccount[a.key] = 0; });
    var overpaidList = [];

    monthData.expenses.forEach(function(e){
      var amount = Math.max(num(e.amount), 0);
      var linked = !!linkNet[e.id];
      var paidBy = {}, remaining = amount, linkedSum = 0;
      MOVE_ACCOUNTS.forEach(function(a){
        var net = linked ? Math.max(linkNet[e.id][a.key] || 0, 0) : 0;
        linkedSum += net;
        var use = Math.min(net, remaining);
        paidBy[a.key] = r2(use);
        remaining -= use;
      });
      var paidLinked = r2(amount - remaining);
      // tick covers only what linked movements haven't (0 if fully covered)
      var paidTick = e.paid ? r2(Math.max(remaining, 0)) : 0;
      var paid = r2(paidLinked + paidTick);
      var outstanding = r2(Math.max(amount - paid, 0));
      var overpaid = r2(Math.max(linkedSum - amount, 0));
      var status;
      if(amount <= 0) status = (e.paid || linked) ? "paid" : "unpaid";
      else if(outstanding <= 0) status = "paid";
      else if(paid > 0) status = "partial";
      else status = "unpaid";

      info[e.id] = {
        amount: amount, linked: linked, paidBy: paidBy, paidLinked: paidLinked, paidTick: paidTick,
        paid: paid, outstanding: outstanding, overpaid: overpaid, status: status,
        moves: linkMoves[e.id] || []
      };
      t.total += amount;
      t.paid += paid;
      t.outstanding += outstanding;
      t.paidTick += paidTick;
      t.overpaid += overpaid;
      if(status === "paid") t.paidCount++;
      MOVE_ACCOUNTS.forEach(function(a){ t.byAccount[a.key] += paidBy[a.key]; });
      if(overpaid > 0) overpaidList.push({ name: e.name || "(Tiada nama)", over: overpaid });
    });
    t.total = r2(t.total); t.paid = r2(t.paid); t.outstanding = r2(t.outstanding);
    t.paidTick = r2(t.paidTick); t.overpaid = r2(t.overpaid);
    MOVE_ACCOUNTS.forEach(function(a){ t.byAccount[a.key] = r2(t.byAccount[a.key]); });
    return { info: info, totals: t, overpaidList: overpaidList };
  }

  function calcMonth(monthData){
    var ex = calcExpenses(monthData);
    var T = ex.totals;
    var income = Number(monthData.income) || 0;

    // Each expense is budgeted out of income exactly once.
    // The RHB reserve has to cover: what is still unpaid + what was paid out of
    // RHB (linked RHB movements + paid ticks). The part of an expense paid from
    // another account (e.g. Maybank) is NOT also reserved in RHB — that was
    // the double count: it used to be taken off the Maybank allocation as an
    // RHB reserve AND again as a Maybank outflow.
    var paidFromRhb = r2(T.byAccount.rhb + T.paidTick);
    var rhbRequired = r2(T.outstanding + paidFromRhb);
    var remaining = r2(income - rhbRequired);

    var maybankOtherSpending, shortfall;
    if(remaining >= 0){
      maybankOtherSpending = remaining;
      shortfall = 0;
    } else {
      maybankOtherSpending = 0;
      shortfall = Math.abs(remaining);
    }

    // RHB movement log: every ringgit in/out of RHB (linked or not) moves the
    // RHB balance exactly once.
    var rhbNetOut = 0;
    (monthData.rhbWithdrawals || []).forEach(function(w){
      var amt = num(w.amount);
      rhbNetOut += (w.direction === "in") ? -amt : amt;
    });
    rhbNetOut = r2(rhbNetOut);
    // Ticked (unlinked) expenses count as money leaving RHB; linked expenses
    // are already in rhbNetOut through their movements.
    var totalWithdrawn = r2(rhbNetOut + T.paidTick);
    var computedRhbBalance = r2(rhbRequired - totalWithdrawn);
    var expensesOverBy = computedRhbBalance < 0 ? Math.abs(computedRhbBalance) : 0;

    var hasRhbBalanceEntry = typeof monthData.rhbCurrentBalance === "number" && !isNaN(monthData.rhbCurrentBalance);
    var rhbCurrentBalance = hasRhbBalanceEntry ? monthData.rhbCurrentBalance : null;
    var rhbReconcileDiff = hasRhbBalanceEntry ? r2(rhbCurrentBalance - computedRhbBalance) : 0;

    // Maybank
    var maybankTotalIn = 0, maybankTotalOut = 0;
    (monthData.maybankMovements || []).forEach(function(x){
      var amt = num(x.amount);
      if(x.direction === "out") maybankTotalOut += amt; else maybankTotalIn += amt;
    });
    maybankTotalIn = r2(maybankTotalIn);
    maybankTotalOut = r2(maybankTotalOut);
    var maybankNetMovement = r2(maybankTotalIn - maybankTotalOut);
    // Baki Maybank Sepatutnya = Available (Awal) + Total Masuk - Total Keluar
    var maybankExpectedBalance = r2(maybankOtherSpending + maybankNetMovement);
    var maybankAvailableAdjusted = r2(maybankOtherSpending + maybankTotalIn);
    var hasBalanceEntry = typeof monthData.maybankCurrentBalance === "number" && !isNaN(monthData.maybankCurrentBalance);
    var maybankCurrentBalance = hasBalanceEntry ? monthData.maybankCurrentBalance : null;
    var maybankSpentEstimate = 0, maybankSurplus = 0;
    if(hasBalanceEntry){
      var diff = r2(maybankAvailableAdjusted - maybankCurrentBalance);
      if(diff >= 0){
        // expenses paid from Maybank are already counted under Expenses,
        // so they are not counted again as "other" spending
        maybankSpentEstimate = r2(Math.max(diff - T.byAccount.maybank, 0));
      } else {
        maybankSurplus = Math.abs(diff);
      }
    }

    return {
      ex: ex,
      income: income,
      expensesReserved: T.total,          // total expenses, each counted once
      expensesPaid: T.paid,
      expensesStillNeeded: T.outstanding,
      paidExpensesTotal: T.paid,
      paidByAccount: T.byAccount,
      paidTick: T.paidTick,
      overpaidTotal: T.overpaid,
      rhbRequired: rhbRequired,
      rhbStillNeededTotal: T.outstanding,
      remaining: remaining,
      maybankOtherSpending: maybankOtherSpending,
      shortfall: shortfall,
      maybankTotalIn: maybankTotalIn,
      maybankTotalOut: maybankTotalOut,
      maybankNetMovement: maybankNetMovement,
      maybankExpectedBalance: maybankExpectedBalance,
      maybankReconcileDiff: hasBalanceEntry ? r2(maybankCurrentBalance - maybankExpectedBalance) : 0,
      maybankAvailableAdjusted: maybankAvailableAdjusted,
      hasBalanceEntry: hasBalanceEntry,
      maybankCurrentBalance: maybankCurrentBalance,
      maybankSpentEstimate: maybankSpentEstimate,
      maybankSurplus: maybankSurplus,
      rhbNetOut: rhbNetOut,
      totalWithdrawn: totalWithdrawn,
      computedRhbBalance: computedRhbBalance,
      expensesOverBy: expensesOverBy,
      hasRhbBalanceEntry: hasRhbBalanceEntry,
      rhbCurrentBalance: rhbCurrentBalance,
      rhbReconcileDiff: rhbReconcileDiff
    };
  }

  function trackerTotals(entries){
    var totalIn = 0, totalOut = 0;
    entries.forEach(function(x){
      var amt = num(x.amount);
      if(x.direction === "out") totalOut += amt; else totalIn += amt;
    });
    return { totalIn: r2(totalIn), totalOut: r2(totalOut), net: r2(totalIn - totalOut) };
  }

  /* ============================================================
     RECEIPTS — stored on the server, in the logged-in account only.
     Key: "YYYY-MM|account|txId". The server checks ownership on every
     request; this module only keeps a list of which receipts exist.
     ============================================================ */
  var Receipts = (function(){
    var keys = {}; // in-memory index of this account's receipt keys
    var ready = false;
    var SERVER_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif)$/;

    function makeKey(month, account, txId){ return month + "|" + account + "|" + txId; }
    function url(key){ return "/api/receipts/" + encodeURIComponent(key); }

    function init(){
      return api("GET", "/api/receipts").then(function(d){
        keys = {};
        (d.receipts || []).forEach(function(r){ keys[r.key] = true; });
        ready = true;
      });
    }

    // Phone photos are large; scale to max 1600px JPEG so many receipts fit.
    // If the browser can't decode the image, the original file is sent.
    function compress(file){
      return new Promise(function(resolve){
        var u;
        try{ u = URL.createObjectURL(file); }catch(e){ resolve(file); return; }
        var img = new Image();
        img.onload = function(){
          try{
            var max = 1600, w = img.naturalWidth, h = img.naturalHeight;
            var s = Math.min(1, max / Math.max(w, h));
            var c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(w * s));
            c.height = Math.max(1, Math.round(h * s));
            var ctx = c.getContext("2d");
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, c.width, c.height);
            ctx.drawImage(img, 0, 0, c.width, c.height);
            c.toBlob(function(b){
              URL.revokeObjectURL(u);
              var useConverted = b && b.size > 0 && (b.size < file.size || !SERVER_TYPES.test(file.type || ""));
              resolve(useConverted ? b : file);
            }, "image/jpeg", 0.82);
          }catch(e){ URL.revokeObjectURL(u); resolve(file); }
        };
        img.onerror = function(){ URL.revokeObjectURL(u); resolve(file); };
        img.src = u;
      });
    }

    function save(month, account, txId, file){
      if(!file) return Promise.reject(new Error("Tiada fail dipilih."));
      if(file.type && !/^image\//.test(file.type)) return Promise.reject(new Error("Sila pilih fail gambar."));
      var key = makeKey(month, account, txId);
      return compress(file).then(function(blob){
        return api("PUT", url(key), {
          body: blob, type: blob.type || file.type || "image/jpeg",
          headers: { "X-Receipt-Name": encodeURIComponent(file.name || "receipt") }
        });
      }).then(function(){
        keys[key] = true;
        return key;
      });
    }

    // Same record shape as before: { data: ArrayBuffer, type, size, savedAt }
    function get(key){
      return fetch(url(key), { credentials: "same-origin", cache: "no-store" }).then(function(res){
        if(res.status === 404) return null;
        if(!res.ok){ var e = new Error("Resit tak dapat dimuatkan (" + res.status + ")."); e.status = res.status; throw e; }
        return res.arrayBuffer().then(function(buf){
          return { data: buf, type: res.headers.get("Content-Type") || "image/jpeg", size: buf.byteLength,
                   savedAt: res.headers.get("X-Receipt-Saved-At") };
        });
      });
    }

    function remove(key){
      if(ready && !keys[key]) return Promise.resolve();
      return api("DELETE", url(key)).then(function(){ delete keys[key]; });
    }
    function removeMonth(month){
      return api("DELETE", "/api/receipts?month=" + encodeURIComponent(month)).then(function(){
        Object.keys(keys).forEach(function(k){ if(k.indexOf(month + "|") === 0) delete keys[k]; });
      });
    }
    function clearAll(){
      return api("DELETE", "/api/receipts?all=1").then(function(){ keys = {}; });
    }
    function has(key){ return !!keys[key]; }
    function countForMonth(month){
      return Object.keys(keys).filter(function(k){ return k.indexOf(month + "|") === 0; }).length;
    }

    return {
      init: init, save: save, get: get, remove: remove, removeMonth: removeMonth, clearAll: clearAll,
      has: has, makeKey: makeKey, countForMonth: countForMonth,
      allKeys: function(){ return keys; },
      isReady: function(){ return ready; }, supported: function(){ return true; }
    };
  })();

  /* ============================================================
     RENDER: MONTH TABS
     ============================================================ */
  function renderMonthTabs(){
    var wrap = document.getElementById("monthTabs");
    wrap.innerHTML = "";
    MONTHS.forEach(function(m){
      var btn = document.createElement("button");
      btn.className = "month-tab" + (m.key === state.selectedMonth ? " active" : "");
      btn.textContent = m.short;
      btn.addEventListener("click", function(){
        state.selectedMonth = m.key;
        saveState();
        renderAll();
      });
      wrap.appendChild(btn);
    });
  }

  /* ============================================================
     RENDER: EXPENSE LIST
     ============================================================ */
  function renderExpenseList(monthData){
    var list = document.getElementById("expenseList");
    var empty = document.getElementById("emptyExpenses");
    list.innerHTML = "";
    empty.style.display = monthData.expenses.length === 0 ? "block" : "none";

    monthData.expenses.forEach(function(expense){
      var row = document.createElement("div");
      row.className = "expense-row";
      row.setAttribute("data-exp-id", expense.id);

      var paidBtn = document.createElement("button");
      paidBtn.type = "button";
      paidBtn.className = "paid-checkbox";
      paidBtn.setAttribute("aria-label", "Tandakan dah bayar");
      paidBtn.addEventListener("click", function(){
        // Tick = confirm fully paid (only the unpaid remainder is added).
        // Untick = remove that manual portion; linked movements still count.
        expense.paid = !expense.paid;
        saveState();
        renderCalculations();
      });

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.placeholder = "Commitment name";
      nameInput.value = expense.name;
      nameInput.addEventListener("input", function(){
        expense.name = nameInput.value;
        saveState();
        renderCalculations();
      });

      var amountWrap = document.createElement("div");
      amountWrap.className = "amount-wrap";
      var amountLabel = document.createElement("span");
      amountLabel.textContent = "RM";
      var amountInput = document.createElement("input");
      amountInput.type = "number";
      amountInput.inputMode = "decimal";
      amountInput.step = "0.01";
      amountInput.min = "0";
      amountInput.placeholder = "0.00";
      amountInput.value = expense.amount === 0 ? "" : expense.amount;
      amountInput.addEventListener("input", function(){
        var val = parseFloat(amountInput.value);
        expense.amount = isNaN(val) ? 0 : val;
        saveState();
        renderCalculations();
      });
      amountWrap.appendChild(amountLabel);
      amountWrap.appendChild(amountInput);

      var delBtn = document.createElement("button");
      delBtn.className = "del-btn";
      delBtn.setAttribute("aria-label", "Delete commitment");
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", function(){
        var monthObj = state.months[state.selectedMonth];
        var idx = monthObj.expenses.findIndex(function(e){ return e.id === expense.id; });
        if(idx > -1){
          monthObj.expenses.splice(idx, 1);
          // unlink any movement that pointed at this expense (the movement itself stays)
          MOVE_ACCOUNTS.forEach(function(a){
            monthObj[a.listKey].forEach(function(m){ if(m.linkedExpenseId === expense.id) m.linkedExpenseId = null; });
          });
          saveState();
          renderAll();
        }
      });

      // Due date row (optional). Changing it only saves + re-renders; it never
      // touches amount, paid tick, links or any balance.
      var dueRow = document.createElement("div");
      dueRow.className = "expense-due";
      var dueLabel = document.createElement("span");
      dueLabel.className = "due-label";
      dueLabel.textContent = "📅 Due";
      var dueWrap = document.createElement("div");
      dueWrap.className = "due-input-wrap";
      var dueInput = document.createElement("input");
      dueInput.type = "date";
      dueInput.setAttribute("aria-label", "Due date");
      dueInput.value = isDueDate(expense.dueDate) ? expense.dueDate : "";
      var dueClear = document.createElement("button");
      dueClear.type = "button";
      dueClear.className = "due-clear";
      dueClear.setAttribute("aria-label", "Buang due date");
      dueClear.textContent = "✕";
      function syncDueUi(){
        var has = isDueDate(expense.dueDate);
        dueInput.classList.toggle("is-empty", !has);
        dueClear.hidden = !has;
      }
      function onDueChange(){
        var v = dueInput.value;
        var next = isDueDate(v) ? v : null;
        if(next === (isDueDate(expense.dueDate) ? expense.dueDate : null)) return;
        expense.dueDate = next;
        syncDueUi();
        saveState();
        renderCalculations();
      }
      dueInput.addEventListener("input", onDueChange);
      dueInput.addEventListener("change", onDueChange);
      dueClear.addEventListener("click", function(){
        dueInput.value = "";
        onDueChange();
      });
      syncDueUi();
      var dueBadge = document.createElement("span");
      dueBadge.className = "due-badge";
      dueWrap.appendChild(dueInput);
      dueWrap.appendChild(dueClear);
      dueRow.appendChild(dueLabel);
      dueRow.appendChild(dueWrap);
      dueRow.appendChild(dueBadge);

      var status = document.createElement("div");
      status.className = "expense-status";

      row.appendChild(paidBtn);
      row.appendChild(nameInput);
      row.appendChild(amountWrap);
      row.appendChild(delBtn);
      row.appendChild(dueRow);
      row.appendChild(status);
      list.appendChild(row);
    });
  }

  // Refresh paid ticks / status lines in place (keeps keyboard focus)
  function updateExpenseStatuses(monthData, calc){
    var info = calc.ex.info;
    var today = todayISO();
    var expById = {};
    monthData.expenses.forEach(function(e){ expById[e.id] = e; });
    document.querySelectorAll("#expenseList .expense-row").forEach(function(row){
      var i = info[row.getAttribute("data-exp-id")];
      if(!i) return;

      // Due-date badge (display only). Paid commitments never show overdue.
      var exp = expById[row.getAttribute("data-exp-id")];
      var badge = row.querySelector(".due-badge");
      var due = exp && isDueDate(exp.dueDate) ? exp.dueDate : null;
      var overdue = false;
      if(badge){
        badge.className = "due-badge";
        badge.textContent = "";
        if(due){
          if(i.status === "paid"){
            badge.classList.add("due-paid");
            badge.textContent = "✓ Paid";
          } else if(due < today){
            overdue = true;
            badge.classList.add("due-overdue");
            var late = daysBetween(due, today);
            badge.textContent = "⚠️ Overdue" + (late > 0 ? " · " + late + " hari" : "");
          } else if(due === today){
            badge.classList.add("due-today");
            badge.textContent = "⏰ Due today";
          } else {
            badge.classList.add("due-upcoming");
            badge.textContent = "Due " + formatDueDate(due);
          }
        }
      }
      row.classList.toggle("is-overdue", overdue);

      var box = row.querySelector(".paid-checkbox");
      var st = row.querySelector(".expense-status");
      row.classList.toggle("is-paid", i.status === "paid");
      box.classList.toggle("checked", i.status === "paid");
      box.classList.toggle("partial", i.status === "partial");
      box.classList.toggle("linked", i.linked);
      box.textContent = i.status === "paid" ? "✓" : (i.status === "partial" ? "–" : "");
      box.title = (i.linked && i.paidTick <= 0 && i.status === "paid") ? "Lunas ikut pergerakan yang di-link"
        : (i.paidTick > 0 ? "Tanda lunas (klik untuk buang)" : "Tandakan dah bayar");

      st.className = "expense-status" + (i.status === "paid" ? " st-paid" : (i.status === "partial" ? " st-partial" : ""));
      st.innerHTML = "";
      if(i.status === "partial"){
        st.appendChild(document.createTextNode("Dibayar " + formatRM(i.paid) + " · Baki " + formatRM(i.outstanding)));
      } else if(i.status === "paid" && i.paidLinked > 0 && i.paidTick > 0){
        st.appendChild(document.createTextNode("Lunas · " + formatRM(i.paidLinked) + " ikut link + " + formatRM(i.paidTick) + " ditanda"));
      }
      if(i.overpaid > 0){
        var over = document.createElement("span");
        over.className = "over";
        over.textContent = "⚠️ Bayaran yang di-link melebihi commitment sebanyak " + formatRM(i.overpaid) + " — lebihan tak dikira sebagai bayaran commitment.";
        st.appendChild(over);
      }
    });

    var paidNote = document.getElementById("expensePaidNote");
    if(monthData.expenses.length === 0){
      paidNote.textContent = "";
    } else {
      var T = calc.ex.totals;
      paidNote.textContent = "✓ " + T.paidCount + "/" + monthData.expenses.length + " lunas · Dibayar " + formatRM(T.paid) + " · Belum dibayar " + formatRM(T.outstanding);
    }
  }

  /* ============================================================
     RENDER: MOVEMENT LISTS (RHB, Maybank, ASNB, TNG, ShopeePay)
     One renderer for all logs; each row: name, direction, amount,
     optional expense link, and receipt controls.
     ============================================================ */
  function linkOptionText(exp, info){
    var t = "🔗 " + (exp.name || "(Tiada nama)") + " — " + formatRM(exp.amount);
    if(info && info.linked && info.outstanding > 0) t += " (baki " + formatRM(info.outstanding) + ")";
    return t;
  }

  function fillLinkSelect(sel, monthData, info){
    var current = sel.getAttribute("data-current") || "";
    sel.innerHTML = "";
    var noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "Pilih commitment…";
    sel.appendChild(noneOpt);
    monthData.expenses.forEach(function(exp){
      var o = document.createElement("option");
      o.value = exp.id;
      o.textContent = linkOptionText(exp, info[exp.id]);
      sel.appendChild(o);
    });
    sel.value = current;
  }

  // Linked-commitment chip on a movement card (display only).
  function fillLinkChip(chip, monthData, info){
    var acct = moveAccount(chip.getAttribute("data-account"));
    var mv = acct ? (monthData[acct.listKey] || []).find(function(x){ return x.id === chip.getAttribute("data-tx"); }) : null;
    var exp = mv && mv.linkedExpenseId ? monthData.expenses.find(function(e){ return e.id === mv.linkedExpenseId; }) : null;
    chip.innerHTML = "";
    chip.hidden = !exp;
    if(!exp) return;
    var i = info[exp.id] || { paidLinked: 0, amount: num(exp.amount), outstanding: num(exp.amount), status: "unpaid" };

    var main = document.createElement("div");
    main.className = "mc-chip-main";
    var name = document.createElement("div");
    name.className = "mc-chip-name";
    name.textContent = "🔗 " + (exp.name || "(Tiada nama)");
    name.title = exp.name || "";
    var meta = document.createElement("div");
    meta.className = "mc-chip-meta";
    var linkedPart = document.createElement("span");
    linkedPart.textContent = "Link " + formatRM(i.paidLinked) + " / " + formatRM(i.amount);
    meta.appendChild(linkedPart);
    if(i.outstanding > 0){
      var remPart = document.createElement("span");
      remPart.className = "mc-chip-rem";
      remPart.textContent = "Baki " + formatRM(i.outstanding);
      meta.appendChild(remPart);
    }
    main.appendChild(name);
    main.appendChild(meta);

    var unlink = document.createElement("button");
    unlink.type = "button";
    unlink.className = "mc-chip-unlink";
    unlink.setAttribute("aria-label", "Buang link");
    unlink.title = "Buang link";
    unlink.textContent = "Unlink";
    chip.appendChild(main);
    chip.appendChild(unlink);
  }

  function refreshLinkChips(monthData, calc){
    document.querySelectorAll(".mc-chip").forEach(function(chip){ fillLinkChip(chip, monthData, calc.ex.info); });
  }

  function refreshLinkSelects(monthData, calc){
    document.querySelectorAll("select.link-select").forEach(function(sel){
      if(document.activeElement === sel) return;
      fillLinkSelect(sel, monthData, calc.ex.info);
    });
  }

  function renderMovementList(monthData, accountKey){
    var acct = moveAccount(accountKey);
    var ui = MOVE_UI[accountKey];
    var entries = monthData[acct.listKey];
    var list = document.getElementById(ui.listId);
    var empty = document.getElementById(ui.emptyId);
    var monthKey = state.selectedMonth;
    var info = calcExpenses(monthData).info;
    list.innerHTML = "";
    empty.style.display = entries.length === 0 ? "block" : "none";

    entries.forEach(function(m, index){
      // Movement card. Keeps the "withdrawal-row" class (used for focus on add).
      var row = document.createElement("div");
      row.className = "withdrawal-row move-card dir-" + m.direction;

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "mc-del";
      delBtn.setAttribute("aria-label", "Padam catatan");
      delBtn.title = "Padam catatan";
      delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
      delBtn.addEventListener("click", function(){
        var monthObj = state.months[monthKey];
        var idx = monthObj[acct.listKey].findIndex(function(x){ return x.id === m.id; });
        if(idx > -1){
          monthObj[acct.listKey].splice(idx, 1);
          saveState();
          // the transaction is gone, so its receipt goes too
          Receipts.remove(Receipts.makeKey(monthKey, accountKey, m.id)).catch(function(err){ console.warn(err); });
          renderMovementList(monthObj, accountKey);
          renderCalculations();
        }
      });
      // line 1: description + delete · line 2: type + amount · line 3: receipt
      var line1 = document.createElement("div");
      line1.className = "mc-line mc-line1";
      var fields = document.createElement("div");
      fields.className = "mc-line mc-fields";

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "mc-control mc-desc";
      nameInput.placeholder = ui.placeholder || "Keterangan (cth: pindahan, bayaran)";
      nameInput.setAttribute("aria-label", "Keterangan");
      nameInput.value = m.name;
      nameInput.addEventListener("input", function(){
        m.name = nameInput.value;
        saveState();
        renderCalculations();
      });

      var dirSelect = document.createElement("select");
      dirSelect.className = "pocket-select mc-control mc-select dir-" + m.direction;
      dirSelect.setAttribute("aria-label", "Jenis pergerakan");
      ui.dirOptions.forEach(function(opt){
        var o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.text;
        dirSelect.appendChild(o);
      });
      dirSelect.value = m.direction;
      dirSelect.addEventListener("change", function(){
        m.direction = dirSelect.value;
        dirSelect.className = "pocket-select mc-control mc-select dir-" + m.direction;
        row.classList.remove("dir-in", "dir-out");
        row.classList.add("dir-" + m.direction);
        saveState();
        renderCalculations();
      });

      var amountWrap = document.createElement("div");
      amountWrap.className = "mc-control mc-amount";
      var amountLabel = document.createElement("span");
      amountLabel.textContent = "RM";
      var amountInput = document.createElement("input");
      amountInput.type = "number";
      amountInput.inputMode = "decimal";
      amountInput.step = "0.01";
      amountInput.min = "0";
      amountInput.placeholder = "0.00";
      amountInput.setAttribute("aria-label", "Amaun (RM)");
      amountInput.value = m.amount === 0 ? "" : m.amount;
      amountInput.addEventListener("input", function(){
        var val = parseFloat(amountInput.value);
        m.amount = isNaN(val) ? 0 : val;
        saveState();
        renderCalculations();
      });
      amountWrap.appendChild(amountLabel);
      amountWrap.appendChild(amountInput);

      line1.appendChild(nameInput);
      line1.appendChild(delBtn);
      fields.appendChild(dirSelect);
      fields.appendChild(amountWrap);

      var foot = document.createElement("div");
      foot.className = "mc-line mc-foot";

      // Optional link to a commitment (RHB only).
      //  • row 3 shows a small "Link" button (left) and the receipt action (right)
      //  • clicking it reveals the selector in its own full-width row
      //  • once linked, a compact chip below the fields shows the commitment,
      //    linked / total, remaining, and an unlink action
      var chip = null, picker = null;
      if(!ui.noLink){
      var linkSelect = document.createElement("select");
      linkSelect.className = "pocket-select link-select mc-control mc-select mc-link-select";
      linkSelect.setAttribute("aria-label", "Link ke commitment");
      linkSelect.setAttribute("data-current", m.linkedExpenseId || "");
      fillLinkSelect(linkSelect, monthData, info);

      var linkBtn = document.createElement("button");
      linkBtn.type = "button";
      linkBtn.className = "mc-link-btn";
      linkBtn.textContent = "🔗 Link Commitment";

      picker = document.createElement("div");
      picker.className = "mc-line mc-picker";
      picker.hidden = true;
      var pickerCancel = document.createElement("button");
      pickerCancel.type = "button";
      pickerCancel.className = "mc-picker-cancel";
      pickerCancel.textContent = "Batal";
      picker.appendChild(linkSelect);
      picker.appendChild(pickerCancel);

      chip = document.createElement("div");
      chip.className = "mc-line mc-chip";
      chip.setAttribute("data-account", accountKey);
      chip.setAttribute("data-tx", m.id);

      var syncLinkUi = function(){
        linkBtn.hidden = !!m.linkedExpenseId || !picker.hidden;
        fillLinkChip(chip, monthData, calcExpenses(monthData).info);
      };

      linkSelect.addEventListener("change", function(){
        m.linkedExpenseId = linkSelect.value || null;
        linkSelect.setAttribute("data-current", m.linkedExpenseId || "");
        saveState();
        picker.hidden = true;
        syncLinkUi();
        renderCalculations();
        if(m.linkedExpenseId){
          var i = calcExpenses(monthData).info[m.linkedExpenseId];
          if(i && i.overpaid > 0){
            openModal(
              "⚠️ Bayaran melebihi commitment",
              "Jumlah pergerakan yang di-link ke commitment ini dah melebihi amaun commitment sebanyak " + formatRM(i.overpaid) +
                ".\n\nCommitment hanya dikira " + formatRM(i.amount) + " — lebihan tak dikira sebagai bayaran commitment, tapi baki akaun masih ikut pergerakan sebenar.",
              null,
              { hideConfirm: true, cancelText: "OK" }
            );
          }
        }
      });
      linkBtn.addEventListener("click", function(){
        fillLinkSelect(linkSelect, monthData, calcExpenses(monthData).info);
        picker.hidden = false;
        syncLinkUi();
        linkSelect.focus();
      });
      pickerCancel.addEventListener("click", function(){
        picker.hidden = true;
        syncLinkUi();
      });
      // unlink = choose "no commitment" in the same selector (same handler/logic)
      chip.addEventListener("click", function(e){
        if(!e.target.closest(".mc-chip-unlink")) return;
        linkSelect.value = "";
        linkSelect.dispatchEvent(new Event("change"));
      });
      syncLinkUi();
      foot.appendChild(linkBtn);
      }

      var receiptCtrl = document.createElement("div");
      receiptCtrl.className = "receipt-ctrl";
      receiptCtrl.setAttribute("data-month", monthKey);
      receiptCtrl.setAttribute("data-account", accountKey);
      receiptCtrl.setAttribute("data-tx", m.id);
      fillReceiptControl(receiptCtrl);
      foot.appendChild(receiptCtrl);

      row.appendChild(line1);
      row.appendChild(fields);
      if(chip) row.appendChild(chip);
      if(picker) row.appendChild(picker);
      row.appendChild(foot);
      list.appendChild(row);
    });
  }

  /* ============================================================
     RECEIPT CONTROLS + REVIEW POPUP
     ============================================================ */
  function findTx(monthKey, accountKey, txId){
    var acct = moveAccount(accountKey);
    var mo = state.months[monthKey];
    if(!acct || !mo) return null;
    return mo[acct.listKey].find(function(x){ return x.id === txId; }) || null;
  }

  function showError(title, err){
    openModal(title, (err && err.message) ? err.message : String(err || "Ralat tidak diketahui."), null, { hideConfirm: true, cancelText: "OK" });
  }

  function fillReceiptControl(ctrl){
    var monthKey = ctrl.getAttribute("data-month");
    var accountKey = ctrl.getAttribute("data-account");
    var txId = ctrl.getAttribute("data-tx");
    var key = Receipts.makeKey(monthKey, accountKey, txId);
    ctrl.innerHTML = "";

    if(Receipts.has(key)){
      var chip = document.createElement("span");
      chip.className = "receipt-chip";
      chip.textContent = "✓ Receipt saved ·";
      var reviewBtn = document.createElement("button");
      reviewBtn.type = "button";
      reviewBtn.className = "receipt-btn review";
      reviewBtn.setAttribute("aria-label", "View Receipt");
      reviewBtn.textContent = "View";
      reviewBtn.addEventListener("click", function(){ openReceiptModal(monthKey, accountKey, txId); });
      ctrl.appendChild(chip);
      ctrl.appendChild(reviewBtn);
      return;
    }

    // <label> wrapping a file input: on phones this offers camera OR gallery
    var label = document.createElement("label");
    label.className = "receipt-btn";
    label.appendChild(document.createTextNode("📎 Add Receipt"));
    var input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.className = "receipt-file";
    input.setAttribute("aria-label", "Add Receipt");
    input.addEventListener("change", function(){
      var file = input.files && input.files[0];
      if(!file) return;
      label.classList.add("busy");
      label.firstChild.textContent = "Menyimpan…";
      Receipts.save(monthKey, accountKey, txId, file).then(function(){
        showSaved();
        fillReceiptControl(ctrl);
      }).catch(function(err){
        fillReceiptControl(ctrl);
        showError("Resit tak dapat disimpan", err);
      });
    });
    label.appendChild(input);
    ctrl.appendChild(label);
  }

  function refreshReceiptControls(){
    document.querySelectorAll(".receipt-ctrl").forEach(fillReceiptControl);
  }

  var receiptView = { key: null, url: null, month: null, account: null, tx: null };

  function loadReceiptImage(){
    var img = document.getElementById("receiptImg");
    var msg = document.getElementById("receiptImgMsg");
    if(receiptView.url){ URL.revokeObjectURL(receiptView.url); receiptView.url = null; }
    img.style.display = "none";
    img.removeAttribute("src");
    msg.style.display = "block";
    msg.textContent = "Memuatkan…";
    var key = receiptView.key;
    Receipts.get(key).then(function(rec){
      if(receiptView.key !== key) return;
      if(!rec){ msg.textContent = "Resit tidak dijumpai."; return; }
      var blob = new Blob([rec.data], { type: rec.type || "image/jpeg" });
      receiptView.url = URL.createObjectURL(blob);
      img.onload = function(){ msg.style.display = "none"; img.style.display = "block"; };
      img.onerror = function(){ msg.textContent = "Format gambar ini tak dapat dipaparkan oleh browser (resit masih disimpan)."; };
      img.src = receiptView.url;
      var saved = new Date(rec.savedAt);
      document.getElementById("receiptMeta").textContent = receiptView.metaText +
        "\nDisimpan: " + (isNaN(saved) ? "-" : saved.toLocaleString("en-MY")) + " · " + Math.round(rec.size / 1024) + " KB";
    }).catch(function(err){ msg.textContent = "Ralat: " + (err && err.message ? err.message : err); });
  }

  function openReceiptModal(monthKey, accountKey, txId){
    var acct = moveAccount(accountKey);
    var t = findTx(monthKey, accountKey, txId);
    receiptView.key = Receipts.makeKey(monthKey, accountKey, txId);
    receiptView.month = monthKey; receiptView.account = accountKey; receiptView.tx = txId;
    receiptView.metaText = acct.name + " · " + ((t && t.name) || "(Tiada nama)") +
      (t ? " · " + (t.direction === "out" ? "Keluar " : "Masuk ") + formatRM(t.amount) : "") + " · " + monthMeta(monthKey).label;
    document.getElementById("receiptTitle").textContent = "🧾 Receipt";
    document.getElementById("receiptMeta").textContent = receiptView.metaText;
    var del = document.getElementById("receiptDeleteBtn");
    del.classList.remove("armed");
    del.textContent = "🗑️ Delete";
    document.getElementById("receiptOverlay").classList.add("show");
    loadReceiptImage();
  }

  function closeReceiptModal(){
    document.getElementById("receiptOverlay").classList.remove("show");
    if(receiptView.url){ URL.revokeObjectURL(receiptView.url); receiptView.url = null; }
    var img = document.getElementById("receiptImg");
    img.removeAttribute("src");
    receiptView.key = null;
  }

  /* ============================================================
     RENDER: CALCULATIONS (everything derived)
     ============================================================ */
  function renderCalculations(){
    var monthData = state.months[state.selectedMonth];
    var monthMetaNow = currentMeta();
    var calc = calcMonth(monthData);

    document.getElementById("monthSubtitle").textContent = monthMetaNow.label;
    document.getElementById("summaryTitle").textContent = monthMetaNow.label;
    document.getElementById("excelMonthLabel").textContent = monthMetaNow.short;
    document.getElementById("deleteMonthLabel").textContent = monthMetaNow.short;

    // top summary card
    document.getElementById("sumIncome").textContent = formatRM(calc.income);
    document.getElementById("sumExpenses").textContent = formatRM(Math.max(calc.expensesStillNeeded, 0));
    document.getElementById("sumRhb").textContent = formatRM(Math.max(calc.rhbStillNeededTotal, 0));

    var sumMaybankEl = document.getElementById("sumMaybank");
    var sumMaybankWrap = document.getElementById("sumMaybankWrap");
    sumMaybankWrap.classList.remove("positive", "warning");
    if(calc.shortfall > 0){
      sumMaybankEl.textContent = "Short by " + formatRM(calc.shortfall);
      sumMaybankWrap.classList.add("warning");
    } else {
      sumMaybankEl.textContent = formatRM(calc.maybankOtherSpending);
      sumMaybankWrap.classList.add("positive");
    }

    // expense total (each expense counted once) + what's still unpaid
    document.getElementById("expenseTotal").textContent = formatRM(calc.expensesReserved);
    var stillNeeded = Math.max(calc.expensesStillNeeded, 0);
    document.getElementById("reserveBanner").textContent =
      "🔴 Need " + formatRM(stillNeeded) + " in RHB for Unpaid/Unreleased Commitments";
    updateExpenseStatuses(monthData, calc);

    document.getElementById("rhbExpensesReserved").textContent = formatRM(Math.max(calc.expensesStillNeeded, 0));
    document.getElementById("rhbTotal").textContent = formatRM(Math.max(calc.rhbStillNeededTotal, 0));
    renderRhbWithdrawalSummary(calc);

    var shortfallBanner = document.getElementById("shortfallBanner");
    if(calc.shortfall > 0){
      shortfallBanner.style.display = "block";
      document.getElementById("shortfallAmount").textContent = "⚠️ Short by " + formatRM(calc.shortfall);
    } else {
      shortfallBanner.style.display = "none";
    }

    renderMaybankBalanceSection(calc);

    [["asnbEntries", "asnbTotalIn", "asnbTotalOut", "asnbNetTotal"],
     ["tngEntries", "tngTotalIn", "tngTotalOut", "tngNetTotal"],
     ["spEntries", "spTotalIn", "spTotalOut", "spNetTotal"]].forEach(function(cfg){
      var t = trackerTotals(monthData[cfg[0]]);
      document.getElementById(cfg[1]).textContent = formatRM(t.totalIn);
      document.getElementById(cfg[2]).textContent = formatRM(t.totalOut);
      document.getElementById(cfg[3]).textContent = formatRM(t.net);
    });

    refreshLinkSelects(monthData, calc);
    refreshLinkChips(monthData, calc);
    renderOverallSummary();
    renderAccountTotals();
  }

  /* ============================================================
     RENDER: RHB — movement-log summary + reconciliation
     ============================================================ */
  function renderRhbWithdrawalSummary(calc){
    document.getElementById("rhbWithdrawnTotal").textContent = formatRM(calc.totalWithdrawn);
    document.getElementById("rhbComputedBalance").textContent = formatRM(calc.computedRhbBalance);

    var expOverBanner = document.getElementById("rhbExpensesOverBanner");
    if(calc.expensesOverBy > 0){
      expOverBanner.style.display = "block";
      document.getElementById("rhbExpensesOverAmount").textContent = "⚠️ Commitments Reserved lebih guna " + formatRM(calc.expensesOverBy);
    } else {
      expOverBanner.style.display = "none";
    }

    var reconcileRow = document.getElementById("rhbReconcileRow");
    var reconcileLabel = document.getElementById("rhbReconcileLabel");
    var reconcileValue = document.getElementById("rhbReconcileValue");
    if(!calc.hasRhbBalanceEntry){
      reconcileRow.style.display = "none";
      return;
    }
    reconcileRow.style.display = "flex";
    var diff = calc.rhbReconcileDiff;
    if(Math.abs(diff) < 0.01){
      reconcileLabel.textContent = "✅ Padan dengan catatan";
      reconcileValue.textContent = formatRM(calc.computedRhbBalance);
      reconcileValue.style.color = "var(--green)";
    } else if(diff < 0){
      reconcileLabel.textContent = "⚠️ Kurang dari catatan";
      reconcileValue.textContent = "-" + formatRM(Math.abs(diff));
      reconcileValue.style.color = "var(--red)";
    } else {
      reconcileLabel.textContent = "ℹ️ Lebih dari catatan";
      reconcileValue.textContent = "+" + formatRM(diff);
      reconcileValue.style.color = "var(--amber)";
    }
  }

  /* ============================================================
     RENDER: MAYBANK
     ============================================================ */
  function renderMaybankBalanceSection(calc){
    document.getElementById("maybankAvailableRef").textContent = formatRM(calc.maybankOtherSpending);
    document.getElementById("maybankTotalIn").textContent = formatRM(calc.maybankTotalIn);
    document.getElementById("maybankTotalOut").textContent = formatRM(calc.maybankTotalOut);
    var netEl = document.getElementById("maybankNetMovement");
    netEl.textContent = (calc.maybankNetMovement > 0 ? "+" : "") + formatRM(calc.maybankNetMovement);
    netEl.style.color = calc.maybankNetMovement > 0 ? "var(--green)" : (calc.maybankNetMovement < 0 ? "var(--red)" : "");
    document.getElementById("maybankExpectedBalance").textContent = formatRM(calc.maybankExpectedBalance);

    var mbReconcileRow = document.getElementById("maybankReconcileRow");
    var mbReconcileLabel = document.getElementById("maybankReconcileLabel");
    var mbReconcileValue = document.getElementById("maybankReconcileValue");
    if(!calc.hasBalanceEntry){
      mbReconcileRow.style.display = "none";
    } else {
      mbReconcileRow.style.display = "flex";
      var mbDiff = calc.maybankReconcileDiff;
      if(Math.abs(mbDiff) < 0.01){
        mbReconcileLabel.textContent = "✅ Padan dengan catatan";
        mbReconcileValue.textContent = formatRM(calc.maybankExpectedBalance);
        mbReconcileValue.style.color = "var(--green)";
      } else if(mbDiff < 0){
        mbReconcileLabel.textContent = "⚠️ Kurang dari catatan";
        mbReconcileValue.textContent = "-" + formatRM(Math.abs(mbDiff));
        mbReconcileValue.style.color = "var(--red)";
      } else {
        mbReconcileLabel.textContent = "ℹ️ Lebih dari catatan";
        mbReconcileValue.textContent = "+" + formatRM(mbDiff);
        mbReconcileValue.style.color = "var(--amber)";
      }
    }

    var bigResult = document.getElementById("maybankBalanceBig");
    var bigNote = document.getElementById("maybankBalanceBigNote");
    var spentRow = document.getElementById("maybankSpentRow");
    var surplusBanner = document.getElementById("maybankSurplusBanner");
    var emptyHint = document.getElementById("maybankEmptyHint");
    var resultBlockWrap = document.getElementById("maybankBalanceResultBlock");

    if(!calc.hasBalanceEntry){
      emptyHint.style.display = "block";
      resultBlockWrap.style.display = "none";
      spentRow.style.display = "none";
      surplusBanner.style.display = "none";
      return;
    }
    emptyHint.style.display = "none";
    resultBlockWrap.style.display = "block";
    spentRow.style.display = "flex";

    bigResult.classList.remove("positive", "zero", "negative");
    if(calc.maybankCurrentBalance <= 0){
      bigResult.textContent = formatRM(0);
      bigResult.classList.add(calc.maybankCurrentBalance < 0 ? "negative" : "zero");
      bigNote.textContent = calc.maybankCurrentBalance < 0
        ? "Baki negatif — semak semula akaun Maybank."
        : "Tiada baki lagi untuk berbelanja.";
    } else {
      bigResult.textContent = formatRM(calc.maybankCurrentBalance);
      bigResult.classList.add("positive");
      bigNote.textContent = "";
    }
    document.getElementById("maybankSpentValue").textContent = formatRM(calc.maybankSpentEstimate);

    if(calc.maybankSurplus > 0){
      surplusBanner.style.display = "block";
      document.getElementById("maybankSurplusAmount").textContent = "ℹ️ Baki lebih " + formatRM(calc.maybankSurplus);
    } else {
      surplusBanner.style.display = "none";
    }
  }

  /* ============================================================
     RENDER: OVERALL SUMMARY
     ============================================================ */
  function renderOverallSummary(){
    var totals = { income: 0, expenses: 0, paid: 0, outstanding: 0, rhbRequired: 0, maybankOtherSpending: 0, maybankSpentEstimate: 0 };
    MONTHS.forEach(function(m){
      var calc = calcMonth(state.months[m.key]);
      totals.income += calc.income;
      totals.expenses += calc.expensesReserved;
      totals.paid += calc.expensesPaid;
      totals.outstanding += calc.expensesStillNeeded;
      totals.rhbRequired += calc.rhbRequired;
      totals.maybankOtherSpending += calc.maybankOtherSpending;
      totals.maybankSpentEstimate += calc.maybankSpentEstimate;
    });
    if(MONTHS.length){
      document.getElementById("overallTitle").textContent =
        "📊 Overall Summary (" + MONTHS[0].short + " – " + MONTHS[MONTHS.length - 1].short + ")";
    }
    document.getElementById("ovIncome").textContent = formatRM(totals.income);
    document.getElementById("ovExpenses").textContent = formatRM(totals.expenses);
    document.getElementById("ovPaid").textContent = formatRM(totals.paid);
    document.getElementById("ovOutstanding").textContent = formatRM(totals.outstanding);
    document.getElementById("ovRhb").textContent = formatRM(totals.rhbRequired);
    document.getElementById("ovMaybank").textContent = formatRM(totals.maybankOtherSpending);
    document.getElementById("ovMaybankSpent").textContent = formatRM(totals.maybankSpentEstimate);
  }

  /* ============================================================
     RENDER: TOTAL ACCOUNT BALANCES (final card)
     For each account, as of the selected month:
       1. the actual balance entered for this month, else
       2. the latest actual balance entered in an earlier month, else
       3. the balance worked out from this month's records (RHB "Baki RHB
          Sepatutnya", ASNB/TNG/ShopeePay "Baki (ikut catatan)") when there is
          at least one record; Maybank has no record-based balance, else
       4. "not entered" — never silently counted as RM0.00.
     Only account balances are summed, so income, transfers and linked
     expense payments are never double-counted.
     ============================================================ */
  var ACCOUNTS = [
    { key: "rhb",     name: "RHB",              color: "var(--blue)",   balanceKey: "rhbCurrentBalance",     available: false },
    { key: "asnb",    name: "ASNB",             color: "#7c3aed",       balanceKey: "asnbCurrentBalance",    available: false, entriesKey: "asnbEntries" },
    { key: "tng",     name: "TNG Go+",          color: "#0891b2",       balanceKey: "tngCurrentBalance",     available: true,  entriesKey: "tngEntries" },
    { key: "maybank", name: "Maybank",          color: "var(--teal)",   balanceKey: "maybankCurrentBalance", available: true },
    { key: "sp",      name: "ShopeePay Money+", color: "var(--orange)", balanceKey: "spCurrentBalance",      available: true,  entriesKey: "spEntries" }
  ];

  function hasNumber(v){ return typeof v === "number" && !isNaN(v); }

  function resolveAccountBalance(acct, monthKey){
    monthKey = monthKey || state.selectedMonth;
    var idx = MONTHS.findIndex(function(m){ return m.key === monthKey; });
    for(var i = idx; i >= 0; i--){
      var v = state.months[MONTHS[i].key][acct.balanceKey];
      if(hasNumber(v)){
        return { value: v, source: i === idx ? "Baki sebenar" : "Baki sebenar terkini · " + MONTHS[i].short };
      }
    }
    var monthData = state.months[monthKey];
    if(acct.key === "rhb"){
      if(monthData.expenses.length > 0 || monthData.rhbWithdrawals.length > 0){
        return { value: calcMonth(monthData).computedRhbBalance, source: "Ikut catatan" };
      }
    } else if(acct.entriesKey){
      var entries = monthData[acct.entriesKey];
      if(entries.length > 0) return { value: trackerTotals(entries).net, source: "Ikut catatan" };
    }
    return null;
  }

  function renderAccountTotals(){
    var list = document.getElementById("accountBalanceList");
    if(!list) return;
    document.getElementById("totalsMonthLabel").textContent = currentMeta().short;

    var totalAll = 0, totalAvailable = 0;
    var missingAll = [], missingAvailable = [];
    list.innerHTML = "";

    ACCOUNTS.forEach(function(acct){
      var res = resolveAccountBalance(acct);
      if(res){
        totalAll += res.value;
        if(acct.available) totalAvailable += res.value;
      } else {
        missingAll.push(acct.name);
        if(acct.available) missingAvailable.push(acct.name);
      }

      var row = document.createElement("div");
      row.className = "acct-row";
      var nameEl = document.createElement("div");
      nameEl.className = "acct-name";
      var dot = document.createElement("span");
      dot.className = "acct-dot";
      dot.style.background = acct.color;
      nameEl.appendChild(dot);
      nameEl.appendChild(document.createTextNode(acct.name));
      if(acct.available){
        var badge = document.createElement("span");
        badge.className = "acct-badge";
        badge.textContent = "Available";
        nameEl.appendChild(badge);
      }
      var right = document.createElement("div");
      right.className = "acct-right";
      var valEl = document.createElement("div");
      valEl.className = "acct-value" + (res ? "" : " missing");
      valEl.textContent = res ? formatRM(res.value) : "Belum dimasukkan";
      right.appendChild(valEl);
      if(res){
        var srcEl = document.createElement("div");
        srcEl.className = "acct-src";
        srcEl.textContent = res.source;
        right.appendChild(srcEl);
      }
      row.appendChild(nameEl);
      row.appendChild(right);
      list.appendChild(row);
    });

    document.getElementById("totalAllValue").textContent = formatRM(totalAll) + (missingAll.length ? " *" : "");
    document.getElementById("totalAvailableValue").textContent = formatRM(totalAvailable) + (missingAvailable.length ? " *" : "");

    var warn = document.getElementById("totalsWarning");
    if(missingAll.length){
      warn.style.display = "block";
      warn.textContent = "* Belum lengkap — baki " + missingAll.join(", ") + " belum dimasukkan.";
    } else {
      warn.style.display = "none";
    }
  }

  /* ============================================================
     RENDER: INPUT FIELDS (income / balances)
     ============================================================ */
  function renderInputs(){
    var monthData = state.months[state.selectedMonth];
    function show(v){ return (v === null || v === undefined) ? "" : v; }
    document.getElementById("incomeInput").value = monthData.income === 0 ? "" : monthData.income;
    document.getElementById("spBalanceInput").value = show(monthData.spCurrentBalance);
    document.getElementById("rhbBalanceInput").value = show(monthData.rhbCurrentBalance);
    document.getElementById("maybankBalanceInput").value = show(monthData.maybankCurrentBalance);
    document.getElementById("asnbBalanceInput").value = show(monthData.asnbCurrentBalance);
    document.getElementById("tngBalanceInput").value = show(monthData.tngCurrentBalance);
    renderNotes(monthData);
  }

  function renderNotes(monthData){
    var notesInput = document.getElementById("notesInput");
    if(document.activeElement !== notesInput) notesInput.value = monthData.notes || "";
    document.getElementById("notesMonthLabel").textContent = currentMeta().short;
    document.getElementById("notesCount").textContent = (monthData.notes || "").length + " aksara";
  }

  /* ============================================================
     RENDER ALL
     ============================================================ */
  function renderAll(){
    refreshMonths();
    var monthData = state.months[state.selectedMonth];
    renderMonthTabs();
    renderInputs();
    renderExpenseList(monthData);
    MOVE_ACCOUNTS.forEach(function(a){ renderMovementList(monthData, a.key); });
    renderCalculations();
  }

  /* ============================================================
     EXCEL EXPORT — real .xlsx (Office Open XML) built in the browser.
     No library / internet needed: the workbook XML is zipped here.
     ============================================================ */
  var Xlsx = (function(){
    var CRC_TABLE = null;
    function crc32(bytes){
      if(!CRC_TABLE){
        CRC_TABLE = new Uint32Array(256);
        for(var n = 0; n < 256; n++){
          var c = n;
          for(var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
          CRC_TABLE[n] = c >>> 0;
        }
      }
      var crc = 0xFFFFFFFF;
      for(var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function utf8(str){ return new TextEncoder().encode(str); }
    function esc(s){
      return String(s)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function colName(i){
      var s = "";
      i++;
      while(i > 0){ var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
      return s;
    }
    // styles: 0 normal · 1 header · 2 money · 3 bold money · 4 bold text · 5 wrapped text
    var STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>' +
      '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF171E2E"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="6">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
      '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

    // cell: null | string | number | { v: value, s: styleIndex }
    function sheetXml(sheet){
      var rows = sheet.rows.map(function(r, ri){
        var cells = r.map(function(cell, ci){
          if(cell === null || cell === undefined || cell === "") return "";
          var v = cell, s = 0;
          if(typeof cell === "object"){ v = cell.v; s = cell.s || 0; }
          if(v === null || v === undefined || v === "") return s ? '<c r="' + colName(ci) + (ri + 1) + '" s="' + s + '"/>' : "";
          var ref = colName(ci) + (ri + 1);
          if(typeof v === "number" && isFinite(v)){
            return '<c r="' + ref + '"' + (s ? ' s="' + s + '"' : "") + '><v>' + v + '</v></c>';
          }
          return '<c r="' + ref + '" t="inlineStr"' + (s ? ' s="' + s + '"' : "") + '><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
        }).join("");
        return '<row r="' + (ri + 1) + '">' + cells + '</row>';
      }).join("");
      var cols = (sheet.widths || []).map(function(w, i){
        return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
      }).join("");
      var views = sheet.freezeHeader
        ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        views + '<sheetFormatPr defaultRowHeight="15"/>' + (cols ? '<cols>' + cols + '</cols>' : "") +
        '<sheetData>' + rows + '</sheetData></worksheet>';
    }

    function zip(files){
      var now = new Date();
      var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
      var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
      var parts = [], central = [], offset = 0;
      files.forEach(function(f){
        var name = utf8(f.name), data = f.data, crc = crc32(data);
        var h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
        h.setUint16(8, 0, true); h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true);
        h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
        h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
        parts.push(new Uint8Array(h.buffer), name, data);
        var c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
        c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, dosTime, true);
        c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true);
        c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint16(30, 0, true);
        c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true);
        c.setUint32(38, 0, true); c.setUint32(42, offset, true);
        central.push(new Uint8Array(c.buffer), name);
        offset += 30 + name.length + data.length;
      });
      var cdSize = central.reduce(function(s, p){ return s + p.length; }, 0);
      var e = new DataView(new ArrayBuffer(22));
      e.setUint32(0, 0x06054b50, true); e.setUint16(4, 0, true); e.setUint16(6, 0, true);
      e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
      e.setUint32(12, cdSize, true); e.setUint32(16, offset, true); e.setUint16(20, 0, true);
      return new Blob(parts.concat(central, [new Uint8Array(e.buffer)]), {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      });
    }

    function build(sheets){
      var files = [];
      var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map(function(s, i){
          return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        }).join("") + '</Types>';
      files.push({ name: "[Content_Types].xml", data: utf8(ct) });
      files.push({ name: "_rels/.rels", data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>') });
      files.push({ name: "xl/workbook.xml", data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets>' + sheets.map(function(s, i){
          return '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
        }).join("") + '</sheets></workbook>') });
      files.push({ name: "xl/_rels/workbook.xml.rels", data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map(function(s, i){
          return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
        }).join("") +
        '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>') });
      files.push({ name: "xl/styles.xml", data: utf8(STYLES) });
      sheets.forEach(function(s, i){ files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: utf8(sheetXml(s)) }); });
      return zip(files);
    }

    return { build: build };
  })();

  // Builds the workbook for one month. Read-only: never changes state.
  function buildMonthSheets(monthKey){
    var meta = monthMeta(monthKey);
    var mo = state.months[monthKey];
    var calc = calcMonth(mo);
    var info = calc.ex.info;
    var expById = {};
    mo.expenses.forEach(function(e){ expById[e.id] = e; });
    function H(t){ return { v: t, s: 1 }; }
    function M(v){ return { v: r2(num(v)), s: 2 }; }
    function MB(v){ return { v: r2(num(v)), s: 3 }; }
    function B(t){ return { v: t, s: 4 }; }

    // Monthly Summary
    var S = [];
    S.push([H("Item"), H("Value"), H("Note")]);
    S.push([B("Month"), meta.label, monthKey]);
    S.push([B("Account"), currentUser ? currentUser.username : "", ""]);
    S.push(["Exported at", new Date().toLocaleString("en-MY"), ""]);
    S.push([]);
    S.push([B("INCOME & EXPENSES"), "", ""]);
    S.push(["Income", M(calc.income), ""]);
    S.push(["Total Commitments (each counted once)", MB(calc.expensesReserved), mo.expenses.length + " commitment(s)"]);
    S.push(["Commitments Paid", M(calc.expensesPaid), calc.ex.totals.paidCount + " fully paid"]);
    MOVE_ACCOUNTS.forEach(function(a){
      if(calc.paidByAccount[a.key] > 0) S.push(["   via linked " + a.name + " movements", M(calc.paidByAccount[a.key]), ""]);
    });
    if(calc.paidTick > 0) S.push(["   via paid tick (assumed from RHB)", M(calc.paidTick), "Manual portion only — never includes linked payments"]);
    S.push(["Commitments Outstanding (Unpaid)", MB(calc.expensesStillNeeded), ""]);
    if(calc.overpaidTotal > 0){
      S.push(["⚠️ Linked payments above commitment amount", M(calc.overpaidTotal),
        calc.ex.overpaidList.map(function(o){ return o.name + " +" + formatRM(o.over); }).join("; ")]);
    }
    S.push([]);
    S.push([B("RHB"), "", ""]);
    S.push(["Total Needed in RHB (Still)", M(calc.rhbStillNeededTotal), ""]);
    S.push(["RHB reserve (unpaid + paid from RHB)", M(calc.rhbRequired), ""]);
    S.push(["Jumlah Bersih Diambil dari RHB", M(calc.totalWithdrawn), "Net movements + paid ticks"]);
    S.push(["Baki RHB Sepatutnya", M(calc.computedRhbBalance), ""]);
    S.push(["Baki RHB (bank, entered)", calc.hasRhbBalanceEntry ? M(calc.rhbCurrentBalance) : "Not entered",
      calc.hasRhbBalanceEntry ? "Difference: " + formatRM(calc.rhbReconcileDiff) : ""]);
    S.push([]);
    S.push([B("MAYBANK"), "", ""]);
    S.push(["Perbelanjaan Lain-lain / Available (Awal)", calc.shortfall > 0 ? "Short by " + formatRM(calc.shortfall) : M(calc.maybankOtherSpending), ""]);
    S.push(["Total Masuk", M(calc.maybankTotalIn), ""]);
    S.push(["Total Keluar", M(calc.maybankTotalOut), ""]);
    S.push(["Baki Maybank Sepatutnya", M(calc.maybankExpectedBalance), ""]);
    S.push(["Baki Maybank (bank, entered)", calc.hasBalanceEntry ? M(calc.maybankCurrentBalance) : "Not entered",
      calc.hasBalanceEntry ? "Difference: " + formatRM(calc.maybankReconcileDiff) : ""]);
    if(calc.hasBalanceEntry){
      S.push(["Anggaran Dah Dibelanjakan (other spending)", M(calc.maybankSpentEstimate), "Excludes commitments paid from Maybank"]);
    }
    S.push([]);
    S.push([B("OTHER ACCOUNTS"), "", ""]);
    [["ASNB", "asnbEntries", "asnbCurrentBalance"], ["TNG Go+", "tngEntries", "tngCurrentBalance"], ["ShopeePay Money+", "spEntries", "spCurrentBalance"]].forEach(function(cfg){
      var t = trackerTotals(mo[cfg[1]]);
      S.push([cfg[0] + " — Baki (ikut catatan)", M(t.net), "Masuk " + formatRM(t.totalIn) + " · Keluar " + formatRM(t.totalOut)]);
      S.push([cfg[0] + " — Baki Sebenar (entered)", hasNumber(mo[cfg[2]]) ? M(mo[cfg[2]]) : "Not entered", ""]);
    });
    S.push([]);
    S.push([B("TOTAL ACCOUNT BALANCES"), "", ""]);
    ACCOUNTS.forEach(function(a){
      var res = resolveAccountBalance(a, monthKey);
      S.push([a.name, res ? M(res.value) : "Not entered", res ? res.source : ""]);
    });
    S.push([]);
    S.push([B("Notes"), { v: mo.notes || "", s: 5 }, ""]);

    // Income
    var I = [[H("Month"), H("Date"), H("Description"), H("Account"), H("Amount (RM)"), H("Counted as Income?")]];
    I.push([monthKey, "", "Monthly income (Income field)", "", M(calc.income), "Yes"]);
    MOVE_ACCOUNTS.forEach(function(a){
      mo[a.listKey].forEach(function(x){
        if(x.direction === "in") I.push([monthKey, x.date || "", x.name || "(Tiada nama)", a.name, M(x.amount), "No — incoming movement (" + x.id + ")"]);
      });
    });

    // Expenses
    var E = [[H("Commitment ID"), H("Date Logged"), H("Due Date"), H("Commitment"), H("Amount (RM)"), H("Status"), H("Paid Tick")]
      .concat(LINK_ACCOUNTS.map(function(a){ return H("Paid via " + a.name + " link"); }))
      .concat([H("Paid via Tick (RHB)"), H("Total Paid"), H("Outstanding"), H("Linked Overpayment"), H("Linked Movements")])];
    mo.expenses.forEach(function(e){
      var i = info[e.id];
      var statusText = i.status === "paid" ? "Paid" : (i.status === "partial" ? "Partially paid" : "Unpaid");
      E.push([e.id, e.date || "", isDueDate(e.dueDate) ? e.dueDate : "", e.name || "(Tiada nama)", M(i.amount), statusText,
        e.paid ? (i.linked ? "Yes (remainder only)" : "Yes") : "No"]
        .concat(LINK_ACCOUNTS.map(function(a){ return M(i.paidBy[a.key]); }))
        .concat([M(i.paidTick), M(i.paid), M(i.outstanding), M(i.overpaid),
          i.moves.map(function(mv){ return moveAccount(mv.account).name + " " + mv.id + " " + (mv.direction === "in" ? "Masuk " : "Keluar ") + formatRM(mv.amount) + (mv.name ? " (" + mv.name + ")" : ""); }).join("; ")]));
    });
    E.push([B("TOTAL"), "", "", "", MB(calc.expensesReserved), "", ""]
      .concat(LINK_ACCOUNTS.map(function(a){ return MB(calc.paidByAccount[a.key]); }))
      .concat([MB(calc.paidTick), MB(calc.expensesPaid), MB(calc.expensesStillNeeded), MB(calc.overpaidTotal), ""]));

    var sheets = [
      { name: "Monthly Summary", rows: S, widths: [44, 22, 50] },
      { name: "Income", rows: I, widths: [10, 12, 34, 18, 14, 34], freezeHeader: true },
      { name: "Commitments", rows: E, widths: [14, 12, 12, 28, 13, 15, 18, 16, 18, 16, 22, 16, 18, 13, 13, 18, 60], freezeHeader: true }
    ];

    // One sheet per account movement log
    var sheetNames = { rhb: "RHB Movements", maybank: "Maybank Movements", tng: "TNG Go+ Movements", sp: "ShopeePay Movements", asnb: "ASNB Movements" };
    MOVE_ACCOUNTS.forEach(function(a){
      var R = [[H("Transaction ID"), H("Date Logged"), H("Description"), H("Account"), H("Direction"), H("Amount (RM)"),
        H("Effect on Balance (RM)"), H("Linked Commitment ID"), H("Linked Commitment"), H("Receipt"), H("Receipt Reference")]];
      mo[a.listKey].forEach(function(x){
        var linkId = canLink(a.key) ? x.linkedExpenseId : null;
        var linked = linkId ? expById[linkId] : null;
        var rKey = Receipts.makeKey(monthKey, a.key, x.id);
        var hasR = Receipts.has(rKey);
        R.push([x.id, x.date || "", x.name || "(Tiada nama)", a.name, x.direction === "out" ? "Keluar (Out)" : "Masuk (In)",
          M(x.amount), M(x.direction === "out" ? -num(x.amount) : num(x.amount)),
          linkId || "", linked ? (linked.name || "(Tiada nama)") : "",
          hasR ? "Yes" : "No", hasR ? "IndexedDB: " + rKey : ""]);
      });
      var t = trackerTotals(mo[a.listKey]);
      R.push([]);
      R.push([B("Total Masuk"), "", "", "", "", MB(t.totalIn)]);
      R.push([B("Total Keluar"), "", "", "", "", MB(t.totalOut)]);
      R.push([B("Net"), "", "", "", "", MB(t.net)]);
      sheets.push({ name: sheetNames[a.key], rows: R, widths: [14, 12, 28, 18, 14, 13, 18, 16, 24, 9, 34], freezeHeader: true });
    });
    return sheets;
  }

  function exportMonthToExcel(monthKey){
    try{
      var blob = Xlsx.build(buildMonthSheets(monthKey));
      var a = document.createElement("a");
      var url = URL.createObjectURL(blob);
      a.href = url;
      var pName = (currentUser ? currentUser.username : "").replace(/[^A-Za-z0-9._-]+/g, "");
      a.download = "Money_Tracker_" + (pName ? pName + "_" : "") + monthKey + ".xlsx";
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 4000);
      return true;
    }catch(err){
      console.error(err);
      showError("Excel tak dapat dibuat", err);
      return false;
    }
  }

  /* ============================================================
     DELETE MONTH + ROLL FORWARD
     ============================================================ */
  function deleteMonth(monthKey){
    refreshMonths();
    var keysBefore = MONTHS.map(function(m){ return m.key; });
    var idx = keysBefore.indexOf(monthKey);
    if(idx === -1) return;
    var newKey = nextMonthKey(keysBefore[keysBefore.length - 1]);
    while(state.months[newKey]) newKey = nextMonthKey(newKey);

    delete state.months[monthKey];
    state.months[newKey] = emptyMonth(); // fresh structure, nothing copied
    refreshMonths();
    while(MONTHS.length < ACTIVE_MONTH_COUNT){
      state.months[nextMonthKey(MONTHS[MONTHS.length - 1].key)] = emptyMonth();
      refreshMonths();
    }
    state.selectedMonth = MONTHS[Math.min(idx, MONTHS.length - 1)].key;
    saveState();
    renderAll();

    Receipts.removeMonth(monthKey).catch(function(err){
      showError("Resit bulan dipadam tak dapat dibuang sepenuhnya", err);
    });
  }

  /* ============================================================
     EVENT WIRING
     ============================================================ */
  function addMovement(accountKey){
    var acct = moveAccount(accountKey);
    var ui = MOVE_UI[accountKey];
    var monthData = state.months[state.selectedMonth];
    var entry = { id: newId(acct.idPrefix), name: "", amount: 0, direction: ui.defaultDir, linkedExpenseId: null, date: todayISO() };
    if(accountKey === "rhb") entry.pocket = "expenses";
    monthData[acct.listKey].push(entry);
    saveState();
    renderMovementList(monthData, accountKey);
    renderCalculations();
    var rows = document.querySelectorAll("#" + ui.listId + " .withdrawal-row input[type='text']");
    if(rows.length) rows[rows.length - 1].focus();
  }

  function wireBalanceInput(id, field){
    document.getElementById(id).addEventListener("input", function(e){
      var val = parseFloat(e.target.value);
      state.months[state.selectedMonth][field] = e.target.value === "" ? null : (isNaN(val) ? null : val);
      saveState();
      renderCalculations();
    });
  }

  function wireEvents(){
    document.getElementById("incomeInput").addEventListener("input", function(e){
      var val = parseFloat(e.target.value);
      state.months[state.selectedMonth].income = isNaN(val) ? 0 : val;
      saveState();
      renderCalculations();
    });
    wireBalanceInput("rhbBalanceInput", "rhbCurrentBalance");
    wireBalanceInput("maybankBalanceInput", "maybankCurrentBalance");
    wireBalanceInput("asnbBalanceInput", "asnbCurrentBalance");
    wireBalanceInput("tngBalanceInput", "tngCurrentBalance");
    wireBalanceInput("spBalanceInput", "spCurrentBalance");

    document.getElementById("notesInput").addEventListener("input", function(e){
      var monthData = state.months[state.selectedMonth];
      monthData.notes = e.target.value;
      document.getElementById("notesCount").textContent = monthData.notes.length + " aksara";
      saveState();
    });

    document.getElementById("notesClearBtn").addEventListener("click", function(){
      openModal(
        "Kosongkan catatan?",
        "Catatan untuk " + currentMeta().label + " akan dipadam. Bulan lain tidak terjejas.",
        function(){
          state.months[state.selectedMonth].notes = "";
          saveState();
          renderNotes(state.months[state.selectedMonth]);
        }
      );
    });

    document.getElementById("addExpenseBtn").addEventListener("click", function(){
      var monthData = state.months[state.selectedMonth];
      monthData.expenses.push({ id: newId("exp"), name: "", amount: 0, paid: false, date: todayISO(), dueDate: null });
      saveState();
      renderExpenseList(monthData);
      renderCalculations();
      var rows = document.querySelectorAll("#expenseList .expense-row input[type='text']");
      if(rows.length) rows[rows.length - 1].focus();
    });

    document.getElementById("addRhbWithdrawalBtn").addEventListener("click", function(){ addMovement("rhb"); });
    document.getElementById("addMaybankMovementBtn").addEventListener("click", function(){ addMovement("maybank"); });
    document.getElementById("addAsnbBtn").addEventListener("click", function(){ addMovement("asnb"); });
    document.getElementById("addTngBtn").addEventListener("click", function(){ addMovement("tng"); });
    document.getElementById("addSpBtn").addEventListener("click", function(){ addMovement("sp"); });

    // Auto-link: unlinked Keluar movements in ANY account whose name matches
    // exactly one expense get linked to it.
    document.getElementById("autoLinkBtn").addEventListener("click", function(){
      var monthData = state.months[state.selectedMonth];
      var norm = function(s){ return String(s || "").trim().toLowerCase(); };
      var linkedCount = 0;
      var skippedAmbiguous = [];

      MOVE_ACCOUNTS.forEach(function(a){
        monthData[a.listKey].forEach(function(w){
          if(!canLink(a.key) || w.linkedExpenseId || w.direction !== "out") return;
          var wName = norm(w.name);
          if(!wName) return;
          var matches = monthData.expenses.filter(function(e){
            var eName = norm(e.name);
            return eName && (eName === wName || eName.indexOf(wName) !== -1 || wName.indexOf(eName) !== -1);
          });
          if(matches.length === 1){
            w.linkedExpenseId = matches[0].id;
            linkedCount++;
          } else if(matches.length > 1){
            skippedAmbiguous.push(w.name + " (" + a.name + ")");
          }
        });
      });

      saveState();
      renderAll();

      var msg = linkedCount > 0
        ? linkedCount + " pergerakan Keluar berjaya di-link ikut nama yang sepadan dengan commitment (semua akaun)."
        : "Tiada pergerakan baru yang sepadan untuk di-link. Semak nama entry vs nama commitment.";
      if(skippedAmbiguous.length > 0){
        msg += "\n\nAda " + skippedAmbiguous.length + " nama yang sepadan dengan lebih dari satu commitment (link manual je untuk ni): " + skippedAmbiguous.join(", ") + ".";
      }
      var over = calcExpenses(monthData).overpaidList;
      if(over.length){
        msg += "\n\n⚠️ Bayaran link melebihi commitment: " + over.map(function(o){ return o.name + " +" + formatRM(o.over); }).join(", ") + ". Semak kalau ada pergerakan yang sama di-link dua kali (contoh: pindahan RHB→Maybank dan bayaran dari Maybank).";
      }
      openModal("Auto-link selesai", msg, null, { hideConfirm: true, cancelText: "OK" });
    });

    document.getElementById("overallToggle").addEventListener("click", function(){
      document.getElementById("overallBody").classList.toggle("open");
      document.getElementById("overallToggle").classList.toggle("open");
    });

    document.getElementById("downloadExcelBtn").addEventListener("click", function(){
      exportMonthToExcel(state.selectedMonth);
    });

    document.getElementById("resetMonthBtn").addEventListener("click", function(){
      var meta = currentMeta();
      var key = meta.key;
      openModal(
        "Reset " + meta.label + "?",
        "Are you sure you want to reset this month's data? Income, commitments, RHB movements, Maybank movements, notes, ASNB, TNG Go+, ShopeePay Money+ and receipt photos for " + meta.label + " will be cleared (account \"" + currentUser.username + "\" only). Other months are not affected.",
        function(){
          state.months[key] = emptyMonth();
          saveState();
          renderAll();
          Receipts.removeMonth(key).then(refreshReceiptControls).catch(function(err){ console.warn(err); });
        }
      );
    });

    document.getElementById("resetAllBtn").addEventListener("click", function(){
      openModal(
        "Reset ALL data?",
        "Account \"" + currentUser.username + "\".\n\nThis will permanently erase income, commitments, RHB movements, Maybank movements, notes, ASNB, TNG Go+, ShopeePay Money+ and receipt photos for every month from " +
          MONTHS[0].label + " to " + MONTHS[MONTHS.length - 1].label + ". This cannot be undone.",
        function(){
          // keep the current month window; ID counters keep counting up so a
          // new transaction can never pick up an old receipt
          state = defaultState(MONTHS.map(function(m){ return m.key; }));
          saveState();
          renderAll();
          Receipts.clearAll().then(refreshReceiptControls).catch(function(err){ console.warn(err); });
        }
      );
    });

    document.getElementById("deleteMonthBtn").addEventListener("click", function(){
      var meta = currentMeta();
      var key = meta.key;
      var newMeta = monthMeta(nextMonthKey(MONTHS[MONTHS.length - 1].key));
      var receiptCount = Receipts.countForMonth(key);
      openModal(
        "Delete " + meta.label + "?",
        "All of " + meta.label + "'s income, commitments, movements (RHB, Maybank, ASNB, TNG Go+, ShopeePay Money+), notes and " +
          receiptCount + " receipt photo(s) will be permanently deleted. This cannot be undone.\n\n" +
          newMeta.label + " will be added as a new, empty month so 7 months stay active. Other months are not affected.\n\n" +
          "Tip: download this month to Excel first to keep a record.",
        function(){ deleteMonth(key); },
        {
          confirmText: "Delete Month",
          extraText: "⬇️ Download Excel first (" + meta.short + ")",
          onExtra: function(btn){
            if(exportMonthToExcel(key)){
              btn.textContent = "✓ Excel downloaded — you can now delete";
              btn.classList.add("done");
            }
          }
        }
      );
    });

    // Modal
    document.getElementById("modalCancel").addEventListener("click", closeModal);
    document.getElementById("modalOverlay").addEventListener("click", function(e){
      if(e.target === document.getElementById("modalOverlay")) closeModal();
    });
    document.getElementById("modalConfirm").addEventListener("click", function(){
      var fn = pendingResetAction;
      closeModal();
      if(fn) fn();
    });
    document.getElementById("modalExtra").addEventListener("click", function(e){
      if(pendingExtraAction) pendingExtraAction(e.currentTarget);
    });

    // Receipt review popup
    document.getElementById("receiptCloseBtn").addEventListener("click", closeReceiptModal);
    document.getElementById("receiptOverlay").addEventListener("click", function(e){
      if(e.target === document.getElementById("receiptOverlay")) closeReceiptModal();
    });
    document.getElementById("receiptReplaceInput").addEventListener("change", function(e){
      var input = e.target;
      var file = input.files && input.files[0];
      if(!file || !receiptView.key) return;
      var msg = document.getElementById("receiptImgMsg");
      msg.style.display = "block";
      msg.textContent = "Menyimpan…";
      document.getElementById("receiptImg").style.display = "none";
      Receipts.save(receiptView.month, receiptView.account, receiptView.tx, file).then(function(){
        input.value = "";
        showSaved();
        loadReceiptImage();
        refreshReceiptControls();
      }).catch(function(err){
        input.value = "";
        loadReceiptImage();
        msg.textContent = "Tak dapat simpan: " + (err && err.message ? err.message : err);
      });
    });
    document.getElementById("receiptDeleteBtn").addEventListener("click", function(){
      var btn = document.getElementById("receiptDeleteBtn");
      if(!btn.classList.contains("armed")){
        btn.classList.add("armed");
        btn.textContent = "Tap again to delete";
        return;
      }
      var key = receiptView.key;
      Receipts.remove(key).then(function(){
        closeReceiptModal();
        refreshReceiptControls();
      }).catch(function(err){
        btn.classList.remove("armed");
        btn.textContent = "🗑️ Delete";
        document.getElementById("receiptImgMsg").textContent = "Tak dapat padam: " + (err && err.message ? err.message : err);
      });
    });
  }

  /* ============================================================
     MODAL HELPERS
     opts: { confirmText, cancelText, hideConfirm, extraText, onExtra }
     ============================================================ */
  function openModal(title, message, onConfirm, opts){
    opts = opts || {};
    document.getElementById("modalTitle").textContent = title;
    document.getElementById("modalMessage").textContent = message;
    var confirmBtn = document.getElementById("modalConfirm");
    var cancelBtn = document.getElementById("modalCancel");
    var extraBtn = document.getElementById("modalExtra");
    confirmBtn.textContent = opts.confirmText || "Yes, Reset";
    confirmBtn.style.display = opts.hideConfirm ? "none" : "";
    cancelBtn.textContent = opts.cancelText || "Cancel";
    if(opts.extraText){
      extraBtn.textContent = opts.extraText;
      extraBtn.classList.remove("done");
      extraBtn.style.display = "";
    } else {
      extraBtn.style.display = "none";
    }
    pendingResetAction = onConfirm || null;
    pendingExtraAction = opts.onExtra || null;
    document.getElementById("modalOverlay").classList.add("show");
  }
  function closeModal(){
    document.getElementById("modalOverlay").classList.remove("show");
    document.getElementById("modalConfirm").style.display = "";
    document.getElementById("modalConfirm").textContent = "Yes, Reset";
    document.getElementById("modalCancel").textContent = "Cancel";
    document.getElementById("modalExtra").style.display = "none";
    pendingResetAction = null;
    pendingExtraAction = null;
  }

  /* ============================================================
     INIT
     ============================================================ */
  function init(){
    wireEvents();
    wireAuthEvents();
    wireAccountEvents();
    wireLifecycle();
    api("GET", "/api/auth/me").then(function(me){
      currentUser = { username: me.username };
      document.body.classList.remove("booting", "auth-required");
      renderAccountHeader();
      return loadAccountData().then(maybeShowImportBanner);
    }).catch(function(err){
      document.body.classList.remove("booting");
      if(err.status === 401){
        return api("GET", "/api/auth/config")
          .then(function(c){ showAuthScreen(!!c.allowRegistration); })
          .catch(function(){ showAuthScreen(true); });
      }
      enterLoadError(new Error("Tak dapat sambung ke pelayan Money Tracker. " + err.message));
    });
  }

  // exposed only for automated testing; contains only this account's own data
  window.__moneyTracker = { calcMonth: calcMonth, getState: function(){ return state; }, receipts: Receipts, buildMonthSheets: buildMonthSheets,
    flush: function(){ return flushPendingEdits(); }, getUser: function(){ return currentUser; } };

  document.addEventListener("DOMContentLoaded", init);
})();
