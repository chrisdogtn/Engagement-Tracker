const { getConfig } = require("../config");
const { importMetaExport } = require("../syncService");

function parseArgs(argv) {
  const options = {};

  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    options[match[1]] = match[2];
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = args.file || args.path;

  if (!filePath) {
    throw new Error("Provide --file=\"C:\\path\\to\\meta-export.csv\"");
  }

  const result = await importMetaExport(getConfig(), {
    filePath,
    weekStart: args.weekStart,
    weekEnd: args.weekEnd,
    updateWeeklyRollups: args.updateWeeklyRollups !== "false",
    updateAnalyticsTabs: args.updateAnalyticsTabs !== "false"
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`Meta export import failed: ${error.message}`);
  process.exit(1);
});
