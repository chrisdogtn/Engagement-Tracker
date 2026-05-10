#!/usr/bin/env node

const { getConfig } = require("./config");
const { startCron, startServer } = require("./server");

async function main() {
  const config = getConfig({ requireSecrets: false });
  startServer(config);
  startCron(config);
}

main().catch((error) => {
  console.error("Failed to start Engagement Tracker:", error);
  process.exitCode = 1;
});
