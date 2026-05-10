#!/usr/bin/env node

const { runSync } = require("../syncService");

runSync(undefined, parseArgs(process.argv.slice(2)))
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error("Sync failed:", error);
    process.exitCode = 1;
  });

function parseArgs(args) {
  const options = {};

  for (const arg of args) {
    const [rawKey, ...rest] = arg.replace(/^--/, "").split("=");
    const value = rest.join("=");
    if (!rawKey || value === "") continue;

    if (rawKey === "start" || rawKey === "startDate") {
      options.startDate = value;
    } else if (rawKey === "end" || rawKey === "endDate") {
      options.endDate = value;
    } else if (rawKey === "lookbackDays") {
      options.lookbackDays = value;
    } else if (rawKey === "updateWeeklyRollups") {
      options.updateWeeklyRollups = ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
    }
  }

  return options;
}
