"use strict";
const config = require("./src/config");
const { openDb } = require("./src/db");
const { createApp } = require("./src/app");

const db = openDb(config.dbPath);
const app = createApp(db, config);

const server = app.listen(config.port, config.host, function(){
  console.log("Money Tracker running at http://" + (config.host === "0.0.0.0" ? "localhost" : config.host) + ":" + config.port);
  console.log("Database: " + config.dbPath);
  if(!config.production) console.log("(development mode — set NODE_ENV=production when deployed behind HTTPS)");
});

function shutdown(){
  server.close(function(){ db.close(); process.exit(0); });
  setTimeout(function(){ process.exit(0); }, 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
