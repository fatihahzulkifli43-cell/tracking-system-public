/*
  Money Tracker — export OLD browser data (for moving into an account)
  --------------------------------------------------------------------
  Use this only if the import screen can't see your old data (e.g. you used the
  old tracker as a file:///…html page or in another browser).

  1. Open the OLD Money_Tracker_v3.html in the browser where your data is.
  2. Open the developer console (Chrome/Edge: Ctrl+Shift+J, Mac: Cmd+Option+J;
     Safari: enable Develop menu → Show JavaScript Console).
  3. Paste everything below and press Enter. A file "money-tracker-old-data.json"
     is downloaded. It contains your data AND receipt photos — keep it private.
  4. In the new app: Account menu → Import data lama → "Pilih fail backup (.json)".
  5. Delete the .json file after importing.
*/
(async () => {
  const out = {};
  for (const k of Object.keys(localStorage)) if (k.startsWith("moneyTracker")) out[k] = localStorage.getItem(k);
  out.__receipts = [];
  await new Promise((done) => {
    const req = indexedDB.open("moneyTrackerReceipts");
    req.onerror = done;
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("receipts")) { db.close(); return done(); }
      const tx = db.transaction("receipts", "readonly");
      const cur = tx.objectStore("receipts").openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const v = c.value, bytes = new Uint8Array(v.data);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
        out.__receipts.push({ key: String(c.primaryKey), type: v.type, name: v.name, data: btoa(bin) });
        c.continue();
      };
      tx.oncomplete = () => { db.close(); done(); };
      tx.onerror = done;
    };
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: "application/json" }));
  a.download = "money-tracker-old-data.json";
  a.click();
  console.log("Exported " + Object.keys(out).length + " keys and " + out.__receipts.length + " receipts.");
})();
